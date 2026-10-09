import { describeError } from './errors.js';

export class VariantError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown>) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = 'VariantError';
  }
}

export function fail(code: string, details: Record<string, unknown>): never {
  throw new VariantError(code, details);
}

// Explicitly snapshot applicable fields. Missing, undefined and mixed stay distinct.
const fields = [
  'visible', 'locked', 'opacity', 'blendMode', 'rotation', 'x', 'y', 'width', 'height',
  'fills', 'strokes', 'strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight',
  'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern', 'effects',
  'cornerRadius', 'cornerSmoothing', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'clipsContent', 'isMask', 'maskType', 'constraints', 'relativeTransform',
  'componentProperties', 'componentPropertyReferences', 'boundVariables', 'explicitVariableModes', 'resolvedVariableModes',
  'layoutMode', 'layoutWrap', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent',
  'strokesIncludedInLayout', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'gridRowCount', 'gridColumnCount', 'gridRowGap', 'gridColumnGap',
  'characters', 'fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'textCase', 'textDecoration',
  'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textTruncation', 'maxLines',
  'paragraphIndent', 'paragraphSpacing', 'indentation', 'listSpacing', 'listOptions', 'textWrapStyle', 'openTypeFeatures', 'hyperlink',
  'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'vectorPaths', 'vectorNetwork',
  'reactions', 'exportSettings', 'description', 'descriptionMarkdown', 'documentationLinks',
] as const;

export function jsonValue(value: unknown, mixed: symbol, depth = 0): unknown {
  if (depth > 32) fail('LIMIT_EXCEEDED', { stage: 'snapshot', reason: 'value nesting' });
  if (value === mixed) return { $figma: 'mixed' };
  if (value === undefined) return { $figma: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, mixed, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, jsonValue((value as Record<string, unknown>)[key], mixed, depth + 1)]));
  fail('INVALID_ARGUMENT', { stage: 'snapshot', reason: `Unsupported value: ${typeof value}` });
}

export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail('INVALID_ARGUMENT', { stage: 'snapshot', reason: 'Non-JSON value' });
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function utf8Length(value: string): number {
  let count = 0;
  for (const char of value) { const code = char.codePointAt(0)!; count += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  return count;
}

export interface NodeSnapshot {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  children: NodeSnapshot[];
}

export function snapshot(node: SceneNode, mixed: symbol, descend = true): NodeSnapshot {
  let count = 0;
  function visit(current: SceneNode, depth: number): NodeSnapshot {
    if (++count > 2000 || depth > 16) fail('LIMIT_EXCEEDED', { stage: 'snapshot', nodeId: current.id });
    if (current.removed) fail('SOURCE_CHANGED', { nodeId: current.id, reason: 'removed' });
    const properties: Record<string, unknown> = {};
    for (const field of fields) {
      if (!(field in current)) continue;
      try { properties[field] = jsonValue((current as unknown as Record<string, unknown>)[field], mixed); }
      catch (error) {
        if (error instanceof VariantError) throw error;
        fail('FIGMA_API_ERROR', { stage: 'snapshot', nodeId: current.id, field, cause: describeError(error) });
      }
    }
    if (current.type === 'TEXT') {
      try {
        properties.textSegments = jsonValue(current.getStyledTextSegments([
          'fontName', 'fontSize', 'fontWeight', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing',
          'fills', 'fillStyleId', 'textStyleId', 'boundVariables', 'hyperlink', 'openTypeFeatures',
        ]), mixed);
      } catch (error) { fail('FIGMA_API_ERROR', { stage: 'snapshot', nodeId: current.id, field: 'textSegments', cause: describeError(error) }); }
    }
    return {
      id: current.id, name: current.name, type: current.type, properties,
      children: descend && 'children' in current ? current.children.map((child) => visit(child, depth + 1)) : [],
    };
  }
  return visit(node, 0);
}

export function indexNodes(node: SceneNode): Map<string, SceneNode> {
  const result = new Map<string, SceneNode>();
  function visit(current: SceneNode, depth: number) {
    if (result.size >= 2000 || depth > 16) fail('LIMIT_EXCEEDED', { stage: 'index', nodeId: current.id });
    result.set(current.id, current);
    if ('children' in current) for (const child of current.children) visit(child, depth + 1);
  }
  visit(node, 0);
  return result;
}

// Deleted library components can remain addressable, with removed=false, on an
// internal page outside the document tree. Only attached document nodes survive.
export function isInDocument(node: BaseNode): boolean {
  let current = node;
  const seen = new Set<string>();
  while (!current.removed && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = current.parent;
    if (!parent) return current.type === 'DOCUMENT';
    if (!('children' in parent) || !parent.children.some((child) => child.id === current.id)) return false;
    current = parent;
  }
  return false;
}
