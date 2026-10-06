import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SyncController } from '../src/bridge/sync/controller.js';
import type { Source } from '../src/bridge/sync/collect.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'sync-registry-')); folders.push(project);
  for (const path of ['src', '.storybook', 'scripts', 'docs', 'source/figma']) await mkdir(join(project, path), { recursive: true });
  const roots = {
    main: { id: 'main', name: 'Checkbox', type: 'COMPONENT_SET', children: [], childCount: 0, properties: {} },
    group: { id: 'group', name: 'Checkbox group', type: 'COMPONENT', children: [], childCount: 0, properties: { paddingLeft: 8 } },
  };
  const sources: (Source & { exportPath?: string[] })[] = [
    { theme: 'dark', componentSetId: 'main', exportPath: ['trees', 'dark'] },
    { theme: 'dark', key: 'groupDark', componentSetId: 'group', nodeType: 'COMPONENT', exportPath: ['trees', 'groupDark'] }];
  const entry = { componentId: 'checkbox', displayName: 'Checkbox', modulePath: 'src/Checkbox.tsx',
    storybook: { componentEntryId: 'checkbox', storyIds: ['checkbox--playground'] },
    figma: { displayName: 'Source', fileKey: 'original', sources },
    baselineCandidate: { rawExport: 'source/figma/checkbox.json', status: 'unverified' } };
  const registry: { schemaVersion: number; components: typeof entry[] } = { schemaVersion: 1, components: [entry, { ...entry, componentId: 'button',
    storybook: { componentEntryId: 'button', storyIds: [] }, figma: { ...entry.figma, sources: [{ theme: 'light', componentSetId: 'unavailable' }] } }] };
  const saveRegistry = () => writeFile(join(project, 'source/figma/component-links.json'), JSON.stringify(registry));
  await saveRegistry();
  await writeFile(join(project, 'source/figma/checkbox.json'), JSON.stringify({ trees: { dark: roots.main, groupDark: roots.group } }));
  let padding = 8;
  const reads: string[] = [];
  const host = { listFiles: () => [{ id: '11111111-1111-4111-8111-111111111111', name: 'Source', active: true, visible: true }],
    pinCurrentFile: () => ({ call: async (method: string, args: unknown) => {
      if (method === 'styles.list') return { paints: [], texts: [], effects: [] };
      const id = (args as { nodeId: string }).nodeId; reads.push(id);
      const root = roots[id as keyof typeof roots];
      if (!root) throw new Error('Unrelated component must not be read');
      return { ...root, properties: id === 'group' ? { paddingLeft: padding } : root.properties };
    } }) };
  return { project, registry, saveRegistry, reads, controller: new SyncController(project, host), setPadding: (value: number) => { padding = value; } };
}
it('compares nested exports and multiple roots of one theme including a standalone component', async () => {
  const f = await fixture();
  await f.controller.bind('original', '11111111-1111-4111-8111-111111111111', 'checkbox');
  expect(f.reads).toEqual(['main', 'group']);
  let row = (await f.controller.compare('checkbox')).components.find(c => c.componentId === 'checkbox')!;
  expect(row.status).toBe('no-baseline'); expect(row.candidateDifferences).toEqual([]);
  await f.controller.implemented('checkbox', row.snapshotId!, row.revision!);
  f.setPadding(12);
  const result = await f.controller.compare('checkbox'); row = result.components.find(c => c.componentId === 'checkbox')!;
  expect(row.status).toBe('needs-transfer');
  expect(row.differences).toContainEqual({ path: '/nodes/group/properties/paddingLeft', kind: 'changed', before: 8, after: 12 });
  expect(result.components.find(c => c.componentId === 'button')!.comparedAt).toBeUndefined();
  const preview = await f.controller.previews('checkbox');
  expect(preview.variants[0].context.theme).toBe('dark'); expect(preview.variants[0].id).toBe('group');
});
it('loads a newly generated registry entry without recreating the controller or assigning a baseline', async () => {
  const f = await fixture(); await f.controller.list();
  f.registry.components.push({ ...f.registry.components[0], componentId: 'new-component', storybook: { componentEntryId: 'new-component', storyIds: [] } });
  await f.saveRegistry();
  expect((await f.controller.list()).components.find(c => c.componentId === 'new-component')?.status).toBe('no-baseline');
});
it('rejects overlapping source keys and invalid historical source paths', async () => {
  const f = await fixture();
  f.registry.components[0].figma.sources[1].key = 'dark'; await f.saveRegistry();
  await expect(f.controller.list()).rejects.toThrow('DUPLICATE_SOURCE_KEY');
  f.registry.components[0].figma.sources[1].key = 'groupDark';
  f.registry.components[0].figma.sources[0].exportPath = ['__proto__']; await f.saveRegistry();
  await f.controller.bind('original', '11111111-1111-4111-8111-111111111111', 'checkbox');
  await expect(f.controller.compare('checkbox')).rejects.toThrow('BASELINE_ROOT_MISSING');
});
