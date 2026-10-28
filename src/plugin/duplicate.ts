import * as z from 'zod/v4';
import { duplicateNodeSchema, type DuplicateNodeArgs, type DuplicateNodeResult } from '../shared/protocol.js';
import { describeError } from './errors.js';
import { fail, indexNodes, isInDocument, jsonValue, snapshot as baseSnapshot, stable, utf8Length, VariantError, type NodeSnapshot } from './variant-state.js';

type DuplicateApi = Pick<typeof figma, 'getNodeByIdAsync' | 'getStyleByIdAsync' | 'loadFontAsync' | 'mixed'>;
type Root = FrameNode | InstanceNode;
type Parent = PageNode | FrameNode;
const prefix = 'codex-duplicate-v1-';
const receiptSchema = z.object({
  request: z.string(), nodeId: z.string().optional(),
  status: z.enum(['pending', 'applied', 'incomplete']),
}).strict();
const resultRecordSchema = z.object({
  nodeMap: z.record(z.string(), z.string()), state: z.string(), parentId: z.string(),
}).strict();
const failureRecordSchema = z.object({
  request: z.string(), code: z.string(), details: z.record(z.string(), z.unknown()),
}).strict();

// Keep the older variant receipt format unchanged while checking instance-specific fields here.
function snapshot(node: SceneNode, mixed: symbol, descend = true): NodeSnapshot {
  const tree = baseSnapshot(node, mixed, descend);
  const nodes = descend ? indexNodes(node) : new Map([[node.id, node]]);
  function enrich(value: NodeSnapshot) {
    const actual = nodes.get(value.id)!;
    if (actual.type === 'INSTANCE') {
      value.properties.scaleFactor = jsonValue(actual.scaleFactor, mixed);
      value.properties.isExposedInstance = jsonValue(actual.isExposedInstance, mixed);
    }
    value.children.forEach(enrich);
  }
  enrich(tree); return tree;
}

function requestKey(args: DuplicateNodeArgs) {
  const { dryRun: _dryRun, expectedState: _expectedState, ...request } = args;
  return stable(request);
}

function parseReceipt(value: string, nodeId: string): unknown {
  try { return JSON.parse(value); }
  catch { fail('OPERATION_RESULT_CHANGED', { nodeId, reason: 'Invalid receipt JSON' }); }
}

// Split by code point: even four-byte characters stay below Figma's 100 kB entry limit.
function writeRecord(node: Root, value: unknown) {
  const data = stable(value);
  if (utf8Length(data) > 524_288) fail('LIMIT_EXCEEDED', { stage: 'receipt', reason: 'Receipt exceeds 512 KiB' });
  const chars = Array.from(data);
  const count = Math.ceil(chars.length / 20_000);
  for (let i = 0; i < count; i++) node.setPluginData(`${prefix}chunk-${i}`, chars.slice(i * 20_000, (i + 1) * 20_000).join(''));
  node.setPluginData(`${prefix}chunks`, String(count));
}

function readRecord(node: Root) {
  const count = Number(node.getPluginData(`${prefix}chunks`));
  if (!Number.isInteger(count) || count < 1 || count > 27) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Missing receipt' });
  let data = '';
  for (let i = 0; i < count; i++) data += node.getPluginData(`${prefix}chunk-${i}`);
  if (utf8Length(data) > 524_288) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Oversized receipt' });
  const parsed = resultRecordSchema.safeParse(parseReceipt(data, node.id));
  if (!parsed.success) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Invalid receipt' });
  return parsed.data;
}

function context(source: Root): { parent: Parent; page: PageNode; document: DocumentNode } {
  const parent = source.parent;
  if (!parent || (parent.type !== 'PAGE' && parent.type !== 'FRAME') || (parent.type === 'FRAME' && parent.layoutMode !== 'NONE')) {
    fail('UNSUPPORTED_NODE', { nodeId: source.id, reason: 'Requires a page or a free-layout FRAME parent' });
  }
  let current: BaseNode | null = parent;
  let page: PageNode | undefined;
  while (current) {
    if (current.type === 'INSTANCE' || current.type === 'COMPONENT' || current.type === 'COMPONENT_SET') {
      fail('UNSUPPORTED_NODE', { nodeId: source.id, ancestorId: current.id, reason: 'Cannot write inside components or instances' });
    }
    if (current.type === 'PAGE') page = current;
    if (current.type === 'DOCUMENT' && page && isInDocument(source)) return { parent, page, document: current };
    current = current.parent;
  }
  fail('UNSUPPORTED_NODE', { nodeId: source.id, reason: 'Source is outside the document' });
}

async function componentLinks(root: SceneNode): Promise<Record<string, string | null>> {
  const entries = await Promise.all([...indexNodes(root).values()].filter((node): node is InstanceNode => node.type === 'INSTANCE')
    .map(async (node) => [node.id, (await node.getMainComponentAsync())?.id ?? null] as const));
  return Object.fromEntries(entries);
}

async function nodeState(node: Root, api: DuplicateApi) {
  const tree = snapshot(node, api.mixed);
  const links = await componentLinks(node);
  if (stable(tree) !== stable(snapshot(node, api.mixed))) fail('SOURCE_CHANGED', { nodeId: node.id, stage: 'capture' });
  return { tree, links };
}

interface Prepared {
  source: Root; parent: Parent; page: PageNode; document: DocumentNode;
  styles: Map<string, PaintStyle>; request: string; expectedState: string;
}

function environment(p: Prepared, api: DuplicateApi, clone?: Root) {
  const ancestors = [];
  let node: BaseNode | null = p.parent;
  while (node && node.type !== 'DOCUMENT') {
    ancestors.push(node.type === 'PAGE' ? { id: node.id, type: node.type, name: node.name } : snapshot(node as SceneNode, api.mixed, false));
    node = node.parent;
  }
  return stable({
    request: p.request, parentId: p.source.parent?.id, ancestors,
    children: p.parent.children.filter((n) => n !== clone).map((n) => n.id),
    styles: [...p.styles.values()].map((style) => jsonValue({ id: style.id, type: style.type, name: style.name, paints: style.paints }, api.mixed)),
  });
}

async function capture(p: Prepared, api: DuplicateApi, clone?: Root) {
  if (p.source.parent !== p.parent || !isInDocument(p.source)) fail('SOURCE_CHANGED', { nodeId: p.source.id });
  const before = environment(p, api, clone);
  const state = await nodeState(p.source, api);
  if (before !== environment(p, api, clone)) fail('SOURCE_CHANGED', { stage: 'capture', nodeId: p.source.id });
  const value = stable({ environment: before, ...state });
  if (utf8Length(value) > 262_144) fail('LIMIT_EXCEEDED', { nodeId: p.source.id, reason: 'Preview exceeds 256 KiB' });
  return value;
}

async function unchanged(p: Prepared, api: DuplicateApi, clone?: Root) {
  if (await capture(p, api, clone) !== p.expectedState) fail('SOURCE_CHANGED', { stage: 'apply', nodeId: p.source.id });
}

function mapCopy(source: SceneNode, clone: SceneNode): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  function visit(a: SceneNode, b: SceneNode, depth: number) {
    if (map.size >= 2000 || depth > 16 || a.type !== b.type) fail('SOURCE_CHANGED', { stage: 'clone', sourceNodeId: a.id, nodeId: b.id });
    map.set(a.id, b);
    const aa = 'children' in a ? a.children : [];
    const bb = 'children' in b ? b.children : [];
    if (aa.length !== bb.length) fail('SOURCE_CHANGED', { stage: 'clone', sourceNodeId: a.id, reason: 'Child count mismatch' });
    aa.forEach((child, i) => visit(child, bb[i], depth + 1));
  }
  visit(source, clone, 0); return map;
}

// Compare all captured fields except exactly requested root placement/name and paint channels.
function preserved(tree: NodeSnapshot, args: DuplicateNodeArgs, reverse: Map<string, string>, root = true): unknown {
  const id = reverse.get(tree.id) ?? tree.id;
  const properties = structuredProperties(tree.properties);
  const override = args.layerStyles.find((style) => style.sourceNodeId === id);
  for (const [channel, target] of [['fills', override?.fillStyleId], ['strokes', override?.strokeStyleId]] as const) {
    if (target === undefined) continue;
    delete properties[channel]; delete properties[channel === 'fills' ? 'fillStyleId' : 'strokeStyleId'];
    const stripBindings = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== channel)) : value;
    if ('boundVariables' in properties) properties.boundVariables = stripBindings(properties.boundVariables);
    if (channel === 'fills' && Array.isArray(properties.textSegments)) {
      properties.textSegments = properties.textSegments.map((segment: Record<string, unknown>) => {
        const { fills: _fills, fillStyleId: _style, ...rest } = segment;
        if ('boundVariables' in rest) rest.boundVariables = stripBindings(rest.boundVariables);
        return rest;
      });
    }
    if (channel === 'fills' && tree.type === 'VECTOR') {
      const network = properties.vectorNetwork as { regions?: Array<Record<string, unknown>> } | undefined;
      if (Array.isArray(network?.regions)) network.regions = network.regions.map((region) => {
        // A whole-vector paint style also updates its region paints. Geometry
        // (vertices, segments, winding and loops) remains part of the comparison.
        const { fills: _fills, fillStyleId: _style, ...geometry } = region;
        return geometry;
      });
    }
  }
  if (root) {
    delete properties.x; delete properties.y;
    if (Array.isArray(properties.relativeTransform)) properties.relativeTransform = (properties.relativeTransform as number[][]).map((row) => row.slice(0, 2));
  }
  return { id, type: tree.type, name: root ? args.sourceNodeId : tree.name, properties,
    children: tree.children.map((child) => preserved(child, args, reverse, false)) };
}

function structuredProperties(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

function difference(expected: unknown, actual: unknown, field = ''): { field: string; expected: unknown; actual: unknown } | undefined {
  if (stable(expected) === stable(actual)) return;
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object'
    && Array.isArray(expected) === Array.isArray(actual)) {
    const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const found = difference(a[key], b[key], field ? `${field}.${key}` : key);
      if (found) return found;
    }
  }
  return { field, expected: expected ?? null, actual: actual ?? null };
}

function describe(args: DuplicateNodeArgs, parentId: string) {
  return { sourceNodeId: args.sourceNodeId, operationId: args.operationId, parentId,
    name: args.name, position: args.position, layerStyles: args.layerStyles };
}

async function replay(api: DuplicateApi, p: Prepared, args: DuplicateNodeArgs): Promise<DuplicateNodeResult | undefined> {
  const raw = p.document.getPluginData(`${prefix}${args.operationId}`);
  if (!raw) return;
  const parsed = receiptSchema.safeParse(parseReceipt(raw, p.document.id));
  if (!parsed.success) fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, reason: 'Invalid operation receipt' });
  const receipt = parsed.data;
  if (receipt.request !== p.request) fail('OPERATION_CONFLICT', { operationId: args.operationId });
  if (receipt.status !== 'applied') fail(receipt.status === 'incomplete' ? 'ROLLBACK_INCOMPLETE' : 'OPERATION_INCOMPLETE', {
    operationId: args.operationId, remainingNodeIds: receipt.nodeId ? [receipt.nodeId] : [], reason: 'Inspect previous operation before retrying' });
  const node = receipt.nodeId ? await api.getNodeByIdAsync(receipt.nodeId) : null;
  if (!node || (node.type !== 'FRAME' && node.type !== 'INSTANCE') || !isInDocument(node) || node.parent !== p.parent) {
    fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, nodeId: receipt.nodeId });
  }
  const record = readRecord(node);
  if (record.parentId !== p.parent.id || record.state !== stable(await nodeState(node, api)) || record.nodeMap[args.sourceNodeId] !== node.id) {
    fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, nodeId: node.id });
  }
  return { status: 'replayed', ...describe(args, p.parent.id), nodeId: node.id, nodeMap: record.nodeMap };
}

async function writeCopy(api: DuplicateApi, p: Prepared, args: DuplicateNodeArgs): Promise<DuplicateNodeResult> {
  let clone: Root | undefined;
  const key = `${prefix}${args.operationId}`;
  let reserved = false;
  try {
    await unchanged(p, api);
    p.document.setPluginData(key, stable({ request: p.request, status: 'pending' })); reserved = true;
    clone = p.source.clone();
    p.document.setPluginData(key, stable({ request: p.request, status: 'pending', nodeId: clone.id }));
    const map = mapCopy(p.source, clone);
    p.parent.appendChild(clone);
    clone.name = args.name; clone.x = args.position.x; clone.y = args.position.y;
    await unchanged(p, api, clone);
    for (const style of args.layerStyles) {
      const target = map.get(style.sourceNodeId)!;
      if (target.type === 'TEXT') {
        const fonts = target.fontName === api.mixed ? target.getRangeAllFontNames(0, target.characters.length) : [target.fontName];
        for (const font of fonts) await api.loadFontAsync(font);
      }
      if (style.fillStyleId !== undefined && 'setFillStyleIdAsync' in target) await target.setFillStyleIdAsync(style.fillStyleId);
      if (style.strokeStyleId !== undefined && 'setStrokeStyleIdAsync' in target) await target.setStrokeStyleIdAsync(style.strokeStyleId);
    }
    // Full snapshots cross the Figma API thousands of times. Validate the source
    // at batch boundaries; a changed source still rolls back the entire copy.
    const sourceNodes = indexNodes(p.source);
    for (const [sourceId, target] of map) {
      const source = sourceNodes.get(sourceId)!;
      if ('constraints' in source && 'constraints' in target && stable(source.constraints) !== stable(target.constraints)) target.constraints = { ...source.constraints };
      if ('reactions' in source && 'reactions' in target && stable(jsonValue(source.reactions, api.mixed)) !== stable(jsonValue(target.reactions, api.mixed))) {
        await target.setReactionsAsync(JSON.parse(JSON.stringify(source.reactions)));
      }
    }
    const state = await nodeState(clone, api);
    await unchanged(p, api, clone);
    if (stable(state.tree) !== stable(snapshot(clone, api.mixed))) fail('SOURCE_CHANGED', { stage: 'readback', nodeId: clone.id });
    const reverse = new Map([...map].map(([id, node]) => [node.id, id]));
    const sourceState = JSON.parse(p.expectedState) as { tree: NodeSnapshot; links: Record<string, string | null> };
    const changed = difference(preserved(sourceState.tree, args, new Map()), preserved(state.tree, args, reverse));
    if (clone.parent !== p.parent || clone.name !== args.name || clone.x !== args.position.x || clone.y !== args.position.y
      || changed || stable(sourceState.links) !== stable(Object.fromEntries(Object.entries(state.links).map(([id, main]) => [reverse.get(id) ?? id, main])))) {
      fail('SOURCE_CHANGED', { stage: 'readback', nodeId: clone.id, reason: 'Copy changed unrequested properties or component links', ...changed });
    }
    for (const style of args.layerStyles) {
      const node = map.get(style.sourceNodeId)!;
      for (const [field, expected, channel] of [['fillStyleId', style.fillStyleId, 'fills'], ['strokeStyleId', style.strokeStyleId, 'strokes']] as const) {
        if (expected === undefined) continue;
        const value = node as unknown as Record<string, unknown>;
        if (value[field] !== expected || stable(jsonValue(value[channel], api.mixed)) !== stable(jsonValue(p.styles.get(expected)!.paints, api.mixed))) {
          fail('SOURCE_CHANGED', { stage: 'styles-readback', nodeId: node.id, field, expected });
        }
        if (channel === 'fills' && node.type === 'VECTOR') {
          for (const [index, region] of (node.vectorNetwork.regions ?? []).entries()) {
            if ((region.fillStyleId && region.fillStyleId !== expected)
              || (region.fills !== undefined && stable(jsonValue(region.fills, api.mixed)) !== stable(jsonValue(p.styles.get(expected)!.paints, api.mixed)))) {
              fail('SOURCE_CHANGED', { stage: 'styles-readback', nodeId: node.id,
                field: `vectorNetwork.regions.${index}.fills`, expected, reason: 'Vector region paint or style mismatch' });
            }
          }
        }
      }
    }
    const nodeMap = Object.fromEntries([...map].map(([id, node]) => [id, node.id]));
    writeRecord(clone, { nodeMap, parentId: p.parent.id, state: stable(state) });
    p.document.setPluginData(key, stable({ request: p.request, status: 'applied', nodeId: clone.id }));
    return { status: 'applied', ...describe(args, p.parent.id), nodeId: clone.id, nodeMap };
  } catch (error) {
    const remainingNodeIds: string[] = [];
    const cleanupErrors: string[] = [];
    if (clone) {
      try { if (!clone.removed) clone.remove(); if (isInDocument(clone)) remainingNodeIds.push(clone.id); }
      catch (cleanup) { remainingNodeIds.push(clone.id); cleanupErrors.push(describeError(cleanup)); }
    }
    if (reserved) {
      try {
        const details = error instanceof VariantError ? error.details : { stage: 'duplicate', cause: describeError(error) };
        const boundedDetails = Object.fromEntries(Object.entries(details).map(([name, value]) => [name,
          utf8Length(stable(value)) > 1000 ? stable(value).slice(0, 250) : value]));
        // Retain errors independently of rollback receipts so a read-only preview
        // can recover an error whose original MCP response timed out.
        p.document.setPluginData(`${key}-failure`, stable({ request: p.request,
          code: error instanceof VariantError ? error.code : 'FIGMA_API_ERROR', details: boundedDetails }));
        p.document.setPluginData(key, remainingNodeIds.length ? stable({ request: p.request, status: 'incomplete', nodeId: clone?.id }) : '');
      }
      catch (cleanup) { cleanupErrors.push(describeError(cleanup)); }
    }
    if (remainingNodeIds.length || cleanupErrors.length) fail('ROLLBACK_INCOMPLETE', { operationId: args.operationId, remainingNodeIds, cleanupErrors, cause: describeError(error) });
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage: 'duplicate', sourceNodeId: args.sourceNodeId, cause: describeError(error) });
  }
}

export async function duplicateNode(api: DuplicateApi, input: unknown): Promise<DuplicateNodeResult> {
  const args = duplicateNodeSchema.parse(input);
  try {
    const source = await api.getNodeByIdAsync(args.sourceNodeId);
    if (!source) fail('NODE_NOT_FOUND', { sourceNodeId: args.sourceNodeId });
    if ((source.type !== 'FRAME' && source.type !== 'INSTANCE') || source.removed) fail('UNSUPPORTED_NODE', { sourceNodeId: source.id });
    const ctx = context(source);
    await ctx.page.loadAsync();
    const p: Prepared = { ...ctx, source, styles: new Map(), request: requestKey(args), expectedState: '' };
    if (utf8Length(stable({ request: p.request, status: 'pending', nodeId: 'x'.repeat(128) })) > 90_000) {
      fail('LIMIT_EXCEEDED', { stage: 'request', reason: 'Operation receipt exceeds 90 KiB' });
    }
    const previous = await replay(api, p, args);
    if (previous) return previous;
    const nodes = indexNodes(source);
    for (const override of args.layerStyles) {
      const node = nodes.get(override.sourceNodeId);
      if (!node) fail('INVALID_ARGUMENT', { sourceNodeId: override.sourceNodeId, reason: 'Layer is outside source' });
      for (const [method, styleId] of [['setFillStyleIdAsync', override.fillStyleId], ['setStrokeStyleIdAsync', override.strokeStyleId]] as const) {
        if (styleId === undefined) continue;
        if (!(method in node)) fail('UNSUPPORTED_NODE', { sourceNodeId: node.id, method });
        if (!p.styles.has(styleId)) {
          const style = await api.getStyleByIdAsync(styleId);
          if (!style) fail('STYLE_NOT_FOUND', { styleId });
          if (style.type !== 'PAINT') fail('STYLE_TYPE_MISMATCH', { styleId });
          p.styles.set(styleId, style);
        }
      }
    }
    p.expectedState = await capture(p, api);
    if (args.dryRun) {
      const rawFailure = p.document.getPluginData(`${prefix}${args.operationId}-failure`);
      const previous = rawFailure ? failureRecordSchema.safeParse(parseReceipt(rawFailure, p.document.id)) : undefined;
      const failure = previous?.success && previous.data.request === p.request
        ? { code: previous.data.code, details: previous.data.details } : undefined;
      return { status: 'preview', ...describe(args, p.parent.id), expectedState: p.expectedState,
        ...(failure ? { previousFailure: failure } : {}) };
    }
    if (p.expectedState !== args.expectedState) fail('SOURCE_CHANGED', { stage: 'preflight', sourceNodeId: source.id });
    return await writeCopy(api, p, args);
  } catch (error) {
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage: 'prepare', sourceNodeId: args.sourceNodeId, cause: describeError(error) });
  }
}
