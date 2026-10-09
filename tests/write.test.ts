import { describe, expect, it, vi } from 'vitest';
import { createScreen, deleteNode, updateNode } from '../src/plugin/write.js';

const screen = {
  pageId: '0:1', name: 'Home', x: 0, y: 0, width: 1440, height: 900,
  children: [{ type: 'text' as const, name: 'Title', x: 40, y: 30, width: 300, height: 60, characters: 'Hello', fontSize: 32 }],
};

function fakeApi() {
  const page = { id: '0:1', type: 'PAGE', loadAsync: vi.fn(async () => {}), appendChild: vi.fn() };
  const frame = { id: '2:1', type: 'FRAME', x: 0, y: 0, resize: vi.fn(), appendChild: vi.fn(), remove: vi.fn() };
  const text = { id: '2:2', type: 'TEXT', resize: vi.fn(), fontName: { family: 'Inter', style: 'Regular' }, characters: '', remove: vi.fn() };
  const api = {
    getNodeByIdAsync: vi.fn(async () => page),
    createFrame: vi.fn(() => frame),
    createText: vi.fn(() => text),
    loadFontAsync: vi.fn(async () => {}),
  };
  return { api, page, frame, text };
}

describe('Figma writes', () => {
  const nameOnlyTypes = ['COMPONENT', 'COMPONENT_SET', 'GROUP', 'VECTOR', 'INSTANCE', 'ELLIPSE'];

  it.each(nameOnlyTypes)('renames %s without touching other properties or loading fonts', async (type) => {
    const node = { id: '2:3', type, name: 'Original', x: 20, y: 30, width: 40, height: 50,
      fills: [{ type: 'SOLID' }], children: [{ id: '2:4' }], mainComponent: { id: '2:5' } };
    const before = structuredClone(node);
    const loadFontAsync = vi.fn();
    const api = { getNodeByIdAsync: vi.fn(async () => node), loadFontAsync } as unknown as Parameters<typeof updateNode>[0];
    expect(await updateNode(api, { nodeId: node.id, patch: { name: 'Renamed' } })).toEqual({ nodeId: node.id, name: 'Renamed' });
    expect(node).toEqual({ ...before, name: 'Renamed' });
    expect(loadFontAsync).not.toHaveBeenCalled();
  });

  it.each(nameOnlyTypes)('rejects mixed and non-name patches for %s before any mutation', async (type) => {
    const node = { id: '2:3', type, name: 'Original', x: 20, fills: [] };
    const before = structuredClone(node);
    const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof updateNode>[0];
    for (const extra of [{ x: 50 }, { fill: '#ffffff' }, { width: 100 }, { characters: 'Text' }, { layoutMode: 'NONE' }]) {
      await expect(updateNode(api, { nodeId: node.id, patch: { name: 'Changed', ...extra } })).rejects.toThrow('UNSUPPORTED_NODE');
      await expect(updateNode(api, { nodeId: node.id, patch: extra })).rejects.toThrow('UNSUPPORTED_NODE');
      expect(node).toEqual(before);
    }
  });

  it.each(['', 'a'.repeat(201)])('rejects invalid rename input before looking up a node', async (name) => {
    const getNodeByIdAsync = vi.fn();
    const api = { getNodeByIdAsync } as unknown as Parameters<typeof updateNode>[0];
    await expect(updateNode(api, { nodeId: '2:3', patch: { name } })).rejects.toThrow();
    expect(getNodeByIdAsync).not.toHaveBeenCalled();
  });

  it('reports a missing rename target', async () => {
    const api = { getNodeByIdAsync: vi.fn(async () => null) } as unknown as Parameters<typeof updateNode>[0];
    await expect(updateNode(api, { nodeId: 'missing', patch: { name: 'Renamed' } })).rejects.toThrow('NODE_NOT_FOUND');
  });

  it.each(['COMPONENT', 'COMPONENT_SET'])('renames an approved %s without changing its geometry or appearance', async (type) => {
    const node = { id: '14853:131178', type, name: 'type=ghost, state=active, size=32', x: 20, width: 112, fills: [] };
    const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof updateNode>[0];
    const name = 'type=ghost orange, state=active, size=32';
    expect(await updateNode(api, { nodeId: node.id, patch: { name } })).toEqual({ nodeId: node.id, name });
    expect(node).toMatchObject({ name, x: 20, width: 112, fills: [] });
  });

  it('rejects broader component patches before applying a rename', async () => {
    const node = { id: '14853:131178', type: 'COMPONENT', name: 'Original', x: 20 };
    const api = { getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof updateNode>[0];
    await expect(updateNode(api, { nodeId: node.id, patch: { name: 'Changed', x: 50 } })).rejects.toThrow('UNSUPPORTED_NODE');
    expect(node).toMatchObject({ name: 'Original', x: 20 });
  });

  it('creates an editable frame and text after loading the font', async () => {
    const { api, page, frame, text } = fakeApi();
    const result = await createScreen(api as unknown as Parameters<typeof createScreen>[0], screen);
    expect(page.loadAsync).toHaveBeenCalledOnce();
    expect(page.appendChild).toHaveBeenCalledWith(frame);
    expect(api.loadFontAsync).toHaveBeenCalledWith({ family: 'Inter', style: 'Regular' });
    expect(frame.appendChild).toHaveBeenCalledWith(text);
    expect(text.characters).toBe('Hello');
    expect(result).toEqual({ screenId: '2:1', childIds: ['2:2'] });
  });

  it('removes only the new screen if its font is unavailable', async () => {
    const { api, frame } = fakeApi();
    api.loadFontAsync.mockRejectedValueOnce(new Error('missing'));
    await expect(createScreen(api as unknown as Parameters<typeof createScreen>[0], screen)).rejects.toThrow('FONT_UNAVAILABLE');
    expect(frame.remove).toHaveBeenCalledOnce();
  });

  it('restores requested screen position after creating text children', async () => {
    const { api, frame, text } = fakeApi();
    let characters = '';
    Object.defineProperty(text, 'characters', {
      get: () => characters,
      set: (value: string) => {
        characters = value;
        frame.x = -210;
        frame.y = 15;
      },
    });
    await createScreen(api as unknown as Parameters<typeof createScreen>[0], { ...screen, x: 500, y: 100 });
    expect(frame.x).toBe(500);
    expect(frame.y).toBe(100);
  });

  it('loads the existing text font before updating characters', async () => {
    const { api, text } = fakeApi();
    api.getNodeByIdAsync = vi.fn(async () => text as never);
    await updateNode(api as unknown as Parameters<typeof updateNode>[0], { nodeId: '2:2', patch: { characters: 'Updated' } });
    expect(api.loadFontAsync).toHaveBeenCalledWith({ family: 'Inter', style: 'Regular' });
    expect(text.characters).toBe('Updated');
  });

  it('never deletes a page', async () => {
    const { api, page } = fakeApi();
    await expect(deleteNode(api as unknown as Parameters<typeof deleteNode>[0], '0:1')).rejects.toThrow('UNSUPPORTED_NODE');
    expect(page.appendChild).not.toHaveBeenCalled();
  });

  it('does not report deletion success if a node remains in the document tree', async () => {
    const node: any = { id: 'copy', type: 'COMPONENT', removed: false, remove: vi.fn() };
    const page: any = { id: 'page', type: 'PAGE', children: [node] };
    const document: any = { id: 'document', type: 'DOCUMENT', parent: null, children: [page] };
    node.parent = page;
    page.parent = document;
    const api = { getNodeByIdAsync: vi.fn(async () => node) };
    await expect(deleteNode(api as unknown as Parameters<typeof deleteNode>[0], node.id)).rejects.toMatchObject({
      code: 'DELETE_INCOMPLETE', details: { nodeId: 'copy', parentId: 'page' },
    });
  });

  it('recognizes removed library components retained outside the document tree', async () => {
    const node: any = { id: 'copy', type: 'COMPONENT', removed: false, parent: null, remove: vi.fn() };
    node.remove.mockImplementation(() => {
      node.parent = { id: 'deleted', type: 'PAGE', parent: null, children: [node] };
    });
    const api = { getNodeByIdAsync: vi.fn(async () => node) };
    await expect(deleteNode(api as unknown as Parameters<typeof deleteNode>[0], node.id)).resolves.toEqual({ nodeId: 'copy' });
  });
});
