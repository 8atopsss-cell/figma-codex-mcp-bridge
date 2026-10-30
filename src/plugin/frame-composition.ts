import { frameCompositionSchema, type FrameCompositionArgs, type FrameCompositionResult } from '../shared/frame-composition.js';
import { fail, indexNodes, isInDocument, snapshot, stable, jsonValue, utf8Length, VariantError } from './variant-state.js';
import { snapshotDigest } from './snapshot-digest.js';
type Api = Pick<PluginAPI, 'root' | 'mixed' | 'getNodeByIdAsync' | 'getStyleByIdAsync' | 'loadFontAsync' | 'createFrame' | 'createText'> & { fileKey?: string };
type Mapping = FrameCompositionArgs['componentMappings'][number];
type AnyNode = SceneNode & Record<string, unknown>;
const MAX = 500, PREFIX = 'codex-compose-v1-', OWNER = 'codex-compose-owner-v1';
const visual = ['visible', 'locked', 'opacity', 'blendMode', 'rotation', 'fills', 'strokes', 'strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern', 'effects', 'cornerRadius', 'cornerSmoothing', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'clipsContent', 'isMask', 'maskType'] as const;
const textFields = ['fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'textCase', 'textDecoration', 'textAlignHorizontal', 'textAlignVertical', 'paragraphIndent', 'paragraphSpacing', 'hangingPunctuation', 'hangingList', 'textAutoResize', 'textTruncation', 'maxLines', 'hyperlink'] as const;
const styleFields = ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId'] as const;
function bounded(value: unknown) { const raw = stable(value); if (utf8Length(raw) > 2097152) fail('LIMIT_EXCEEDED', { stage: 'compose-state', limit: 2097152 }); return raw; }
function hash(value: unknown) { return snapshotDigest(bounded(value)); }
function tree(node: SceneNode) { const map = indexNodes(node); if (map.size > MAX) fail('LIMIT_EXCEEDED', { stage: 'compose-tree', nodeId: node.id, limit: MAX }); return map; }
function privateMetadata(n: SceneNode) { const v = n as SceneNode & { getPluginDataKeys?: () => string[] }; const keys = v.getPluginDataKeys?.() ?? [OWNER].filter(k => n.getPluginData(k)); if (keys.length > 64) fail('LIMIT_EXCEEDED', { stage: 'compose-metadata', nodeId: n.id }); return Object.fromEntries(keys.sort().map(k => [k, n.getPluginData(k)])); }
function rootState(n: SceneNode, api: Api) { return { tree: snapshot(n, api.mixed), schema: schemaState(n), metadata: [...tree(n).values()].map(v => [v.id, privateMetadata(v)]), parentId: n.parent?.id, mainSchemaParent: n.type === 'COMPONENT' && n.parent?.type === 'COMPONENT_SET' ? { id: n.parent.id, name: n.parent.name, children: n.parent.children.map(v => v.id), definitions: n.parent.componentPropertyDefinitions } : undefined }; }
function mixedAggregate(n: SceneNode, key: string, api: Api) { const a = n as unknown as Record<string, unknown>, fields = key === 'strokeWeight' ? ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'] : key === 'cornerRadius' ? ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'] : []; return a[key] === api.mixed && fields.length === 4 && fields.every(k => typeof a[k] === 'number' && Number.isFinite(a[k])); }
function children(n: SceneNode): readonly SceneNode[] { return 'children' in n ? n.children : []; }
function siblings(parent: PageNode | FrameNode, owned: Set<string>) { return parent.children.filter(n => !owned.has(n.id)).map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, visible: n.visible })); }
function defs(main: ComponentNode) { return main.parent?.type === 'COMPONENT_SET' ? main.parent.componentPropertyDefinitions : main.componentPropertyDefinitions; }
function schemaState(n: SceneNode) { return n.type === 'COMPONENT' ? { definitions: defs(n), variantProperties: n.variantProperties, parentId: n.parent?.id } : undefined; }
function request(args: FrameCompositionArgs) { const { dryRun: _dry, expectedState: _state, ...v } = args; return hash(v); }
function context(source: SceneNode) {
  const p = source.parent;
  if (!p || (p.type !== 'PAGE' && p.type !== 'FRAME') || (p.type === 'FRAME' && p.layoutMode !== 'NONE')) fail('UNSUPPORTED_NODE', { reason: 'Source requires PAGE or free FRAME parent' });
  let n: BaseNode | null = p; while (n) { if (['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(n.type)) fail('UNSUPPORTED_NODE', { ancestorId: n.id }); n = n.parent; }
  if (!isInDocument(source)) fail('SOURCE_CHANGED', { reason: 'Source outside document' }); return p;
}
async function node(api: Api, id: string): Promise<SceneNode> {
  const n = await api.getNodeByIdAsync(id); if (!n || n.type === 'DOCUMENT' || n.type === 'PAGE' || !isInDocument(n)) fail('SOURCE_CHANGED', { nodeId: id, reason: 'Missing attached scene node' }); return n;
}
interface Prepared { source: SceneNode; parent: PageNode | FrameNode; sourceNodes: Map<string, SceneNode>; mappings: Map<string, Mapping>; targets: Map<string, ComponentNode>; mains: Map<string, ComponentNode>; fonts: FontName[]; seal: string; styles: Map<string, BaseStyle>; graphRoots: SceneNode[]; guard?: () => void }
function styleState(s: BaseStyle, api: Api) {
  const a = s as unknown as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const k of ['id', 'type', 'name', 'description', 'paints', 'effects', 'fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'paragraphIndent', 'paragraphSpacing', 'textCase', 'textDecoration', 'boundVariables']) if (k in a) out[k] = jsonValue(a[k], api.mixed); return out;
}
async function capture(api: Api, args: FrameCompositionArgs, p: Prepared, owned = new Set<string>()) {
  const records: unknown[] = [], guards: Array<{ node: SceneNode; state: string }> = [], instanceGuards: Array<{ node: InstanceNode; mainId: string }> = [], links: Record<string, string> = {}, seen = new Set<string>(), queue = [...p.graphRoots]; let total = 0;
  for (const root of queue) {
    if (seen.has(root.id)) continue; seen.add(root.id); if (!isInDocument(root)) fail('SOURCE_CHANGED', { nodeId: root.id });
    const nodes = tree(root); total += nodes.size; if (total > 4000) fail('LIMIT_EXCEEDED', { stage: 'compose-graph' });
    const state = rootState(root, api); records.push(state); guards.push({ node: root, state: stable(state) });
    for (const n of nodes.values()) if (n.type === 'INSTANCE') { const m = await n.getMainComponentAsync(); if (!m || m.remote || !isInDocument(m)) fail('SOURCE_CHANGED', { nodeId: n.id, reason: 'Attached local main required' }); links[n.id] = m.id; instanceGuards.push({ node: n, mainId: m.id }); queue.push(m); }
  }
  const styles: unknown[] = [], styleGuards: Array<{ style: BaseStyle; state: string }> = []; for (const [id] of p.styles) { const s = await api.getStyleByIdAsync(id); if (!s) fail('SOURCE_CHANGED', { styleId: id }); const state = styleState(s, api); styles.push(state); styleGuards.push({ style: s, state: stable(state) }); }
  const ancestors: unknown[] = []; let a: BaseNode | null = p.parent;
  while (a && a.type !== 'DOCUMENT') { ancestors.push(a.type === 'PAGE' ? { id: a.id, name: a.name, parentId: a.parent?.id } : { tree: snapshot(a as SceneNode, api.mixed, false), parentId: a.parent?.id }); a = a.parent; }
  if (context(p.source) !== p.parent) fail('SOURCE_CHANGED', { reason: 'Source parent changed' });
  for (const g of instanceGuards) if ((await g.node.getMainComponentAsync())?.id !== g.mainId) fail('SOURCE_CHANGED', { nodeId: g.node.id, stage: 'compose-main-recheck' });
  for (const g of guards) if (stable(rootState(g.node, api)) !== g.state) fail('SOURCE_CHANGED', { nodeId: g.node.id, stage: 'compose-final-capture' });
  for (const g of styleGuards) if (stable(styleState(g.style, api)) !== g.state) fail('SOURCE_CHANGED', { styleId: g.style.id, stage: 'compose-style-recheck' });
  const membership = siblings(p.parent, owned);
  p.guard = () => {
    if (context(p.source) !== p.parent || stable(siblings(p.parent, owned)) !== stable(membership)) fail('SOURCE_CHANGED', { stage: 'compose-final-membership' });
    for (const g of guards) if (stable(rootState(g.node, api)) !== g.state) fail('SOURCE_CHANGED', { nodeId: g.node.id, stage: 'compose-final-guard' });
    for (const g of styleGuards) if (stable(styleState(g.style, api)) !== g.state) fail('SOURCE_CHANGED', { styleId: g.style.id, stage: 'compose-final-style' });
    const currentAncestors: unknown[] = []; let parent: BaseNode | null = p.parent;
    while (parent && parent.type !== 'DOCUMENT') { currentAncestors.push(parent.type === 'PAGE' ? { id: parent.id, name: parent.name, parentId: parent.parent?.id } : { tree: snapshot(parent as SceneNode, api.mixed, false), parentId: parent.parent?.id }); parent = parent.parent; }
    if (stable(currentAncestors) !== stable(ancestors)) fail('SOURCE_CHANGED', { stage: 'compose-final-parent' });
  };
  p.guard();
  return `compose-v1:sha256:${hash({ request: request(args), fileName: api.root.name, fileKey: api.fileKey, documentId: api.root.id, records, links, styles, ancestors, siblings: membership })}`;
}
function assertText(n: SceneNode, api: Api, fonts: Map<string, FontName>) {
  if (n.type !== 'TEXT') return;
  for (const k of [...textFields, ...styleFields, 'fills', 'strokes']) if ((n as unknown as Record<string, unknown>)[k] === api.mixed) fail('TRANSFER_UNSUPPORTED', { nodeId: n.id, field: k, reason: 'Mixed text formatting unsupported' });
  const seg = n.getStyledTextSegments(['fontName', 'fontSize', 'textStyleId', 'fillStyleId', 'fills', 'hyperlink', 'openTypeFeatures']);
  if (seg.length > 1) fail('TRANSFER_UNSUPPORTED', { nodeId: n.id, reason: 'Mixed text segments unsupported' });
  for (const f of n.getRangeAllFontNames(0, n.characters.length)) fonts.set(stable(f), f); if (n.fontName !== api.mixed) fonts.set(stable(n.fontName), n.fontName);
}
function automaticMap(s: InstanceNode, main: ComponentNode) {
  const map: Record<string, string> = {};
  function visit(a: SceneNode, b: SceneNode) { const aa = children(a), bb = children(b); if (aa.length !== bb.length) fail('TRANSFER_UNSUPPORTED', { nodeId: a.id, reason: 'Same-main custom topology differs' }); for (let i = 0; i < aa.length; i++) { if (aa[i].type !== bb[i].type || !aa[i].id.endsWith(`;${bb[i].id}`)) fail('TRANSFER_UNSUPPORTED', { nodeId: aa[i].id, reason: 'Native main lineage required for implicit icon preservation' }); map[aa[i].id] = bb[i].id; if (aa[i].type !== 'INSTANCE') visit(aa[i], bb[i]); } }
  visit(s, main); return map;
}
async function prepare(api: Api, args: FrameCompositionArgs): Promise<Prepared> {
  const source = await node(api, args.nodeId); if (!['FRAME', 'INSTANCE'].includes(source.type)) fail('UNSUPPORTED_NODE', { nodeId: source.id });
  const parent = context(source), sourceNodes = tree(source), mappings = new Map<string, Mapping>(), targets = new Map<string, ComponentNode>(), mains = new Map<string, ComponentNode>(), styles = new Map<string, BaseStyle>();
  const frames = new Set(args.frameNodeIds), used = new Set<string>(), fontNames = new Map<string, FontName>();
  if (frames.size !== args.frameNodeIds.length) fail('INVALID_ARGUMENT', { reason: 'Duplicate frame fallback' });
  for (const id of frames) { const n = sourceNodes.get(id); if (!n || n.type !== 'INSTANCE' || n === source) fail('INVALID_ARGUMENT', { nodeId: id, reason: 'frameNodeIds requires descendant INSTANCE' }); }
  for (const m of args.componentMappings) { const n = sourceNodes.get(m.sourceNodeId), target = await node(api, m.targetComponentId); if (!n || n.type !== 'INSTANCE' || n === source || target.type !== 'COMPONENT' || target.remote || mappings.has(n.id) || frames.has(n.id)) fail('INVALID_ARGUMENT', { nodeId: m.sourceNodeId, reason: 'Distinct source INSTANCE and local COMPONENT required' }); mappings.set(n.id, m); targets.set(n.id, target); }
  for (const n of sourceNodes.values()) { assertText(n, api, fontNames); if (n.type === 'INSTANCE') { const main = await n.getMainComponentAsync(); if (!main || main.remote || !isInDocument(main)) fail('SOURCE_CHANGED', { nodeId: n.id }); mains.set(n.id, main); } }
  function propertyMap(s: InstanceNode, main: ComponentNode, map: Record<string, string>, valueMap: Mapping['valueMap'] = {}) {
    const d = defs(main), props = s.componentProperties;
    for (const [k, v] of Object.entries(props)) {
      const to = map[k] ?? (v.type === 'VARIANT' ? k : undefined); if (!to || !d[to] || d[to].type !== v.type) fail('TRANSFER_MAPPING_REQUIRED', { nodeId: s.id, property: k });
      if (!['BOOLEAN', 'TEXT', 'VARIANT'].includes(v.type)) fail('TRANSFER_UNSUPPORTED', { nodeId: s.id, property: k, reason: 'Only text/boolean and exact target variant supported' });
      const expected = valueMap[k]?.[String(v.value)] ?? v.value;
      if (v.type === 'VARIANT' && (!d[to].variantOptions?.includes(String(expected)) || main.variantProperties?.[to] !== expected)) fail('TRANSFER_UNSUPPORTED', { nodeId: s.id, property: k, reason: 'Explicit target master must already match mapped state variant' });
    }
    for (const k of Object.keys(map)) if (!(k in props)) fail('INVALID_ARGUMENT', { nodeId: s.id, property: k, reason: 'Unused property mapping' });
    for (const [k, values] of Object.entries(valueMap)) if (props[k]?.type !== 'VARIANT' || Object.keys(values).length !== 1 || !Object.prototype.hasOwnProperty.call(values, String(props[k].value))) fail('INVALID_ARGUMENT', { nodeId: s.id, property: k, reason: 'valueMap must normalize only the current source VARIANT value' });
  }
  function atomic(s: InstanceNode, target: ComponentNode, mapping?: Mapping) {
    if (mapping) used.add(s.id); const layerMap = mapping?.layerMap ?? automaticMap(s, target);
    propertyMap(s, target, mapping?.propertyMap ?? Object.fromEntries(Object.keys(s.componentProperties).map(k => [k, k])), mapping?.valueMap);
    const tn = tree(target), seen = new Set<string>(), seenSource = new Set<string>();
    const sourceMain = mains.get(s.id)!, originalNodes = tree(sourceMain), originalMap = automaticMap(s, sourceMain);
    for (const [sourceId, mainId] of Object.entries(originalMap)) {
      const a = sourceNodes.get(sourceId)!, b = originalNodes.get(mainId)!;
      if (a.type === 'INSTANCE') continue;
    }
    const visit = (a: SceneNode, b: SceneNode) => {
      if (a !== s) { if (layerMap[a.id] !== b.id || a.type !== b.type || seen.has(b.id)) fail('TRANSFER_MAPPING_REQUIRED', { sourceNodeId: a.id, targetMasterNodeId: b.id, reason: 'Complete exact topology mapping required' }); seen.add(b.id); seenSource.add(a.id);
        if (a.type === 'INSTANCE') { const explicit = mappings.get(a.id); atomic(a, explicit ? targets.get(a.id)! : mains.get(a.id)!, explicit); return; }
        if (a.type === 'SLOT') fail('TRANSFER_UNSUPPORTED', { nodeId: a.id, reason: 'Atomic SLOT unsupported; use approved fallback' }); }
      const aa = children(a), bb = children(b); if (aa.length !== bb.length) fail('TRANSFER_MAPPING_REQUIRED', { nodeId: a.id, reason: 'Child count differs' }); for (let i = 0; i < aa.length; i++) visit(aa[i], bb[i]);
    };
    visit(s, target); for (const id of Object.keys(layerMap)) if (!seenSource.has(id) || !tn.has(layerMap[id])) fail('INVALID_ARGUMENT', { nodeId: id, reason: 'Out-of-scope or unused layer map' });
  }
  function structural(n: SceneNode) {
    if (n !== source && n.type === 'INSTANCE' && !frames.has(n.id)) { const m = mappings.get(n.id); if (!m) fail('TRANSFER_MAPPING_REQUIRED', { nodeId: n.id, reason: 'Explicit light mapping or approved frame fallback required' }); atomic(n, targets.get(n.id)!, m); return; }
    if (!['FRAME', 'SLOT', 'INSTANCE', 'TEXT'].includes(n.type)) fail('TRANSFER_UNSUPPORTED', { nodeId: n.id, type: n.type });
    if (('boundVariables' in n && Object.keys(n.boundVariables ?? {}).length) || ('explicitVariableModes' in n && Object.keys(n.explicitVariableModes ?? {}).length)) fail('TRANSFER_UNSUPPORTED', { nodeId: n.id, reason: 'Structural node variable bindings or explicit modes unsupported' });
    for (const k of visual) if ((n as unknown as Record<string, unknown>)[k] === api.mixed && !mixedAggregate(n, k, api)) fail('TRANSFER_UNSUPPORTED', { nodeId: n.id, field: k }); children(n).forEach(structural);
  }
  structural(source); for (const id of mappings.keys()) if (!used.has(id)) fail('INVALID_ARGUMENT', { nodeId: id, reason: 'Unused component mapping' });
  for (const id of frames) { let n: BaseNode | null = sourceNodes.get(id)!.parent; while (n && n !== source) { if (n.type === 'INSTANCE' && !frames.has(n.id)) fail('INVALID_ARGUMENT', { nodeId: id, reason: 'Fallback hidden inside atomic control' }); n = n.parent; } }
  const styleNodes = new Set<string>();
  for (const assignment of args.layerStyles) { const n = sourceNodes.get(assignment.nodeId); if (!n || styleNodes.has(n.id)) fail('INVALID_ARGUMENT', { nodeId: assignment.nodeId }); styleNodes.add(n.id); for (const key of styleFields) { const id = assignment[key]; if (!id) continue; const s = await api.getStyleByIdAsync(id), type = key === 'textStyleId' ? 'TEXT' : key === 'effectStyleId' ? 'EFFECT' : 'PAINT'; if (!s || s.type !== type || (type === 'TEXT' && n.type !== 'TEXT')) fail('INVALID_STYLE', { styleId: id }); styles.set(id, s); if (s.type === 'TEXT') fontNames.set(stable(s.fontName), s.fontName); } }
  const graphRoots = [source, ...targets.values()], visited = new Set<string>();
  for (const r of graphRoots) { if (visited.has(r.id)) continue; visited.add(r.id); if (visited.size > 500) fail('LIMIT_EXCEEDED', { stage: 'compose-main-closure' }); for (const n of tree(r).values()) if (n.type === 'INSTANCE') { const m = await n.getMainComponentAsync(); if (!m || m.remote || !isInDocument(m)) fail('SOURCE_CHANGED', { nodeId: n.id }); if (!visited.has(m.id)) graphRoots.push(m); } }
  for (const r of graphRoots) for (const n of tree(r).values()) { assertText(n, api, fontNames); for (const key of styleFields) { const id = (n as unknown as Record<string, unknown>)[key]; if (typeof id === 'string' && id) { const s = await api.getStyleByIdAsync(id); if (!s) fail('SOURCE_CHANGED', { styleId: id }); styles.set(id, s); } } }
  const p: Prepared = { source, parent, sourceNodes, mappings, targets, mains, styles, graphRoots, fonts: [...fontNames.values()], seal: '' }; p.seal = await capture(api, args, p); return p;
}
interface Receipt { version: 1; requestHash: string; status: 'pending' | 'applied' | 'partial'; expectedState: string; parentId: string; rootId?: string; chunks: number; chunksHash: string; resultHash?: string; error?: { code: string; message: string }; resumeCount?: number; previousErrors?: Array<{ code: string; message: string }> }
interface Data { nodeMap: Record<string, string>; owned: string[] }
function store(api: Api, key: string, receipt: Receipt, data: Data) {
  const raw = stable(data); if (utf8Length(raw) > 131072) fail('LIMIT_EXCEEDED', { stage: 'compose-receipt' });
  const chunks = Math.ceil(raw.length / 12000); for (let i = 0; i < chunks; i++) api.root.setPluginData(`${key}-${i}`, raw.slice(i * 12000, (i + 1) * 12000)); receipt.chunks = chunks; receipt.chunksHash = hash(raw); api.root.setPluginData(key, stable(receipt));
}
function load(api: Api, key: string, raw: string): { receipt: Receipt; data: Data } {
  try { const receipt = JSON.parse(raw) as Receipt; if (receipt.version !== 1 || !Number.isInteger(receipt.chunks) || receipt.chunks < 1 || receipt.chunks > 12) throw Error('receipt'); const chunks = Array.from({ length: receipt.chunks }, (_, i) => api.root.getPluginData(`${key}-${i}`)).join(''); if (hash(chunks) !== receipt.chunksHash) throw Error('chunks'); const data = JSON.parse(chunks) as Data; if (!Array.isArray(data.owned) || data.owned.length > MAX || typeof data.nodeMap !== 'object' || Object.keys(data.nodeMap).length > MAX) throw Error('data'); return { receipt, data }; } catch { fail('OPERATION_INCOMPLETE', { reason: 'Corrupt receipt; retain owned nodes and inspect operation' }); }
}
async function resultHash(api: Api, root: SceneNode, parentId: string, owner: string) {
  if (root.parent?.id !== parentId || root.getPluginData(OWNER) !== owner || !isInDocument(root)) fail('OPERATION_RESULT_CHANGED', { nodeId: root.id });
  const before = rootState(root, api), links: Record<string, unknown> = {}, guard: Array<{ node: SceneNode; state: string }> = [];
  for (const n of tree(root).values()) if (n.type === 'INSTANCE') { const main = await n.getMainComponentAsync(); const state = main ? rootState(main, api) : null; links[n.id] = state; if (main) guard.push({ node: main, state: stable(state) }); }
  if (stable(rootState(root, api)) !== stable(before) || guard.some(g => stable(rootState(g.node, api)) !== g.state)) fail('OPERATION_RESULT_CHANGED', { nodeId: root.id, stage: 'compose-result-capture' });
  return hash({ parentId, owner, tree: before, links });
}
function copyValue(value: unknown) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
async function stylesOn(target: SceneNode, source: SceneNode, args: FrameCompositionArgs, includeSource: boolean) {
  const assignment = args.layerStyles.find(a => a.nodeId === source.id);
  for (const key of styleFields) { const value = assignment?.[key] ?? (includeSource ? (source as unknown as Record<string, unknown>)[key] : undefined);
    if (typeof value !== 'string' || !value || !(key in target) || (target as unknown as Record<string, unknown>)[key] === value) continue;
    const method = `set${key[0].toUpperCase()}${key.slice(1)}Async`, t = target as unknown as Record<string, unknown>; if (typeof t[method] === 'function') await (t[method] as (id: string) => Promise<void>).call(target, value); else t[key] = value;
  }
}
async function preserveText(s: TextNode, t: TextNode, args: FrameCompositionArgs, structural: boolean) {
  if (structural) await stylesOn(t, s, args, true);
  else { const textStyleId = args.layerStyles.find(v => v.nodeId === s.id)?.textStyleId ?? s.textStyleId; if (typeof textStyleId === 'string' && textStyleId) await stylesOn(t, s, { ...args, layerStyles: [{ nodeId: s.id, textStyleId }] }, false); }
  for (const k of textFields) if (k in s && k in t && stable(t[k]) !== stable(s[k])) (t as unknown as Record<string, unknown>)[k] = copyValue(s[k]);
  if (t.characters !== s.characters) t.characters = s.characters;
}
function nativeVisualWrite(t: SceneNode, action: () => void) {
  try { action(); } catch (error) {
    let ancestor = t.parent; let inherited = false;
    while (ancestor && ancestor.type !== 'PAGE' && ancestor.type !== 'DOCUMENT') { if (ancestor.type === 'INSTANCE') { inherited = true; break; } ancestor = ancestor.parent; }
    // Inherited geometry/path fields are not all overridable in Figma. Retain
    // their native layout; the user performs the visual review of this new copy.
    if (!inherited) throw error;
  }
}
function geometry(s: SceneNode, t: SceneNode) {
  if (!('resize' in t)) fail('TRANSFER_UNSUPPORTED', { nodeId: t.id });
  if (t.width !== s.width || t.height !== s.height) nativeVisualWrite(t, () => t.resize(s.width, s.height));
  if (t.x !== s.x) nativeVisualWrite(t, () => { t.x = s.x; });
  if (t.y !== s.y) nativeVisualWrite(t, () => { t.y = s.y; });
  if ('rotation' in s && 'rotation' in t && t.rotation !== s.rotation) nativeVisualWrite(t, () => { t.rotation = s.rotation; });
}
export async function composeSourceFrame(api: Api, input: unknown): Promise<FrameCompositionResult> {
  const args = frameCompositionSchema.parse(input), key = PREFIX + args.operationId, requestHash = request(args), owner = `${args.operationId}:${requestHash}`, raw = api.root.getPluginData(key);
  let resumed: { receipt: Receipt; data: Data; root: FrameNode; partialHash: string } | undefined;
  if (raw) {
    const { receipt: r, data } = load(api, key, raw); if (r.requestHash !== requestHash) fail('OPERATION_CONFLICT', { operationId: args.operationId });
    const base = { operationId: args.operationId, sourceNodeId: args.nodeId, parentId: r.parentId, expectedState: r.expectedState, nodeId: r.rootId, nodeMap: data.nodeMap };
    if (r.status !== 'applied') {
      const eligible = r.status === 'partial' && !r.resumeCount && r.error?.code === 'FIGMA_API_ERROR'
        && r.error.message === 'in set_x: This property cannot be overridden in an instance: relative-transform';
      if (!eligible) return { ...base, status: 'partial', remainingNodeIds: data.owned, error: r.error ?? { code: 'OPERATION_INCOMPLETE', message: 'Pending owned operation; inspect retained IDs' } };
      const root = r.rootId ? await api.getNodeByIdAsync(r.rootId) : null;
      if (!root || root.type !== 'FRAME') fail('OPERATION_RESULT_CHANGED', { nodeId: r.rootId });
      const nodes = tree(root);
      if (nodes.size !== data.owned.length || data.owned.some(id => !nodes.has(id)) || new Set(data.owned).size !== data.owned.length) fail('OPERATION_RESULT_CHANGED', { reason: 'Partial ownership membership changed' });
      resumed = { receipt: r, data, root, partialHash: await resultHash(api, root, r.parentId, owner) };
    } else {
      const root = r.rootId ? await api.getNodeByIdAsync(r.rootId) : null; if (!root || root.type === 'PAGE' || root.type === 'DOCUMENT' || await resultHash(api, root, r.parentId, owner) !== r.resultHash) fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, nodeId: r.rootId }); return { ...base, status: 'replayed' };
    }
  }
  const sourceKey = `${PREFIX}source-${hash(args.nodeId)}`, previous = api.root.getPluginData(sourceKey);
  if (previous && previous !== key) {
    const priorRaw = api.root.getPluginData(previous);
    if (!priorRaw) fail('OPERATION_INCOMPLETE', { reason: 'Source operation index points to missing receipt' });
    const prior = load(api, previous, priorRaw); if (prior.receipt.status !== 'applied') fail('OPERATION_INCOMPLETE', { operationKey: previous, remainingNodeIds: prior.data.owned, reason: 'New operationId cannot bypass retained partial operation' });
  }
  const p = await prepare(api, args), oldOwned = new Set(resumed?.data.owned ?? []);
  if (resumed) {
    p.seal = await capture(api, args, p, oldOwned);
    if (p.seal !== resumed.receipt.expectedState) fail('SOURCE_CHANGED', { stage: 'compose-resume-source' });
    if (Object.entries(resumed.data.nodeMap).some(([sourceId, resultId]) => !p.sourceNodes.has(sourceId) || !oldOwned.has(resultId))) fail('OPERATION_RESULT_CHANGED', { reason: 'Partial node map changed' });
  }
  const expectedState = resumed ? `compose-v1:sha256:${hash({ source: p.seal, partialHash: resumed.partialHash, receipt: raw })}` : p.seal;
  const base = { operationId: args.operationId, sourceNodeId: args.nodeId, parentId: p.parent.id, expectedState, ...(resumed ? { nodeId: resumed.root.id } : {}) };
  if (args.dryRun) return { ...base, status: 'preview' }; if (expectedState !== args.expectedState) fail('SOURCE_CHANGED', { stage: 'compose-preview' });
  for (const font of p.fonts) await api.loadFontAsync(font); if (await capture(api, args, p, oldOwned) !== p.seal) fail('SOURCE_CHANGED', { stage: 'compose-after-fonts' });
  if (resumed && (api.root.getPluginData(key) !== raw || await resultHash(api, resumed.root, p.parent.id, owner) !== resumed.partialHash)) fail('OPERATION_RESULT_CHANGED', { stage: 'compose-resume-after-fonts' });
  const data: Data = resumed ? resumed.data : { nodeMap: {}, owned: [] }, owned = new Set<string>(data.owned), ownedNodes = resumed ? tree(resumed.root) : new Map<string, SceneNode>();
  const receipt: Receipt = resumed ? { ...resumed.receipt, status: 'pending', resumeCount: 1, previousErrors: [...(resumed.receipt.previousErrors ?? []), resumed.receipt.error!], error: undefined }
    : { version: 1, requestHash, status: 'pending', expectedState: p.seal, parentId: p.parent.id, chunks: 0, chunksHash: '' };
  store(api, key, receipt, data); api.root.setPluginData(sourceKey, key); let root: FrameNode | undefined = resumed?.root;
  const refreshOwned = () => { for (const [id, n] of ownedNodes) if (n.removed) { ownedNodes.delete(id); owned.delete(id); } data.owned = [...ownedNodes.keys()]; };
  const remember = (n: SceneNode) => { refreshOwned(); for (const c of tree(n).values()) if (!owned.has(c.id)) { owned.add(c.id); ownedNodes.set(c.id, c); } data.owned = [...ownedNodes.keys()]; store(api, key, receipt, data); if (owned.size > MAX) fail('LIMIT_EXCEEDED', { stage: 'compose-created' }); };
  const mapInstance = (main: ComponentNode, instance: InstanceNode) => {
    const map = new Map<string, SceneNode>(); function visit(a: SceneNode, b: SceneNode) { if (a.type !== b.type && a !== main) fail('TRANSFER_UNSUPPORTED', { reason: 'Native instance topology differs' }); map.set(a.id, b); if (a !== main && a.type === 'INSTANCE') return; const aa = children(a), bb = children(b); if (aa.length !== bb.length) fail('TRANSFER_UNSUPPORTED', { reason: 'Native instance children differ' }); for (let i = 0; i < aa.length; i++) visit(aa[i], bb[i]); } visit(main, instance); return map;
  };
  const atomic = async (s: InstanceNode, t: InstanceNode, main: ComponentNode, mapping?: Mapping) => {
    const actual = await t.getMainComponentAsync(); if (actual?.id !== main.id) { t.swapComponent(main); remember(t); }
    const lm = mapping?.layerMap ?? automaticMap(s, main), pm = mapping?.propertyMap ?? Object.fromEntries(Object.keys(s.componentProperties).map(k => [k, k]));
    const props = Object.fromEntries(Object.entries(s.componentProperties).filter(([, v]) => v.type === 'TEXT' || v.type === 'BOOLEAN').map(([k, v]) => [pm[k], v.value])); if (Object.keys(props).length) t.setProperties(props);
    const targetNodes = mapInstance(main, t); data.nodeMap[s.id] = t.id; t.name = s.name; geometry(s, t); t.visible = s.visible; t.opacity = s.opacity;
    const visit = async (a: SceneNode) => { const b = targetNodes.get(lm[a.id]); if (!b) fail('TRANSFER_MAPPING_REQUIRED', { nodeId: a.id }); data.nodeMap[a.id] = b.id;
      if (a.type === 'INSTANCE' && b.type === 'INSTANCE') { const m = p.mappings.get(a.id); await atomic(a, b, m ? p.targets.get(a.id)! : p.mains.get(a.id)!, m); return; }
      b.visible = a.visible; if ('opacity' in a && 'opacity' in b) b.opacity = a.opacity;
      // Native instance scaling can change vector paths relative to its master.
      // Carry the observed path to the new vector instead of rejecting the icon.
      if (a.type === 'VECTOR' && b.type === 'VECTOR' && stable(a.vectorPaths) !== stable(b.vectorPaths)) nativeVisualWrite(b, () => { b.vectorPaths = copyValue(a.vectorPaths); });
      if ('effects' in a && 'effects' in b && stable(a.effects) !== stable(b.effects)) nativeVisualWrite(b, () => { b.effects = copyValue(a.effects); });
      if ('dashPattern' in a && 'dashPattern' in b && stable(a.dashPattern) !== stable(b.dashPattern)) nativeVisualWrite(b, () => { b.dashPattern = copyValue(a.dashPattern); });
      if (a.type === 'TEXT' && b.type === 'TEXT') await preserveText(a, b, args, false); await stylesOn(b, a, args, false); for (const c of children(a)) await visit(c);
    }; for (const child of s.children) await visit(child); await stylesOn(t, s, args, false); remember(t);
  };
  async function copyStructural(s: SceneNode, t: FrameNode | TextNode) {
    const a = s as unknown as Record<string, unknown>, b = t as unknown as Record<string, unknown>; for (const k of visual) if (k in a && k in b && a[k] !== api.mixed && stable(a[k]) !== stable(b[k])) b[k] = copyValue(a[k]); if (t.type === 'FRAME') t.layoutMode = 'NONE';
    if (s.type === 'TEXT' && t.type === 'TEXT') await preserveText(s, t, args, true); await stylesOn(t, s, args, true); geometry(s, t);
  }
  const structural = async (s: SceneNode, parent: FrameNode) => {
    const existing = data.nodeMap[s.id] ? ownedNodes.get(data.nodeMap[s.id]) : undefined;
    if (existing && existing.parent?.id !== parent.id) fail('OPERATION_RESULT_CHANGED', { nodeId: existing.id, reason: 'Partial parent changed' });
    const m = p.mappings.get(s.id); if (s.type === 'INSTANCE' && m) {
      if (existing && existing.type !== 'INSTANCE') fail('OPERATION_RESULT_CHANGED', { nodeId: existing.id });
      const t = existing as InstanceNode | undefined ?? p.targets.get(s.id)!.createInstance();
      if (!existing) { remember(t); parent.appendChild(t); } await atomic(s, t, p.targets.get(s.id)!, m); return;
    }
    if (existing && existing.type !== (s.type === 'TEXT' ? 'TEXT' : 'FRAME')) fail('OPERATION_RESULT_CHANGED', { nodeId: existing.id });
    const t = (existing ?? (s.type === 'TEXT' ? api.createText() : api.createFrame())) as TextNode | FrameNode;
    if (!existing) { remember(t); parent.appendChild(t); } data.nodeMap[s.id] = t.id; t.name = s.name; await copyStructural(s, t); if (t.type === 'FRAME') for (const c of children(s)) await structural(c, t);
  };
  try {
    if (!root) { root = api.createFrame(); receipt.rootId = root.id; remember(root); root.setPluginData(OWNER, owner); p.parent.appendChild(root); data.nodeMap[p.source.id] = root.id; }
    await copyStructural(p.source, root); root.name = args.name; root.x = args.position.x; root.y = args.position.y; for (const child of children(p.source)) await structural(child, root);
    refreshOwned(); const resultNodes = tree(root);
    if (resultNodes.size !== ownedNodes.size || [...resultNodes.keys()].some(id => !owned.has(id))) fail('PRESERVATION_FAILED', { reason: 'Created tree contains unowned or detached nodes' });
    // Restore geometry after native content/layout updates. The user performs
    // visual verification; do not turn typography/render differences into a block.
    for (const [sourceId, resultId] of Object.entries(data.nodeMap).reverse()) { const a = p.sourceNodes.get(sourceId)!, b = resultNodes.get(resultId); if (!b) fail('PRESERVATION_FAILED', { sourceNodeId: sourceId, reason: 'Mapped result missing' }); geometry(a, b); }
    root.x = args.position.x; root.y = args.position.y;
    if (await capture(api, args, p, owned) !== p.seal) fail('SOURCE_CHANGED', { stage: 'compose-after-writes' }); receipt.resultHash = await resultHash(api, root, p.parent.id, owner); p.guard?.(); receipt.status = 'applied'; store(api, key, receipt, data);
    return { ...base, status: 'applied', nodeId: root.id, nodeMap: data.nodeMap };
  } catch (e) { refreshOwned(); receipt.status = 'partial'; receipt.error = { code: e instanceof VariantError ? e.code : 'FIGMA_API_ERROR', message: String(e instanceof Error ? e.message : e).slice(0, 1000) }; store(api, key, receipt, data); return { ...base, status: 'partial', nodeId: root?.id, nodeMap: data.nodeMap, remainingNodeIds: data.owned, error: receipt.error }; }
}
