import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { readFileKey } from '../src/plugin/file-identity.js';
import { startBridgeSocketServer } from '../src/bridge/session.js';

it('treats restricted, absent and invalid file keys as unavailable', () => {
  expect(readFileKey({ fileKey: 'File_A-123' })).toBe('File_A-123');
  expect(readFileKey({})).toBeUndefined();
  expect(readFileKey({ fileKey: 'file name' })).toBeUndefined();
  expect(readFileKey({ get fileKey(): string { throw new Error('Private API unavailable'); } })).toBeUndefined();
});

it('keeps stable identity across reconnect and never routes a pinned request to a replacement connection', async () => {
  const token = 'a'.repeat(64);
  const bridge = await startBridgeSocketServer({ port: 0, token });
  const sockets: WebSocket[] = [];
  const connect = async (fileKey?: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    sockets.push(socket);
    await once(socket, 'open');
    const hello = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', token, fileName: 'Same name', ...(fileKey ? { fileKey } : {}) }));
    await hello;
    return socket;
  };
  try {
    const first = await connect('original');
    const firstId = bridge.session.listFiles()[0].id;
    const pinned = bridge.session.pinCurrentFile('original');
    const closed = once(first, 'close');
    first.close();
    await closed;
    await connect('original');
    const current = bridge.session.listFiles().find((file) => file.active)!;
    expect(current.fileKey).toBe('original');
    expect(current.id).not.toBe(firstId);
    expect(() => bridge.session.pinCurrentFile('original')).not.toThrow();
    await expect(pinned.call('file.overview', {})).rejects.toThrow('NOT_CONNECTED');
    await connect('copy');
    expect(() => bridge.session.pinCurrentFile('original')).toThrow('FILE_IDENTITY_MISMATCH');
    expect(() => bridge.session.pinCurrentFile('copy')).not.toThrow();
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

it('preserves legacy hello while refusing identity-dependent comparison', async () => {
  const token = 'b'.repeat(64);
  const bridge = await startBridgeSocketServer({ port: 0, token });
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
  try {
    await once(socket, 'open');
    const hello = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', token, fileName: 'Same name' }));
    await hello;
    expect(() => bridge.session.pinCurrentFile()).not.toThrow();
    expect(() => bridge.session.pinCurrentFile('original')).toThrow('FILE_IDENTITY_UNAVAILABLE');
    expect(bridge.session.listFiles()[0]).not.toHaveProperty('fileKey');
  } finally { socket.close(); await bridge.close(); }
});
