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
});
