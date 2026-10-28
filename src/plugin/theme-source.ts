import type { ComponentDescriptor, SlotContent } from '../shared/theme-conversion.js';
import { describeComponent, loadNodePage } from './component-catalog.js';
import { describeError } from './errors.js';
import { fail, indexNodes, isInDocument, jsonValue, stable } from './variant-state.js';

export type ThemeSourceApi = Pick<typeof figma, 'getNodeByIdAsync' | 'mixed'>;
export interface SourceInstance {
  node: InstanceNode; parentInstanceId?: string; main?: ComponentNode; component?: ComponentDescriptor; owner?: ComponentDescriptor;
  error?: string; properties: InstanceNode['componentProperties'];
  texts: Array<{ id: string; characters: string }>; slots: SlotContent[];
}
export function sourceStamp(root: FrameNode | InstanceNode, mixed: symbol) {
  return stable([...indexNodes(root).values()].map(node => {
    const data = node as unknown as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    for (const key of ['visible', 'x', 'y', 'width', 'height', 'characters', 'componentProperties', 'componentPropertyReferences', 'overrides', 'layoutMode']) {
      if (key in data) properties[key] = jsonValue(data[key], mixed);
    }
    return { id: node.id, type: node.type, name: node.name, parentId: node.parent?.id, properties,
      children: 'children' in node ? node.children.map(c => c.id) : [] };
  }));
}

export async function readThemeSource(api: ThemeSourceApi, nodeId: string) {
  const root = await api.getNodeByIdAsync(nodeId);
  if (!root) fail('NODE_NOT_FOUND', { nodeId });
  if ((root.type !== 'FRAME' && root.type !== 'INSTANCE') || root.removed || !isInDocument(root)) fail('UNSUPPORTED_NODE', { nodeId });
  await loadNodePage(root);
  const stamp = sourceStamp(root, api.mixed), instances: SourceInstance[] = [], byId = new Map<string, SourceInstance>();
  const rawSlots: Array<{ node: SceneNode; owner: SourceInstance }> = [];
  async function visit(node: SceneNode, owner?: SourceInstance) {
    if (node.type === 'INSTANCE') {
      const current: SourceInstance = { node, ...(owner ? { parentInstanceId: owner.node.id } : {}),
        properties: node.componentProperties, texts: [], slots: [] };
      instances.push(current); byId.set(node.id, current);
      try {
        const main = await node.getMainComponentAsync();
        if (!main) throw new Error('Main component unavailable');
        if (main.removed || (!main.remote && !isInDocument(main))) throw new Error('Local main component is outside the document');
        current.main = main; current.component = describeComponent(main, api.mixed);
        current.owner = main.parent?.type === 'COMPONENT_SET' ? describeComponent(main.parent, api.mixed) : current.component;
      } catch (error) { current.error = describeError(error); }
      owner = current;
    }
    if (node.type === 'TEXT' && owner) owner.texts.push({ id: node.id, characters: node.characters });
    if (node.type === 'SLOT' && owner) rawSlots.push({ node, owner });
    if ('children' in node) for (const child of node.children) await visit(child, owner);
  }
  await visit(root);
  for (const { node, owner } of rawSlots) {
    const refs = (node as unknown as { componentPropertyReferences?: { slotContentId?: string } }).componentPropertyReferences;
    if (!refs?.slotContentId) continue;
    owner.slots.push({ nodeId: node.id, propertyId: refs.slotContentId, children: ('children' in node ? node.children : []).map(child => {
      const nested = byId.get(child.id);
      return { id: child.id, type: child.type, ...(nested?.component ? { componentKey: nested.component.key } : {}),
        ...(nested?.owner?.type === 'COMPONENT_SET' ? { componentSetKey: nested.owner.key } : {}) };
    }) });
  }
  if (sourceStamp(root, api.mixed) !== stamp) fail('SOURCE_CHANGED', { stage: 'theme-source', nodeId });
  return { root, instances, stamp };
}

export async function assertThemeSourceUnchanged(source: Awaited<ReturnType<typeof readThemeSource>>, api: ThemeSourceApi) {
  for (const instance of source.instances) {
    if (!instance.main) continue;
    const current = await instance.node.getMainComponentAsync();
    if (current?.id !== instance.main.id) fail('SOURCE_CHANGED', { stage: 'theme-source-main', nodeId: instance.node.id });
    if (current && instance.component && stable(describeComponent(current, api.mixed)) !== stable(instance.component)) {
      fail('SOURCE_CHANGED', { stage: 'theme-source-schema', nodeId: instance.node.id });
    }
    if (current && instance.owner) {
      const owner = current.parent?.type === 'COMPONENT_SET' ? current.parent : current;
      if (stable(describeComponent(owner, api.mixed)) !== stable(instance.owner)) fail('SOURCE_CHANGED', { stage: 'theme-source-schema-owner', nodeId: instance.node.id });
    }
  }
  if (sourceStamp(source.root, api.mixed) !== source.stamp) fail('SOURCE_CHANGED', { stage: 'theme-source', nodeId: source.root.id });
}
