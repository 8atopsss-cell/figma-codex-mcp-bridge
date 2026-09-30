type OverviewApi = {
  root: { name: string; children: ReadonlyArray<{ id: string; name: string }> };
  currentPage: { id: string; selection: ReadonlyArray<{ id: string; name: string; type: string }> };
};

export function getFileOverview(api: OverviewApi) {
  return {
    fileName: api.root.name,
    pages: api.root.children.map((page) => ({ id: page.id, name: page.name })),
    currentPageId: api.currentPage.id,
    selection: api.currentPage.selection.map((node) => ({ id: node.id, name: node.name, type: node.type })),
  };
}

export interface NodeTree {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  characters?: string;
  fills?: string[];
  children?: NodeTree[];
  childCount?: number;
}

export async function getNodeTree(
  api: Pick<typeof figma, 'getNodeByIdAsync'>,
  args: { nodeId: string; depth: number; offset: number; limit: number },
): Promise<NodeTree> {
  const node = await api.getNodeByIdAsync(args.nodeId);
  if (!node) throw new Error('NODE_NOT_FOUND');
  let remaining = 200;
  const serialize = async (current: BaseNode, depth: number, root: boolean): Promise<NodeTree> => {
    if (current.type === 'PAGE') await current.loadAsync();
    const result: NodeTree = { id: current.id, name: current.name, type: current.type };
    if ('x' in current) result.x = current.x;
    if ('y' in current) result.y = current.y;
    if ('width' in current) result.width = current.width;
    if ('height' in current) result.height = current.height;
    if (current.type === 'TEXT') result.characters = current.characters;
    if ('fills' in current && Array.isArray(current.fills)) {
      result.fills = current.fills.filter((paint) => paint.type === 'SOLID').map((paint) => rgbToHex(paint.color));
    }
    if (depth > 0 && 'children' in current) {
      const children = current.children;
      result.childCount = children.length;
      const selected = root ? children.slice(args.offset, args.offset + args.limit) : children.slice(0, Math.min(50, remaining));
      result.children = [];
      for (const child of selected) {
        if (remaining <= 0) break;
        remaining--;
        result.children.push(await serialize(child, depth - 1, false));
      }
    }
    return result;
  };
  return serialize(node, args.depth, true);
}

export async function getNodePreview(
  api: Pick<typeof figma, 'getNodeByIdAsync'>,
  args: { nodeId: string; scale: number },
) {
  const node = await api.getNodeByIdAsync(args.nodeId);
  if (!node) throw new Error('NODE_NOT_FOUND');
  if (!('exportAsync' in node)) throw new Error('UNSUPPORTED_NODE');
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: args.scale } });
  if (bytes.length > 2 * 1024 * 1024) throw new Error('PREVIEW_TOO_LARGE');
  return { mimeType: 'image/png', data: encodeBase64(bytes) };
}

export async function getLocalStyles(
  api: Pick<typeof figma, 'getLocalPaintStylesAsync' | 'getLocalTextStylesAsync'>,
) {
  const [paints, texts] = await Promise.all([api.getLocalPaintStylesAsync(), api.getLocalTextStylesAsync()]);
  return {
    paints: paints.slice(0, 500).map((style) => ({
      id: style.id,
      name: style.name,
      colors: style.paints.filter((paint) => paint.type === 'SOLID').map((paint) => rgbToHex(paint.color)),
    })),
    texts: texts.slice(0, 500).map((style) => ({
      id: style.id,
      name: style.name,
      fontName: style.fontName,
      fontSize: style.fontSize,
    })),
  };
}

function rgbToHex(color: RGB): string {
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    result += alphabet[a >> 2];
    result += alphabet[((a & 3) << 4) | (b >> 4)];
    result += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    result += index + 2 < bytes.length ? alphabet[c & 63] : '=';
  }
  return result;
}
