import { once } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { startBridgeSocketServer } from '../src/bridge/session.js';

const token = 'a'.repeat(64);

describe('local Figma session', () => {
  it('pairs one plugin and correlates replies by request ID', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      expect(JSON.parse(String((await hello)[0])).type).toBe('hello.ok');

      const message = once(socket, 'message');
      const result = bridge.session.call('file.overview', {});
      const request = JSON.parse(String((await message)[0]));
      expect(request.method).toBe('file.overview');
      socket.send(JSON.stringify({ type: 'plugin.result', requestId: request.requestId, value: { pages: ['A'] } }));
      await expect(result).resolves.toEqual({ pages: ['A'] });
    } finally {
      socket.close();
      await bridge.close();
    }
  });

  it('rejects a wrong token and fails pending calls on disconnect', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const stranger = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(stranger, 'open');
      const closed = once(stranger, 'close');
      stranger.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
      await closed;
      await expect(bridge.session.call('file.overview', {})).rejects.toThrow('NOT_CONNECTED');

      const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      await hello;
      const message = once(socket, 'message');
      const result = bridge.session.call('file.overview', {});
      await message;
      socket.close();
      await expect(result).rejects.toThrow('FIGMA_DISCONNECTED');
    } finally {
      await bridge.close();
    }
  });
});
