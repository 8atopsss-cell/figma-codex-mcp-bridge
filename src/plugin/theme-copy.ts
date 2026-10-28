import { themeCopySchema, type ThemeCopyArgs, type ThemeCopyInventory, type ThemeCopyResult } from '../shared/theme-copy.js';
import type { ThemePlan } from '../shared/theme-conversion.js';
import { planThemeConversion } from './theme-plan.js';
import { boundedResult, collectComponents, describeComponent } from './component-catalog.js';
import { readThemeSource, sourceStamp } from './theme-source.js';
import { readFileKey } from './file-identity.js';
import { describeError } from './errors.js';
import { fail, indexNodes, isInDocument, jsonValue, snapshot, stable, utf8Length, VariantError } from './variant-state.js';

type Api = Pick<typeof figma, 'root' | 'mixed' | 'getNodeByIdAsync' | 'loadFontAsync'> & { fileKey?: string };
type Parent = PageNode | FrameNode;
const prefix = 'theme-copy-v1-';
const layoutFields = ['rotation', 'constraints', 'layoutMode', 'layoutWrap', 'itemSpacing', 'counterAxisSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'primaryAxisSizingMode', 'counterAxisSizingMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent', 'strokesIncludedInLayout',
  'layoutGrow', 'layoutAlign', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'gridRowCount', 'gridColumnCount', 'gridRowGap', 'gridColumnGap'] as const;
const geometryFields = ['x', 'y', 'width', 'height', ...layoutFields] as const;
type Transfer = { source: SceneNode; target: SceneNode; kind: 'layer' | 'slot' | 'instance' };
interface Prepared {
  source: InstanceNode; target: ComponentNode; parent: Parent; page: PageNode; document: DocumentNode;
  args: ThemeCopyArgs; request: string; plan: ThemePlan; transfers: Transfer[]; expectedState: string;
  preservationRestores: ThemeCopyResult['preservationRestores'];
  guard?: () => void;
  linkSeal?: Array<{ node: InstanceNode; mainId: string | null }>;
}
function requestKey(args: ThemeCopyArgs) { const { dryRun: _dry, expectedState: _state, ...request } = args; return stable(request); }
function context(source: InstanceNode) {
  const parent = source.parent;
  if (!parent || (parent.type !== 'PAGE' && parent.type !== 'FRAME') || (parent.type === 'FRAME' && parent.layoutMode !== 'NONE')) {
    fail('UNSUPPORTED_NODE', { nodeId: source.id, reason: 'Requires page or free-layout FRAME parent' });
  }
  let current: BaseNode | null = parent, page: PageNode | undefined;
  while (current) {
    if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(current.type)) fail('UNSUPPORTED_NODE', { nodeId: source.id, ancestorId: current.id });
    if (current.type === 'PAGE') page = current;
    if (current.type === 'DOCUMENT' && page && isInDocument(source)) return { parent, page, document: current };
    current = current.parent;
  }
  fail('UNSUPPORTED_NODE', { nodeId: source.id, reason: 'Source outside document' });
}
function fullTree(node: SceneNode, api: Api, descend = true) {
  const tree = snapshot(node, api.mixed, descend), nodes = descend ? indexNodes(node) : new Map([[node.id, node]]);
  const extra = [...nodes.values()].map(n => {
    const value = n as unknown as Record<string, unknown>;
    return { id: n.id, parentId: n.parent?.id, overrides: jsonValue(value.overrides, api.mixed),
      scaleFactor: jsonValue(value.scaleFactor, api.mixed), isExposedInstance: jsonValue(value.isExposedInstance, api.mixed),
      limitViolations: jsonValue(value.limitViolations, api.mixed), slotSettings: jsonValue(value.slotSettings, api.mixed) };
  });
  return { tree, extra };
}
async function graph(roots: SceneNode[], api: Api) {
  const records = new Map<string, { node: SceneNode; state: string; shallow: boolean }>();
  const links: Record<string, string | null> = {};
  const instances = new Map<string, InstanceNode>();
  function record(node: SceneNode, shallow = false) {
    if (records.has(node.id)) return;
    if (records.size >= 2000) fail('LIMIT_EXCEEDED', { stage: 'theme-copy-graph' });
    const schema = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' ? describeComponent(node, api.mixed) : undefined;
    records.set(node.id, { node, shallow, state: stable({ ...fullTree(node, api, !shallow), ...(schema ? { schema } : {}) }) });
  }
  roots.forEach(node => record(node));
  for (const { node, shallow } of records.values()) {
    for (const instance of (shallow ? [node] : [...indexNodes(node).values()]).filter((n): n is InstanceNode => n.type === 'INSTANCE')) {
      if (Object.prototype.hasOwnProperty.call(links, instance.id)) continue;
      instances.set(instance.id, instance);
      const main = await instance.getMainComponentAsync(); links[instance.id] = main?.id ?? null;
      if (!main || main.removed || (!main.remote && !isInDocument(main))) fail('SOURCE_CHANGED', { stage: 'theme-copy-link', nodeId: instance.id });
      record(main);
      if (main.parent?.type === 'COMPONENT_SET') record(main.parent, true);
    }
  }
  function verify() {
    for (const { node, state, shallow } of records.values()) {
      const schema = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' ? describeComponent(node, api.mixed) : undefined;
      if (state !== stable({ ...fullTree(node, api, !shallow), ...(schema ? { schema } : {}) })) fail('SOURCE_CHANGED', { stage: 'theme-copy-capture', nodeId: node.id });
    }
  }
  verify();
  return { records: Object.fromEntries([...records].map(([id, r]) => [id, JSON.parse(r.state)])), links, verify, instances };
}
function environment(p: Prepared, api: Api, created: Set<string>) {
  const ancestors: unknown[] = []; let node: BaseNode | null = p.parent;
  while (node && node.type !== 'DOCUMENT') {
    ancestors.push(node.type === 'PAGE' ? { id: node.id, type: node.type, name: node.name } : snapshot(node as SceneNode, api.mixed, false)); node = node.parent;
  }
  return stable({ request: p.request, fileName: api.root.name, fileKey: readFileKey(api), parentId: p.source.parent?.id, ancestors,
    children: p.parent.children.filter(n => !created.has(n.id)).map(n => n.id) });
}
async function capture(p: Prepared, api: Api, created = new Set<string>()) {
  if (p.source.parent !== p.parent || !isInDocument(p.source) || p.target.removed || (!p.target.remote && !isInDocument(p.target))) fail('SOURCE_CHANGED', { stage: 'theme-copy-context' });
  const env = environment(p, api, created), { verify, instances, ...state } = await graph([p.source, p.target], api);
  const catalog = await collectComponents(api, p.args.libraryRootIds, p.args.scanLimit);
  if (env !== environment(p, api, created) || catalog.scopeSnapshot !== p.plan.scopeSnapshot || sourceStamp(p.source, api.mixed) !== p.plan.sourceSnapshot) fail('SOURCE_CHANGED', { stage: 'theme-copy-capture' });
  verify();
  p.guard = () => { verify(); if (env !== environment(p, api, created)) fail('SOURCE_CHANGED', { stage: 'theme-copy-final-environment' }); };
  p.linkSeal = [...instances.values()].map(node => ({ node, mainId: state.links[node.id] }));
  const value = stable({ environment: env, graph: state, scope: catalog.scopeSnapshot });
  if (utf8Length(value) > 262_144) fail('LIMIT_EXCEEDED', { stage: 'theme-copy-preview', reason: 'State exceeds 256 KiB; narrow source and scope' });
  return value;
}
async function unchanged(p: Prepared, api: Api, created: Set<string>) {
  if (await capture(p, api, created) !== p.expectedState) fail('SOURCE_CHANGED', { stage: 'theme-copy-apply' });
}
function transfers(source: InstanceNode, target: ComponentNode, args: ThemeCopyArgs): Transfer[] {
  const sourceNodes = indexNodes(source), targetNodes = indexNodes(target), result: Transfer[] = [], used = new Set<string>();
  const supported = new Set(['INSTANCE', 'SLOT', 'TEXT', 'FRAME', 'GROUP', 'RECTANGLE', 'VECTOR', 'ELLIPSE', 'POLYGON', 'STAR', 'BOOLEAN_OPERATION', 'LINE']);
  for (const node of [...sourceNodes.values(), ...targetNodes.values()]) {
    if (node === target) continue;
    if (!supported.has(node.type)) fail('TRANSFER_UNSUPPORTED', { nodeId: node.id, type: node.type, reason: 'Native node type has no complete preservation snapshot in this version' });
  }
  function visit(node: SceneNode) {
    if (node === source) { source.children.forEach(visit); return; }
    const id = args.layerMap[node.id], other = id ? targetNodes.get(id) : undefined;
    if (!other || other === target || other.type !== node.type) fail('TRANSFER_MAPPING_REQUIRED', { sourceNodeId: node.id, targetMasterNodeId: id, reason: 'Exact compatible target master descendant required' });
    let parent: BaseNode | null = other.parent;
    while (parent && parent !== target) {
      if (parent.type === 'INSTANCE' || parent.type === 'SLOT') fail('TRANSFER_UNSUPPORTED', { sourceNodeId: node.id, targetMasterNodeId: id, reason: 'Target mapping crosses nested instance or SLOT boundary' });
      parent = parent.parent;
    }
    used.add(node.id); result.push({ source: node, target: other, kind: node.type === 'SLOT' ? 'slot' : node.type === 'INSTANCE' ? 'instance' : 'layer' });
    if (node.type !== 'SLOT' && node.type !== 'INSTANCE' && 'children' in node) node.children.forEach(visit);
  }
  visit(source);
  const covered = new Set(result.map(t => t.target.id));
  function targetCoverage(node: SceneNode) {
    if (node !== target && !covered.has(node.id)) fail('TRANSFER_MAPPING_REQUIRED', { targetMasterNodeId: node.id, reason: 'Target contains an unmapped extra layer' });
    if (node !== target && (node.type === 'INSTANCE' || node.type === 'SLOT')) return;
    if ('children' in node) node.children.forEach(targetCoverage);
  }
  targetCoverage(target);
  const targetBySource = new Map(result.map(t => [t.source.id, t.target])); targetBySource.set(source.id, target);
  for (const [sourceId, mapped] of targetBySource) {
    const original = sourceNodes.get(sourceId)!;
    if (original.type === 'SLOT' || (original.type === 'INSTANCE' && original !== source)) continue;
    const aa = 'children' in original ? original.children : [], bb = 'children' in mapped ? mapped.children : [];
    if (stable(aa.map(n => targetBySource.get(n.id)?.id)) !== stable(bb.map(n => n.id))) fail('TRANSFER_MAPPING_REQUIRED', { sourceNodeId: sourceId, targetMasterNodeId: mapped.id, reason: 'Mapped parent topology or sibling order differs' });
  }
  for (const id of Object.keys(args.layerMap)) if (!sourceNodes.has(id) || !used.has(id)) fail('INVALID_ARGUMENT', { sourceNodeId: id, reason: 'Unused or out-of-scope layerMap entry' });
  // Allow only content/visibility and nested component-link overrides. Paint,
  // geometry, text styling and all unknown override fields are unsupported.
  for (const node of sourceNodes.values()) if (node.type === 'INSTANCE') {
    for (const override of node.overrides) {
      if (!sourceNodes.has(override.id)) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: override.id, reason: 'Override ID outside source subtree' });
      const fields = override.overriddenFields.filter(field => !['characters', 'visible', 'componentProperties', 'mainComponent'].includes(field));
      if (fields.length) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: override.id, fields, reason: 'Unsupported paint/geometry/style overrides; no overrides will be erased' });
    }
  }
  for (const transfer of result) {
    if (transfer.kind === 'slot') {
      const src = (transfer.source as unknown as { componentPropertyReferences?: { slotContentId?: string } }).componentPropertyReferences?.slotContentId;
      const dst = (transfer.target as unknown as { componentPropertyReferences?: { slotContentId?: string } }).componentPropertyReferences?.slotContentId;
      if (!src || !dst) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: transfer.source.id, reason: 'SLOT binding unavailable' });
      for (const child of (transfer.source as SlotNode).children) {
        if ([...indexNodes(child).values()].some(n => n.type === 'SLOT')) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: child.id, reason: 'SLOT-containing content subtrees require a separate transfer plan in this version' });
      }
    }
    if (transfer.kind === 'instance' && [...indexNodes(transfer.source).values()].some(n => n.type === 'SLOT')) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: transfer.source.id, reason: 'Custom nested instances containing SLOT require separate transfer plan' });
    if (transfer.source.type === 'TEXT' && transfer.source.fontName === undefined) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: transfer.source.id, reason: 'Text fonts unavailable' });
  }
  return result;
}
function exactCopyMap(source: SceneNode, clone: SceneNode, map: Map<string, SceneNode>, depth = 0) {
  if (map.size >= 2000 || depth > 16) fail('LIMIT_EXCEEDED', { stage: 'theme-copy-clone-map' });
  if (source.type !== clone.type) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: source.id, nodeId: clone.id, reason: 'Clone type mismatch' });
  map.set(source.id, clone);
  const aa = 'children' in source ? source.children : [], bb = 'children' in clone ? clone.children : [];
  if (aa.length !== bb.length) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: source.id, reason: 'Clone child count mismatch' });
  aa.forEach((n, i) => exactCopyMap(n, bb[i], map, depth + 1));
}
function masterDescendant(root: InstanceNode, masterId: string): SceneNode {
  const matches = [...indexNodes(root).values()].filter(n => n !== root && n.id.endsWith(`;${masterId}`));
  if (matches.length !== 1) fail('TRANSFER_VALIDATION_FAILED', { nodeId: root.id, masterNodeId: masterId, reason: 'Target master lineage is missing or ambiguous' });
  return matches[0];
}
function sameGeometry(source: SceneNode, copy: SceneNode, root = false) {
  const a = source as unknown as Record<string, unknown>, b = copy as unknown as Record<string, unknown>;
  for (const field of geometryFields) {
    if (root && (field === 'x' || field === 'y')) continue;
    if (field in a && stable(a[field]) !== stable(b[field])) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: source.id, nodeId: copy.id, field, reason: 'Source layout/dimensions could not be preserved' });
  }
}
function restoreLayout(source: SceneNode, copy: SceneNode, root = false) {
  const a = source as unknown as Record<string, unknown>, b = copy as unknown as Record<string, unknown>;
  if ('resize' in copy && 'width' in source && 'height' in source && (source.width !== copy.width || source.height !== copy.height)) copy.resize(source.width, source.height);
  for (const field of layoutFields) if (field in a && field in b && stable(a[field]) !== stable(b[field])) b[field] = JSON.parse(JSON.stringify(a[field]));
  if (!root && 'x' in a && 'x' in b) { b.x = a.x; b.y = a.y; }
}
function remapIds(value: unknown, reverse: Map<string, string>, field = ''): unknown {
  // IDs in native structural references only. User text, URLs, vector paths,
  // component property strings and style/variable IDs remain literal.
  if (typeof value === 'string') return ['id', 'nodeId', 'destinationId'].includes(field) ? reverse.get(value) ?? value : value;
  if (Array.isArray(value)) return value.map(item => remapIds(item, reverse, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapIds(item, reverse, key)]));
  return value;
}
// Theme defaults may change inherited paints; every such channel is checked
// against exact target master separately. Everything else must survive.
function stripInheritedPaints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInheritedPaints);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['fills', 'strokes', 'fillStyleId', 'strokeStyleId'].includes(key))
    .map(([key, item]) => [key, stripInheritedPaints(item)]));
  return value;
}
function preservationCheck(p: Prepared, api: Api, map: Map<string, SceneNode>) {
  const sourceNodes = indexNodes(p.source), reverse = new Map([...map].map(([id, node]) => [node.id, id]));
  const themed = new Map(p.transfers.map(t => [t.source.id, t]));
  const mapping = p.args.mappings.find(m => m.sourceId === p.plan.steps[0].sourceComponentId) ?? p.args.mappings.find(m => m.sourceId === p.plan.steps[0].sourceSetId);
  const root = map.get(p.source.id)! as InstanceNode;
  for (const [id, value] of Object.entries(p.plan.steps[0].mappedValues ?? {})) if (root.componentProperties[id]?.value !== value) fail('TRANSFER_VALIDATION_FAILED', { nodeId: root.id, propertyId: id, reason: 'Mapped property changed' });
  if (root.parent !== p.parent || root.name !== p.args.name || root.x !== p.args.position.x || root.y !== p.args.position.y || root.scaleFactor !== p.source.scaleFactor || root.visible !== p.source.visible) fail('TRANSFER_VALIDATION_FAILED', { nodeId: root.id, reason: 'Root placement, visibility or scale changed' });
  for (const [id, node] of map) {
    const source = sourceNodes.get(id)!;
    const a = snapshot(source, api.mixed, false), b = snapshot(node, api.mixed, false);
    let expected = a.properties, actual = remapIds(b.properties, reverse) as Record<string, unknown>;
    const transfer = themed.get(id), themeLayer = source === p.source || !!transfer;
    if (themeLayer) {
      if (transfer?.kind !== 'instance') {
        expected = stripInheritedPaints(expected) as Record<string, unknown>;
        actual = stripInheritedPaints(actual) as Record<string, unknown>;
      }
      const refs = expected.componentPropertyReferences;
      if (refs && typeof refs === 'object') expected.componentPropertyReferences = Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, typeof value === 'string' ? mapping?.propertyMap[value] ?? value : value]));
      const master = source === p.source ? p.target : transfer!.target;
      // A custom nested main is restored to ORIGINAL; paint verification then
      // belongs to full exact subtree comparison, rather than light defaults.
      if (transfer?.kind !== 'instance') for (const field of ['fills', 'strokes', 'fillStyleId', 'strokeStyleId'] as const) {
        const av = node as unknown as Record<string, unknown>, mv = master as unknown as Record<string, unknown>;
        if (field in mv && stable(jsonValue(av[field], api.mixed)) !== stable(jsonValue(mv[field], api.mixed))) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, nodeId: node.id, field, reason: 'Result retained a paint override instead of exact target master inheritance' });
      }
      if (transfer?.kind !== 'instance') {
        const current = snapshot(node, api.mixed, false).properties, defaults = snapshot(master, api.mixed, false).properties;
        if (Array.isArray(current.textSegments) && Array.isArray(defaults.textSegments)) {
          const channels = (segment: unknown) => {
            const v = segment as Record<string, unknown>;
            return { fills: v.fills, fillStyleId: v.fillStyleId,
              boundFills: (v.boundVariables as Record<string, unknown> | undefined)?.fills };
          };
          const paints = defaults.textSegments.map(channels);
          // Character counts may change. A uniform master paint is exact for
          // every resulting range; mixed master paint ranges need a richer map.
          if (paints.some(value => stable(value) !== stable(paints[0])) || current.textSegments.some(value => stable(channels(value)) !== stable(paints[0]))) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, reason: 'Text range paint inheritance unsupported or changed' });
        }
        const regions = (value: unknown) => {
          const network = value as { regions?: Array<Record<string, unknown>> } | undefined;
          return network?.regions?.map(region => ({ fills: region.fills, fillStyleId: region.fillStyleId }));
        };
        if (stable(regions(current.vectorNetwork)) !== stable(regions(defaults.vectorNetwork))) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, reason: 'Vector region paint inheritance changed' });
      }
    }
    if (source === p.source) {
      delete expected.componentProperties; delete actual.componentProperties;
      for (const value of [expected, actual]) {
        delete value.x; delete value.y;
        if (Array.isArray(value.relativeTransform)) value.relativeTransform = (value.relativeTransform as number[][]).map(row => row.slice(0, 2));
      }
    }
    if (stable(expected) !== stable(actual)) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, nodeId: node.id, reason: 'Content, text formatting, geometry, bindings or reactions changed' });
    if (source.type === 'TEXT' && (node.type !== 'TEXT' || source.characters !== node.characters)) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, reason: 'Text changed' });
    if (!themeLayer) {
      if (source.name !== node.name || source.type !== node.type) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, reason: 'Preserved subtree identity changed' });
    }
    const originalChildren = 'children' in source ? source.children : [], copiedChildren = 'children' in node ? node.children : [];
    if (stable(originalChildren.map(n => map.get(n.id)?.id)) !== stable(copiedChildren.map(n => n.id))) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: id, reason: 'Preserved child structure/order changed' });
  }
}
async function inventory(api: Api, nodeId: string): Promise<ThemeCopyInventory> {
  const source = await readThemeSource(api, nodeId);
  return { instances: source.instances.map(n => ({ nodeId: n.node.id, ...(n.main ? { mainComponentId: n.main.id } : {}),
    ...(n.parentInstanceId ? { parentInstanceId: n.parentInstanceId } : {}), textNodes: n.texts, slots: n.slots, ...(n.error ? { error: n.error } : {}) })) };
}
function describe(p: Prepared, fresh: ThemeCopyInventory): ThemeCopyResult {
  const pending = p.plan.steps.slice(1).map(step => ({ ...step, provisional: true, requiresReplanAfterParent: true, status: 'pending' as const }));
  return { status: 'preview', operationId: p.args.operationId, sourceNodeId: p.source.id, parentId: p.parent.id,
    name: p.args.name, position: p.args.position, stage: 'parent_only', plan: p.plan, rootStep: p.plan.steps[0], pendingDescendantSteps: pending,
    freshInventory: fresh, followupRequired: fresh.instances.length > 1, preservationRestores: p.preservationRestores,
    remainingEvidence: fresh.instances.length > 1 ? ['This operation handles root theme only. Descendant plans remain provisional; replan using freshInventory node IDs.'] : [] };
}
function parse(raw: string, nodeId: string): any {
  try { return JSON.parse(raw); } catch { fail('OPERATION_RESULT_CHANGED', { nodeId, reason: 'Invalid receipt JSON' }); }
}
// Cross-check chunk integrity against independent document receipt. This is
// accidental-edit detection, not an authentication boundary.
function checksum(value: string) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 0x01000193); b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b); }
  return `${value.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}
function writeChunks(node: InstanceNode, data: unknown) {
  const value = stable(data);
  if (utf8Length(value) > 524_288) fail('LIMIT_EXCEEDED', { stage: 'theme-copy-receipt', reason: 'Result snapshot exceeds 512 KiB' });
  const chars = Array.from(value), count = Math.ceil(chars.length / 20_000);
  for (let i = 0; i < count; i++) node.setPluginData(`${prefix}chunk-${i}`, chars.slice(i * 20_000, (i + 1) * 20_000).join(''));
  node.setPluginData(`${prefix}chunks`, String(count));
  return checksum(value);
}
function readChunks(node: InstanceNode) {
  const count = Number(node.getPluginData(`${prefix}chunks`));
  if (!Number.isInteger(count) || count < 1 || count > 27) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Incomplete copy receipt' });
  let value = '';
  for (let i = 0; i < count; i++) { const chunk = node.getPluginData(`${prefix}chunk-${i}`); if (!chunk) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Missing result chunk' }); value += chunk; }
  if (utf8Length(value) > 524_288) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Oversized result snapshot' });
  return parse(value, node.id);
}
async function resultState(root: InstanceNode, api: Api) {
  const tree = fullTree(root, api), links: Record<string, string | null> = {};
  for (const n of indexNodes(root).values()) if (n.type === 'INSTANCE') links[n.id] = (await n.getMainComponentAsync())?.id ?? null;
  if (stable(tree) !== stable(fullTree(root, api))) fail('SOURCE_CHANGED', { stage: 'theme-copy-result-capture' });
  return stable({ tree, links });
}
async function replay(api: Api, document: DocumentNode, args: ThemeCopyArgs, request: string) {
  const raw = document.getPluginData(`${prefix}${args.operationId}`); if (!raw) return;
  const r = parse(raw, document.id);
  if (!r || typeof r !== 'object' || typeof r.request !== 'string') fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId });
  if (r.request !== request) fail('OPERATION_CONFLICT', { operationId: args.operationId });
  if (r.status !== 'applied') fail(r.status === 'incomplete' ? 'ROLLBACK_INCOMPLETE' : 'OPERATION_INCOMPLETE', { operationId: args.operationId, remainingNodeIds: Array.isArray(r.nodeIds) ? r.nodeIds : [] });
  const root = await api.getNodeByIdAsync(r.nodeId);
  if (!root || root.type !== 'INSTANCE' || root.removed || root.parent?.id !== r.parentId || !isInDocument(root)) fail('OPERATION_RESULT_CHANGED', { nodeId: r.nodeId });
  const record = readChunks(root);
  if (!record || typeof r.recordChecksum !== 'string' || checksum(stable(record)) !== r.recordChecksum || record.request !== request || record.parentId !== r.parentId || record.state !== await resultState(root, api)
    || record.result?.nodeId !== root.id || record.result?.nodeMap?.[args.nodeId] !== root.id) fail('OPERATION_RESULT_CHANGED', { nodeId: root.id });
  return { ...record.result, status: 'replayed' } as ThemeCopyResult;
}
async function write(p: Prepared, api: Api): Promise<ThemeCopyResult> {
  const created = new Map<string, SceneNode>(), map = new Map<string, SceneNode>(), key = `${prefix}${p.args.operationId}`;
  let reserved = false, root: InstanceNode | undefined, recordChecksum: string | undefined;
  function receipt(status: string, resultId?: string) {
    const value = stable({ request: p.request, status, parentId: p.parent.id, nodeIds: [...created.keys()], ...(resultId ? { nodeId: resultId } : {}), ...(recordChecksum ? { recordChecksum } : {}) });
    if (utf8Length(value) > 90_000) fail('LIMIT_EXCEEDED', { stage: 'theme-copy-receipt', reason: 'Operation receipt exceeds 90 KiB' });
    p.document.setPluginData(key, value);
  }
  function track(node: SceneNode) { for (const item of indexNodes(node).values()) created.set(item.id, item); receipt('pending', root?.id); }
  function assertOwned(node: SceneNode) {
    const ids = [...indexNodes(node).values()].filter(n => !created.has(n.id)).map(n => n.id);
    if (ids.length) fail('SOURCE_CHANGED', { stage: 'theme-copy-unowned-content', nodeId: node.id, unownedNodeIds: ids });
  }
  try {
    await unchanged(p, api, new Set());
    const existing = p.document.getPluginData(key);
    if (existing) {
      const previous = parse(existing, p.document.id);
      fail(previous.request !== p.request ? 'OPERATION_CONFLICT' : 'OPERATION_INCOMPLETE', { operationId: p.args.operationId, remainingNodeIds: previous.nodeIds ?? [] });
    }
    receipt('pending'); reserved = true;
    root = p.source.clone(); track(root);
    exactCopyMap(p.source, root, map);
    p.parent.appendChild(root); root.name = p.args.name; root.x = p.args.position.x; root.y = p.args.position.y;
    await unchanged(p, api, new Set(created.keys()));
    // Clone SLOT CONTENT before swap destroys copied source descendants. Never
    // clone SLOT itself: native clone() returns FRAME, losing slot semantics.
    const slotCopies = new Map<string, SceneNode[]>();
    for (const transfer of p.transfers.filter(t => t.kind === 'slot')) {
      const children: SceneNode[] = [];
      for (const child of (transfer.source as SlotNode).children) {
        const originalCopy = map.get(child.id);
        if (!originalCopy) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: child.id });
        const staged = originalCopy.clone(); track(staged); p.parent.appendChild(staged);
        exactCopyMap(child, staged, map); children.push(staged);
      }
      slotCopies.set(transfer.source.id, children);
    }
    assertOwned(root); root.swapComponent(p.target); track(root);
    root.visible = p.source.visible;
    root.setProperties(p.plan.steps[0].mappedValues ?? {}); track(root);
    map.set(p.source.id, root);
    for (const transfer of p.transfers) {
      const target = masterDescendant(root, transfer.target.id); map.set(transfer.source.id, target);
      if (transfer.kind === 'slot') {
        if (target.type !== 'SLOT') fail('TRANSFER_VALIDATION_FAILED', { nodeId: target.id });
        for (const child of [...target.children]) child.remove();
        for (const child of slotCopies.get(transfer.source.id) ?? []) target.appendChild(child);
      } else if (transfer.source.type === 'TEXT' && target.type === 'TEXT') {
        const fonts = target.fontName === api.mixed ? target.getRangeAllFontNames(0, target.characters.length) : [target.fontName];
        for (const font of fonts) { await api.loadFontAsync(font); await unchanged(p, api, new Set(created.keys())); }
        assertOwned(root);
        target.characters = transfer.source.characters;
      } else if (transfer.source.type === 'INSTANCE' && target.type === 'INSTANCE') {
        const sourceMain = await transfer.source.getMainComponentAsync(), copiedMain = await target.getMainComponentAsync();
        if (!sourceMain) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: transfer.source.id, reason: 'Custom nested main unavailable' });
        assertOwned(root);
        if (sourceMain.id !== copiedMain?.id) { target.swapComponent(sourceMain); track(target); }
        const props = Object.fromEntries(Object.entries(transfer.source.componentProperties).filter(([, v]) => v.type !== 'SLOT').map(([id, v]) => [id, v.value]));
        target.setProperties(props); track(target);
        // Explicit master lineage, never inferred names or child indexes.
        const masters = [...indexNodes(sourceMain).values()];
        for (const child of indexNodes(transfer.source).values()) {
          if (child === transfer.source) continue;
          const matches = masters.filter(m => child.id.endsWith(`;${m.id}`));
          if (matches.length !== 1) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: child.id, reason: 'Original nested master lineage ambiguous' });
          const copied = masterDescendant(target, matches[0].id);
          if (child.type !== copied.type) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: child.id, reason: 'Nested type changed' });
          map.set(child.id, copied);
          if (child.type === 'TEXT' && copied.type === 'TEXT') {
            const fonts = copied.fontName === api.mixed ? copied.getRangeAllFontNames(0, copied.characters.length) : [copied.fontName];
            for (const font of fonts) { await api.loadFontAsync(font); await unchanged(p, api, new Set(created.keys())); }
            assertOwned(root);
            copied.characters = child.characters;
          }
          copied.visible = child.visible; restoreLayout(child, copied);
        }
      }
      target.visible = transfer.source.visible; restoreLayout(transfer.source, target);
    }
    restoreLayout(p.source, root, true);
    if (root.scaleFactor !== p.source.scaleFactor) fail('TRANSFER_UNSUPPORTED', { nodeId: root.id, reason: 'Scale factor changed' });
    await unchanged(p, api, new Set(created.keys()));
    for (const [sourceId, target] of map) {
      const source = indexNodes(p.source).get(sourceId)!;
      if (target.removed || !isInDocument(target)) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: sourceId, reason: 'Mapped result removed' });
      if (source.type === 'TEXT' && (target.type !== 'TEXT' || source.characters !== target.characters)) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: sourceId, reason: 'Text changed' });
      if (source.visible !== target.visible) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: sourceId, reason: 'Visibility changed' });
      sameGeometry(source, target, source === p.source);
      if (source.type === 'INSTANCE' && target.type === 'INSTANCE' && source !== p.source) {
        if ((await source.getMainComponentAsync())?.id !== (await target.getMainComponentAsync())?.id || stable(source.componentProperties) !== stable(target.componentProperties)) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: sourceId, reason: 'Nested component or properties changed' });
      }
    }
    for (const transfer of p.transfers.filter(t => t.kind === 'slot')) {
      const copied = map.get(transfer.source.id)! as SlotNode;
      if (!Array.isArray(copied.limitViolations) || copied.limitViolations.length) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: transfer.source.id, limitViolations: copied.limitViolations ?? null, reason: 'SLOT native limit evidence unavailable or violated' });
      const expectedIds = (transfer.source as SlotNode).children.map(n => map.get(n.id)?.id);
      if (stable(expectedIds) !== stable(copied.children.map(n => n.id))) fail('TRANSFER_VALIDATION_FAILED', { sourceNodeId: transfer.source.id, reason: 'SLOT content/order changed' });
    }
    for (const [id, value] of Object.entries(p.plan.steps[0].mappedValues ?? {})) if (root.componentProperties[id]?.value !== value) fail('TRANSFER_VALIDATION_FAILED', { nodeId: root.id, propertyId: id });
    if ((await root.getMainComponentAsync())?.id !== p.target.id || root.parent !== p.parent || root.name !== p.args.name || root.x !== p.args.position.x || root.y !== p.args.position.y) fail('TRANSFER_VALIDATION_FAILED', { nodeId: root.id, reason: 'Root result mismatch' });
    preservationCheck(p, api, map);
    const validatedTree = stable(fullTree(root, api));
    const state = await resultState(root, api);
    if (validatedTree !== stable(fullTree(root, api))) fail('SOURCE_CHANGED', { stage: 'theme-copy-validated-result' });
    const fresh = await inventory(api, root.id);
    await unchanged(p, api, new Set(created.keys()));
    const result: ThemeCopyResult = boundedResult({ ...describe(p, fresh), status: 'applied', nodeId: root.id, nodeMap: Object.fromEntries([...map].map(([id, n]) => [id, n.id])) });
    recordChecksum = writeChunks(root, { request: p.request, parentId: p.parent.id, state, result });
    if (state !== await resultState(root, api)) fail('SOURCE_CHANGED', { stage: 'theme-copy-final-result' });
    await unchanged(p, api, new Set(created.keys()));
    // No awaits after this pin: postcondition and source/master preservation
    // cannot silently become a new baseline during final asynchronous reads.
    if (state !== await resultState(root, api)) fail('SOURCE_CHANGED', { stage: 'theme-copy-final-links' });
    const resultLinks = (JSON.parse(state) as { links: Record<string, string | null> }).links;
    const sealed = [...(p.linkSeal ?? []), ...[...indexNodes(root).values()].filter((node): node is InstanceNode => node.type === 'INSTANCE').map(node => ({ node, mainId: resultLinks[node.id] }))];
    // Figma exposes links asynchronously under dynamic-page access. Re-read
    // source, target-master and output links together twice: an output read may
    // itself yield while another editor changes an earlier source link. This
    // guards observed drift; the native API offers no document transaction.
    for (let pass = 0; pass < 2; pass++) {
      const current = await Promise.all(sealed.map(async ({ node }) => (await node.getMainComponentAsync())?.id ?? null));
      const changed = sealed.findIndex((entry, i) => entry.mainId !== current[i]);
      if (changed !== -1) fail('SOURCE_CHANGED', { stage: 'theme-copy-final-all-links', nodeId: sealed[changed].node.id });
      p.guard?.();
      if (validatedTree !== stable(fullTree(root, api))) fail('SOURCE_CHANGED', { stage: 'theme-copy-final-all-links-tree' });
    }
    p.guard?.();
    if (validatedTree !== stable(fullTree(root, api))) fail('SOURCE_CHANGED', { stage: 'theme-copy-final-postcondition' });
    preservationCheck(p, api, map); receipt('applied', root.id);
    return result;
  } catch (error) {
    const cleanupErrors: string[] = [];
    // Remove operation-owned nodes only; staging roots first, then detached
    // survivors. A removed ancestor does not excuse a live staged sibling.
    const blockingUnownedNodeIds = new Set<string>();
    for (const node of created.values()) {
      try {
        if (node.removed) continue;
        const unknown = [...indexNodes(node).values()].filter(n => !created.has(n.id));
        if (unknown.length) { unknown.forEach(n => blockingUnownedNodeIds.add(n.id)); continue; }
        // Native instance descendants are not independent deletion targets.
        // If their owned root could not be removed, leave and report them.
        let owner: BaseNode | null = node.parent;
        while (owner && !created.has(owner.id)) owner = owner.parent;
        if (owner && !owner.removed) continue;
        node.remove();
      } catch (cleanup) { cleanupErrors.push(describeError(cleanup)); }
    }
    const remainingNodeIds = [...created.values()].filter(n => !n.removed && isInDocument(n)).map(n => n.id);
    if (reserved) {
      try {
        const details = error instanceof VariantError ? error.details : { cause: describeError(error) };
        p.document.setPluginData(`${key}-failure`, stable({ request: p.request, code: error instanceof VariantError ? error.code : 'FIGMA_API_ERROR', details }));
        p.document.setPluginData(key, remainingNodeIds.length ? stable({ request: p.request, status: 'incomplete', nodeIds: remainingNodeIds }) : '');
      } catch (cleanup) { cleanupErrors.push(describeError(cleanup)); }
    }
    if (remainingNodeIds.length || cleanupErrors.length) fail('ROLLBACK_INCOMPLETE', { operationId: p.args.operationId, remainingNodeIds, blockingUnownedNodeIds: [...blockingUnownedNodeIds], cleanupErrors, cause: describeError(error) });
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage: 'theme-copy-write', cause: describeError(error) });
  }
}
export async function copyThemeComponent(api: Api, input: unknown): Promise<ThemeCopyResult> {
  const args = themeCopySchema.parse(input);
  try {
    const request = requestKey(args);
    const previous = await replay(api, api.root, args, request); if (previous) return previous;
    const source = await api.getNodeByIdAsync(args.nodeId);
    if (!source) fail('NODE_NOT_FOUND', { nodeId: args.nodeId });
    if (source.type !== 'INSTANCE' || source.removed) fail('UNSUPPORTED_NODE', { nodeId: source.id, reason: 'Stage B accepts INSTANCE only' });
    const ctx = context(source); await ctx.page.loadAsync();
    if (utf8Length(stable({ request, nodeIds: [] })) > 60_000) fail('LIMIT_EXCEEDED', { stage: 'theme-copy-request', reason: 'Request too large for durable receipt' });
    const plan = await planThemeConversion(api, { nodeId: args.nodeId, libraryRootIds: args.libraryRootIds, targetTheme: args.targetTheme,
      themeProperty: args.themeProperty, mappings: args.mappings, sharedComponentIds: args.sharedComponentIds, scanLimit: args.scanLimit });
    const step = plan.steps[0];
    if (!step || step.nodeId !== source.id || step.action !== 'reuse' || !step.targetComponentId || step.issues.some(i => i.severity === 'error')) fail('THEME_COPY_BLOCKED', { rootStep: step, reason: 'Root requires exact compatible reuse target; keep/alignment/mapping/unknown are not executable' });
    const target = await api.getNodeByIdAsync(step.targetComponentId);
    if (!target || target.type !== 'COMPONENT') fail('SOURCE_CHANGED', { nodeId: step.targetComponentId });
    const p: Prepared = { ...ctx, args, request, source, target, plan, transfers: transfers(source, target, args), expectedState: '', preservationRestores: [] };
    const mapping = args.mappings.find(m => m.sourceId === step.sourceComponentId) ?? args.mappings.find(m => m.sourceId === step.sourceSetId);
    for (const transfer of p.transfers) {
      if (transfer.kind === 'instance' && transfer.source.type === 'INSTANCE') {
        const main = await transfer.source.getMainComponentAsync();
        if (!main) fail('TRANSFER_UNSUPPORTED', { sourceNodeId: transfer.source.id, reason: 'Original nested main unavailable' });
        p.preservationRestores.push({ sourceNodeId: transfer.source.id, targetMasterNodeId: transfer.target.id, originalMainComponentId: main.id });
      }
      if (transfer.kind === 'slot') {
        const a = (transfer.source as unknown as { componentPropertyReferences: { slotContentId: string } }).componentPropertyReferences.slotContentId;
        const b = (transfer.target as unknown as { componentPropertyReferences: { slotContentId: string } }).componentPropertyReferences.slotContentId;
        if ((mapping?.propertyMap[a] ?? a) !== b) fail('TRANSFER_MAPPING_REQUIRED', { sourceNodeId: transfer.source.id, targetMasterNodeId: transfer.target.id, reason: 'SLOT layer mapping disagrees with property mapping' });
      }
    }
    p.expectedState = await capture(p, api);
    // Repeat capture to pin links and master trees across all awaited reads.
    if (p.expectedState !== await capture(p, api)) fail('SOURCE_CHANGED', { stage: 'theme-copy-prepare' });
    if (!args.dryRun) {
      if (args.expectedState !== p.expectedState) fail('SOURCE_CHANGED', { stage: 'theme-copy-preflight' });
      return await write(p, api);
    }
    const fresh = await inventory(api, source.id); await unchanged(p, api, new Set());
    const failureRaw = ctx.document.getPluginData(`${prefix}${args.operationId}-failure`);
    const failure = failureRaw ? parse(failureRaw, ctx.document.id) : undefined;
    return boundedResult({ ...describe(p, fresh), expectedState: p.expectedState,
      ...(failure?.request === request && typeof failure.code === 'string' ? { previousFailure: { code: failure.code, details: failure.details ?? {} } } : {}) });
  } catch (error) {
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage: 'theme-copy-prepare', cause: describeError(error) });
  }
}
