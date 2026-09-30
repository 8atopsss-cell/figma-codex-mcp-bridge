import { expect, it, vi } from 'vitest';
import { getFileOverview, getLocalStyles, getNodePreview, getNodeTree } from '../src/plugin/read.js';

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

it('lists only local paint and text styles', async () => {
  const api = {
    getLocalPaintStylesAsync: vi.fn(async () => [{ id: 'S:1', name: 'Brand', paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }]),
    getLocalTextStylesAsync: vi.fn(async () => [{ id: 'S:2', name: 'Heading', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32 }]),
  } as unknown as Parameters<typeof getLocalStyles>[0];
  expect(await getLocalStyles(api)).toEqual({
    paints: [{ id: 'S:1', name: 'Brand', colors: ['#ff0000'] }],
    texts: [{ id: 'S:2', name: 'Heading', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32 }],
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
