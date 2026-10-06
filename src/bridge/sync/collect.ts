import { snapshot, type Snapshot, type Tree } from './snapshot.js';

export interface Reader { call(method: string, args: unknown): Promise<unknown> }
export interface Source { theme: string; componentSetId: string }
export async function collect(reader: Reader, sources: Source[]): Promise<Snapshot> {
  let reads = 0;
  const deadline = Date.now() + 180_000;
  const assets: Record<string, unknown> = {};
  const variables: Record<string, unknown> = {};
  const warnings: string[] = [];
  const styleIds = new Set<string>();
  const call = async (method: string, args: unknown) => {
    if (++reads > 2000) throw new Error('SNAPSHOT_READ_LIMIT');
    if (Date.now() > deadline) throw new Error('SNAPSHOT_TIMEOUT');
    return reader.call(method, args);
  };
  const tree = async (id: string, depth = 0, parentVisible = true): Promise<Tree> => {
    if (depth > 32) throw new Error('SNAPSHOT_DEPTH_LIMIT');
    const result = await call('node.tree', { nodeId: id, depth: 1, offset: 0, limit: 100 }) as Tree;
    if (!result || result.id !== id || typeof result.type !== 'string') throw new Error('INVALID_TREE_REPLY');
    const visible = parentVisible && result.properties?.visible !== false;
    const children = [...(result.children ?? [])];
    while (children.length < (result.childCount ?? 0)) {
      const page = await call('node.tree', { nodeId: id, depth: 1, offset: children.length, limit: 100 }) as Tree;
      if (!page.children?.length || page.childCount !== result.childCount) throw new Error('SOURCE_CHANGED_OR_INCOMPLETE');
      children.push(...page.children);
    }
    if (new Set(children.map((child) => child.id)).size !== children.length) throw new Error('SOURCE_CHANGED_OR_INCOMPLETE');
    result.children = [];
    for (const child of children) result.children.push(await tree(child.id, depth + 1, visible));
    if (['VECTOR', 'BOOLEAN_OPERATION'].includes(result.type)) {
      if (!visible) assets[id] = { status: 'not-rendered' };
      else {
        try { assets[id] = await call('node.svg', { nodeId: id }); }
        catch (error) {
          warnings.push(`${id}: SVG unavailable: ${error instanceof Error ? error.message : 'SVG_EXPORT_FAILED'}`);
          assets[id] = { status: 'unavailable' };
        }
      }
    }
    // Read tokens in the actual consuming context; keep bindings and aliases.
    const ids = new Set<string>();
    const bindings = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if ('type' in value && value.type === 'VARIABLE_ALIAS' && 'id' in value && typeof value.id === 'string') ids.add(value.id);
      for (const entry of Object.values(value)) bindings(entry);
    };
    bindings(result.properties); bindings(result.textSegments);
    const stylesUsed = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (/StyleId$/.test(key) && typeof item === 'string' && item) styleIds.add(item);
        stylesUsed(item);
      }
    };
    stylesUsed(result.properties); stylesUsed(result.textSegments);
    if (ids.size) {
      const pages: unknown[] = [];
      const variableIds = [...ids].sort();
      for (let start = 0; start < variableIds.length; start += 100) {
        let offset = 0;
        for (;;) {
          const page = await call('variables.list', { nodeId: id, variableIds: variableIds.slice(start, start + 100), offset, limit: 100 }) as { warnings?: string[]; pagination?: { nextOffset: number | null } };
          pages.push(page);
          for (const warning of page.warnings ?? []) warnings.push(`${id}: ${warning}`);
          const unresolved = (value: unknown) => {
            if (!value || typeof value !== 'object') return;
            if ('status' in value && value.status === 'unresolved') warnings.push(`${id}: unresolved variable`);
            for (const item of Object.values(value)) unresolved(item);
          };
          unresolved(page);
          if (page.pagination?.nextOffset === null) break;
          const next = page.pagination?.nextOffset;
          if (typeof next !== 'number' || next <= offset) throw new Error('VARIABLE_PAGINATION_INCOMPLETE');
          offset = next;
        }
      }
      variables[id] = pages;
    }
    return result;
  };
  const trees: Record<string, Tree> = {};
  for (const source of sources) trees[source.theme] = await tree(source.componentSetId);
  const styles = await call('styles.list', {}) as Record<string, unknown[]>;
  for (const [kind, values] of Object.entries(styles)) if (!Array.isArray(values) || values.length >= 500) warnings.push(`styles/${kind}: completeness unavailable`);
  const selectedStyles: Record<string, unknown> = {};
  for (const values of Object.values(styles)) if (Array.isArray(values)) for (const value of values) {
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && styleIds.has(value.id)) selectedStyles[value.id] = value;
  }
  for (const id of styleIds) if (!Object.hasOwn(selectedStyles, id)) warnings.push(`${id}: referenced style unavailable`);
  const result = snapshot(trees, { assets, variables, styles: selectedStyles });
  result.warnings.push(...warnings);
  return result;
}
