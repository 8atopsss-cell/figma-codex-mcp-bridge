import { describeError } from './errors.js';

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
  properties?: Record<string, unknown>;
  textSegments?: Record<string, unknown>[];
  warnings?: string[];
  children?: NodeTree[];
  childCount?: number;
}

const DESIGN_PROPERTIES = [
  'visible', 'opacity', 'blendMode', 'rotation',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern',
  'effects', 'cornerRadius', 'cornerSmoothing', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'clipsContent', 'isMask', 'maskType', 'constraints',
  'relativeTransform', 'absoluteTransform', 'componentProperties', 'componentPropertyReferences', 'variantProperties',
  'boundVariables', 'explicitVariableModes', 'resolvedVariableModes',
  'layoutMode', 'layoutWrap', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent',
  'strokesIncludedInLayout', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'gridRowCount', 'gridColumnCount', 'gridRowGap', 'gridColumnGap',
  'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textTruncation', 'maxLines', 'fontName', 'fontSize',
  'letterSpacing', 'lineHeight', 'textCase', 'textDecoration', 'paragraphIndent', 'paragraphSpacing', 'indentation',
  'listSpacing', 'listOptions', 'textWrapStyle', 'openTypeFeatures', 'hyperlink', 'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId',
] as const;

const TEXT_SEGMENT_PROPERTIES = [
  'fontName', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'textDecorationStyle', 'textDecorationOffset',
  'textDecorationThickness', 'textDecorationColor', 'textDecorationSkipInk', 'textCase', 'lineHeight', 'letterSpacing',
  'fills', 'textStyleId', 'fillStyleId', 'listOptions', 'listSpacing', 'indentation', 'paragraphIndent', 'paragraphSpacing',
  'textWrapStyle', 'hyperlink', 'openTypeFeatures', 'boundVariables', 'textStyleOverrides',
] as const;

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
    const properties = readDesignProperties(current, result);
    if (Array.isArray(properties.fills)) {
      result.fills = (properties.fills as Paint[]).filter((paint) => paint.type === 'SOLID').map((paint) => rgbToHex(paint.color));
    }
    await readComponentDefinitions(current, properties, result);
    if (Object.keys(properties).length) result.properties = properties;
    if (current.type === 'TEXT') {
      const textSegments = current.getStyledTextSegments([...TEXT_SEGMENT_PROPERTIES]);
      result.textSegments = textSegments.map((segment) => toJsonValue(segment) as Record<string, unknown>);
    }
    const warnings = getDesignWarnings(current, result);
    if (warnings.length) result.warnings = warnings;
    if ('children' in current) {
      const children = current.children;
      result.childCount = children.length;
      if (depth <= 0 && children.length > 0) {
        (result.warnings ??= []).push('children omitted by depth limit; increase depth for complete design data');
      } else if (depth > 0) {
        const selected = root ? children.slice(args.offset, args.offset + args.limit) : children.slice(0, Math.min(50, remaining));
        result.children = [];
        for (const child of selected) {
          if (remaining <= 0) break;
          remaining--;
          result.children.push(await serialize(child, depth - 1, false));
        }
        if (selected.length < children.length || remaining <= 0 && selected.length > 0) {
          (result.warnings ??= []).push('children omitted by node limit; request remaining nodes for complete design data');
        }
      }
    }
    if (result.warnings?.length) result.warnings = [...new Set(result.warnings)];
    return result;
  };
  return serialize(node, args.depth, true);
}

async function readComponentDefinitions(current: BaseNode, properties: Record<string, unknown>, result: NodeTree) {
  if (current.type !== 'INSTANCE' && current.type !== 'COMPONENT' && current.type !== 'COMPONENT_SET') return;
  try {
    const main = current.type === 'INSTANCE' ? await current.getMainComponentAsync() : current;
    if (!main) throw new Error('MAIN_COMPONENT_UNAVAILABLE');
    if (current.type === 'INSTANCE') properties.mainComponent = { id: main.id, name: main.name, key: main.key };
    const source = main.parent?.type === 'COMPONENT_SET' ? main.parent : main;
    properties.componentPropertyDefinitionsSource = { id: source.id, name: source.name, type: source.type, key: source.key };
    properties.componentPropertyDefinitions = toJsonValue(source.componentPropertyDefinitions);
  } catch (error) {
    (result.warnings ??= []).push(current.type === 'INSTANCE' && !properties.mainComponent
      ? 'main component unavailable; component property definitions could not be read'
      : 'component property definitions unavailable');
    const sourceId = (properties.componentPropertyDefinitionsSource as { id: string } | undefined)?.id ?? current.id;
    (result.warnings ??= []).push(`componentPropertyDefinitions on ${sourceId}: ${describeError(error)}`);
  }
}

function readDesignProperties(current: BaseNode, result: NodeTree): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const warnings: string[] = result.warnings ?? (result.warnings = []);
  const source = current as unknown as Record<string, unknown>;
  for (const name of DESIGN_PROPERTIES) {
    try {
      if (!(name in current)) continue;
      const value = source[name];
      if (typeof value === 'symbol') {
        warnings.push(`${name} has mixed values${current.type === 'TEXT' ? '; see textSegments' : ''}`);
        continue;
      }
      const serialized = toJsonValue(value);
      if (serialized !== undefined) properties[name] = serialized;
    } catch (error) {
      warnings.push(`${name} unavailable on ${current.id}: ${describeError(error)}`);
    }
  }
  if ('topLeftRadius' in properties || 'topRightRadius' in properties || 'bottomLeftRadius' in properties || 'bottomRightRadius' in properties) {
    properties.rectangleCornerRadii = {
      topLeft: properties.topLeftRadius,
      topRight: properties.topRightRadius,
      bottomLeft: properties.bottomLeftRadius,
      bottomRight: properties.bottomRightRadius,
    };
  }
  return properties;
}

function getDesignWarnings(current: BaseNode, result: NodeTree): string[] {
  const warnings: string[] = result.warnings ?? [];
  const properties = result.properties ?? {};
  for (const field of ['fills', 'strokes'] as const) {
    const paints = properties[field];
    if (!Array.isArray(paints)) continue;
    for (const paint of paints) {
      if (!paint || typeof paint !== 'object' || !('type' in paint)) continue;
      const type = paint.type;
      if (type === 'IMAGE' || type === 'VIDEO' || type === 'PATTERN') warnings.push(`${field} contains ${type}; export or recreate the asset separately`);
      if (type === 'SHADER') warnings.push(`${field} contains SHADER paint; no direct CSS equivalent`);
      if (type === 'GRADIENT_ANGULAR' || type === 'GRADIENT_DIAMOND') warnings.push(`${field} contains ${type}; CSS rendering may differ from Figma`);
    }
  }
  const effects = properties.effects;
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (!effect || typeof effect !== 'object' || !('type' in effect)) continue;
      if (!['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'].includes(String(effect.type))) {
        warnings.push(`effect ${String(effect.type)} has no direct CSS equivalent`);
      }
    }
  }
  if (current.type === 'VECTOR' || current.type === 'BOOLEAN_OPERATION') warnings.push(`${current.type} requires SVG or asset export for exact rendering`);
  return [...new Set(warnings)];
}

export function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue).filter((item) => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const serialized = toJsonValue(item);
    if (serialized !== undefined) result[key] = serialized;
  }
  return result;
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

export async function getNodeSvg(
  api: Pick<typeof figma, 'getNodeByIdAsync'>,
  args: { nodeId: string },
): Promise<string> {
  const node = await api.getNodeByIdAsync(args.nodeId);
  if (!node) throw new Error('NODE_NOT_FOUND');
  if (!('exportAsync' in node)) throw new Error('UNSUPPORTED_NODE');
  const svg = await node.exportAsync({ format: 'SVG_STRING' });
  if (typeof svg !== 'string') throw new Error('UNSUPPORTED_NODE');
  if (svg.length > 2 * 1024 * 1024) throw new Error('SVG_TOO_LARGE');
  return svg;
}

export async function getLocalStyles(
  api: Pick<typeof figma, 'getLocalPaintStylesAsync' | 'getLocalTextStylesAsync' | 'getLocalEffectStylesAsync'>,
) {
  const [paints, texts, effects] = await Promise.all([
    api.getLocalPaintStylesAsync(),
    api.getLocalTextStylesAsync(),
    api.getLocalEffectStylesAsync(),
  ]);
  return {
    paints: paints.slice(0, 500).map((style) => ({
      id: style.id,
      name: style.name,
      colors: style.paints.filter((paint) => paint.type === 'SOLID').map((paint) => rgbToHex(paint.color)),
      paints: toJsonValue(style.paints),
    })),
    texts: texts.slice(0, 500).map((style) => ({
      id: style.id,
      name: style.name,
      fontName: style.fontName,
      fontSize: style.fontSize,
      properties: pickJsonProperties(style, [
        'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'paragraphIndent', 'paragraphSpacing',
        'textAlignHorizontal', 'textAlignVertical', 'listOptions', 'listSpacing', 'indentation', 'textAutoResize', 'textTruncation',
      ]),
    })),
    effects: effects.slice(0, 500).map((style) => ({ id: style.id, name: style.name, effects: toJsonValue(style.effects) })),
  };
}

function pickJsonProperties(source: object, names: readonly string[]): Record<string, unknown> {
  const values = source as Record<string, unknown>;
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    const value = toJsonValue(values[name]);
    if (value !== undefined) properties[name] = value;
  }
  return properties;
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
