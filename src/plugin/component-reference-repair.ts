import { componentReferenceRepairSchema, type ComponentReferenceRepairArgs, type ComponentReferenceRepairResult } from '../shared/component-reference-repair.js';
import { describeError } from './errors.js';
import { snapshotDigest } from './snapshot-digest.js';
import { fail, indexNodes, isInDocument, jsonValue, snapshot, stable, utf8Length } from './variant-state.js';

type Api = Pick<typeof figma, 'root' | 'mixed' | 'getNodeByIdAsync'> & { fileKey?: string };
type Obj = Record<string, any>;
const prefix = 'component-reference-repair-v1-';
const maxState = 524_288;
const maxRawState = 8 * 1024 * 1024;
const nativeFields = ['layoutMode', 'layoutWrap', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'counterAxisAlignContent', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'strokesIncludedInLayout'] as const;
const policy = 'Only exact direct-owned icon INSTANCE main link changes. Native child-index topology mapping preserves content, overrides, paints, geometry, bindings, metadata and other main links. Intrinsic wrapper layout may take exact previewed replacement values. No speculative rollback.';
const asObj = (value: unknown) => value as Obj;
function bounded(value: string, stage: string, max = maxState) {
  if (utf8Length(value) > max) fail('LIMIT_EXCEEDED', { stage, maxBytes: max });
  return value;
}
function stateDigest(state: Captured['state'], req: string, stage: 'preview' | 'result') {
  const raw = bounded(stable(state), 'repair-state', maxRawState);
  return `repair-${stage}-v2:sha256:${snapshotDigest(`repair-${stage}-v2\0${req}\0${raw}`)}`;
}
function pluginData(node: BaseNode) {
  if (typeof node.getPluginDataKeys !== 'function') fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, reason: 'Plugin metadata enumeration unavailable' });
  return Object.fromEntries(node.getPluginDataKeys().filter(k => !k.startsWith(prefix)).sort().map(k => [k, node.getPluginData(k)]));
}
function nodesAtPaths(root: SceneNode): Map<string, SceneNode> {
  const result = new Map<string, SceneNode>();
  function visit(n: SceneNode, path: string, depth: number) {
    if (depth > 16 || result.size >= 2000 || n.removed) fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Removed or unbounded tree' });
    result.set(path, n);
    if ('children' in n) n.children.forEach((c, i) => visit(c, `${path}/${i}`, depth + 1));
  }
  visit(root, '', 0); return result;
}
function tree(root: SceneNode, api: Api) {
  const result = snapshot(root, api.mixed);
  function extra(n: typeof result, source: SceneNode) {
    n.properties.$metadata = pluginData(source);
    for (const key of ['overrides', 'scaleFactor', 'isExposedInstance', 'slotSettings', 'limitViolations', 'key', 'remote']) {
      if (key in source) n.properties[`$${key}`] = jsonValue(asObj(source)[key], api.mixed);
    }
    if ('children' in source) source.children.forEach((c, i) => extra(n.children[i], c));
  }
  extra(result, root); return result;
}
function ancestry(node: BaseNode, api: Api) {
  const result: unknown[] = []; const seen = new Set<string>(); let n: BaseNode | null = node;
  while (n) {
    if (seen.has(n.id)) fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Ancestry cycle' }); seen.add(n.id);
    const item: Obj = { id: n.id, type: n.type, name: n.name, parentId: n.parent?.id ?? null,
      childIds: 'children' in n ? n.children.map(c => c.id) : [], metadata: pluginData(n) };
    if (n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && n.parent?.type !== 'COMPONENT_SET')) item.schema = jsonValue(n.componentPropertyDefinitions, api.mixed);
    if (n.type === 'COMPONENT') item.variantProperties = jsonValue(n.variantProperties, api.mixed);
    result.push(item); n = n.parent;
  }
  return result;
}
interface Captured {
  state: { fileKey: string | null; roots: Record<string, unknown>; links: Record<string, string>; impactIds: string[] };
  records: Map<string, SceneNode>; paths: Map<string, Map<string, SceneNode>>;
}
async function capture(api: Api, owner: ComponentNode, old: ComponentNode, replacement: ComponentNode): Promise<Captured> {
  const records = new Map<string, SceneNode>(); const roots: Record<string, unknown> = {}, links: Record<string, string> = {};
  const paths = new Map<string, Map<string, SceneNode>>();
  function record(n: SceneNode) {
    if (records.has(n.id)) return;
    if (records.size >= 100) fail('LIMIT_EXCEEDED', { stage: 'repair-main-graph', max: 100 });
    records.set(n.id, n); paths.set(n.id, nodesAtPaths(n));
    roots[n.id] = { tree: tree(n, api), ancestry: ancestry(n, api) };
  }
  record(owner); record(old); record(replacement);
  const instances = await owner.getInstancesAsync();
  if (instances.length > 1000 || new Set(instances.map(n => n.id)).size !== instances.length) fail('LIMIT_EXCEEDED', { stage: 'repair-instance-impact', max: 1000 });
  for (const n of instances) {
    if (n.removed || !isInDocument(n) || n.type !== 'INSTANCE') fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Impact instance unavailable' }); record(n);
  }
  let count = 0;
  for (const root of records.values()) for (const n of indexNodes(root).values()) {
    if (++count > 8000) fail('LIMIT_EXCEEDED', { stage: 'repair-graph', max: 8000 });
    if (n.type !== 'INSTANCE' || n.id in links) continue;
    const main = await n.getMainComponentAsync();
    if (!main || main.removed || (main.id !== old.id && !main.remote && !isInDocument(main))) fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Main link unavailable outside approved orphan' });
    links[n.id] = main.id; record(main);
  }
  function verifyTrees() {
    for (const [id, n] of records) if (stable(roots[id]) !== stable({ tree: tree(n, api), ancestry: ancestry(n, api) })) fail('SOURCE_CHANGED', { nodeId: id, stage: 'repair-async-capture' });
  }
  verifyTrees();
  for (const [id, n] of records) for (const node of indexNodes(n).values()) if (node.type === 'INSTANCE') {
    if ((await node.getMainComponentAsync())?.id !== links[node.id]) fail('SOURCE_CHANGED', { nodeId: node.id, stage: 'repair-main-link' });
  }
  const impactIds = instances.map(n => n.id).sort();
  if (stable((await owner.getInstancesAsync()).map(n => n.id).sort()) !== stable(impactIds)) fail('SOURCE_CHANGED', { stage: 'repair-instance-impact' });
  verifyTrees();
  const state = { fileKey: api.fileKey ?? null, roots, links, impactIds }; bounded(stable(state), 'repair-state', maxRawState);
  return { state, records, paths };
}
function iconTopology(root: SceneNode) {
  if (root.type !== 'INSTANCE' || root.children.length !== 1 || root.children[0].type !== 'INSTANCE' || root.children[0].children.length !== 1 || root.children[0].children[0].type !== 'VECTOR') {
    fail('PRESERVATION_UNSUPPORTED', { nodeId: root.id, reason: 'Only exact INSTANCE -> INSTANCE -> VECTOR icon topology supported' });
  }
  return root as InstanceNode;
}
function masterTopology(root: ComponentNode) {
  if (root.children.length !== 1 || root.children[0].type !== 'INSTANCE' || root.children[0].children.length !== 1 || root.children[0].children[0].type !== 'VECTOR') fail('PRESERVATION_UNSUPPORTED', { nodeId: root.id, reason: 'Replacement/orphan icon topology unsupported' });
}
function request(args: ComponentReferenceRepairArgs) {
  const { dryRun: _dry, expectedState: _state, ...rest } = args; return stable(rest);
}
function writeChunks(root: BaseNode, key: string, value: string) {
  bounded(value, 'repair-receipt-result');
  // Code points avoid splitting UTF-16 surrogate pairs; key+value < native 100 KiB.
  const points = Array.from(value), chunks: string[] = [];
  for (let i = 0; i < points.length; i += 12_000) chunks.push(points.slice(i, i + 12_000).join(''));
  if (chunks.length > 64) fail('LIMIT_EXCEEDED', { stage: 'repair-receipt-chunks' });
  chunks.forEach((part, i) => { bounded(key + i + part, 'repair-receipt-entry', 100_000); root.setPluginData(`${key}-${i}`, part); });
  return chunks.length;
}
function readChunks(root: BaseNode, key: string, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 64) fail('OPERATION_RESULT_CHANGED', { reason: 'Invalid receipt chunk count' });
  let value = '';
  for (let i = 0; i < count; i++) { const part = root.getPluginData(`${key}-${i}`); if (!part || utf8Length(part) > 48_000) fail('OPERATION_RESULT_CHANGED', { reason: 'Missing or oversized receipt chunk', index: i }); value += part; }
  return bounded(value, 'repair-read-receipt');
}
interface Prepared { instance: InstanceNode; owner: ComponentNode; old: ComponentNode; replacement: ComponentNode; capture: Captured; wrapperPaths: Map<string, string>; result: ComponentReferenceRepairResult }
async function prepare(api: Api, args: ComponentReferenceRepairArgs, applying: boolean): Promise<Prepared> {
  const instance = await api.getNodeByIdAsync(args.instanceId), old = await api.getNodeByIdAsync(args.expectedMainComponentId), replacement = await api.getNodeByIdAsync(args.replacementComponentId);
  if (!instance || !old || !replacement) fail('NODE_NOT_FOUND', { nodeId: !instance ? args.instanceId : !old ? args.expectedMainComponentId : args.replacementComponentId });
  if (!instance || instance.type !== 'INSTANCE' || instance.parent?.type !== 'COMPONENT' || !isInDocument(instance) || instance.parent.remote) fail('UNSUPPORTED_NODE', { nodeId: args.instanceId, reason: 'Attached direct-owned local component INSTANCE required' });
  const owner = instance.parent;
  if (!old || old.type !== 'COMPONENT' || old.remote || old.removed || isInDocument(old)) fail('PRESERVATION_UNSUPPORTED', { nodeId: args.expectedMainComponentId, reason: 'Readable orphan local main required' });
  if (!replacement || replacement.type !== 'COMPONENT' || replacement.remote || replacement.removed || !isInDocument(replacement)) fail('PRESERVATION_UNSUPPORTED', { nodeId: args.replacementComponentId, reason: 'Attached local replacement COMPONENT required' });
  if (old === owner || replacement === owner) fail('PRESERVATION_UNSUPPORTED', { reason: 'Owner cannot be replacement or orphan main' });
  masterTopology(old); masterTopology(replacement); iconTopology(instance);
  if ([instance.width, instance.height, replacement.width, replacement.height, old.width, old.height].some(n => n !== 16)) fail('PRESERVATION_UNSUPPORTED', { nodeId: instance.id, reason: 'Exact 16x16 icon required' });
  const captured = await capture(api, owner, old, replacement);
  if (captured.state.links[instance.id] !== old.id) fail(applying ? 'SOURCE_CHANGED' : 'PRESERVATION_UNSUPPORTED', { nodeId: instance.id, reason: 'Expected orphan main link differs' });
  const childIndex = owner.children.indexOf(instance), wrapperPaths = new Map<string, string>([[owner.id, `/${childIndex}`]]);
  for (const id of captured.state.impactIds) {
    const root = captured.records.get(id)!;
    if (captured.state.links[id] !== owner.id || root.type !== 'INSTANCE' || root.children.length !== owner.children.length) fail('PRESERVATION_UNSUPPORTED', { nodeId: id, reason: 'Complete direct owner-instance correspondence required' });
    const wrapper = iconTopology(root.children[childIndex]);
    if (captured.state.links[wrapper.id] !== old.id) fail('PRESERVATION_UNSUPPORTED', { nodeId: wrapper.id, reason: 'Affected icon has custom main override' });
    wrapperPaths.set(id, `/${childIndex}`);
  }
  // Every preserved nested main must stay locally accessible for bounded restoration.
  for (const [id, path] of wrapperPaths) {
    const nested = captured.paths.get(id)!.get(`${path}/0`)!; const main = captured.records.get(captured.state.links[nested.id]);
    if (!main || main.type !== 'COMPONENT' || main.remote || !isInDocument(main)) fail('PRESERVATION_UNSUPPORTED', { nodeId: nested.id, reason: 'Accessible local nested add main required' });
  }
  const nativeLayoutChanges: ComponentReferenceRepairResult['nativeLayoutChanges'] = [];
  for (const [id, path] of wrapperPaths) {
    const wrapper = captured.paths.get(id)!.get(path)!;
    for (const field of nativeFields) if (field in replacement && stable(jsonValue(asObj(wrapper)[field], api.mixed)) !== stable(jsonValue(asObj(replacement)[field], api.mixed))) nativeLayoutChanges.push({ nodeId: wrapper.id, field, before: jsonValue(asObj(wrapper)[field], api.mixed), after: jsonValue(asObj(replacement)[field], api.mixed) });
  }
  const result: ComponentReferenceRepairResult = { status: 'preview', operationId: args.operationId, instanceId: instance.id, ownerComponentId: owner.id, expectedMainComponentId: old.id, replacementComponentId: replacement.id,
    instanceImpact: { count: captured.state.impactIds.length, nodeIds: captured.state.impactIds }, nativeLayoutChanges, preservationPolicy: policy };
  return { instance, owner, old, replacement, capture: captured, wrapperPaths, result };
}
function mappedState(state: Captured['state'], mapping: Map<string, string>) {
  const result = JSON.parse(stable(state)) as Captured['state'];
  for (const root of Object.values(result.roots)) {
    const visit = (node: Obj) => {
      node.id = mapping.get(node.id) ?? node.id;
      // Only native identity slots are mapped. Names, text, metadata and bindings
      // can legitimately contain strings equal to an old node ID.
      if (Array.isArray(node.properties.$overrides)) for (const entry of node.properties.$overrides) entry.id = mapping.get(entry.id) ?? entry.id;
      node.children.forEach(visit);
    };
    visit((root as Obj).tree);
    for (const item of (root as Obj).ancestry) { item.id = mapping.get(item.id) ?? item.id; if (item.parentId) item.parentId = mapping.get(item.parentId) ?? item.parentId; item.childIds = item.childIds.map((id: string) => mapping.get(id) ?? id); }
  }
  result.links = Object.fromEntries(Object.entries(result.links).map(([id, main]) => [mapping.get(id) ?? id, main]));
  return result;
}
function nativeOverrideNormalization(expected: Captured['state'], actual: Captured['state'], allowed: Set<string>) {
  for (const [id, root] of Object.entries(expected.roots)) {
    const visit = (before: Obj, after: Obj) => {
      if (!after) return;
      if (Array.isArray(before.properties.$overrides) && Array.isArray(after.properties.$overrides)) {
        after.properties.$overrides = after.properties.$overrides.flatMap((entry: Obj) => {
          const existing = before.properties.$overrides.find((old: Obj) => old.id === entry.id);
          if (!allowed.has(entry.id) || existing?.overriddenFields.includes('mainComponent')) return [entry];
          const filtered = entry.overriddenFields.filter((field: string) => field !== 'mainComponent');
          return filtered.length || existing ? [{ ...entry, overriddenFields: filtered }] : [];
        });
        for (const n of [before, after]) n.properties.$overrides = n.properties.$overrides.map((entry: Obj) => ({ ...entry, overriddenFields: [...entry.overriddenFields].sort() })).sort((a: Obj, b: Obj) => a.id.localeCompare(b.id));
      }
      before.children.forEach((child: Obj, i: number) => visit(child, after.children[i]));
    };
    if (actual.roots[id]) visit((root as Obj).tree, (actual.roots[id] as Obj).tree);
  }
}
function validatePost(p: Prepared, post: Captured, restoredNestedInstanceIds: string[]): ComponentReferenceRepairResult['nodeMap'] {
  const before = p.capture, nodeMap: NonNullable<ComponentReferenceRepairResult['nodeMap']> = [], mapping = new Map<string, string>();
  if (stable(before.state.impactIds) !== stable(post.state.impactIds)) fail('PRESERVATION_FAILED', { reason: 'Owner instance impact changed' });
  for (const [rootId, path] of p.wrapperPaths) {
    const oldPaths = before.paths.get(rootId)!, nextPaths = post.paths.get(rootId)!;
    if (!nextPaths) fail('PRESERVATION_FAILED', { nodeId: rootId, reason: 'Affected root disappeared' });
    for (const [childPath, node] of oldPaths) {
      const next = nextPaths.get(childPath); if (!next || next.type !== node.type) fail('PRESERVATION_FAILED', { nodeId: node.id, reason: 'Child-index topology changed' });
      if (childPath === path || childPath.startsWith(`${path}/`)) { mapping.set(node.id, next.id); nodeMap.push({ beforeId: node.id, afterId: next.id, path: `${rootId}${childPath}` }); }
      else if (next.id !== node.id) fail('PRESERVATION_FAILED', { nodeId: node.id, reason: 'Unrelated node identity changed' });
    }
    if (oldPaths.size !== nextPaths.size || nextPaths.get(path)?.id !== oldPaths.get(path)?.id) fail('PRESERVATION_FAILED', { nodeId: rootId, reason: 'Wrapper identity or topology changed' });
  }
  const expected = mappedState(before.state, mapping);
  const actual = JSON.parse(stable(post.state)) as Captured['state'], allowedOverrides = new Set<string>();
  for (const [rootId, path] of p.wrapperPaths) {
    const parts = path.split('/').filter(Boolean).map(Number); let icon = (expected.roots[rootId] as Obj).tree;
    for (const part of parts) icon = icon.children[part];
    const nextWrapper = post.paths.get(rootId)!.get(path)!;
    for (const change of p.result.nativeLayoutChanges.filter(c => c.nodeId === before.paths.get(rootId)!.get(path)!.id)) {
      const nextValue = jsonValue(asObj(nextWrapper)[change.field], Symbol.for('unreachable-mixed'));
      if (stable(nextValue) !== stable(change.before) && stable(nextValue) !== stable(change.after)) fail('PRESERVATION_FAILED', { nodeId: nextWrapper.id, field: change.field, reason: 'Native layout differs from before and exact preview value' });
      icon.properties[change.field] = nextValue;
    }
    expected.links[icon.id] = p.replacement.id;
    allowedOverrides.add(icon.id);
  }
  restoredNestedInstanceIds.forEach(id => allowedOverrides.add(id));
  nativeOverrideNormalization(expected, actual, allowedOverrides);
  if (stable(expected) !== stable(actual)) {
    const changedRoots = Object.keys(expected.roots).filter(id => stable(expected.roots[id]) !== stable(actual.roots[id]));
    fail('PRESERVATION_FAILED', { reason: 'Content, geometry, paints, overrides, metadata, schema or main links changed outside exact plan', changedRootIds: changedRoots });
  }
  return nodeMap;
}
function changedNodes(before: Captured, post: Captured) {
  const changed = new Set<string>();
  const flatten = (root: unknown) => {
    const result = new Map<string, Obj>();
    function visit(n: Obj, path: string) { result.set(path, { id: n.id, name: n.name, type: n.type, properties: n.properties, childIds: n.children.map((c: Obj) => c.id) }); n.children.forEach((c: Obj, i: number) => visit(c, `${path}/${i}`)); }
    if (root) visit((root as Obj).tree, ''); return result;
  };
  for (const rootId of new Set([...Object.keys(before.state.roots), ...Object.keys(post.state.roots)])) {
    const oldNodes = flatten(before.state.roots[rootId]), newNodes = flatten(post.state.roots[rootId]);
    for (const path of new Set([...oldNodes.keys(), ...newNodes.keys()])) {
      const old = oldNodes.get(path), next = newNodes.get(path);
      if (stable(old) !== stable(next) || before.state.links[old?.id] !== post.state.links[next?.id]) { if (old) changed.add(old.id); if (next) changed.add(next.id); }
    }
  }
  return [...changed].sort();
}
export async function repairComponentReference(api: Api, input: unknown): Promise<ComponentReferenceRepairResult> {
  const args = componentReferenceRepairSchema.parse(input), req = request(args), key = `${prefix}operation-${args.operationId}`, lockKey = `${prefix}lock-${args.instanceId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const prior = api.root.getPluginData(key), lock = api.root.getPluginData(lockKey);
  if (lock && lock !== args.operationId) fail('OPERATION_INCOMPLETE', { operationId: lock, nodeId: args.instanceId, reason: 'Prior repair reserved this instance' });
  if (prior) {
    let receipt: Obj; try { receipt = JSON.parse(prior); } catch { fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Corrupt receipt' }); }
    if (receipt.request !== req) fail('OPERATION_CONFLICT', { operationId: args.operationId });
    if (receipt.status !== 'applied') {
      let failure: Obj = receipt;
      if (receipt.failureChunks) try { failure = JSON.parse(readChunks(api.root, `${key}-failure`, receipt.failureChunks)); } catch { fail('OPERATION_INCOMPLETE', { operationId: args.operationId, cause: 'Incomplete failure receipt', auditIncomplete: true }); }
      fail('OPERATION_INCOMPLETE', { operationId: args.operationId, changedNodeIds: failure.changedNodeIds ?? [], cause: failure.cause, auditIncomplete: failure.auditIncomplete ?? false });
    }
    let stored: Obj; try { stored = JSON.parse(readChunks(api.root, key, receipt.chunks)); } catch { fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, reason: 'Corrupt result receipt' }); }
    if (!stored || typeof stored !== 'object' || !stored.result || typeof stored.result.ownerComponentId !== 'string') fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, reason: 'Invalid result receipt shape' });
    const owner = await api.getNodeByIdAsync(stored.result.ownerComponentId), old = await api.getNodeByIdAsync(args.expectedMainComponentId), replacement = await api.getNodeByIdAsync(args.replacementComponentId);
    if (!owner || owner.type !== 'COMPONENT' || !old || old.type !== 'COMPONENT' || !replacement || replacement.type !== 'COMPONENT') fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId });
    const current = (await capture(api, owner, old, replacement)).state;
    if ('stateDigest' in stored || 'stateDigestVersion' in stored) {
      if (stored.stateDigestVersion !== 2 || typeof stored.stateDigest !== 'string' || !/^repair-result-v2:sha256:[a-f0-9]{64}$/.test(stored.stateDigest)
        || stateDigest(current, req, 'result') !== stored.stateDigest) fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, reason: 'Result state digest differs or version invalid' });
    } else if (!stored.state || stable(current) !== stable(stored.state)) fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId });
    return { ...stored.result, status: 'replayed' };
  }
  if (lock || api.root.getPluginDataKeys().some(k => k.startsWith(`${key}-`))) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Receipt missing while lock or chunks remain' });
  const p = await prepare(api, args, !args.dryRun), expectedState = stateDigest(p.capture.state, req, 'preview');
  if (args.dryRun) {
    const result = { ...p.result, expectedState };
    bounded(stable(result), 'repair-preview-result'); return result;
  }
  if (args.expectedState !== expectedState) fail('SOURCE_CHANGED', { operationId: args.operationId, reason: 'Preview state changed' });
  const finalCapture = await capture(api, p.owner, p.old, p.replacement);
  if (stable(finalCapture.state) !== stable(p.capture.state)) fail('SOURCE_CHANGED', { stage: 'repair-before-write' });
  // Reserve durable failure metadata and result space before first scene write.
  bounded(stable({ stateDigestVersion: 2, stateDigest: stateDigest(p.capture.state, req, 'result'), result: { ...p.result, nodeMap: [...p.wrapperPaths.keys()].flatMap(id => [...p.capture.paths.get(id)!].map(([path, n]) => ({ beforeId: n.id, afterId: 'x'.repeat(256), path }))) } }), 'repair-receipt-preflight');
  const receipt: Obj = { status: 'pending', request: req, changedNodeIds: [], cause: null };
  const persist = () => api.root.setPluginData(key, bounded(stable(receipt), 'repair-document-receipt', 90_000));
  api.root.setPluginData(lockKey, args.operationId); persist();
  let post: Captured | undefined; const restoredNestedInstanceIds: string[] = [];
  try {
    p.instance.swapComponent(p.replacement);
    // Native swap may drop nested add overrides. Restore only that exact main link;
    // all paints/style/bindings and every other field remain read-only.
    const syncState = () => stable([...p.capture.records].map(([id, n]) => [id, tree(n, api), ancestry(n, api)]));
    let nativeState = syncState();
    const unchanged = () => { if (syncState() !== nativeState) fail('SOURCE_CHANGED', { stage: 'repair-native-await', reason: 'State changed during native link read' }); };
    for (const [rootId, path] of p.wrapperPaths) {
      const root = p.capture.records.get(rootId)!, next = nodesAtPaths(root).get(`${path}/0`), oldNested = p.capture.paths.get(rootId)!.get(`${path}/0`)!;
      if (!next || next.type !== 'INSTANCE') fail('PRESERVATION_FAILED', { nodeId: rootId, reason: 'Nested add topology changed' });
      const originalMainId = p.capture.state.links[oldNested.id];
      const currentMainId = (await next.getMainComponentAsync())?.id; unchanged();
      if ((await next.getMainComponentAsync())?.id !== currentMainId) fail('SOURCE_CHANGED', { nodeId: next.id, stage: 'repair-native-main-link' }); unchanged();
      if (currentMainId !== originalMainId) {
        const replacementNested = p.replacement.children[0];
        if (replacementNested.type !== 'INSTANCE' || currentMainId !== p.capture.state.links[replacementNested.id]) fail('SOURCE_CHANGED', { nodeId: next.id, reason: 'Unexpected native nested main; restoration refused' });
        const main = p.capture.records.get(originalMainId);
        if (!main || main.type !== 'COMPONENT' || !isInDocument(main) || main.remote) fail('PRESERVATION_FAILED', { nodeId: next.id, reason: 'Original add unavailable' });
        next.swapComponent(main); restoredNestedInstanceIds.push(next.id); nativeState = syncState();
      }
    }
    post = await capture(api, p.owner, p.old, p.replacement);
    const nodeMap = validatePost(p, post, restoredNestedInstanceIds), changedNodeIds = changedNodes(p.capture, post);
    const result: ComponentReferenceRepairResult = { ...p.result, status: 'applied', nodeMap, restoredNestedInstanceIds, changedNodeIds };
    receipt.chunks = writeChunks(api.root, key, stable({ stateDigestVersion: 2, stateDigest: stateDigest(post.state, req, 'result'), result })); receipt.status = 'applied'; receipt.changedNodeCount = changedNodeIds.length; persist();
    return result;
  } catch (error) {
    // Never swap back to inaccessible orphan, delete or detach after partial swap.
    try { post ??= await capture(api, p.owner, p.old, p.replacement); } catch { /* Native partial tree can itself be unreadable. */ }
    let auditIncomplete = false;
    if (!post) {
      auditIncomplete = true;
      const roots: Record<string, unknown> = {}, links: Record<string, string> = {};
      for (const [id, n] of p.capture.records) {
        try { roots[id] = { tree: tree(n, api), ancestry: ancestry(n, api) }; } catch { /* Unreadable tree stays absent. */ }
        try { for (const node of indexNodes(n).values()) if (node.type === 'INSTANCE') try { const main = await node.getMainComponentAsync(); if (main) links[node.id] = main.id; } catch { /* Report audit limitation explicitly. */ } } catch { /* A malformed subtree must still persist incomplete receipt. */ }
      }
      post = { ...p.capture, state: { ...p.capture.state, roots, links } };
    }
    const changedNodeIds = changedNodes(p.capture, post), cause = Array.from(describeError(error)).slice(0, 4000).join('');
    receipt.status = 'incomplete'; receipt.cause = cause; receipt.auditIncomplete = auditIncomplete;
    let receiptFailure: string | undefined;
    try {
      receipt.failureChunks = writeChunks(api.root, `${key}-failure`, stable({ changedNodeIds, cause, auditIncomplete }));
      receipt.changedNodeCount = changedNodeIds.length; persist();
    } catch (failure) {
      receiptFailure = describeError(failure);
      try { receipt.auditIncomplete = true; receipt.receiptFailure = Array.from(receiptFailure).slice(0, 4000).join(''); persist(); } catch { /* Pending root reservation still prevents another repair. */ }
    }
    fail('PARTIAL_APPLY', { operationId: args.operationId, changedNodeIds, cause, auditIncomplete, ...(receiptFailure ? { receiptFailure } : {}) });
  }
}
