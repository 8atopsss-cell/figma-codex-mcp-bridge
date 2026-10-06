import type { Difference, Snapshot } from './snapshot.js';

interface Node { id: string; name: string; type: string; children?: string[]; properties?: Record<string, unknown>; [key: string]: unknown }
interface Data { roots: Record<string, string>; nodes: Record<string, Node>; assets?: Record<string, unknown>; sourceThemes?: Record<string, string> }

// Reconstruct only the changed variants from the exact two saved snapshots.
// No editor reads, acceptance writes, or historical-export fallbacks here.
export function previewVariants(before: Snapshot, after: Snapshot, changes: Difference[]) {
  const previous = before.data as unknown as Data, current = after.data as unknown as Data;
  const contexts: Record<string, { name: string; type: string; theme: string; variant: unknown; variantRoot: boolean; variantId?: string }> = {};
  const owners = new Map<string, string>();
  for (const data of [previous, current]) {
    const visit = (id: string, theme: string, variantId?: string) => {
      const node = data.nodes[id];
      if (!node) return;
      const variantRoot = node.type === 'COMPONENT' && !variantId;
      if (variantRoot && node.properties?.variantProperties && typeof node.properties.variantProperties === 'object') {
        const declared = Object.entries(node.properties.variantProperties).find(([key]) => key.toLowerCase() === 'theme')?.[1];
        if (typeof declared === 'string') theme = declared;
      }
      const owner = variantRoot ? id : variantId;
      const root = owner ? data.nodes[owner] : undefined;
      contexts[id] = { name: node.name, type: node.type, theme, variant: root?.properties?.variantProperties ?? {}, variantRoot,
        ...(owner ? { variantId: owner } : {}) };
      if (owner) owners.set(id, owner);
      for (const child of node.children ?? []) visit(child, theme, owner);
    };
    for (const [key, id] of Object.entries(data.roots)) visit(id, data.sourceThemes?.[key] ?? key);
  }
  const affected = new Map<string, Set<string>>();
  for (const change of changes) {
    const [section, id] = change.path.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const ids = ['nodes', 'assets', 'variables'].includes(section) ? [id] : section === 'styles'
      ? [...new Set([...Object.values(previous.nodes), ...Object.values(current.nodes)].filter(node =>
        Object.entries(node.properties ?? {}).some(([key, value]) => key.endsWith('StyleId') && value === id)).map(node => node.id))] : [];
    for (const nodeId of ids) {
      const owner = owners.get(nodeId);
      if (!owner) continue;
      if (!affected.has(owner)) affected.set(owner, new Set());
      affected.get(owner)!.add(nodeId);
    }
  }
  const scene = (data: Data, id: string) => {
    if (!data.nodes[id]) return null;
    const nodes: Record<string, Node> = {}, assets: Record<string, string> = {};
    const visit = (nodeId: string) => {
      const node = data.nodes[nodeId];
      if (!node) return;
      nodes[nodeId] = node;
      const asset = data.assets?.[nodeId];
      if (typeof asset === 'string') assets[nodeId] = asset;
      for (const child of node.children ?? []) visit(child);
    };
    visit(id);
    return { rootId: id, nodes, assets };
  };
  const visibleContexts = new Set([...affected].flatMap(([id, ids]) => [id, ...ids]));
  return { contexts: Object.fromEntries([...visibleContexts].map(id => [id, contexts[id]])), variants: [...affected].map(([id, ids]) => ({ id, context: contexts[id],
    changedNodeIds: [...ids], before: scene(previous, id), after: scene(current, id) })) };
}
