import { listComponentsSchema, type ComponentDescriptor, type ThemeDefinitions } from '../shared/theme-conversion.js';
import { describeError } from './errors.js';
import { fail, isInDocument, jsonValue, stable, utf8Length } from './variant-state.js';

export type CatalogApi = Pick<typeof figma, 'getNodeByIdAsync'> & { mixed?: symbol };
type Master = ComponentNode | ComponentSetNode;
export interface ComponentCatalog { components: ComponentDescriptor[]; scopeRootIds: string[]; scopeComplete: true; scannedNodes: number; scopeSnapshot: string }

export async function loadNodePage(node: BaseNode) {
  let parent: BaseNode | null = node;
  while (parent && parent.type !== 'PAGE') parent = parent.parent;
  if (parent?.type === 'PAGE') await parent.loadAsync();
}

export function describeComponent(node: Master, mixed: symbol): ComponentDescriptor {
  const owner = node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET' ? node.parent : node;
  let definitions: ThemeDefinitions = {}, variants: Record<string, string> | null = null;
  const warnings: string[] = [];
  try {
    const raw = jsonValue(owner.componentPropertyDefinitions, mixed) as ThemeDefinitions;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid property schema');
    for (const definition of Object.values(raw)) {
      if (!definition || !['BOOLEAN', 'TEXT', 'VARIANT', 'INSTANCE_SWAP', 'SLOT'].includes(definition.type)
        || (definition.type === 'VARIANT' && (!Array.isArray(definition.variantOptions) || definition.variantOptions.some(v => typeof v !== 'string')))) {
        throw new Error('Invalid property definition');
      }
    }
    definitions = raw;
    if (node.type === 'COMPONENT') variants = node.variantProperties;
  } catch (error) { warnings.push(`Schema unavailable on ${owner.id}: ${describeError(error)}`); }
  return { id: node.id, name: node.name, type: node.type, key: node.key, remote: node.remote,
    ...(node.parent ? { parentId: node.parent.id } : {}),
    definitionSource: { id: owner.id, name: owner.name, type: owner.type }, definitions,
    schemaStatus: warnings.length ? 'unavailable' : 'available', warnings,
    variantProperties: variants ? JSON.parse(JSON.stringify(variants)) : null,
    ...(node.type === 'COMPONENT_SET' ? { variantIds: node.children.filter(c => c.type === 'COMPONENT' && !c.removed).map(c => c.id) } : {}),
  };
}

export function boundedResult<T>(value: T): T {
  if (utf8Length(stable(value)) > 524_288) fail('LIMIT_EXCEEDED', { stage: 'theme-result', reason: 'Result exceeds 512 KiB; narrow the scope' });
  return value;
}

export async function collectComponents(api: CatalogApi, roots: string[], limit: number): Promise<ComponentCatalog> {
  const seen = new Set<string>(), masters = new Map<string, Master>(), rootNodes: BaseNode[] = [];
  const mixed = api.mixed ?? Symbol('mixed');
  for (const id of roots) {
    const node = await api.getNodeByIdAsync(id);
    if (!node) fail('NODE_NOT_FOUND', { rootNodeId: id });
    if (!['PAGE', 'SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET'].includes(node.type)
      || node.removed || !isInDocument(node) || ('remote' in node && node.remote)) {
      fail('UNSUPPORTED_NODE', { rootNodeId: id, reason: 'Requires an attached local library root' });
    }
    await loadNodePage(node); rootNodes.push(node);
  }
  function visit(node: BaseNode, depth: number) {
    if (seen.has(node.id)) return;
    if (seen.size >= limit || depth > 64) fail('CATALOG_LIMIT_EXCEEDED', { rootNodeIds: roots, scanLimit: limit, reason: 'Scope was not completely scanned' });
    seen.add(node.id);
    if (node.removed) fail('SOURCE_CHANGED', { nodeId: node.id, stage: 'catalog' });
    if (node.type === 'INSTANCE') return;
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      if (node.remote) fail('CATALOG_INCOMPLETE', { nodeId: node.id, reason: 'Remote master encountered in local scope' });
      masters.set(node.id, node);
    }
    if ('children' in node) for (const child of node.children) visit(child, depth + 1);
  }
  rootNodes.forEach(node => visit(node, 0));
  const components = [...masters.values()].map(node => describeComponent(node, mixed));
  const schemas = Object.fromEntries(components.map(c => [c.definitionSource.id, { definitions: c.definitions, status: c.schemaStatus, warnings: c.warnings }]));
  const scopeSnapshot = stable({ roots, schemas, entries: components.map(({ definitions: _definitions, ...entry }) => entry) });
  if (utf8Length(scopeSnapshot) > 262_144) fail('LIMIT_EXCEEDED', { stage: 'catalog', reason: 'Scope snapshot exceeds 256 KiB; narrow the scope' });
  return { components, scopeRootIds: [...roots], scopeComplete: true, scannedNodes: seen.size, scopeSnapshot };
}

export async function listComponents(api: CatalogApi, input: unknown) {
  const args = listComponentsSchema.parse(input);
  const catalog = await collectComponents(api, [args.rootNodeId], args.scanLimit);
  if (args.expectedScopeSnapshot && args.expectedScopeSnapshot !== catalog.scopeSnapshot) fail('SOURCE_CHANGED', { stage: 'catalog-pagination', rootNodeId: args.rootNodeId });
  const query = args.query?.trim().toLowerCase();
  const filtered = catalog.components.filter(c => !query || `${c.name} ${c.definitionSource.name}`.toLowerCase().includes(query));
  return boundedResult({ ...catalog, total: filtered.length, offset: args.offset, limit: args.limit,
    components: filtered.slice(args.offset, args.offset + args.limit),
    nextOffset: args.offset + args.limit < filtered.length ? args.offset + args.limit : null,
    limitations: ['Only attached local masters within the explicit roots were scanned; this does not establish absence in other pages or libraries.'],
  });
}
