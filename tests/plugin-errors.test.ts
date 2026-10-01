import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('includes the original Figma exception and requested node in an API error', async () => {
  const messages: unknown[] = [];
  const api = {
    showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    getNodeByIdAsync: vi.fn(async () => { throw new Error('in getNodeByIdAsync: Invalid node ID'); }),
  };
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'r1', method: 'node.svg', args: { nodeId: 'I4391:92047;1900:44734;1893:44709' } });
  expect(messages).toEqual([{
    type: 'plugin.error', requestId: 'r1', code: 'FIGMA_API_ERROR',
    message: 'node.svg I4391:92047;1900:44734;1893:44709: in getNodeByIdAsync: Invalid node ID',
  }]);
});
