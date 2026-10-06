import { screenSpecSchema, updateNodeSchema, type NodeSpec } from '../shared/protocol.js';

type WriteApi = Pick<typeof figma, 'getNodeByIdAsync' | 'createPage' | 'createFrame' | 'createText' | 'createRectangle' | 'loadFontAsync' | 'mixed'>;
type CreatedNode = FrameNode | TextNode | RectangleNode;

export function createPage(api: Pick<WriteApi, 'createPage'>, name: string) {
  if (!name || name.length > 200) throw new Error('INVALID_ARGUMENT');
  const page = api.createPage();
  page.name = name;
  return { pageId: page.id };
}

export async function createScreen(api: WriteApi, input: unknown) {
  const spec = screenSpecSchema.parse(input);
  const page = await api.getNodeByIdAsync(spec.pageId);
  if (!page) throw new Error('NODE_NOT_FOUND');
  if (page.type !== 'PAGE') throw new Error('UNSUPPORTED_NODE');
  await page.loadAsync();

  const created: CreatedNode[] = [];
  const childIds: string[] = [];
  try {
    const root = api.createFrame();
    created.push(root);
    page.appendChild(root);
    applyCommon(root, spec);
    applyFrameLayout(root, spec);
    for (const child of spec.children) await createChild(api, root, child, created, childIds);
    root.x = spec.x;
    root.y = spec.y;
    return { screenId: root.id, childIds };
  } catch (error) {
    for (const node of created.reverse()) {
      try { if (!node.removed) node.remove(); } catch { /* Continue cleaning other new nodes. */ }
    }
    if (error instanceof Error && error.message === 'FONT_UNAVAILABLE') throw error;
    throw error;
  }
}

async function createChild(
  api: WriteApi,
  parent: FrameNode,
  spec: NodeSpec,
  created: CreatedNode[],
  childIds: string[],
): Promise<void> {
  const node = spec.type === 'frame' ? api.createFrame()
    : spec.type === 'text' ? api.createText()
    : api.createRectangle();
  created.push(node);
  parent.appendChild(node);
  applyCommon(node, spec);
  childIds.push(node.id);
  if (spec.type === 'frame' && node.type === 'FRAME') {
    applyFrameLayout(node, spec);
    for (const child of spec.children ?? []) await createChild(api, node, child, created, childIds);
  } else if (spec.type === 'text' && node.type === 'TEXT') {
    const font = { family: spec.fontFamily ?? 'Inter', style: spec.fontStyle ?? 'Regular' };
    await loadFont(api, font);
    node.fontName = font;
    node.characters = spec.characters ?? '';
    if (spec.fontSize !== undefined) node.fontSize = spec.fontSize;
  } else if (spec.type === 'rectangle' && node.type === 'RECTANGLE' && spec.cornerRadius !== undefined) {
    node.cornerRadius = spec.cornerRadius;
  }
}

export async function updateNode(api: WriteApi, input: unknown) {
  const { nodeId, patch } = updateNodeSchema.parse(input);
  const node = await api.getNodeByIdAsync(nodeId);
  if (!node) throw new Error('NODE_NOT_FOUND');
  const supportsNameOnly = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET'
    || node.type === 'GROUP' || node.type === 'VECTOR' || node.type === 'INSTANCE' || node.type === 'ELLIPSE';
  if (supportsNameOnly && patch.name !== undefined && Object.keys(patch).length === 1) {
    node.name = patch.name;
    return { nodeId: node.id, name: node.name };
  }
  if (node.type !== 'FRAME' && node.type !== 'TEXT' && node.type !== 'RECTANGLE') throw new Error('UNSUPPORTED_NODE');
  if ((patch.characters !== undefined || patch.fontSize !== undefined) && node.type !== 'TEXT') throw new Error('UNSUPPORTED_NODE');
  if ((patch.layoutMode !== undefined || patch.itemSpacing !== undefined) && node.type !== 'FRAME') throw new Error('UNSUPPORTED_NODE');

  if (node.type === 'TEXT' && (patch.characters !== undefined || patch.fontSize !== undefined)) {
    const fonts = node.fontName === api.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
    for (const font of fonts) await loadFont(api, font);
  }
  if (patch.name !== undefined) node.name = patch.name;
  if (patch.x !== undefined) node.x = patch.x;
  if (patch.y !== undefined) node.y = patch.y;
  if (patch.width !== undefined || patch.height !== undefined) node.resize(patch.width ?? node.width, patch.height ?? node.height);
  if (patch.fill !== undefined) node.fills = [solidPaint(patch.fill)];
  if (node.type === 'FRAME') {
    if (patch.layoutMode !== undefined) node.layoutMode = patch.layoutMode;
    if (patch.itemSpacing !== undefined) node.itemSpacing = patch.itemSpacing;
  }
  if (node.type === 'TEXT') {
    if (patch.characters !== undefined) node.characters = patch.characters;
    if (patch.fontSize !== undefined) node.fontSize = patch.fontSize;
  }
  return { nodeId: node.id, name: node.name };
}

export async function deleteNode(api: Pick<WriteApi, 'getNodeByIdAsync'>, nodeId: string) {
  const node = await api.getNodeByIdAsync(nodeId);
  if (!node) throw new Error('NODE_NOT_FOUND');
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error('UNSUPPORTED_NODE');
  node.remove();
  return { nodeId };
}

function applyCommon(node: CreatedNode, spec: Pick<NodeSpec, 'name' | 'x' | 'y' | 'width' | 'height' | 'fill'>) {
  node.name = spec.name;
  node.resize(spec.width, spec.height);
  node.x = spec.x;
  node.y = spec.y;
  if (spec.fill) node.fills = [solidPaint(spec.fill)];
}

function applyFrameLayout(node: FrameNode, spec: Pick<NodeSpec, 'layoutMode' | 'itemSpacing' | 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom'>) {
  if (spec.layoutMode !== undefined) node.layoutMode = spec.layoutMode;
  if (spec.itemSpacing !== undefined) node.itemSpacing = spec.itemSpacing;
  if (spec.paddingLeft !== undefined) node.paddingLeft = spec.paddingLeft;
  if (spec.paddingRight !== undefined) node.paddingRight = spec.paddingRight;
  if (spec.paddingTop !== undefined) node.paddingTop = spec.paddingTop;
  if (spec.paddingBottom !== undefined) node.paddingBottom = spec.paddingBottom;
}

async function loadFont(api: Pick<WriteApi, 'loadFontAsync'>, font: FontName) {
  try { await api.loadFontAsync(font); } catch { throw new Error('FONT_UNAVAILABLE'); }
}

function solidPaint(hex: string): SolidPaint {
  return {
    type: 'SOLID',
    color: {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255,
    },
  };
}
