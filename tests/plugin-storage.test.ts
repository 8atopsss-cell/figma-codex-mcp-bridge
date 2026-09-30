import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('stores an accepted pairing for the next plugin launch and clears a rejected one', async () => {
  const storage = new Map<string, unknown>();
  const posted: unknown[] = [];
  const plugin = {
    showUI: vi.fn(),
    root: { name: 'First file' },
    ui: { onmessage: undefined as ((value: unknown) => Promise<void>) | undefined, postMessage: (value: unknown) => posted.push(value) },
    clientStorage: {
      getAsync: async (key: string) => storage.get(key),
      setAsync: async (key: string, value: unknown) => { storage.set(key, value); },
      deleteAsync: async (key: string) => { storage.delete(key); },
    },
  };
  vi.stubGlobal('figma', plugin);
  vi.stubGlobal('__html__', '<html></html>');
  await import('../src/plugin/main.js');
  const send = plugin.ui.onmessage!;
  const token = 'b'.repeat(64);

  await send({ type: 'pairing.load' });
  expect(posted.pop()).toEqual({ type: 'pairing.saved', token: null, fileName: 'First file' });
  await send({ type: 'pairing.save', token });
  await send({ type: 'pairing.load' });
  expect(posted.pop()).toEqual({ type: 'pairing.saved', token, fileName: 'First file' });
  await send({ type: 'pairing.clear' });
  await send({ type: 'pairing.load' });
  expect(posted.pop()).toEqual({ type: 'pairing.saved', token: null, fileName: 'First file' });
});
