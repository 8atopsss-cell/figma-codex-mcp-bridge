import * as z from 'zod/v4';
import {
  createComponentVariantsSchema, type ComponentVariantSpec, type CreateComponentVariantsArgs,
  type CreatedVariantResult, type CreateComponentVariantsResult,
} from '../shared/protocol.js';
import { describeError } from './errors.js';
import { fail, indexNodes, isInDocument, jsonValue, snapshot, stable, utf8Length, VariantError, type NodeSnapshot } from './variant-state.js';

type VariantApi = Pick<typeof figma, 'getNodeByIdAsync' | 'getStyleByIdAsync' | 'mixed'>;
const markerKey = 'codex-component-variants-v1';
const markerSchema = z.object({
  version: z.literal(1), operationId: z.string(), request: z.string(),
  index: z.number().int().min(0).max(19), count: z.number().int().min(1).max(20),
  nodeMap: z.record(z.string(), z.string()), snapshot: z.string(),
  setReceipt: z.object({ width: z.number(), height: z.number(), definitions: z.string() }).strict().optional(),
}).strict();

interface PreparedVariant { spec: ComponentVariantSpec; source: ComponentNode; name: string; nodes: Map<string, SceneNode> }
interface Prepared {
  set: ComponentSetNode; keys: string[]; definitions: ComponentPropertyDefinitions;
  originals: ComponentNode[]; variants: PreparedVariant[]; styles: Map<string, PaintStyle>;
  expectedState: string; request: string;
  originalSize: { width: number; height: number };
}

function requestKey(args: CreateComponentVariantsArgs) {
  return stable({ componentSetId: args.componentSetId, operationId: args.operationId, variants: args.variants, ...changes(args) });
}

function changes(args: CreateComponentVariantsArgs) {
  return {
    ...(args.componentSetSize === undefined ? {} : { componentSetSize: args.componentSetSize }),
    ...(args.newVariantValues === undefined ? {} : { newVariantValues: args.newVariantValues }),
  };
}

// Native option ordering is not a semantic change; defaults and all other fields are.
function schemaKey(definitions: ComponentPropertyDefinitions) {
  return stable(Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, {
    ...def, ...(def.variantOptions ? { variantOptions: [...def.variantOptions].sort() } : {}),
  }])));
}

function setReceipt(set: ComponentSetNode) {
  return { width: set.width, height: set.height, definitions: schemaKey(set.componentPropertyDefinitions) };
}

function combination(properties: Record<string, string> | null, keys: string[]): string {
  if (!properties || Object.keys(properties).length !== keys.length || keys.some((key) => typeof properties[key] !== 'string')) {
    fail('INVALID_VARIANT_SCHEMA', { stage: 'combination', properties, keys });
  }
  return stable(keys.map((key) => [key, properties[key]]));
}

function styleSnapshot(style: PaintStyle, mixed: symbol) {
  try { return jsonValue({ id: style.id, type: style.type, name: style.name, paints: style.paints, remote: style.remote }, mixed); }
  catch (error) {
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage: 'snapshot-style', styleId: style.id, cause: describeError(error) });
  }
}

function capture(p: Omit<Prepared, 'expectedState'>, args: CreateComponentVariantsArgs, api: VariantApi, written = false, added: ComponentNode[] = []) {
  if (p.set.removed || p.originals.some((node) => node.removed || node.parent !== p.set)) fail('SOURCE_CHANGED', { stage: 'capture', componentSetId: p.set.id });
  const set = snapshot(p.set, api.mixed, false);
  let definitions = p.set.componentPropertyDefinitions;
  if (written) {
    const target = args.componentSetSize ?? p.originalSize;
    const expectedDefinitions: ComponentPropertyDefinitions = Object.fromEntries(Object.entries(p.definitions).map(([key, def]) => [key, {
      ...def, ...(def.variantOptions ? { variantOptions: [...def.variantOptions, ...new Set(added.map((node) => node.variantProperties?.[key])
        .filter((value): value is string => value !== undefined && args.newVariantValues?.[key]?.includes(value) === true))] } : {}),
    }]));
    if (p.set.width !== target.width || p.set.height !== target.height || schemaKey(definitions) !== schemaKey(expectedDefinitions)) {
      fail('SOURCE_CHANGED', { stage: 'set-readback', componentSetId: p.set.id, expectedSize: target, actualSize: { width: p.set.width, height: p.set.height }, reason: 'Set size or schema changed unexpectedly' });
    }
    set.properties.width = p.originalSize.width;
    set.properties.height = p.originalSize.height;
    definitions = p.definitions;
  }
  const value = stable({
    request: p.request,
    set,
    parentId: p.set.parent?.id,
    definitions: jsonValue(definitions, api.mixed),
    childIds: p.originals.map((node) => node.id),
    children: p.originals.map((node) => ({ properties: node.variantProperties, tree: snapshot(node, api.mixed) })),
    styles: [...p.styles.values()].map((style) => styleSnapshot(style, api.mixed)),
  });
  if (utf8Length(value) > 262_144) fail('LIMIT_EXCEEDED', { stage: 'capture', componentSetId: args.componentSetId, reason: 'Snapshot exceeds 256 KiB' });
  return value;
}

function assertUnchanged(p: Prepared, args: CreateComponentVariantsArgs, api: VariantApi, added: ComponentNode[] = [], written = false) {
  if (stable(p.set.children.map((node) => node.id)) !== stable([...p.originals, ...added].map((node) => node.id))
    || capture(p, args, api, written, added) !== p.expectedState) fail('SOURCE_CHANGED', { stage: 'apply', componentSetId: p.set.id });
}

function describeVariant(v: PreparedVariant): CreatedVariantResult {
  return { sourceComponentId: v.source.id, name: v.name, properties: v.spec.properties, position: v.spec.position, layerStyles: v.spec.layerStyles };
}

function replay(set: ComponentSetNode, args: CreateComponentVariantsArgs, api: VariantApi): CreateComponentVariantsResult | undefined {
  const matching: Array<{ node: ComponentNode; marker: z.infer<typeof markerSchema> }> = [];
  for (const node of set.children) {
    if (node.type !== 'COMPONENT') continue;
    const data = node.getPluginData(markerKey);
    if (!data) continue;
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { continue; }
    // Other operation markers are irrelevant; malformed markers for this operation are not.
    if (!raw || typeof raw !== 'object' || !('operationId' in raw) || raw.operationId !== args.operationId) continue;
    const parsed = markerSchema.safeParse(raw);
    if (!parsed.success) fail('OPERATION_RESULT_CHANGED', { nodeId: node.id, reason: 'Malformed operation marker' });
    matching.push({ node, marker: parsed.data });
  }
  if (!matching.length) return undefined;
  const request = requestKey(args);
  if (matching.some(({ marker }) => marker.request !== request)) fail('OPERATION_ID_CONFLICT', { operationId: args.operationId });
  if (args.componentSetSize || args.newVariantValues) {
    const receipt = stable(setReceipt(set));
    if (matching.some(({ marker }) => !marker.setReceipt || stable(marker.setReceipt) !== receipt)) {
      fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, componentSetId: set.id, reason: 'Set size or schema changed' });
    }
  }
  if (matching.length !== args.variants.length || matching.some(({ marker }) => marker.count !== args.variants.length)
    || new Set(matching.map(({ marker }) => marker.index)).size !== args.variants.length) {
    fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, nodeIds: matching.map(({ node }) => node.id), reason: 'Incomplete operation' });
  }
  const keys = Object.entries(set.componentPropertyDefinitions).filter(([, def]) => def.type === 'VARIANT').map(([key]) => key);
  const variants = matching.sort((a, b) => a.marker.index - b.marker.index).map(({ node, marker }) => {
    const spec = args.variants[marker.index];
    if (!spec || marker.snapshot !== stable(snapshot(node, api.mixed))
      || combination(node.variantProperties, keys) !== combination(spec.properties, keys)) {
      fail('OPERATION_RESULT_CHANGED', { operationId: args.operationId, nodeId: node.id, reason: 'Created variant changed' });
    }
    return { ...spec, name: node.name, nodeId: node.id, nodeMap: marker.nodeMap };
  });
  return { status: 'replayed', operationId: args.operationId, componentSetId: set.id, ...changes(args), variants, componentPropertyDefinitions: jsonValue(set.componentPropertyDefinitions, api.mixed) };
}

async function loadPage(set: ComponentSetNode): Promise<void> {
  let page: BaseNode | null = set.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (!page || page.type !== 'PAGE') fail('UNSUPPORTED_NODE', { stage: 'prepare', nodeId: set.id, reason: 'No editable page' });
  await page.loadAsync();
}

async function prepare(api: VariantApi, args: CreateComponentVariantsArgs, set: ComponentSetNode): Promise<Prepared> {
  if (set.removed || set.remote || set.layoutMode !== 'NONE') fail('UNSUPPORTED_NODE', { stage: 'prepare', nodeId: set.id, reason: 'Requires a local set with layoutMode NONE' });
  let definitions: ComponentPropertyDefinitions;
  try { definitions = set.componentPropertyDefinitions; }
  catch (error) { fail('INVALID_VARIANT_SCHEMA', { stage: 'schema', nodeId: set.id, cause: describeError(error) }); }
  const keys = Object.entries(definitions).filter(([, def]) => def.type === 'VARIANT').map(([key]) => key);
  if (!keys.length || keys.length > 20 || keys.some((key) => /[,=]/.test(key) || key.trim() !== key)) fail('INVALID_VARIANT_SCHEMA', { stage: 'schema', nodeId: set.id, keys });
  for (const [key, values] of Object.entries(args.newVariantValues ?? {})) {
    if (!keys.includes(key) || values.some((value) => definitions[key].variantOptions?.includes(value)
      || !args.variants.some((spec) => spec.properties[key] === value))) {
      fail('INVALID_VARIANT_SCHEMA', { stage: 'schema', nodeId: set.id, key, values, reason: 'Only used new values of existing axes may be declared' });
    }
  }
  const originals: ComponentNode[] = [];
  const occupied = new Set<string>();
  for (const child of set.children) {
    if (child.type !== 'COMPONENT' || child.remote) fail('UNSUPPORTED_NODE', { stage: 'schema', nodeId: child.id });
    let value: string;
    try { value = combination(child.variantProperties, keys); }
    catch (error) { fail('INVALID_VARIANT_SCHEMA', { stage: 'schema', nodeId: child.id, cause: describeError(error) }); }
    if (occupied.has(value)) fail('INVALID_VARIANT_SCHEMA', { stage: 'schema', nodeId: child.id, reason: 'Existing duplicate combination' });
    occupied.add(value);
    originals.push(child);
  }
  const styles = new Map<string, PaintStyle>();
  const variants: PreparedVariant[] = [];
  const boxes = originals.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
  const targetSize = args.componentSetSize ?? { width: set.width, height: set.height };
  if (args.componentSetSize && boxes.some((box) => box.x < 0 || box.y < 0 || box.x + box.width > targetSize.width || box.y + box.height > targetSize.height)) {
    fail('INVALID_ARGUMENT', { stage: 'size', componentSetId: set.id, reason: 'Existing variant outside requested set size' });
  }
  for (const spec of args.variants) {
    const value = combination(spec.properties, keys);
    if (keys.some((key) => !definitions[key].variantOptions?.includes(spec.properties[key]) && !args.newVariantValues?.[key]?.includes(spec.properties[key]))) fail('INVALID_VARIANT_SCHEMA', { stage: 'schema', properties: spec.properties, reason: 'Unknown variant option' });
    if (occupied.has(value)) fail('VARIANT_ALREADY_EXISTS', { componentSetId: set.id, properties: spec.properties });
    occupied.add(value);
    const source = await api.getNodeByIdAsync(spec.sourceComponentId);
    if (!source) fail('NODE_NOT_FOUND', { stage: 'source', sourceComponentId: spec.sourceComponentId });
    if (source.type !== 'COMPONENT' || source.remote || source.parent !== set || !originals.includes(source)) fail('UNSUPPORTED_NODE', { stage: 'source', sourceComponentId: source.id });
    const box = { ...spec.position, width: source.width, height: source.height };
    if (![box.x, box.y, box.width, box.height, targetSize.width, targetSize.height].every(Number.isFinite)
      || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > targetSize.width || box.y + box.height > targetSize.height
      || boxes.some((b) => box.x < b.x + b.width && box.x + box.width > b.x && box.y < b.y + b.height && box.y + box.height > b.y)) {
      fail('INVALID_ARGUMENT', { stage: 'position', sourceComponentId: source.id, box, reason: 'Outside set or intersects another variant' });
    }
    boxes.push(box);
    const nodes = indexNodes(source);
    for (const override of spec.layerStyles) {
      const node = nodes.get(override.sourceNodeId);
      if (!node) fail('INVALID_ARGUMENT', { stage: 'styles', sourceComponentId: source.id, sourceNodeId: override.sourceNodeId, reason: 'Layer is outside source' });
      for (const [channel, styleId] of [['fill', override.fillStyleId], ['stroke', override.strokeStyleId]] as const) {
        if (styleId === undefined) continue;
        const method = channel === 'fill' ? 'setFillStyleIdAsync' : 'setStrokeStyleIdAsync';
        if (!(method in node) || typeof (node as unknown as Record<string, unknown>)[method] !== 'function') fail('UNSUPPORTED_NODE', { stage: 'styles', sourceNodeId: node.id, channel });
        if (!styles.has(styleId)) {
          const style = await api.getStyleByIdAsync(styleId);
          if (!style) fail('STYLE_NOT_FOUND', { stage: 'styles', sourceNodeId: node.id, styleId });
          if (style.type !== 'PAINT') fail('STYLE_TYPE_MISMATCH', { stage: 'styles', styleId, type: style.type });
          styles.set(styleId, style);
        }
      }
    }
    variants.push({ spec, source, nodes, name: keys.map((key) => `${key}=${spec.properties[key]}`).join(', ') });
  }
  const partial = { set, keys, definitions, originals, variants, styles, request: requestKey(args), originalSize: { width: set.width, height: set.height } };
  return { ...partial, expectedState: capture(partial, args, api) };
}

function cloneMap(source: SceneNode, clone: SceneNode): Map<string, SceneNode> {
  const result = new Map<string, SceneNode>();
  function visit(a: SceneNode, b: SceneNode, depth: number) {
    if (result.size >= 2000 || depth > 16 || a.type !== b.type) fail('SOURCE_CHANGED', { stage: 'clone', sourceNodeId: a.id, nodeId: b.id });
    result.set(a.id, b);
    const aa = 'children' in a ? a.children : [];
    const bb = 'children' in b ? b.children : [];
    if (aa.length !== bb.length) fail('SOURCE_CHANGED', { stage: 'clone', sourceNodeId: a.id, reason: 'Child count mismatch' });
    aa.forEach((node, index) => visit(node, bb[index], depth + 1));
  }
  visit(source, clone, 0);
  return result;
}

// Compare every captured property except requested root placement/name and paint channels.
function preserved(tree: NodeSnapshot, spec: ComponentVariantSpec, idToSource: Map<string, string>, root = true): NodeSnapshot {
  const id = idToSource.get(tree.id) ?? tree.id;
  const properties = { ...tree.properties };
  const override = spec.layerStyles.find((style) => style.sourceNodeId === id);
  for (const [channel, target] of [['fills', override?.fillStyleId], ['strokes', override?.strokeStyleId]] as const) {
    if (target === undefined) continue;
    delete properties[channel];
    delete properties[channel === 'fills' ? 'fillStyleId' : 'strokeStyleId'];
    const bindings = properties.boundVariables;
    if (bindings && typeof bindings === 'object' && !Array.isArray(bindings)) {
      properties.boundVariables = Object.fromEntries(Object.entries(bindings).filter(([key]) => key !== channel));
    }
    // Mixed text fill changes would need per-segment overrides; do not silently relax that comparison.
  }
  if (root) {
    delete properties.x; delete properties.y;
    if (Array.isArray(properties.relativeTransform)) {
      properties.relativeTransform = (properties.relativeTransform as number[][]).map((row) => row.slice(0, 2));
    }
  }
  return { id, type: tree.type, name: root ? spec.sourceComponentId : tree.name, properties, children: tree.children.map((child) => preserved(child, spec, idToSource, false)) };
}

function valueDifference(expected: unknown, actual: unknown, field: string): { field: string; expected: unknown; actual: unknown } | undefined {
  if (stable(expected) === stable(actual)) return;
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object'
    && Array.isArray(expected) === Array.isArray(actual)) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const difference = valueDifference(a[key], b[key], field ? `${field}.${key}` : key);
      if (difference) return difference;
    }
  }
  return { field, expected: expected === undefined ? { $figma: 'undefined' } : expected, actual: actual === undefined ? { $figma: 'undefined' } : actual };
}

function cloneDifference(expected: NodeSnapshot, actual: NodeSnapshot): { sourceNodeId: string; field: string; expected: unknown; actual: unknown } | undefined {
  const difference = valueDifference({ id: expected.id, type: expected.type, name: expected.name, properties: expected.properties },
    { id: actual.id, type: actual.type, name: actual.name, properties: actual.properties }, '');
  if (difference) return { sourceNodeId: expected.id, ...difference };
  if (expected.children.length !== actual.children.length) {
    return { sourceNodeId: expected.id, field: 'children.length', expected: expected.children.length, actual: actual.children.length };
  }
  for (const [index, child] of expected.children.entries()) {
    const difference = cloneDifference(child, actual.children[index]);
    if (difference) return difference;
  }
}

async function writeVariants(api: VariantApi, args: CreateComponentVariantsArgs, p: Prepared): Promise<CreateComponentVariantsResult> {
  const created: ComponentNode[] = [];
  const added: ComponentNode[] = [];
  const results: CreatedVariantResult[] = [];
  let stage = 'clone';
  let sourceNodeId: string | undefined;
  let resized = false;
  try {
    assertUnchanged(p, args, api);
    for (const v of p.variants) {
      stage = 'clone'; sourceNodeId = v.source.id;
      const clone = v.source.clone();
      created.push(clone);
      const map = cloneMap(v.source, clone);
      clone.name = v.name;
      stage = 'styles';
      for (const style of v.spec.layerStyles) {
        sourceNodeId = style.sourceNodeId;
        const node = map.get(style.sourceNodeId)!;
        if (style.fillStyleId !== undefined && 'setFillStyleIdAsync' in node) await node.setFillStyleIdAsync(style.fillStyleId);
        if (style.strokeStyleId !== undefined && 'setStrokeStyleIdAsync' in node) await node.setStrokeStyleIdAsync(style.strokeStyleId);
        assertUnchanged(p, args, api);
      }
      results.push({ ...describeVariant(v), nodeId: clone.id, nodeMap: Object.fromEntries([...map].map(([id, node]) => [id, node.id])) });
    }
    assertUnchanged(p, args, api);
    if (args.componentSetSize) {
      stage = 'resize';
      resized = true;
      p.set.resizeWithoutConstraints(args.componentSetSize.width, args.componentSetSize.height);
      assertUnchanged(p, args, api, [], true);
    }
    stage = 'append';
    for (const [index, clone] of created.entries()) {
      p.set.appendChild(clone);
      added.push(clone);
      clone.x = p.variants[index].spec.position.x;
      clone.y = p.variants[index].spec.position.y;
    }
    // A clone briefly lives outside its set; Figma can strip CHANGE_TO reactions
    // and reset constraints there. Restore source behavior on new copies only.
    stage = 'restore-behavior';
    for (const [index, clone] of created.entries()) {
      const v = p.variants[index];
      const targets = indexNodes(clone);
      for (const [sourceId, source] of v.nodes) {
        sourceNodeId = sourceId;
        const target = targets.get(results[index].nodeMap![sourceId])!;
        if ('constraints' in source && 'constraints' in target && stable(source.constraints) !== stable(target.constraints)) {
          target.constraints = { ...source.constraints };
        }
        if ('reactions' in source && 'reactions' in target && 'setReactionsAsync' in target
          && stable(jsonValue(source.reactions, api.mixed)) !== stable(jsonValue(target.reactions, api.mixed))) {
          await target.setReactionsAsync(JSON.parse(JSON.stringify(source.reactions)));
          assertUnchanged(p, args, api, added, true);
        }
      }
    }
    stage = 'readback';
    assertUnchanged(p, args, api, added, true);
    for (const [index, clone] of created.entries()) {
      const v = p.variants[index];
      const result = results[index];
      if (clone.parent !== p.set || clone.name !== v.name || clone.x !== v.spec.position.x || clone.y !== v.spec.position.y
        || combination(clone.variantProperties, p.keys) !== combination(v.spec.properties, p.keys)) fail('SOURCE_CHANGED', { stage, nodeId: clone.id, reason: 'Variant readback mismatch' });
      const reverse = new Map(Object.entries(result.nodeMap!).map(([source, target]) => [target, source]));
      const difference = cloneDifference(preserved(snapshot(v.source, api.mixed), v.spec, new Map()),
        preserved(snapshot(clone, api.mixed), v.spec, reverse));
      if (difference) {
        fail('SOURCE_CHANGED', { stage, ...difference, nodeId: result.nodeMap![difference.sourceNodeId], reason: 'Clone changed unrequested properties' });
      }
      const map = indexNodes(clone);
      for (const style of v.spec.layerStyles) {
        const node = map.get(result.nodeMap![style.sourceNodeId])!;
        for (const [field, expected] of [['fillStyleId', style.fillStyleId], ['strokeStyleId', style.strokeStyleId]] as const) {
          if (expected === undefined) continue;
          if (!(field in node) || (node as unknown as Record<string, unknown>)[field] !== expected) fail('SOURCE_CHANGED', { stage, nodeId: node.id, field, expected });
          const paints = (node as unknown as Record<string, unknown>)[field === 'fillStyleId' ? 'fills' : 'strokes'];
          if (stable(jsonValue(paints, api.mixed)) !== stable(jsonValue(p.styles.get(expected)!.paints, api.mixed))) {
            fail('SOURCE_CHANGED', { stage, nodeId: node.id, field, reason: 'Paint or binding readback mismatch' });
          }
        }
      }
      stage = 'metadata';
      const data = stable({ version: 1, operationId: args.operationId, request: p.request, index, count: created.length, nodeMap: result.nodeMap, snapshot: stable(snapshot(clone, api.mixed)),
        ...(args.componentSetSize || args.newVariantValues ? { setReceipt: setReceipt(p.set) } : {}),
      });
      if (utf8Length(data) > 90_000) fail('LIMIT_EXCEEDED', { stage, nodeId: clone.id, reason: 'Operation marker exceeds 90 KiB' });
      clone.setPluginData(markerKey, data);
    }
    return { status: 'applied', operationId: args.operationId, componentSetId: p.set.id, ...changes(args), variants: results, componentPropertyDefinitions: jsonValue(p.set.componentPropertyDefinitions, api.mixed) };
  } catch (error) {
    const remainingNodeIds: string[] = [];
    const cleanupErrors: string[] = [];
    for (const node of [...created].reverse()) {
      try {
        if (!node.removed) {
          const parent = node.parent;
          node.remove();
          // Figma may first turn a removed variant into a standalone page component.
          // A second removal is restricted to this operation's newly created copy.
          if (isInDocument(node) && parent?.type === 'COMPONENT_SET' && node.parent?.type === 'PAGE') node.remove();
        }
        if (isInDocument(node)) remainingNodeIds.push(node.id);
      }
      catch (cleanup) { remainingNodeIds.push(node.id); cleanupErrors.push(describeError(cleanup)); }
    }
    let componentSetSizeRestored = true;
    if (resized) {
      try {
        if (p.set.width !== p.originalSize.width || p.set.height !== p.originalSize.height) {
          if (p.set.width !== args.componentSetSize!.width || p.set.height !== args.componentSetSize!.height) throw new Error('Set dimensions changed externally; restoration skipped');
          p.set.resizeWithoutConstraints(p.originalSize.width, p.originalSize.height);
        }
        if (p.set.width !== p.originalSize.width || p.set.height !== p.originalSize.height) throw new Error('Set size restoration mismatch');
      } catch (cleanup) { componentSetSizeRestored = false; cleanupErrors.push(describeError(cleanup)); }
    }
    if (remainingNodeIds.length || !componentSetSizeRestored) fail('ROLLBACK_INCOMPLETE', { stage, componentSetId: p.set.id, sourceNodeId, remainingNodeIds, componentSetSizeRestored, currentSize: { width: p.set.width, height: p.set.height }, cleanupErrors, cause: describeError(error) });
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage, componentSetId: p.set.id, sourceNodeId, cause: describeError(error) });
  }
}

export async function createComponentVariants(api: VariantApi, input: unknown): Promise<CreateComponentVariantsResult> {
  const args = createComponentVariantsSchema.parse(input);
  try {
    const set = await api.getNodeByIdAsync(args.componentSetId);
    if (!set) fail('NODE_NOT_FOUND', { componentSetId: args.componentSetId });
    if (set.type !== 'COMPONENT_SET' || set.remote || set.removed) fail('UNSUPPORTED_NODE', { componentSetId: args.componentSetId });
    await loadPage(set);
    const previous = replay(set, args, api);
    if (previous) return previous;
    const p = await prepare(api, args, set);
    if (args.dryRun) return { status: 'preview', operationId: args.operationId, componentSetId: set.id, ...changes(args), expectedState: p.expectedState, variants: p.variants.map(describeVariant), componentPropertyDefinitions: jsonValue(p.definitions, api.mixed) };
    if (p.expectedState !== args.expectedState) fail('SOURCE_CHANGED', { stage: 'preflight', componentSetId: set.id });
    return await writeVariants(api, args, p);
  } catch (error) {
    if (error instanceof VariantError) throw error;
    fail('FIGMA_API_ERROR', { stage: 'prepare', componentSetId: args.componentSetId, cause: describeError(error) });
  }
}
