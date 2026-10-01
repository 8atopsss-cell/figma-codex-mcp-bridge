import type { VariableReadArgs } from '../shared/protocol.js';
import { toJsonValue } from './read.js';

type VariablesApi = Pick<typeof figma, 'getNodeByIdAsync'> & {
  variables: Pick<VariablesAPI, 'getLocalVariablesAsync' | 'getLocalVariableCollectionsAsync' | 'getVariableByIdAsync' | 'getVariableCollectionByIdAsync'>;
};
type Values = Record<string, VariableValue>;
type ModeSource = 'requestedMode' | 'nodeResolved' | 'collectionDefault';
interface ChainStep {
  variableId: string;
  name: string;
  collectionId: string;
  modeId: string;
  modeSource: ModeSource;
  value: VariableValue;
}
interface Resolution {
  variableId: string;
  collectionId?: string;
  modeId?: string;
  status: 'resolved' | 'unresolved';
  chain: ChainStep[];
  value?: VariableValue;
  reason?: string;
  resolvedForConsumer?: { value: VariableValue; resolvedType: VariableResolvedDataType };
}
const MAX_VARIABLES = 500;
const MAX_ALIAS_DEPTH = 64;

// The raw graph is retained alongside resolved values so token provenance is never lost.
export async function getVariables(api: VariablesApi, args: VariableReadArgs) {
  const warnings = new Set<string>();
  let consumer: SceneNode | undefined;
  if (args.nodeId) {
    const node = await api.getNodeByIdAsync(args.nodeId);
    if (!node) throw new Error('NODE_NOT_FOUND');
    if (!('resolvedVariableModes' in node)) throw new Error('UNSUPPORTED_NODE');
    consumer = node;
  }
  const [localVariables, localCollections] = await Promise.all([
    api.variables.getLocalVariablesAsync(), api.variables.getLocalVariableCollectionsAsync(),
  ]);
  const variableCache = new Map(localVariables.map((v) => [v.id, v]));
  const collections = new Map(localCollections.map((c) => [c.id, c]));
  const unavailableVariables = new Set<string>();
  const unavailableCollections = new Set<string>();

  async function loadVariable(id: string): Promise<Variable | undefined> {
    if (variableCache.has(id)) return variableCache.get(id);
    if (unavailableVariables.has(id)) return undefined;
    try {
      const variable = await api.variables.getVariableByIdAsync(id);
      if (variable) { variableCache.set(id, variable); return variable; }
    } catch { /* Report inaccessible library tokens as missing, without importing them. */ }
    unavailableVariables.add(id);
    warnings.add(`variable ${id} unavailable; its value and alias provenance are incomplete`);
    return undefined;
  }
  async function loadCollection(id: string): Promise<VariableCollection | undefined> {
    if (collections.has(id)) return collections.get(id);
    if (unavailableCollections.has(id)) return undefined;
    try {
      const collection = await api.variables.getVariableCollectionByIdAsync(id);
      if (collection) { collections.set(id, collection); return collection; }
    } catch { /* Preserve the variable even when its collection is inaccessible. */ }
    unavailableCollections.add(id);
    warnings.add(`collection ${id} unavailable; mode metadata is incomplete`);
    return undefined;
  }

  const filterCollection = args.collectionId ? await loadCollection(args.collectionId) : undefined;
  if (args.collectionId && !filterCollection) throw new Error('COLLECTION_NOT_FOUND');
  if (consumer) {
    for (const id of Object.keys(consumer.resolvedVariableModes)) await loadCollection(id);
  }
  let candidateIds = [...new Set(args.variableIds ?? filterCollection?.variableIds ?? localVariables.map((v) => v.id))];
  if (args.variableIds && filterCollection) {
    const matching: string[] = [];
    for (const id of candidateIds) {
      const variable = await loadVariable(id);
      if (variable && (variable.variableCollectionId === filterCollection.id || filterCollection.variableIds.includes(id))) matching.push(id);
    }
    candidateIds = matching;
  }
  const rootVariableIds = candidateIds.slice(args.offset, args.offset + args.limit);
  const graph = new Map<string, Variable>();
  const valuesByCollection = new Map<string, Record<string, Values>>();
  const queue = [...rootVariableIds];
  const queued = new Set(queue);
  let graphLimited = false;
  for (let index = 0; index < queue.length; index++) {
    if (graph.size >= MAX_VARIABLES) {
      graphLimited = true;
      warnings.add(`alias graph limited to ${MAX_VARIABLES} variables; request fewer root variableIds`);
      break;
    }
    const variable = await loadVariable(queue[index]);
    if (!variable) continue;
    graph.set(variable.id, variable);
    await loadCollection(variable.variableCollectionId);
    const extensionValues: Record<string, Values> = {};
    // Extension values cannot be reconstructed from the base variable's valuesByMode.
    for (const collection of collections.values()) {
      if (!collection.isExtension || !collection.variableIds.includes(variable.id)) continue;
      try {
        extensionValues[collection.id] = await variable.valuesByModeForCollectionAsync(collection);
      } catch {
        warnings.add(`extension values for ${variable.id} in ${collection.id} unavailable`);
      }
    }
    valuesByCollection.set(variable.id, extensionValues);
    for (const values of [variable.valuesByMode, ...Object.values(extensionValues)]) {
      for (const value of Object.values(values)) {
        if (isAlias(value) && !queued.has(value.id)) { queued.add(value.id); queue.push(value.id); }
      }
    }
  }

  function effectiveCollection(variable: Variable): VariableCollection | undefined {
    if (consumer) {
      const extensions = [...collections.values()].filter((c) => c.isExtension
        && c.variableIds.includes(variable.id) && consumer.resolvedVariableModes[c.id] !== undefined);
      if (extensions.length > 1) return undefined;
      if (extensions.length === 1) return extensions[0];
    }
    return collections.get(variable.variableCollectionId);
  }
  function trace(id: string, forced?: { collectionId: string; modeId: string }): Resolution {
    const chain: ChainStep[] = [];
    const seen = new Set<string>();
    const result: Resolution = { variableId: id, ...(forced ?? {}), status: 'unresolved', chain };
    let currentId = id;
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
      const variable = graph.get(currentId);
      if (!variable) { result.reason = graphLimited && !unavailableVariables.has(currentId) ? 'ALIAS_GRAPH_LIMIT' : 'VARIABLE_NOT_FOUND'; return result; }
      const baseCollection = collections.get(variable.variableCollectionId);
      const collection = forced && (forced.collectionId === variable.variableCollectionId || collections.get(forced.collectionId)?.variableIds.includes(variable.id))
        ? collections.get(forced.collectionId) : effectiveCollection(variable);
      if (!collection) {
        result.reason = baseCollection ? 'AMBIGUOUS_COLLECTION_CONTEXT' : 'COLLECTION_NOT_FOUND';
        return result;
      }
      const forcedMode = forced?.collectionId === collection.id ? forced.modeId : undefined;
      const nodeMode = consumer?.resolvedVariableModes[collection.id];
      const modeId = forcedMode ?? nodeMode ?? collection.defaultModeId;
      const modeSource: ModeSource = forcedMode !== undefined ? 'requestedMode' : nodeMode !== undefined ? 'nodeResolved' : 'collectionDefault';
      const key = `${currentId}\u0000${collection.id}\u0000${modeId}`;
      if (seen.has(key)) { result.reason = 'ALIAS_CYCLE'; return result; }
      seen.add(key);
      const values = collection.isExtension ? valuesByCollection.get(currentId)?.[collection.id] : variable.valuesByMode;
      const value = values?.[modeId];
      if (value === undefined) { result.reason = 'MODE_VALUE_MISSING'; return result; }
      chain.push({ variableId: currentId, name: variable.name, collectionId: collection.id, modeId, modeSource, value });
      if (!isAlias(value)) { result.status = 'resolved'; result.value = value; return result; }
      currentId = value.id;
    }
    result.reason = 'ALIAS_DEPTH_LIMIT';
    return result;
  }

  const resolutions: Resolution[] = [];
  const nodeResolutions: Resolution[] = [];
  for (const id of rootVariableIds) {
    const variable = graph.get(id);
    if (!variable) continue;
    const modeSets = { [variable.variableCollectionId]: variable.valuesByMode, ...valuesByCollection.get(id) };
    for (const [collectionId, values] of Object.entries(modeSets)) {
      for (const modeId of Object.keys(values)) resolutions.push(trace(id, { collectionId, modeId }));
    }
    if (consumer) {
      const resolution = trace(id);
      try {
        resolution.resolvedForConsumer = variable.resolveForConsumer(consumer);
        if (resolution.status === 'resolved' && !equalValues(resolution.value, resolution.resolvedForConsumer.value)) {
          resolution.status = 'unresolved';
          resolution.reason = 'CONSUMER_RESOLUTION_MISMATCH';
          delete resolution.value;
          warnings.add(`alias chain for ${id} differs from resolveForConsumer; use the native consumer value`);
        }
      } catch {
        warnings.add(`resolveForConsumer failed for ${id}; native node value unavailable`);
      }
      nodeResolutions.push(resolution);
    }
  }
  for (const resolution of [...resolutions, ...nodeResolutions]) {
    if (resolution.status === 'unresolved') warnings.add(`${resolution.variableId}: ${resolution.reason}; alias chain incomplete`);
  }
  const result = {
    collections: [...collections.values()].map(serializeCollection),
    variables: [...graph.values()].map((v) => ({
      id: v.id, key: v.key, name: v.name, description: v.description, remote: v.remote,
      resolvedType: v.resolvedType, variableCollectionId: v.variableCollectionId,
      hiddenFromPublishing: v.hiddenFromPublishing, scopes: v.scopes, codeSyntax: v.codeSyntax,
      valuesByMode: v.valuesByMode,
      ...(Object.keys(valuesByCollection.get(v.id) ?? {}).length ? { valuesByCollection: valuesByCollection.get(v.id) } : {}),
    })),
    rootVariableIds,
    resolutionContext: consumer ? 'node' : 'collectionDefaults',
    ...(consumer ? { nodeContext: {
      nodeId: consumer.id, name: consumer.name,
      explicitVariableModes: consumer.explicitVariableModes, resolvedVariableModes: consumer.resolvedVariableModes,
    } } : {}),
    resolutions, nodeResolutions,
    pagination: { offset: args.offset, limit: args.limit, total: candidateIds.length,
      nextOffset: args.offset + args.limit < candidateIds.length ? args.offset + args.limit : null },
    warnings: [...warnings],
  };
  // Keep the JSON below the bridge's 4 MiB frame limit, including UTF-8 expansion.
  if (JSON.stringify(result).length > 1_000_000) throw new Error('VARIABLES_TOO_LARGE');
  return result;
}

function isAlias(value: VariableValue): value is VariableAlias {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS';
}
function serializeCollection(collection: VariableCollection): Record<string, unknown> {
  const fields = ['id', 'key', 'name', 'remote', 'hiddenFromPublishing', 'defaultModeId', 'modes', 'variableIds',
    'isExtension', 'parentVariableCollectionId', 'rootVariableCollectionId', 'variableOverrides'];
  const source = collection as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = toJsonValue(source[field]);
    if (value !== undefined) result[field] = value;
  }
  return result;
}
function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalValues(left[key], right[key]));
}
