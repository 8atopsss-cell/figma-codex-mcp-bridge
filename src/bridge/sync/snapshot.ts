import { createHash } from 'node:crypto';

export interface Tree {
  id: string; name: string; type: string;
  childCount?: number; children?: Tree[]; warnings?: string[];
  properties?: Record<string, unknown>;
  [field: string]: unknown;
}
export interface Snapshot {
  schemaVersion: 1;
  id: string;
  data: Record<string, unknown>;
  warnings: string[];
}
export interface Difference { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }

export function stable(value: unknown): string {
  if (value === undefined) throw new Error('UNDEFINED_SNAPSHOT_VALUE');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('NON_FINITE_SNAPSHOT_VALUE');
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

// Array order is meaningful for paint/effect stacks, text segments and children.
export function snapshot(trees: Record<string, Tree>, extra: Record<string, unknown> = {}): Snapshot {
  const warnings: string[] = [];
  const nodes: Record<string, unknown> = {};
  const visit = (node: Tree, standalone: boolean) => {
    if (nodes[node.id]) throw new Error(`DUPLICATE_NODE:${node.id}`);
    const children = node.children ?? [];
    const complete = node.childCount === undefined || node.childCount === children.length;
    if (!complete) warnings.push(`${node.id}: incomplete descendants`);
    for (const warning of node.warnings ?? []) {
      if (complete && warning.startsWith('children omitted by ')) continue;
      // SVG warnings are covered only when exact assets are supplied by the caller.
      if (warning.includes('requires SVG or asset export') && extra.assets &&
          Object.hasOwn(extra.assets as object, node.id)) continue;
      if (warning.includes('has mixed values') && node.type === 'TEXT' && Array.isArray(node.textSegments) && node.textSegments.length) continue;
      warnings.push(`${node.id}: ${warning}`);
    }
    const properties = { ...node.properties };
    // World position changes when a set is moved on the Figma canvas.
    delete properties.absoluteTransform;
    if (standalone && Array.isArray(properties.relativeTransform)) {
      properties.relativeTransform = (properties.relativeTransform as number[][]).map((row) => row.map((v, i) => i === 2 ? 0 : v));
    }
    if (node.type === 'COMPONENT_SET') {
      // Set packing and bounds are editor presentation, not component geometry.
      for (const field of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']) delete properties[field];
    }
    const { children: _children, warnings: _warnings, properties: _properties, fills: _fills, ...rest } = node;
    if (standalone) { delete rest.x; delete rest.y; }
    if (node.type === 'COMPONENT_SET') { delete rest.width; delete rest.height; }
    const childIds = children.map((child) => child.id);
    nodes[node.id] = { ...rest, properties, children: node.type === 'COMPONENT_SET' ? childIds.sort() : childIds };
    for (const child of children) visit(child, node.type === 'COMPONENT_SET');
  };
  for (const tree of Object.values(trees)) visit(tree, true);
  const data = { roots: Object.fromEntries(Object.entries(trees).map(([theme, tree]) => [theme, tree.id])), nodes, ...extra };
  return { schemaVersion: 1, id: digest(data), data, warnings: [...new Set(warnings)] };
}

export function differences(before: unknown, after: unknown, prefix = ''): Difference[] {
  if (stable(before) === stable(after)) return [];
  const path = prefix || '/';
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(before) || !object(after)) return [{ path, kind: 'changed', before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
    const next = `${prefix}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!Object.hasOwn(before, key)) return [{ path: next, kind: 'added' as const, after: after[key] }];
    if (!Object.hasOwn(after, key)) return [{ path: next, kind: 'removed' as const, before: before[key] }];
    return differences(before[key], after[key], next);
  });
}
