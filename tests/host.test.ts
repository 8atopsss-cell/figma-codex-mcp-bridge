import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { BridgeHost } from '../src/bridge/host.js';
import { startBridgeSocketServer } from '../src/bridge/session.js';

it('keeps MCP available and binds after another bridge releases the port', async () => {
  const token = 'c'.repeat(64);
  const blocker = await startBridgeSocketServer({ port: 0, token });
  const host = new BridgeHost(token, { port: blocker.port, retryMs: 20 });
  let socket: WebSocket | undefined;
  try {
    await host.start();
    expect(host.status).toBe('waiting');
    await expect(host.call('file.overview', {})).rejects.toThrow('BRIDGE_PORT_BUSY');

    await blocker.close();
    await vi.waitFor(() => expect(host.status).toBe('listening'), { timeout: 1_000 });
    socket = new WebSocket(`ws://127.0.0.1:${blocker.port}`, { origin: 'null' });
    await once(socket, 'open');
    const hello = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', token, fileName: 'Recovered file' }));
    await hello;
    expect(host.listFiles()).toEqual([expect.objectContaining({ name: 'Recovered file' })]);
  } finally {
    socket?.close();
    await host.stop();
    await blocker.close().catch(() => undefined);
  }
});
