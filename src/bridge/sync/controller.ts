import { randomBytes } from 'node:crypto';
import { readFile, readdir, realpath, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import type { BridgeHost } from '../host.js';
import { collect, type Reader } from './collect.js';
import { digest, differences, snapshot, type Snapshot, type Tree, type Difference } from './snapshot.js';
import { previewVariants } from './preview.js';

const entrySchema = z.object({
  componentId: z.string().regex(/^[a-z0-9-]{1,80}$/), displayName: z.string(), modulePath: z.string(),
  storybook: z.object({ componentEntryId: z.string(), storyIds: z.array(z.string()) }),
  figma: z.object({ displayName: z.string(), fileKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), url: z.string().url().optional(),
    sources: z.array(z.object({ theme: z.string().min(1), componentSetId: z.string().min(1),
      key: z.string().min(1).max(128).optional(), nodeType: z.enum(['COMPONENT_SET', 'COMPONENT']).optional(),
      exportPath: z.array(z.string().min(1).max(200)).min(1).max(64).optional() })).min(1) }),
  baselineCandidate: z.object({ rawExport: z.string(), status: z.string() }).passthrough(),
}).passthrough();
const registrySchema = z.object({ schemaVersion: z.literal(1), components: z.array(entrySchema) });
type Entry = z.infer<typeof entrySchema>;
interface RecordState {
  observed?: Snapshot; implemented?: Snapshot; implementationHash?: string; acceptedHash?: string;
  revision: string; comparedAt?: string; warnings: string[]; differences: Difference[];
  candidateDifferences?: Difference[];
  observationComplete?: boolean;
}
interface State { schemaVersion: 1; components: Record<string, RecordState> }
interface SyncHost {
  listFiles(): ReturnType<BridgeHost['listFiles']>;
  pinCurrentFile(expectedFileKey?: string): Reader;
}

export class SyncController {
  private binding?: { fileKey: string; connectionId: string };
  private tail = Promise.resolve();
  constructor(readonly project: string, private readonly host: SyncHost, readonly accessCode = randomBytes(32).toString('hex')) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
  private async path(path: string) {
    const root = await realpath(this.project);
    const target = await realpath(resolve(root, path));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_SYNC_PROJECT');
    return target;
  }
  private async registry() {
    const value = registrySchema.parse(JSON.parse(await readFile(await this.path('source/figma/component-links.json'), 'utf8')));
    if (new Set(value.components.map((entry) => entry.componentId)).size !== value.components.length) throw new Error('DUPLICATE_COMPONENT_ID');
    for (const entry of value.components) {
      const keys = entry.figma.sources.map(source => source.key ?? source.theme);
      if (new Set(keys).size !== keys.length) throw new Error('DUPLICATE_SOURCE_KEY');
      if (new Set(entry.figma.sources.map(source => source.componentSetId)).size !== keys.length) throw new Error('DUPLICATE_SOURCE_NODE');
    }
    return value;
  }
  private async load(): Promise<State> {
    try {
      const path = await this.path('.figma-sync/state.json');
      const value = JSON.parse(await readFile(path, 'utf8')) as State;
      if (value.schemaVersion !== 1 || !value.components || typeof value.components !== 'object') throw new Error('INVALID_SYNC_STATE');
      for (const record of Object.values(value.components)) for (const snap of [record.observed, record.implemented]) {
        if (snap && (snap.schemaVersion !== 1 || snap.id !== digest(snap.data))) throw new Error('INVALID_SYNC_SNAPSHOT');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, components: {} };
      throw error;
    }
  }
  private async save(state: State) {
    const root = await realpath(this.project);
    await mkdir(join(root, '.figma-sync'), { recursive: true });
    const dir = await this.path('.figma-sync');
    // Temp and destination share a directory, so readers see one complete state.
    const temp = join(dir, `state-${randomBytes(8).toString('hex')}.tmp`);
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw new Error('SYNC_STATE_TOO_LARGE');
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, join(dir, 'state.json'));
  }
  private async implementationHash() {
    const files: Record<string, string> = {};
    const visit = async (path: string) => {
      const safe = await this.path(path);
      for (const entry of await readdir(safe, { withFileTypes: true })) {
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory()) await visit(child);
        else files[child] = digest((await readFile(await this.path(child))).toString('base64'));
      }
    };
    for (const path of ['src', '.storybook', 'scripts', 'docs']) await visit(path);
    files.registry = digest(await readFile(await this.path('source/figma/component-links.json'), 'utf8'));
    return digest(files);
  }
  private reader(entry: Entry) {
    const current = this.host.listFiles().find((file) => file.active);
    if (!current) throw new Error('FIGMA_NOT_CONNECTED');
    if (current.fileKey) return this.host.pinCurrentFile(entry.figma.fileKey);
    if (this.binding?.connectionId !== current.id || this.binding.fileKey !== entry.figma.fileKey) throw new Error('FILE_CONFIRMATION_REQUIRED');
    return this.host.pinCurrentFile();
  }
  bind(fileKey: string, connectionId: string, componentId?: string) {
    return this.serial(async () => {
      const entries = (await this.registry()).components.filter((entry) => entry.figma.fileKey === fileKey);
      if (!entries.length) throw new Error('FILE_NOT_IN_REGISTRY');
      const selected = componentId ? entries.filter(entry => entry.componentId === componentId) : entries;
      if (!selected.length) throw new Error('COMPONENT_NOT_IN_REGISTRY');
      const current = this.host.listFiles().find((file) => file.active && file.id === connectionId);
      if (!current || (current.fileKey && current.fileKey !== fileKey)) throw new Error('FILE_IDENTITY_MISMATCH');
      const reader = this.host.pinCurrentFile(current.fileKey ? fileKey : undefined);
      for (const entry of selected) for (const source of entry.figma.sources) {
        const node = await reader.call('node.tree', { nodeId: source.componentSetId, depth: 0, offset: 0, limit: 1 }) as Tree;
        if (node.id !== source.componentSetId || node.type !== (source.nodeType ?? 'COMPONENT_SET')) throw new Error('INVALID_COMPONENT_SOURCE');
      }
      this.binding = { fileKey, connectionId };
      return { confirmed: true, persistent: !!current.fileKey };
    });
  }
  async list() {
    const registry = await this.registry();
    const state = await this.load();
    const codeHash = await this.implementationHash();
    return { protocolVersion: 2, files: this.host.listFiles(), components: registry.components.map((entry) => {
      const record = state.components[entry.componentId];
      const status = record?.observationComplete === false ? 'incomplete' : !record?.implemented ? 'no-baseline' : record.warnings.length ? 'incomplete'
        : record.differences.length ? 'needs-transfer' : record.implementationHash !== codeHash ? 'implementation-changed'
        : record.acceptedHash === digest([record.implemented.id, codeHash]) ? 'accepted' : 'ready';
      return { componentId: entry.componentId, displayName: entry.displayName, storybook: entry.storybook, figma: entry.figma,
        status, revision: record?.revision, snapshotId: record?.observed?.id, comparedAt: record?.comparedAt,
        stale: !this.host.listFiles().some((file) => file.active && (file.fileKey === entry.figma.fileKey ||
          this.binding?.connectionId === file.id && this.binding.fileKey === entry.figma.fileKey)),
        warnings: record?.warnings ?? [], differences: record?.differences ?? [], candidateDifferences: record?.candidateDifferences,
        bound: this.host.listFiles().some((file) => file.active && (file.fileKey === entry.figma.fileKey ||
          this.binding?.connectionId === file.id && this.binding.fileKey === entry.figma.fileKey)) };
    }) };
  }
  async previews(componentId: string) {
    if (!(await this.registry()).components.some(entry => entry.componentId === componentId)) throw new Error('COMPONENT_NOT_IN_REGISTRY');
    const record = (await this.load()).components[componentId];
    if (!record?.implemented || !record.observed || record.observationComplete === false) throw new Error('PREVIEW_NOT_AVAILABLE');
    return { componentId, revision: record.revision, snapshotId: record.observed.id,
      baselineId: record.implemented.id, ...previewVariants(record.implemented, record.observed, record.differences) };
  }
  private async compareEntry(entry: Entry, state: State) {
    const reader = this.reader(entry);
    const observed = await collect(reader, entry.figma.sources);
    const previous = state.components[entry.componentId];
    const next: RecordState = { ...previous, revision: randomBytes(16).toString('hex'), comparedAt: new Date().toISOString(),
      warnings: observed.warnings, observationComplete: !observed.warnings.length, differences: [] };
    if (!observed.warnings.length) next.observed = observed;
    if (previous?.implemented) next.differences = differences(previous.implemented.data, observed.data);
    else {
      // Historical exports are candidates, never automatically accepted baselines.
      const raw = JSON.parse(await readFile(await this.path(entry.baselineCandidate.rawExport), 'utf8')) as Record<string, Tree>;
      const roots = Object.fromEntries(entry.figma.sources.map((source) => {
        let tree: unknown = raw;
        for (const part of source.exportPath ?? [source.theme]) {
          if (!tree || typeof tree !== 'object' || !Object.hasOwn(tree, part)) throw new Error('BASELINE_ROOT_MISSING');
          tree = (tree as Record<string, unknown>)[part];
        }
        if (!tree || typeof tree !== 'object' || (tree as Tree).id !== source.componentSetId) throw new Error('BASELINE_ROOT_MISMATCH');
        return [source.key ?? source.theme, tree as Tree];
      }));
      const candidate = snapshot(roots);
      next.candidateDifferences = differences(candidate.data.nodes, observed.data.nodes, '/nodes');
      next.warnings = [...new Set([...observed.warnings, ...candidate.warnings.map((warning) => `Historical baseline: ${warning}`)])];
    }
    state.components[entry.componentId] = next;
    return observed;
  }
  compare(componentId: string) {
    return this.serial(async () => {
      const entry = (await this.registry()).components.find((entry) => entry.componentId === componentId);
      if (!entry) throw new Error('COMPONENT_NOT_IN_REGISTRY');
      const state = await this.load();
      await this.compareEntry(entry, state);
      await this.save(state);
      return this.list();
    });
  }
  // Called by the code-transfer workflow, never by export or the browser UI.
  implemented(componentId: string, snapshotId: string, revision: string) {
    return this.serial(async () => {
      const state = await this.load();
      const record = state.components[componentId];
      if (!record?.observed || record.observed.id !== snapshotId || record.revision !== revision) throw new Error('STALE_IMPLEMENTATION_REQUEST');
      if (!record.observationComplete || record.observed.warnings.length) throw new Error('SNAPSHOT_INCOMPLETE');
      record.implemented = record.observed;
      record.implementationHash = await this.implementationHash();
      record.acceptedHash = undefined;
      record.differences = [];
      record.candidateDifferences = undefined;
      record.warnings = [];
      record.revision = randomBytes(16).toString('hex');
      await this.save(state);
      return this.list();
    });
  }
  accept(componentId: string, snapshotId: string, revision: string) {
    return this.serial(async () => {
      const state = await this.load();
      const record = state.components[componentId];
      if (!record?.implemented || record.implemented.id !== snapshotId || record.revision !== revision ||
          record.implementationHash !== await this.implementationHash()) throw new Error('STALE_ACCEPTANCE_REQUEST');
      const entry = (await this.registry()).components.find((entry) => entry.componentId === componentId);
      if (!entry) throw new Error('COMPONENT_NOT_IN_REGISTRY');
      const current = await this.compareEntry(entry, state);
      if (current.warnings.length || current.id !== record.implemented.id || record.implementationHash !== await this.implementationHash()) {
        await this.save(state);
        throw new Error('SOURCE_OR_IMPLEMENTATION_CHANGED');
      }
      state.components[componentId].acceptedHash = digest([snapshotId, record.implementationHash]);
      await this.save(state);
      return this.list();
    });
  }
}
