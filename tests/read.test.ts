import { expect, it, vi } from 'vitest';
import { getFileOverview, getLocalStyles, getNodePreview, getNodeSvg, getNodeTree } from '../src/plugin/read.js';

it('reports pages and selection without loading other pages', () => {
  const api = {
    root: { name: 'Design file', children: [{ id: '0:1', name: 'Home' }, { id: '0:2', name: 'Archive' }] },
    currentPage: { id: '0:1', name: 'Home', selection: [{ id: '3:4', name: 'Header', type: 'FRAME' }] },
  } as unknown as Parameters<typeof getFileOverview>[0];
  expect(getFileOverview(api)).toEqual({
    fileName: 'Design file',
    pages: [{ id: '0:1', name: 'Home' }, { id: '0:2', name: 'Archive' }],
    currentPageId: '0:1',
    selection: [{ id: '3:4', name: 'Header', type: 'FRAME' }],
  });
});

it('returns a bounded PNG preview', async () => {
  const node = { type: 'FRAME', exportAsync: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodePreview>[0];
  expect(await getNodePreview(api, { nodeId: '3:1', scale: 1 })).toEqual({ mimeType: 'image/png', data: 'iVBORw==' });
  expect(node.exportAsync).toHaveBeenCalledWith({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
});

it('exports a bounded vector node as SVG text', async () => {
  const node = { type: 'VECTOR', exportAsync: vi.fn(async () => '<svg><path /></svg>') };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeSvg>[0];

  expect(await getNodeSvg(api, { nodeId: '3:1' })).toBe('<svg><path /></svg>');
  expect(node.exportAsync).toHaveBeenCalledWith({ format: 'SVG_STRING' });
});

it('lists complete local paint, text, and effect style details', async () => {
  const api = {
    getLocalPaintStylesAsync: vi.fn(async () => [{ id: 'S:1', name: 'Brand', paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.6 }] }]),
    getLocalTextStylesAsync: vi.fn(async () => [{ id: 'S:2', name: 'Heading', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32, lineHeight: { unit: 'PIXELS', value: 40 }, letterSpacing: { unit: 'PIXELS', value: 0.2 } }]),
    getLocalEffectStylesAsync: vi.fn(async () => [{ id: 'S:3', name: 'Shadow', effects: [{ type: 'DROP_SHADOW', radius: 8, spread: 0 }] }]),
  } as unknown as Parameters<typeof getLocalStyles>[0];
  expect(await getLocalStyles(api)).toEqual({
    paints: [{ id: 'S:1', name: 'Brand', colors: ['#ff0000'], paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.6 }] }],
    texts: [{ id: 'S:2', name: 'Heading', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32, properties: { lineHeight: { unit: 'PIXELS', value: 40 }, letterSpacing: { unit: 'PIXELS', value: 0.2 } } }],
    effects: [{ id: 'S:3', name: 'Shadow', effects: [{ type: 'DROP_SHADOW', radius: 8, spread: 0 }] }],
  });
});

it('loads a requested page before reading its children', async () => {
  let loaded = false;
  const page = {
    id: '0:2', name: 'Archive', type: 'PAGE',
    loadAsync: vi.fn(async () => { loaded = true; }),
    get children() {
      if (!loaded) throw new Error('page not loaded');
      return [{ id: '3:1', name: 'Screen', type: 'FRAME', x: 0, y: 0, width: 100, height: 200, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }], children: [] }];
    },
  };
  const api = { getNodeByIdAsync: vi.fn(async () => page) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: '0:2', depth: 1, offset: 0, limit: 10 });
  expect(page.loadAsync).toHaveBeenCalledOnce();
  expect(tree.children).toEqual([expect.objectContaining({ id: '3:1', name: 'Screen', fills: ['#00ff00'] })]);
});

it('preserves CSS-relevant geometry, paint, stroke, and layout properties', async () => {
  const node = {
    id: '3:2', name: 'Primary button', type: 'FRAME', x: 0, y: 0, width: 120, height: 40,
    fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.75 }],
    strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }],
    effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0 }],
    opacity: 0.9, blendMode: 'NORMAL', rotation: 0,
    cornerRadius: 8, topLeftRadius: 8, topRightRadius: 8, bottomLeftRadius: 8, bottomRightRadius: 8,
    strokeWeight: 1, strokeAlign: 'INSIDE',
    layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
    primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER',
    children: [],
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];

  const tree = await getNodeTree(api, { nodeId: '3:2', depth: 1, offset: 0, limit: 10 });

  expect(tree.properties).toMatchObject({
    cornerRadius: 8,
    rectangleCornerRadii: { topLeft: 8, topRight: 8, bottomLeft: 8, bottomRight: 8 },
    opacity: 0.9,
    strokeWeight: 1,
    strokes: [{ type: 'SOLID', opacity: 0.5 }],
    effects: [{ type: 'DROP_SHADOW', radius: 4, spread: 0 }],
    layoutMode: 'HORIZONTAL',
    itemSpacing: 8,
    paddingLeft: 12,
    primaryAxisSizingMode: 'AUTO',
    counterAxisAlignItems: 'CENTER',
  });
  expect(tree.properties?.fills).toEqual([{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.75 }]);
});

it('returns styled text segments and warns when a visual style cannot be represented directly', async () => {
  const node = {
    id: '3:3', name: 'Mixed label', type: 'TEXT', x: 0, y: 0, width: 100, height: 24,
    characters: 'VPN now', fills: Symbol('mixed'), fontSize: Symbol('mixed'), fontName: Symbol('mixed'),
    textAlignHorizontal: 'LEFT', textAlignVertical: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT',
    getStyledTextSegments: vi.fn(() => [{ characters: 'VPN', start: 0, end: 3, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 14, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }]),
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];

  const tree = await getNodeTree(api, { nodeId: '3:3', depth: 0, offset: 0, limit: 10 });

  expect(tree.textSegments).toEqual([{ characters: 'VPN', start: 0, end: 3, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 14, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }]);
  expect(tree.warnings).toContain('fontSize has mixed values; see textSegments');
  expect(tree.properties).toMatchObject({ textAlignHorizontal: 'LEFT', textAlignVertical: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' });
});

it('keeps gradient details and flags image paints that need asset export', async () => {
  const node = {
    id: '3:4', name: 'Gradient card', type: 'RECTANGLE', x: 0, y: 0, width: 80, height: 40,
    fills: [
      { type: 'GRADIENT_LINEAR', opacity: 0.8, gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }] },
      { type: 'IMAGE', imageHash: 'asset-hash', scaleMode: 'CROP', opacity: 1 },
    ],
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];

  const tree = await getNodeTree(api, { nodeId: '3:4', depth: 0, offset: 0, limit: 10 });

  expect(tree.properties?.fills).toEqual(node.fills);
  expect(tree.warnings).toContain('fills contains IMAGE; export or recreate the asset separately');
});

it('warns when requested tree depth omits child nodes', async () => {
  const node = { id: '3:5', name: 'Button', type: 'FRAME', children: [{ id: '3:6', name: 'Label', type: 'TEXT' }] };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];

  const tree = await getNodeTree(api, { nodeId: '3:5', depth: 0, offset: 0, limit: 10 });

  expect(tree.childCount).toBe(1);
  expect(tree.warnings).toContain('children omitted by depth limit; increase depth for complete design data');
});

it('preserves node bindings, inherited modes, and structured component definitions', async () => {
  const node = {
    id: '3:7', name: 'Contradictory name', type: 'COMPONENT', children: [],
    boundVariables: { topLeftRadius: { type: 'VARIABLE_ALIAS', id: 'V:radius' }, paddingLeft: { type: 'VARIABLE_ALIAS', id: 'V:space' } },
    explicitVariableModes: {}, resolvedVariableModes: { 'C:theme': 'dark' },
    variantProperties: { size: '32', state: 'enabled' },
    componentPropertyDefinitions: {
      size: { type: 'VARIANT', defaultValue: '32', variantOptions: ['32', '40'] },
      'label#1': { type: 'TEXT', defaultValue: 'Connect', boundVariables: { defaultValue: { type: 'VARIABLE_ALIAS', id: 'V:label' } } },
      'icon#2': { type: 'BOOLEAN', defaultValue: false },
    },
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: node.id, depth: 0, offset: 0, limit: 10 });
  expect(tree.properties).toMatchObject({
    boundVariables: node.boundVariables,
    explicitVariableModes: {}, resolvedVariableModes: { 'C:theme': 'dark' },
    variantProperties: node.variantProperties, componentPropertyDefinitions: node.componentPropertyDefinitions,
  });
});

it('reads instance definitions from its component set while retaining selected values', async () => {
  const definitions = { size: { type: 'VARIANT', defaultValue: '32', variantOptions: ['32', '40'] } };
  const set = { id: '4:1', name: 'Button', type: 'COMPONENT_SET', key: 'set-key', componentPropertyDefinitions: definitions };
  const main = { id: '4:2', name: 'size=32', type: 'COMPONENT', key: 'main-key', parent: set };
  const node = {
    id: '4:3', name: 'Button instance', type: 'INSTANCE', children: [],
    componentProperties: { size: { type: 'VARIANT', value: '40' } }, variantProperties: { size: '40' },
    getMainComponentAsync: vi.fn(async () => main),
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: node.id, depth: 0, offset: 0, limit: 10 });
  expect(tree.properties).toMatchObject({
    componentProperties: node.componentProperties, variantProperties: { size: '40' },
    componentPropertyDefinitions: definitions,
    componentPropertyDefinitionsSource: { id: set.id, name: 'Button', type: 'COMPONENT_SET', key: 'set-key' },
    mainComponent: { id: main.id, key: 'main-key' },
  });
});

it('reports an inaccessible main component without dropping the instance tree', async () => {
  const node = {
    id: '4:4', name: 'Remote instance', type: 'INSTANCE', children: [],
    componentProperties: { size: { type: 'VARIANT', value: '40' } },
    getMainComponentAsync: vi.fn(async () => null),
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: node.id, depth: 0, offset: 0, limit: 10 });
  expect(tree.properties?.componentProperties).toEqual(node.componentProperties);
  expect(tree.warnings).toContain('main component unavailable; component property definitions could not be read');
});

it('reads a variant schema from its parent set without calling the variant definition getter', async () => {
  const definitions = { size: { type: 'VARIANT', defaultValue: '32', variantOptions: ['32', '40'] } };
  const set = { id: '4:1', name: 'Button', type: 'COMPONENT_SET', key: 'set-key', componentPropertyDefinitions: definitions };
  const node = {
    id: '4:2', name: 'size=40', type: 'COMPONENT', key: 'variant-key', parent: set,
    variantProperties: { size: '40' },
    get componentPropertyDefinitions() { throw new Error('Use the component set'); },
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: node.id, depth: 0, offset: 0, limit: 10 });
  expect(tree.properties).toMatchObject({ variantProperties: { size: '40' }, componentPropertyDefinitions: definitions });
});

it('retains a light variant tree when one API getter fails and reports the original error', async () => {
  const set = { id: '4391:92045', name: 'button light', type: 'COMPONENT_SET', key: 'set-key', componentPropertyDefinitions: {} };
  const node = {
    id: '4391:92046', name: 'type=primary, state=enabled, size=32', type: 'COMPONENT', parent: set,
    cornerRadius: 2, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], children: [],
    get variantProperties() { throw new Error('Component set has existing errors'); },
  };
  const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: node.id, depth: 0, offset: 0, limit: 10 });
  expect(tree.properties).toMatchObject({ cornerRadius: 2, fills: node.fills });
  expect(tree.warnings?.join(' ')).toContain('variantProperties');
  expect(tree.warnings?.join(' ')).toContain('Component set has existing errors');
  expect(tree.properties).not.toHaveProperty('variantProperties');
});

it('preserves the component schema source and exact reason when definitions are inaccessible', async () => {
  const set = {
    id: '4391:92045', name: 'button light', type: 'COMPONENT_SET', key: 'set-key',
    get componentPropertyDefinitions() { throw new Error('Component set has existing errors'); },
  };
  const api = { getNodeByIdAsync: vi.fn(async () => set) } as unknown as Parameters<typeof getNodeTree>[0];
  const tree = await getNodeTree(api, { nodeId: set.id, depth: 0, offset: 0, limit: 10 });
  expect(tree.properties?.componentPropertyDefinitionsSource).toMatchObject({ id: set.id, name: 'button light' });
  expect(tree.warnings?.join(' ')).toContain('Component set has existing errors');
});
