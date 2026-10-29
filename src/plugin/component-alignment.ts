import { componentAlignmentSchema, type ComponentAlignmentArgs, type ComponentAlignmentPlan, type ComponentAlignmentResult } from '../shared/component-alignment.js';
import { describeError } from './errors.js';
import { readFileKey } from './file-identity.js';
import { loadNodePage } from './component-catalog.js';
import { fail, indexNodes, isInDocument, jsonValue, snapshot, stable, utf8Length, type NodeSnapshot, VariantError } from './variant-state.js';
import { snapshotDigest } from './snapshot-digest.js';

type Api = Pick<typeof figma, 'root' | 'mixed' | 'getNodeByIdAsync' | 'loadFontAsync'> & { fileKey?: string };
type Obj = Record<string, any>;
const prefix = 'component-alignment-v1-';
const maxInternalState = 8 * 1024 * 1024;
const typographyFields = ['textStyleId', 'fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'textCase', 'textDecoration',
  'textAlignHorizontal', 'textAlignVertical', 'textTruncation', 'maxLines', 'paragraphIndent', 'paragraphSpacing', 'indentation',
  'listSpacing', 'listOptions', 'textWrapStyle', 'openTypeFeatures', 'hangingPunctuation', 'hangingList'] as const;
const policy = 'Existing instance custom content, overrides, paints and main links survive; exact requested master changes may propagate to unoverridden inherited fields. New derived component properties are allowed. Unsupported preservation fails closed.';
function bounded<T>(value: T, stage: string, max = 262_144): T {
  if (utf8Length(typeof value === 'string' ? value : stable(value)) > max) fail('LIMIT_EXCEEDED', { stage, reason: 'Bounded state or result exceeds limit', maxBytes: max });
  return value;
}
function request(args: ComponentAlignmentArgs) { const { dryRun: _dry, expectedState: _state, ...rest } = args; return bounded(stable(rest), 'alignment-request'); }
function previewState(req: string, fullCapture: string) {
  return `alignment-state-v2:sha256:${snapshotDigest(bounded(`alignment-preview-v2\0${req}\0${fullCapture}`, 'alignment-preview-state', maxInternalState))}`;
}
function resultStateDigest(req: string, fullCapture: string) {
  return snapshotDigest(bounded(`alignment-result-v2\0${req}\0${fullCapture}`, 'alignment-result-state', maxInternalState));
}
interface Recovery { kind: 'recovery'; receiptText: string; receipt: Obj; attempt: number; previousFailures: Obj[] }
function recoveryState(req: string, fullCapture: string, recovery: Recovery) {
  return `alignment-recovery-v1:sha256:${snapshotDigest(bounded(`alignment-recovery-v1\0${req}\0${recovery.receiptText}\0${fullCapture}`, 'alignment-recovery-state', maxInternalState))}`;
}
function receiptPreflight(args: ComponentAlignmentArgs, req: string, recovery?: Recovery) {
  const steps = [...args.bindings.map(b => `property:${b.sourcePropertyId}`), ...args.bindings.flatMap(b => b.targetNodeIds.map(id => `bind:${b.sourcePropertyId}:${id}`)), ...args.fields.flatMap(f => f.fields.map(field => `field:${f.targetNodeId}:${field}`))];
  const nodes = [...new Set([args.targetComponentId, ...args.bindings.flatMap(b => b.targetNodeIds), ...args.fields.map(f => f.targetNodeId)])];
  // A pluginData entry has a native 100 KiB key+value limit. Reserve headroom
  // for generated IDs and final/failure metadata before first scene mutation.
  bounded({ version: 1, status: 'pending', request: req, targetComponentId: args.targetComponentId,
    createdPropertyIds: args.bindings.map(() => 'x'.repeat(256)), changedNodeIds: nodes, completedSteps: steps,
    remainingSteps: steps, failureHeadroom: 'x'.repeat(4000), ...(recovery ? { recoveryAttempt: recovery.attempt, previousFailures: recovery.previousFailures } : {}) }, 'alignment-receipt-preflight', 90_000);
}
function obj(node: unknown): Obj { return node as Obj; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function read(value: unknown, api: Api) { return jsonValue(value, api.mixed); }
function schemaValue(definitions: unknown, api: Api): Obj {
  const result = clone(read(definitions, api)) as Obj;
  // Native SLOT getters omit defaultValue although creation requires ''.
  for (const def of Object.values(result)) if (def.type === 'SLOT' && (def.defaultValue === '' || def.defaultValue === undefined)) delete def.defaultValue;
  return result;
}
function paintSignature(node: TextNode) {
  const segments = node.getStyledTextSegments(['fills', 'fillStyleId', 'boundVariables']);
  return [...new Set(segments.map(s => stable({ fills: s.fills, fillStyleId: s.fillStyleId, boundVariables: s.boundVariables })))];
}
function textPreservable(node: SceneNode, api: Api) {
  const n = node as TextNode;
  if (n.fills === api.mixed || n.fillStyleId === api.mixed || paintSignature(n).length > 1) fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Uniform text paints and per-run paint bindings required' });
}
function context(node: ComponentNode) {
  if (node.remote || !isInDocument(node)) fail('UNSUPPORTED_NODE', { nodeId: node.id, reason: 'Requires attached local standalone COMPONENT' });
  const ancestors: unknown[] = []; let n: BaseNode | null = node.parent;
  while (n) {
    if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(n.type)) fail('UNSUPPORTED_NODE', { nodeId: node.id, ancestorId: n.id, reason: 'Standalone COMPONENT required' });
    ancestors.push({ id: n.id, type: n.type, name: n.name, children: 'children' in n ? n.children.map(c => c.id) : [] });
    n = n.parent;
  }
  return ancestors;
}
function owned(node: SceneNode, master: ComponentNode, nestedText = false) {
  if (node === master) return;
  let n: BaseNode | null = node.parent;
  while (n && n !== master) {
    if (['COMPONENT', 'COMPONENT_SET'].includes(n.type) || (n.type === 'INSTANCE' && !nestedText)) fail('INVALID_ARGUMENT', { nodeId: node.id, reason: 'Binding or field crosses component/instance boundary' });
    n = n.parent;
  }
  if (n !== master) fail('INVALID_ARGUMENT', { nodeId: node.id, masterId: master.id, reason: 'Node outside exact master scope' });
}
function metadata(node: BaseNode) {
  if (typeof node.getPluginDataKeys !== 'function') fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, reason: 'Plugin metadata enumeration unavailable' });
  return Object.fromEntries(node.getPluginDataKeys().filter(k => !k.startsWith(prefix)).sort().map(k => [k, node.getPluginData(k)]));
}
function tree(node: SceneNode, api: Api) {
  const nodes = [...indexNodes(node).values()];
  const extra = nodes.map(n => ({ id: n.id, parentId: n.parent?.id, metadata: metadata(n),
    overrides: read(obj(n).overrides, api), scaleFactor: read(obj(n).scaleFactor, api), isExposedInstance: read(obj(n).isExposedInstance, api),
    slotSettings: read(obj(n).slotSettings, api), limitViolations: read(obj(n).limitViolations, api),
    key: read(obj(n).key, api), remote: read(obj(n).remote, api) }));
  // Native variant getters throw: definitions belong to the parent set.
  // Pin that exact owner and variant values as part of preservation state.
  const owner = node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET' ? node.parent : node;
  const schema = owner.type === 'COMPONENT' || owner.type === 'COMPONENT_SET' ? read(owner.componentPropertyDefinitions, api) : undefined;
  return { tree: snapshot(node, api.mixed), extra, ...(schema ? { schema, schemaSourceId: owner.id } : {}),
    ...(node.type === 'COMPONENT' ? { variantProperties: read(node.variantProperties, api) } : {}) };
}
async function graph(roots: SceneNode[], api: Api) {
  const records = new Map<string, { node: SceneNode; state: string }>(), links: Record<string, string | null> = {};
  function record(node: SceneNode) {
    if (records.has(node.id)) return;
    if (records.size >= 100) fail('LIMIT_EXCEEDED', { stage: 'alignment-main-components', max: 100 });
    records.set(node.id, { node, state: stable(tree(node, api)) });
  }
  roots.forEach(record);
  let total = 0;
  for (const { node } of records.values()) for (const n of indexNodes(node).values()) {
    if (++total > 4000) fail('LIMIT_EXCEEDED', { stage: 'alignment-graph', max: 4000 });
    if (n.type !== 'INSTANCE' || n.id in links) continue;
    const main = await n.getMainComponentAsync();
    if (!main || main.removed || (!main.remote && !isInDocument(main))) fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Main component unavailable' });
    links[n.id] = main.id; record(main);
  }
  const verify = () => {
    for (const { node, state } of records.values()) if (state !== stable(tree(node, api))) fail('SOURCE_CHANGED', { stage: 'alignment-async-capture', nodeId: node.id });
  };
  verify();
  // Re-read every asynchronous link after all graph awaits, then verify trees.
  for (const { node } of records.values()) for (const n of indexNodes(node).values()) if (n.type === 'INSTANCE') {
    if ((await n.getMainComponentAsync())?.id !== links[n.id]) fail('SOURCE_CHANGED', { stage: 'alignment-main-link', nodeId: n.id });
  }
  verify();
  return { state: { records: Object.fromEntries([...records].map(([id, r]) => [id, JSON.parse(r.state)])), links }, verify };
}
interface Prepared {
  source: ComponentNode; target: ComponentNode; sources: Map<string, SceneNode>; targets: Map<string, SceneNode>;
  plan: ComponentAlignmentPlan; sourceInstances: InstanceNode[]; targetInstances: InstanceNode[];
}
function typography(node: SceneNode, api: Api) {
  if (node.type !== 'TEXT') fail('INVALID_ARGUMENT', { nodeId: node.id, reason: 'Typography requires TEXT' });
  const result: Obj = {};
  for (const field of typographyFields) if (field in node) {
    const value = obj(node)[field];
    if (value === api.mixed || value === undefined) fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, field, reason: 'Uniform accessible typography required' });
    result[field] = read(value, api);
  }
  if (!result.fontName || typeof result.fontName !== 'object' || !('family' in result.fontName)) fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, reason: 'Uniform font required' });
  return result;
}
function typographyPreflight(before: Obj, after: Obj, target: SceneNode) {
  // Native derived getter has no setter. Only a different nonempty text style
  // can produce requested feature changes; its native result is verified later.
  if ('openTypeFeatures' in after && stable(before.openTypeFeatures) !== stable(after.openTypeFeatures)
    && (typeof after.textStyleId !== 'string' || !after.textStyleId || after.textStyleId === before.textStyleId || typeof obj(target).setTextStyleIdAsync !== 'function')) {
    fail('PRESERVATION_UNSUPPORTED', { nodeId: target.id, field: 'openTypeFeatures', reason: 'Differing readonly typography requires an applicable different text style' });
  }
}
function plan(source: ComponentNode, target: ComponentNode, args: ComponentAlignmentArgs, api: Api): ComponentAlignmentPlan {
  const sources = indexNodes(source), targets = indexNodes(target), properties: ComponentAlignmentPlan['properties'] = [], fields: ComponentAlignmentPlan['fields'] = [];
  if ([...sources.keys()].some(id => targets.has(id))) fail('INVALID_ARGUMENT', { reason: 'Overlapping source and target' });
  if (Object.keys(target.componentPropertyDefinitions).length) fail('TARGET_SCHEMA_NOT_EMPTY', { nodeId: target.id });
  const defs = source.componentPropertyDefinitions, used = new Set<string>(), targetRefs = new Set<string>(), targetFields = new Set<string>();
  for (const n of sources.values()) if (n.type === 'SLOT') {
    // Slots inside nested button instances belong to their own masters.
    let parent = n.parent, nested = false;
    while (parent && parent !== source) { if (parent.type === 'INSTANCE') nested = true; parent = parent.parent; }
    if (nested) continue;
    const id = obj(n).componentPropertyReferences?.slotContentId;
    if (typeof id !== 'string' || defs[id]?.type !== 'SLOT') fail('INVALID_ARGUMENT', { nodeId: n.id, reason: 'Orphan physical source SLOT' });
  }
  if (Object.keys(defs).length !== args.bindings.length) fail('INVALID_ARGUMENT', { reason: 'Bindings must cover complete source schema' });
  for (const binding of args.bindings) {
    const def = defs[binding.sourcePropertyId];
    if (!def || !['BOOLEAN', 'SLOT'].includes(def.type) || used.has(binding.sourcePropertyId)) fail('INVALID_ARGUMENT', { sourcePropertyId: binding.sourcePropertyId, reason: 'Unique BOOLEAN/SLOT source property required' });
    used.add(binding.sourcePropertyId);
    const name = binding.sourcePropertyId.replace(/#[^#]*$/, '');
    if (!name || (def.type === 'BOOLEAN' && typeof def.defaultValue !== 'boolean') || (def.type === 'SLOT' && def.defaultValue !== '' && def.defaultValue !== undefined) || Object.keys(def.boundVariables ?? {}).length) fail('PRESERVATION_UNSUPPORTED', { sourcePropertyId: binding.sourcePropertyId, reason: 'Unsupported default or bound property' });
    const ref = def.type === 'BOOLEAN' ? 'visible' : 'slotContentId';
    const matches = [...sources.values()].filter(n => obj(n).componentPropertyReferences?.[ref] === binding.sourcePropertyId);
    if (!matches.length || (def.type === 'SLOT' && (matches.length !== 1 || matches[0].type !== 'SLOT'))) fail('INVALID_ARGUMENT', { sourcePropertyId: binding.sourcePropertyId, reason: 'Source property orphaned or physical attachment ambiguous' });
    for (const n of matches) { owned(n, source); if (n === source) fail('INVALID_ARGUMENT', { nodeId: n.id, reason: 'Master root cannot be bound' }); }
    if (def.type === 'SLOT' && binding.targetNodeIds.length !== 1) fail('INVALID_ARGUMENT', { sourcePropertyId: binding.sourcePropertyId, reason: 'SLOT requires one target FRAME' });
    for (const id of binding.targetNodeIds) {
      const n = targets.get(id);
      if (!n || n === target) fail('INVALID_ARGUMENT', { nodeId: id, reason: 'Target descendant required' });
      owned(n, target);
      const key = `${id}:${ref}`;
      if (targetRefs.has(key) || obj(n).componentPropertyReferences?.[ref] || (def.type === 'SLOT' && (n.type !== 'FRAME' || n.layoutMode === 'GRID'))) fail('INVALID_ARGUMENT', { nodeId: id, reason: 'Unique unbound owned target; SLOT requires non-GRID FRAME' });
      targetRefs.add(key);
    }
    const options: Obj = {};
    for (const key of ['description', 'preferredValues', 'slotSettings']) if (key in def) options[key] = read(obj(def)[key], api);
    properties.push({ sourcePropertyId: binding.sourcePropertyId, name, type: def.type as 'BOOLEAN' | 'SLOT', defaultValue: def.type === 'SLOT' ? '' : def.defaultValue,
      options, sourceNodeIds: matches.map(n => n.id), targetNodeIds: binding.targetNodeIds });
  }
  for (const pair of args.fields) {
    const a = sources.get(pair.sourceNodeId), b = targets.get(pair.targetNodeId);
    if (!a || !b) fail('INVALID_ARGUMENT', { ...pair, reason: 'Exact in-scope node IDs required' });
    const nestedText = pair.fields.every(f => f === 'characters') && a.type === 'TEXT' && b.type === 'TEXT';
    owned(a, source, nestedText); owned(b, target, nestedText);
    if (a.type !== b.type && !(a.type === 'SLOT' && b.type === 'FRAME')) fail('INVALID_ARGUMENT', { ...pair, reason: 'Compatible node types required' });
    for (const field of pair.fields) {
      const key = `${b.id}:${field}`;
      if (targetFields.has(key)) fail('INVALID_ARGUMENT', { nodeId: b.id, field, reason: 'Duplicate field write' });
      targetFields.add(key);
      if (['characters', 'textAutoResize', 'typography'].includes(field) && (a.type !== 'TEXT' || b.type !== 'TEXT')) fail('INVALID_ARGUMENT', { nodeId: b.id, field, reason: 'TEXT required' });
      if (field === 'typography') { textPreservable(b, api); const before = typography(b, api), after = typography(a, api); typographyPreflight(before, after, b); fields.push({ sourceNodeId: a.id, targetNodeId: b.id, field, before, after }); continue; }
      const before = obj(b)[field], after = obj(a)[field];
      if (!(field in a) || !(field in b) || before === undefined || after === undefined || before === api.mixed || after === api.mixed) fail('PRESERVATION_UNSUPPORTED', { nodeId: b.id, field, reason: 'Accessible uniform field required' });
      if (field === 'characters') {
        if (obj(b).autoRename === true) fail('PRESERVATION_UNSUPPORTED', { nodeId: b.id, reason: 'Character copy would automatically rename TEXT' });
        typography(a, api); typography(b, api); textPreservable(b, api);
      }
      fields.push({ sourceNodeId: a.id, targetNodeId: b.id, field, before: read(before, api), after: read(after, api) });
    }
  }
  // Native auto-layout is permitted only at exact source-derived values shown
  // in preview. No blanket waiver of arbitrary widths/positions.
  const pairs = new Map<string, SceneNode>();
  function pairAncestors(a: SceneNode, b: SceneNode) {
    if (pairs.has(b.id) && pairs.get(b.id) !== a) fail('INVALID_ARGUMENT', { nodeId: b.id, reason: 'Ambiguous geometry correspondence' });
    pairs.set(b.id, a);
    const aa = a.parent, bb = b.parent;
    if (aa && bb && aa !== source && bb !== target && aa.type === bb.type && 'width' in aa && 'width' in bb) pairAncestors(aa as SceneNode, bb as SceneNode);
  }
  for (const f of fields) pairAncestors(sources.get(f.sourceNodeId)!, targets.get(f.targetNodeId)!);
  for (const p of properties) if (p.sourceNodeIds.length === 1 && p.targetNodeIds.length === 1) pairAncestors(sources.get(p.sourceNodeIds[0])!, targets.get(p.targetNodeIds[0])!);
  const nativeGeometryChanges: ComponentAlignmentPlan['nativeGeometryChanges'] = [];
  for (const [id, a] of pairs) {
    const b = targets.get(id)!;
    for (const field of ['x', 'y', 'width', 'height']) {
      if (targetFields.has(`${id}:${field}`)) continue;
      const before = obj(b)[field], after = obj(a)[field];
      const autoParent = b.parent && 'layoutMode' in b.parent && b.parent.layoutMode !== 'NONE';
      const natural = field === 'x' || field === 'y' ? autoParent : b.type === 'TEXT' || obj(b)[field === 'width' ? 'layoutSizingHorizontal' : 'layoutSizingVertical'] === 'HUG';
      if (natural && typeof before === 'number' && typeof after === 'number' && before !== after) nativeGeometryChanges.push({ nodeId: id, sourceNodeId: a.id, field, before, after, reason: 'Exact source-derived native text/auto-layout result; may remain unchanged' });
    }
  }
  return { properties, fields, nativeGeometryChanges };
}
async function instances(master: ComponentNode) {
  if (typeof master.getInstancesAsync !== 'function') fail('PRESERVATION_UNSUPPORTED', { nodeId: master.id, reason: 'Live instance enumeration unavailable' });
  const list = await master.getInstancesAsync();
  if (list.length > 200 || new Set(list.map(n => n.id)).size !== list.length) fail('LIMIT_EXCEEDED', { stage: 'alignment-instance-impact', nodeId: master.id, max: 200 });
  for (const n of list) if (n.removed || !isInDocument(n) || (await n.getMainComponentAsync())?.id !== master.id) fail('SOURCE_CHANGED', { nodeId: n.id, reason: 'Instance impact is incomplete or main link changed' });
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}
async function capture(p: Prepared, api: Api, includeSource = true) {
  const env = stable({ documentId: api.root.id, documentName: api.root.name, fileKey: readFileKey(api), metadata: metadata(api.root),
    source: includeSource ? context(p.source) : undefined, target: context(p.target) });
  const roots: SceneNode[] = includeSource ? [p.source, p.target] : [p.target];
  const sourceInstances = includeSource ? await instances(p.source) : [], targetInstances = await instances(p.target);
  // Source instances cannot be affected by target-only edits. Enumerate exact
  // IDs/main links, but snapshot only target instances and their custom content.
  roots.push(...targetInstances);
  const g = await graph(roots, api);
  const sourceAgain = includeSource ? await instances(p.source) : [], targetAgain = await instances(p.target);
  if (stable(sourceInstances.map(n => n.id)) !== stable(sourceAgain.map(n => n.id)) || stable(targetInstances.map(n => n.id)) !== stable(targetAgain.map(n => n.id))) fail('SOURCE_CHANGED', { stage: 'alignment-instance-capture' });
  g.verify();
  const envAfter = stable({ documentId: api.root.id, documentName: api.root.name, fileKey: readFileKey(api), metadata: metadata(api.root),
    source: includeSource ? context(p.source) : undefined, target: context(p.target) });
  if (env !== envAfter) fail('SOURCE_CHANGED', { stage: 'alignment-environment' });
  return bounded(stable({ environment: env, ...g.state, sourceInstanceIds: sourceInstances.map(n => n.id), targetInstanceIds: targetInstances.map(n => n.id) }), 'alignment-state', maxInternalState);
}
async function prepare(args: ComponentAlignmentArgs, api: Api): Promise<Prepared> {
  const source = await api.getNodeByIdAsync(args.sourceComponentId), target = await api.getNodeByIdAsync(args.targetComponentId);
  if (!source) fail('NODE_NOT_FOUND', { sourceComponentId: args.sourceComponentId });
  if (!target) fail('NODE_NOT_FOUND', { targetComponentId: args.targetComponentId });
  if (source?.type !== 'COMPONENT' || target?.type !== 'COMPONENT') fail('UNSUPPORTED_NODE', { reason: 'Exact source and target COMPONENT required' });
  context(source); context(target); await loadNodePage(source); await loadNodePage(target);
  const p: Prepared = { source, target, sources: indexNodes(source), targets: indexNodes(target), plan: plan(source, target, args, api), sourceInstances: [], targetInstances: [] };
  p.sourceInstances = await instances(source); p.targetInstances = await instances(target);
  return p;
}
function result(p: Prepared, args: ComponentAlignmentArgs): ComponentAlignmentResult {
  return { status: 'preview', operationId: args.operationId, sourceComponentId: p.source.id, targetComponentId: p.target.id, plan: p.plan,
    executionOrder: ['properties', 'slotBindings', 'fields', 'booleanBindings'],
    instanceImpact: { source: { count: p.sourceInstances.length, nodeIds: p.sourceInstances.map(n => n.id) }, target: { count: p.targetInstances.length, nodeIds: p.targetInstances.map(n => n.id) } }, preservationPolicy: policy };
}
async function fonts(p: Prepared, api: Api) {
  const names = new Map<string, FontName>();
  for (const f of p.plan.fields) for (const node of [p.sources.get(f.sourceNodeId)!, p.targets.get(f.targetNodeId)!].filter(n => n.type === 'TEXT')) {
    const text = node as TextNode;
    for (const font of text.getRangeAllFontNames(0, text.characters.length)) {
      if (!font || typeof font.family !== 'string' || typeof font.style !== 'string') fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, reason: 'Font list unavailable' });
      names.set(stable(font), font);
    }
    const font = text.fontName;
    if (font === api.mixed) fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, reason: 'Mixed font unsupported' });
    names.set(stable(font), font);
  }
  for (const font of names.values()) await api.loadFontAsync(font);
}
function chunks(target: ComponentNode, operationId: string, value: string) {
  bounded(value, 'alignment-receipt', 524_288);
  const parts: string[] = [];
  const points = Array.from(value);
  for (let i = 0; i < points.length; i += 12_000) parts.push(points.slice(i, i + 12_000).join(''));
  parts.forEach((v, i) => target.setPluginData(`${prefix}${operationId}-chunk-${i}`, v));
  return parts.length;
}
function readChunks(target: ComponentNode, operationId: string, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 64) fail('OPERATION_RESULT_CHANGED', { reason: 'Invalid receipt chunk count' });
  let value = '';
  for (let i = 0; i < count; i++) {
    const part = target.getPluginData(`${prefix}${operationId}-chunk-${i}`);
    if (!part || Array.from(part).length > 12_000) fail('OPERATION_RESULT_CHANGED', { reason: 'Missing or invalid receipt chunk', index: i });
    value += part;
  }
  return bounded(value, 'alignment-read-receipt', 524_288);
}
function scalarWrite(node: SceneNode, field: string, value: any) {
  if (field === 'width') {
    if (!('resize' in node) || !('height' in node)) fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, field });
    node.resize(value, node.height);
  } else obj(node)[field] = clone(value);
}
async function writeField(node: SceneNode, field: string, value: any) {
  if (field !== 'typography') { scalarWrite(node, field, value); return; }
  const text = node as TextNode;
  if ('textStyleId' in value && text.textStyleId !== value.textStyleId) {
    if (typeof text.setTextStyleIdAsync !== 'function') fail('PRESERVATION_UNSUPPORTED', { nodeId: node.id, reason: 'Async text style setter unavailable' });
    const owned = new Map(typographyFields.filter(key => key in value).map(key => [key, stable(obj(text)[key])]));
    await text.setTextStyleIdAsync(value.textStyleId);
    if (text.textStyleId !== value.textStyleId) fail('SOURCE_CHANGED', { nodeId: node.id, field: 'textStyleId', reason: 'Native style binding changed during await' });
    // Complete ownership check before any further setter can erase concurrent
    // target changes. Native style may retain old values or yield exact desired
    // values; every third value is unsupported and left untouched.
    for (const [key, before] of owned) if (stable(obj(text)[key]) !== before && stable(obj(text)[key]) !== stable(value[key])) fail('SOURCE_CHANGED', { nodeId: node.id, field: key, reason: 'Typography changed outside owned old/new values during style await' });
  }
  if ('openTypeFeatures' in value && stable(text.openTypeFeatures) !== stable(value.openTypeFeatures)) fail('PRESERVATION_FAILED', { nodeId: node.id, field: 'openTypeFeatures', reason: 'Native text style did not produce exact readonly typography' });
  for (const key of typographyFields) if (key !== 'textStyleId' && key !== 'openTypeFeatures' && key in value && stable(obj(text)[key]) !== stable(value[key])) obj(text)[key] = clone(value[key]);
  if ('openTypeFeatures' in value && stable(text.openTypeFeatures) !== stable(value.openTypeFeatures)) fail('PRESERVATION_FAILED', { nodeId: node.id, field: 'openTypeFeatures', reason: 'Native text style did not produce exact readonly typography' });
}
function changed(before: unknown, after: unknown) { return stable(before) !== stable(after); }
function snapshotIndex(root: NodeSnapshot) {
  const result = new Map<string, NodeSnapshot>();
  const visit = (n: NodeSnapshot) => { result.set(n.id, n); n.children.forEach(visit); }; visit(root); return result;
}
function characterOverrideOwners(node: SceneNode, root: SceneNode, owners: Map<string, Set<string>>) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'INSTANCE') {
      const ids = owners.get(parent.id) ?? new Set<string>(); ids.add(node.id); owners.set(parent.id, ids);
    }
    if (parent === root) break;
    parent = parent.parent;
  }
}
function normalizeCharacterOverrides(extra: Array<{ id: string; overrides: unknown }>, owners: Map<string, Set<string>>) {
  for (const row of extra) {
    const allowed = owners.get(row.id);
    if (!allowed || !Array.isArray(row.overrides)) continue;
    const ids = new Set<string>();
    row.overrides = row.overrides.flatMap((override: Obj) => {
      if (typeof override.id !== 'string' || !Array.isArray(override.overriddenFields) || ids.has(override.id)) fail('PRESERVATION_FAILED', { nodeId: row.id, reason: 'Invalid native override records' });
      ids.add(override.id);
      const fields = override.overriddenFields.filter((field: string) => !(allowed.has(override.id) && ['characters', 'styledTextSegments'].includes(field)));
      if (!fields.length && allowed.has(override.id)) return [];
      return [{ ...override, overriddenFields: fields.sort() }];
    }).sort((a: Obj, b: Obj) => stable(a).localeCompare(stable(b)));
  }
}
function nativeTranslations(expected: NodeSnapshot, actual: NodeSnapshot) {
  const before = expected.properties.relativeTransform, after = actual.properties.relativeTransform;
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== 2 || after.length !== 2) return;
  const matrix = clone(before);
  // Only translations already authorized as exact x/y values may move.
  if (expected.properties.x === actual.properties.x && Array.isArray(matrix[0]) && Array.isArray(after[0]) && after[0][2] === expected.properties.x) matrix[0][2] = expected.properties.x;
  if (expected.properties.y === actual.properties.y && Array.isArray(matrix[1]) && Array.isArray(after[1]) && after[1][2] === expected.properties.y) matrix[1][2] = expected.properties.y;
  expected.properties.relativeTransform = matrix;
}
function targetDifferences(expected: NodeSnapshot, actual: NodeSnapshot) {
  const differences: Array<Record<string, unknown>> = []; let differencesTruncated = false;
  const safeEnums = new Set(['layoutMode', 'layoutWrap', 'layoutAlign', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'textAutoResize', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems']);
  const safeEnumValues = new Set(['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID', 'NO_WRAP', 'WRAP', 'INHERIT', 'STRETCH', 'MIN', 'CENTER', 'MAX', 'AUTO', 'ABSOLUTE', 'FIXED', 'HUG', 'FILL', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE', 'SPACE_BETWEEN', 'BASELINE', 'FRAME', 'SLOT', 'TEXT', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'GROUP', 'VECTOR', 'RECTANGLE', 'ELLIPSE', 'LINE', 'BOOLEAN_OPERATION', 'POLYGON', 'STAR']);
  const safeNumbers = new Set(['x', 'y', 'width', 'height', 'layoutGrow', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing', 'counterAxisSpacing']);
  const summary = (field: string, value: unknown) => {
    if (value === undefined) return { missing: true };
    if (field === 'componentPropertyReferences' && value && typeof value === 'object' && !Array.isArray(value)
      && Object.entries(value).every(([key, ref]) => ['visible', 'characters', 'mainComponent', 'slotContentId'].includes(key) && typeof ref === 'string' && /^[A-Za-z0-9_ #.:;-]{1,256}$/.test(ref))) return value;
    if ((safeNumbers.has(field) && typeof value === 'number' && Number.isFinite(value)) || (['visible', 'locked'].includes(field) && typeof value === 'boolean')) return value;
    if ((safeEnums.has(field) || field === 'type') && typeof value === 'string' && safeEnumValues.has(value)) return value;
    return { sha256: snapshotDigest(stable(value)) };
  };
  const add = (nodeId: string, field: string, before: unknown, after: unknown) => {
    if (stable(before) === stable(after)) return;
    const row = { nodeId, path: field === 'name' || field === 'type' || field === 'children' ? `/${field}` : `/properties/${field}`, expected: summary(field, before), actual: summary(field, after) };
    if (differences.length >= 20 || utf8Length(stable([...differences, row])) > 2500) { differencesTruncated = true; return; }
    differences.push(row);
  };
  const a = snapshotIndex(expected), b = snapshotIndex(actual);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(id), after = b.get(id);
    if (!before || !after) { add(id, 'type', before?.type, after?.type); continue; }
    for (const field of ['name', 'type'] as const) add(id, field, before[field], after[field]);
    add(id, 'children', before.children.map(n => n.id), after.children.map(n => n.id));
    for (const field of new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])) add(id, field, before.properties[field], after.properties[field]);
  }
  return { differences, differencesTruncated };
}
function checkTarget(p: Prepared, api: Api, before: ReturnType<typeof tree>, propertyMap: Record<string, string>) {
  const after = tree(p.target, api), oldNodes = new Map<string, NodeSnapshot>(), newNodes = new Map<string, NodeSnapshot>();
  function walk(n: NodeSnapshot, map: Map<string, NodeSnapshot>) { map.set(n.id, n); n.children.forEach(c => walk(c, map)); }
  walk(before.tree, oldNodes); walk(after.tree, newNodes);
  if (stable([...oldNodes.keys()]) !== stable([...newNodes.keys()])) fail('PRESERVATION_FAILED', { reason: 'Target node IDs, children or order changed', ...targetDifferences(before.tree, after.tree) });
  const desired = clone(before.tree);
  function amend(n: NodeSnapshot) {
    const bindings = p.plan.properties.filter(pr => pr.targetNodeIds.includes(n.id));
    if (bindings.length) {
      // Build from original refs, not current refs, to detect unrelated edits.
      const previous = n.properties.componentPropertyReferences;
      const original = previous && typeof previous === 'object' && !('$figma' in previous) ? previous : {};
      n.properties.componentPropertyReferences = { ...original, ...Object.fromEntries(bindings.map(binding => [binding.type === 'BOOLEAN' ? 'visible' : 'slotContentId', propertyMap[binding.sourcePropertyId]])) };
      if (bindings.some(b => b.type === 'SLOT')) n.type = 'SLOT';
    }
    for (const f of p.plan.fields.filter(f => f.targetNodeId === n.id)) {
      if (f.field === 'typography') Object.assign(n.properties, f.after);
      else n.properties[f.field] = f.after;
    }
    let moved = false;
    for (const g of p.plan.nativeGeometryChanges.filter(g => g.nodeId === n.id)) if (stable(newNodes.get(n.id)!.properties[g.field]) === stable(g.after)) { n.properties[g.field] = g.after; if (g.field === 'x' || g.field === 'y') moved = true; }
    if (moved) nativeTranslations(n, newNodes.get(n.id)!);
    // Native styled segments change along with explicitly copied text fields;
    // compare segment paint channels separately below.
    if (p.plan.fields.some(f => f.targetNodeId === n.id && ['typography', 'characters'].includes(f.field))) {
      delete n.properties.textSegments;
      delete newNodes.get(n.id)!.properties.textSegments;
    }
    n.children.forEach(amend);
  }
  amend(desired);
  if (stable(desired) !== stable(after.tree)) fail('PRESERVATION_FAILED', { reason: 'Unrequested target field, geometry, paint, or tree changed', ...targetDifferences(desired, after.tree) });
  const expectedExtra = clone(before.extra);
  for (const n of expectedExtra) if (p.plan.properties.some(pr => pr.type === 'SLOT' && pr.targetNodeIds.includes(n.id))) n.limitViolations = read(obj(p.targets.get(n.id)).limitViolations, api);
  const overrideOwners = new Map<string, Set<string>>();
  for (const f of p.plan.fields.filter(f => f.field === 'characters')) characterOverrideOwners(p.targets.get(f.targetNodeId)!, p.target, overrideOwners);
  // Native text edits create derivative override bookkeeping on containing
  // button instances. Only these exact label IDs and two native fields may
  // differ; raw text, typography, paints, links and all other overrides remain
  // independently checked against their exact expected snapshots.
  normalizeCharacterOverrides(expectedExtra, overrideOwners); normalizeCharacterOverrides(after.extra, overrideOwners);
  if (stable(expectedExtra) !== stable(after.extra)) fail('PRESERVATION_FAILED', { reason: 'Target metadata, overrides or component identity changed' });
  const expectedSchema = Object.fromEntries(p.plan.properties.map(pr => [propertyMap[pr.sourcePropertyId], { type: pr.type, defaultValue: pr.defaultValue, ...pr.options }]));
  if (stable(schemaValue(p.target.componentPropertyDefinitions, api)) !== stable(schemaValue(expectedSchema, api))) fail('PRESERVATION_FAILED', { reason: 'Target schema does not match exact created properties' });
  // Paint preservation includes text runs; reject mixed paints up front rather
  // than guessing how character-count changes remap them.
  for (const f of p.plan.fields.filter(f => f.field === 'typography' || f.field === 'characters')) {
    const a = oldNodes.get(f.targetNodeId)!, b = snapshot(p.targets.get(f.targetNodeId)!, api.mixed, false);
    for (const field of ['fills', 'fillStyleId', 'strokes', 'strokeStyleId', 'effects', 'effectStyleId', 'boundVariables']) if (changed(a.properties[field], b.properties[field])) fail('PRESERVATION_FAILED', { nodeId: b.id, field, reason: 'Text paint or variable binding changed' });
  }
}
function graphPreservation(p: Prepared, before: string, after: string) {
  const a = JSON.parse(before), b = JSON.parse(after);
  const mutable = new Set([p.target.id, ...p.targetInstances.map(n => n.id)]);
  for (const [id, link] of Object.entries(b.links)) if (a.links[id] !== link) fail('PRESERVATION_FAILED', { nodeId: id, reason: 'Existing nested main component link changed' });
  for (const [id, record] of Object.entries(b.records)) if (!mutable.has(id) && stable(a.records[id]) !== stable(record)) fail('PRESERVATION_FAILED', { nodeId: id, reason: 'Source or nested main component state changed' });
  if (stable(a.targetInstanceIds) !== stable(b.targetInstanceIds)) fail('PRESERVATION_FAILED', { reason: 'Target instance impact changed during apply' });
}
function instancePreservation(p: Prepared, api: Api, original: Map<string, ReturnType<typeof tree>>, propertyMap: Record<string, string>, masterBefore: ReturnType<typeof tree>) {
  const newIds = new Set(Object.values(propertyMap));
  const oldMaster = snapshotIndex(masterBefore.tree), newMaster = snapshotIndex(snapshot(p.target, api.mixed));
  for (const n of p.targetInstances) {
    const before = clone(original.get(n.id)!), after = tree(n, api), actualNodes = snapshotIndex(after.tree);
    const liveNodes = indexNodes(n), overrideOwners = new Map<string, Set<string>>();
    const overrides = new Map<string, Set<string>>();
    for (const row of before.extra) if (Array.isArray(row.overrides)) for (const override of row.overrides as Array<{ id: string; overriddenFields: string[] }>) {
      const fields = overrides.get(override.id) ?? new Set<string>(); override.overriddenFields.forEach(f => fields.add(f)); overrides.set(override.id, fields);
    }
    const props = after.tree.properties.componentProperties as Obj | undefined;
    if (props && !('$figma' in props)) for (const id of newIds) delete props[id];
    const touched = new Set<string>();
    for (const layer of snapshotIndex(before.tree).values()) {
      if (layer.id === n.id) continue;
      // IDs retain native master lineage. Accept full composite ID and native
      // composite form without its leading I, never names/topology guesses.
      const matches = [...oldMaster.values()].filter(m => m.id !== p.target.id && (layer.id.endsWith(`;${m.id}`) || (m.id.startsWith('I') && layer.id.endsWith(`;${m.id.slice(1)}`))));
      if (matches.length > 1) fail('PRESERVATION_UNSUPPORTED', { nodeId: layer.id, reason: 'Ambiguous native master lineage' });
      if (!matches.length) continue; // Custom slot content remains exact.
      const old = matches[0], current = newMaster.get(old.id)!, actual = actualNodes.get(layer.id);
      if (!actual) fail('PRESERVATION_FAILED', { nodeId: layer.id, reason: 'Existing instance layer removed' });
      const bound = p.plan.properties.filter(pr => pr.targetNodeIds.includes(old.id));
      if (bound.length) {
        if (bound.some(pr => pr.type === 'SLOT')) layer.type = 'SLOT';
        const refs = layer.properties.componentPropertyReferences;
        const previous = refs && typeof refs === 'object' && !('$figma' in refs) ? refs : {};
        layer.properties.componentPropertyReferences = { ...previous, ...Object.fromEntries(bound.map(pr => [pr.type === 'BOOLEAN' ? 'visible' : 'slotContentId', propertyMap[pr.sourcePropertyId]])) };
        if (bound.some(pr => pr.type === 'SLOT')) {
          const extra = before.extra.find(row => row.id === layer.id)!;
          const actualExtra = after.extra.find(row => row.id === layer.id)!;
          extra.limitViolations = actualExtra.limitViolations;
        }
      }
      const allowed = new Set<string>();
      for (const f of p.plan.fields.filter(f => f.targetNodeId === old.id)) {
        if (f.field === 'typography') Object.keys(obj(f.after)).forEach(k => allowed.add(k)); else allowed.add(f.field);
      }
      p.plan.nativeGeometryChanges.filter(g => g.nodeId === old.id).forEach(g => allowed.add(g.field));
      let moved = false;
      for (const field of allowed) {
        if (overrides.get(layer.id)?.has(field) || stable(layer.properties[field]) !== stable(old.properties[field])) continue;
        layer.properties[field] = current.properties[field];
        if (field === 'characters') characterOverrideOwners(liveNodes.get(layer.id)!, n, overrideOwners);
        if (field === 'x' || field === 'y') moved = true;
        if (field === 'characters' || typographyFields.includes(field as typeof typographyFields[number])) touched.add(layer.id);
      }
      if (moved) nativeTranslations(layer, actual);
      if (touched.has(layer.id)) {
        const aa = layer.properties.textSegments, bb = actual.properties.textSegments;
        const signature = (segments: unknown) => Array.isArray(segments) ? [...new Set(segments.map(s => stable({ fills: s.fills, fillStyleId: s.fillStyleId, boundVariables: s.boundVariables, hyperlink: s.hyperlink })))].sort() : segments;
        if (stable(signature(aa)) !== stable(signature(bb))) fail('PRESERVATION_FAILED', { nodeId: layer.id, reason: 'Existing instance text paint bindings changed' });
        delete layer.properties.textSegments; delete actual.properties.textSegments;
      }
    }
    normalizeCharacterOverrides(before.extra, overrideOwners); normalizeCharacterOverrides(after.extra, overrideOwners);
    if (stable(before) !== stable(after)) fail('PRESERVATION_FAILED', { nodeId: n.id, reason: 'Existing instance content, overrides or custom state changed' });
  }
}
async function replay(api: Api, args: ComponentAlignmentArgs, key: string, req: string): Promise<ComponentAlignmentResult | Recovery | undefined> {
  const text = api.root.getPluginData(key);
  if (!text) return;
  let receipt: Obj;
  try { receipt = JSON.parse(text); } catch { fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Corrupt document receipt' }); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Invalid document receipt' });
  if (receipt.request !== req) fail('OPERATION_CONFLICT', { operationId: args.operationId });
  if (receipt.status === 'incomplete' && (args.dryRun || args.expectedState?.startsWith('alignment-recovery-v1:sha256:'))) {
    bounded(text, 'alignment-recovery-receipt', 90_000);
    const previousAttempt = receipt.recoveryAttempt ?? 0, history = receipt.previousFailures ?? [];
    if (receipt.version !== 1 || receipt.targetComponentId !== args.targetComponentId || 'chunks' in receipt || !Number.isInteger(previousAttempt) || previousAttempt < 0 || previousAttempt >= 3
      || !Array.isArray(history) || history.length !== previousAttempt || history.some(r => !r || r.status !== 'incomplete' || r.request !== req)
      || !['createdPropertyIds', 'completedSteps', 'remainingSteps'].every(k => Array.isArray(receipt[k]) && receipt[k].every((v: unknown) => typeof v === 'string')) || !Array.isArray(receipt.cleanupErrors)) {
      fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Invalid recovery history or recovery attempt limit reached' });
    }
    return { kind: 'recovery', receiptText: text, receipt, attempt: previousAttempt + 1, previousFailures: [...history, clone(receipt)] };
  }
  if (receipt.status !== 'applied') fail('OPERATION_INCOMPLETE', { operationId: args.operationId, createdPropertyIds: receipt.createdPropertyIds ?? [], changedNodeIds: receipt.changedNodeIds ?? [], cleanupErrors: receipt.cleanupErrors ?? [] });
  const target = await api.getNodeByIdAsync(args.targetComponentId);
  if (target?.type !== 'COMPONENT') fail('OPERATION_RESULT_CHANGED', { nodeId: args.targetComponentId, reason: 'Target missing' });
  try {
    const stored = JSON.parse(readChunks(target, args.operationId, receipt.chunks));
    const p = { target } as Prepared;
    const fullCapture = await capture(p, api, false);
    if ('stateDigest' in stored || 'stateDigestVersion' in stored) {
      if (stored.stateDigestVersion !== 2 || typeof stored.stateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(stored.stateDigest) || resultStateDigest(req, fullCapture) !== stored.stateDigest) fail('OPERATION_RESULT_CHANGED', { nodeId: target.id, reason: 'Invalid or changed versioned result digest' });
    } else if (typeof stored.state !== 'string' || fullCapture !== stored.state) fail('OPERATION_RESULT_CHANGED', { nodeId: target.id });
    return bounded({ ...stored.result, status: 'replayed' } as ComponentAlignmentResult, 'alignment-replay', 524_288);
  } catch (error) {
    if (error instanceof VariantError && error.code === 'OPERATION_RESULT_CHANGED') throw error;
    fail('OPERATION_RESULT_CHANGED', { nodeId: target.id, cause: describeError(error) });
  }
}
function validateRecovery(p: Prepared, recovery: Recovery, api: Api, args: ComponentAlignmentArgs, key: string) {
  if (api.root.getPluginData(key) !== recovery.receiptText) fail('SOURCE_CHANGED', { stage: 'alignment-recovery-receipt' });
  if (p.target.getPluginDataKeys().some(k => k.startsWith(`${prefix}${args.operationId}-`))) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Recovery cannot adopt existing result chunks' });
  if (Object.keys(p.target.componentPropertyDefinitions).length) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Recovery target schema must be empty' });
  const propertyIds = new Set<string>();
  for (const prior of recovery.previousFailures) {
    if ('chunks' in prior || !Array.isArray(prior.createdPropertyIds) || prior.createdPropertyIds.some((id: unknown) => typeof id !== 'string')) fail('OPERATION_INCOMPLETE', { reason: 'Invalid prior created property list or prior result chunks' });
    prior.createdPropertyIds.forEach((id: string) => propertyIds.add(id));
  }
  let count = 0;
  for (const root of [p.target, ...p.targetInstances]) for (const node of indexNodes(root).values()) {
    if (++count > 4000) fail('LIMIT_EXCEEDED', { stage: 'alignment-recovery-property-audit' });
    const references = Object.values(obj(node).componentPropertyReferences ?? {}), properties = Object.keys(obj(node).componentProperties ?? {});
    for (const id of propertyIds) if (references.includes(id) || properties.includes(id)) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, nodeId: node.id, propertyId: id, reason: 'Prior created property remains referenced or adopted' });
  }
  for (const binding of p.plan.properties.filter(pr => pr.type === 'SLOT')) for (const id of binding.targetNodeIds) if (p.targets.get(id)?.type !== 'FRAME') fail('OPERATION_INCOMPLETE', { nodeId: id, reason: 'Recovery requires original unconverted FRAME slot candidates' });
}
function assertNoOtherIncomplete(api: Api, targetComponentId: string, currentKey: string) {
  const keys = api.root.getPluginDataKeys().filter(k => k.startsWith(prefix) && k !== currentKey);
  if (keys.length > 200) fail('LIMIT_EXCEEDED', { stage: 'alignment-receipt-registry', max: 200 });
  let totalBytes = 0;
  for (const key of keys) {
    const text = api.root.getPluginData(key); totalBytes += utf8Length(text);
    if (utf8Length(text) > 90_000 || totalBytes > maxInternalState) fail('LIMIT_EXCEEDED', { stage: 'alignment-receipt-registry', maxBytes: maxInternalState });
    let receipt: Obj;
    try { receipt = JSON.parse(text); } catch { fail('OPERATION_INCOMPLETE', { receiptKey: key, reason: 'Corrupt alignment receipt prevents safe target ownership check' }); }
    if (!receipt || receipt.version !== 1 || typeof receipt.targetComponentId !== 'string' || typeof receipt.request !== 'string' || !['pending', 'incomplete', 'applied'].includes(receipt.status)) fail('OPERATION_INCOMPLETE', { receiptKey: key, reason: 'Invalid alignment receipt prevents safe target ownership check' });
    if (receipt.targetComponentId === targetComponentId && receipt.status !== 'applied') fail('OPERATION_INCOMPLETE', { operationId: key.slice(prefix.length), targetComponentId, reason: 'Another incomplete alignment operation reserves this target; reuse its exact operation ID' });
  }
}

/** Adds schema and binds existing owned layers. Never creates, deletes,
 * reparents, swaps or detaches any scene node. Native FRAME->SLOT may not have a
 * safe inverse; failures remain durably incomplete, with exact progress. */
export async function alignComponent(api: Api, input: unknown): Promise<ComponentAlignmentResult> {
  const args = componentAlignmentSchema.parse(input), req = request(args), key = `${prefix}${args.operationId}`;
  const existing = await replay(api, args, key, req); if (existing && !('kind' in existing)) return existing;
  const recovery = existing;
  assertNoOtherIncomplete(api, args.targetComponentId, key);
  receiptPreflight(args, req, recovery);
  // Lost document receipt must never treat target-owned chunks as a new run.
  const initialTarget = await api.getNodeByIdAsync(args.targetComponentId);
  if (initialTarget?.getPluginDataKeys().some(k => k.startsWith(`${prefix}${args.operationId}-`))) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, reason: 'Target chunks exist without document receipt' });
  const p = await prepare(args, api);
  if (recovery) validateRecovery(p, recovery, api, args, key);
  const beforeGraph = await capture(p, api), state = recovery ? recoveryState(req, beforeGraph, recovery) : previewState(req, beforeGraph);
  assertNoOtherIncomplete(api, args.targetComponentId, key);
  if (recovery) validateRecovery(p, recovery, api, args, key);
  if (stable(plan(p.source, p.target, args, api)) !== stable(p.plan)) fail('SOURCE_CHANGED', { stage: 'alignment-preview-plan' });
  const preview = result(p, args);
  if (args.dryRun) return bounded({ ...preview, expectedState: state, ...(recovery ? { recovery: { requiresApproval: true as const, cause: recovery.receipt.failure, completedSteps: clone(recovery.receipt.completedSteps), remainingSteps: clone(recovery.receipt.remainingSteps), cleanupErrors: clone(recovery.receipt.cleanupErrors), attempt: recovery.attempt } } : {}) }, 'alignment-preview-result', 524_288);
  if (state !== args.expectedState) fail('SOURCE_CHANGED', { stage: 'alignment-apply' });
  // Fail before writes for mixed paints or unsupported typography setter.
  for (const f of p.plan.fields.filter(f => f.field === 'typography' || f.field === 'characters')) {
    const n = p.targets.get(f.targetNodeId)! as TextNode;
    if (n.fills === api.mixed || n.fillStyleId === api.mixed || (f.field === 'typography' && typeof n.setTextStyleIdAsync !== 'function')) fail('PRESERVATION_UNSUPPORTED', { nodeId: n.id, reason: 'Uniform text paints and async style API required' });
  }
  await fonts(p, api);
  if (await capture(p, api) !== beforeGraph) fail('SOURCE_CHANGED', { stage: 'alignment-after-fonts' });
  assertNoOtherIncomplete(api, args.targetComponentId, key);
  if (recovery) validateRecovery(p, recovery, api, args, key);
  const before = tree(p.target, api), sourceBefore = stable(tree(p.source, api));
  const referenceBefore = new Map([...p.targets.values()].map(n => [n.id, clone(obj(n).componentPropertyReferences ?? {})]));
  const instanceBefore = new Map(p.targetInstances.map(n => [n.id, tree(n, api)]));
  const paintBefore = new Map(p.plan.fields.filter(f => f.field === 'typography' || f.field === 'characters').map(f => [f.targetNodeId, paintSignature(p.targets.get(f.targetNodeId)! as TextNode)]));
  const sourceContext = stable(context(p.source)), targetContext = stable(context(p.target));
  const createdPropertyIds: string[] = [], changedNodeIds = new Set<string>(), completedSteps: string[] = [], propertyMap: Record<string, string> = {};
  const bindingSteps = (type: 'SLOT' | 'BOOLEAN') => p.plan.properties.filter(pr => pr.type === type).flatMap(pr => pr.targetNodeIds.map(id => `bind:${pr.sourcePropertyId}:${id}`));
  const remainingSteps = [...p.plan.properties.map(pr => `property:${pr.sourcePropertyId}`), ...bindingSteps('SLOT'), ...p.plan.fields.map(f => `field:${f.targetNodeId}:${f.field}`), ...bindingSteps('BOOLEAN')];
  const receipt: Obj = { version: 1, status: 'pending', request: req, targetComponentId: p.target.id, createdPropertyIds, changedNodeIds: [], completedSteps, remainingSteps,
    ...(recovery ? { recoveryAttempt: recovery.attempt, previousFailures: recovery.previousFailures } : {}) };
  const persist = () => { receipt.changedNodeIds = [...changedNodeIds]; api.root.setPluginData(key, bounded(stable(receipt), 'alignment-document-receipt', 90_000)); };
  function done(step: string) { completedSteps.push(step); remainingSteps.splice(remainingSteps.indexOf(step), 1); persist(); }
  const touchedSteps: Array<{ kind: 'field'; node: SceneNode; field: string; before: any; after: any } | { kind: 'reference'; node: SceneNode; before: any; after: any }> = [];
  const sourceUnchanged = () => {
    assertNoOtherIncomplete(api, args.targetComponentId, key);
    if (stable(tree(p.source, api)) !== sourceBefore || stable(context(p.source)) !== sourceContext || stable(context(p.target)) !== targetContext) fail('SOURCE_CHANGED', { stage: 'alignment-write-guard' });
  };
  const bind = (type: 'SLOT' | 'BOOLEAN') => {
    for (const pr of p.plan.properties.filter(pr => pr.type === type)) for (const id of pr.targetNodeIds) {
      sourceUnchanged(); const node = p.targets.get(id)!, previous = obj(node).componentPropertyReferences;
      if (stable(previous ?? {}) !== stable(referenceBefore.get(id))) fail('SOURCE_CHANGED', { nodeId: id, reason: 'Binding references changed during apply' });
      const next = { ...(previous ?? {}), [pr.type === 'BOOLEAN' ? 'visible' : 'slotContentId']: propertyMap[pr.sourcePropertyId] };
      touchedSteps.push({ kind: 'reference', node, before: previous, after: next }); changedNodeIds.add(id); persist();
      obj(node).componentPropertyReferences = next; referenceBefore.set(id, clone(next)); done(`bind:${pr.sourcePropertyId}:${id}`);
    }
  };
  persist();
  try {
    for (const pr of p.plan.properties) {
      sourceUnchanged();
      changedNodeIds.add(p.target.id); persist();
      const id = p.target.addComponentProperty(pr.name, pr.type, pr.defaultValue, pr.options as ComponentPropertyOptions);
      // Record returned ID before any subsequent write/validation.
      createdPropertyIds.push(id); propertyMap[pr.sourcePropertyId] = id; changedNodeIds.add(p.target.id); persist();
      if (!id || id.length > 256 || !p.target.componentPropertyDefinitions[id]) fail('PRESERVATION_FAILED', { sourcePropertyId: pr.sourcePropertyId, reason: 'Native API did not return bounded actual created property' });
      done(`property:${pr.sourcePropertyId}`);
    }
    // Native FRAME -> SLOT may reset child sizing and binding references.
    // Finish conversions first, then requested fields, then visible bindings.
    bind('SLOT');
    for (const f of p.plan.fields) {
      sourceUnchanged(); const node = p.targets.get(f.targetNodeId)!;
      touchedSteps.push({ kind: 'field', node, field: f.field, before: f.before, after: f.after }); changedNodeIds.add(node.id); persist();
      await writeField(node, f.field, f.after);
      sourceUnchanged(); done(`field:${node.id}:${f.field}`);
    }
    bind('BOOLEAN');
    sourceUnchanged(); checkTarget(p, api, before, propertyMap); instancePreservation(p, api, instanceBefore, propertyMap, before);
    // Complete async link and impact readback before receipt can become applied.
    graphPreservation(p, beforeGraph, await capture(p, api));
    const post = await capture(p, api, false);
    graphPreservation(p, beforeGraph, post);
    sourceUnchanged(); checkTarget(p, api, before, propertyMap); instancePreservation(p, api, instanceBefore, propertyMap, before);
    for (const [id, signature] of paintBefore) if (stable(paintSignature(p.targets.get(id)! as TextNode)) !== stable(signature)) fail('PRESERVATION_FAILED', { nodeId: id, reason: 'Text run paints or variable bindings changed' });
    const r = bounded({ ...preview, status: 'applied', propertyMap, changedNodeIds: [...changedNodeIds] } as ComponentAlignmentResult, 'alignment-applied', 524_288);
    receipt.chunks = chunks(p.target, args.operationId, bounded(stable({ stateDigestVersion: 2, stateDigest: resultStateDigest(req, post), result: r }), 'alignment-stored-result', 524_288));
    receipt.status = 'applied'; persist(); return r;
  } catch (error) {
    const cleanupErrors: Array<{ nodeId?: string; propertyId?: string; field?: string; error: string }> = [];
    // Restore only still-owned exact values. Never overwrite an external edit.
    for (const t of [...touchedSteps].reverse()) try {
      if (t.kind === 'reference') {
        if (stable(obj(t.node).componentPropertyReferences) !== stable(t.after)) throw new Error('Reference changed externally; left untouched');
        obj(t.node).componentPropertyReferences = t.before ?? {};
      } else {
        const current = t.field === 'typography' ? typography(t.node, api) : obj(t.node)[t.field];
        if (stable(current) !== stable(t.after)) throw new Error('Field changed externally or write incomplete; left untouched');
        await writeField(t.node, t.field, t.before);
      }
    } catch (e) { cleanupErrors.push({ nodeId: t.node.id, field: t.kind === 'field' ? t.field : 'componentPropertyReferences', error: describeError(e) }); }
    for (const id of [...createdPropertyIds].reverse()) try {
      const pr = p.plan.properties.find(pr => propertyMap[pr.sourcePropertyId] === id)!;
      const expected = { type: pr.type, defaultValue: pr.defaultValue, ...pr.options };
      if (stable(schemaValue({ [id]: p.target.componentPropertyDefinitions[id] }, api)) !== stable(schemaValue({ [id]: expected }, api))) throw new Error('Created property changed externally; left untouched');
      // Deleting a property natively clears its references and instance values.
      // Once another edit adopts it, this operation no longer owns deletion.
      const liveInstances = await instances(p.target);
      let scanned = 0;
      for (const root of [p.target, ...liveInstances]) for (const node of indexNodes(root).values()) {
        if (++scanned > 4000) throw new Error('Property ownership scan exceeds limit; left untouched');
        const refs = obj(node).componentPropertyReferences ?? {};
        if (Object.values(refs).includes(id)) throw new Error(`Property still referenced by ${node.id}; left untouched`);
      }
      for (const instance of liveInstances) {
        const value = instance.componentProperties[id];
        if (value && (value.type !== pr.type || (pr.type === 'BOOLEAN' && value.value !== pr.defaultValue))) throw new Error(`Property adopted by custom instance value on ${instance.id}; left untouched`);
      }
      p.target.deleteComponentProperty(id);
    } catch (e) { cleanupErrors.push({ propertyId: id, error: describeError(e) }); }
    const original = stable(before), restoredTarget = stable(tree(p.target, api));
    let restored = original === restoredTarget;
    if (!restored) cleanupErrors.push({ nodeId: p.target.id, error: 'Original complete target state not restored; FRAME/SLOT inverse or concurrent change remains' });
    for (const instance of p.targetInstances) try {
      const a = instanceBefore.get(instance.id)!, b = tree(instance, api);
      if (stable(a) !== stable(b)) {
        restored = false;
        const aa = snapshotIndex(a.tree), bb = snapshotIndex(b.tree);
        for (const id of new Set([...aa.keys(), ...bb.keys()])) {
          const old = aa.get(id), current = bb.get(id);
          const shallow = (n: NodeSnapshot | undefined) => n ? { ...n, children: n.children.map(c => c.id) } : null;
          if (stable(shallow(old)) !== stable(shallow(current))) changedNodeIds.add(id);
        }
        cleanupErrors.push({ nodeId: instance.id, error: 'Existing instance custom content, fields or overrides were not restored; left untouched' });
      }
    } catch (e) { restored = false; changedNodeIds.add(instance.id); cleanupErrors.push({ nodeId: instance.id, error: describeError(e) }); }
    try { graphPreservation(p, beforeGraph, await capture(p, api, false)); }
    catch (e) { restored = false; cleanupErrors.push({ error: `Rollback main-link/impact audit failed: ${describeError(e)}` }); }
    receipt.status = 'incomplete'; receipt.cleanupErrors = cleanupErrors; receipt.failure = describeError(error);
    try { persist(); } catch (e) { cleanupErrors.push({ error: `Receipt update failed: ${describeError(e)}` }); }
    fail(cleanupErrors.length ? 'ROLLBACK_INCOMPLETE' : 'PARTIAL_APPLY', { operationId: args.operationId, cause: describeError(error), createdPropertyIds,
      changedNodeIds: [...changedNodeIds], completedSteps, remainingSteps, cleanupErrors, restored });
  }
}
