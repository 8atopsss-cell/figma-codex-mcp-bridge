import { once } from 'node:events';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { createBridgeServer } from '../src/bridge/mcp.js';
import { startBridgeSocketServer } from '../src/bridge/session.js';

it('routes MCP reads and screen creation through one paired Figma session', async () => {
  const bridge = await startBridgeSocketServer({ port: 0, token: 'a'.repeat(64) });
  const plugin = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
  const server = createBridgeServer({ call: (method, args) => bridge.session.call(method, args) });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await once(plugin, 'open');
    const paired = once(plugin, 'message');
    plugin.send(JSON.stringify({ type: 'hello', token: 'a'.repeat(64) }));
    await paired;
    plugin.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'plugin.call') return;
      const value = message.method === 'file.overview'
        ? { fileName: 'Test file', pages: [{ id: '0:1', name: 'Home' }] }
        : { screenId: '2:1', childIds: [] };
      plugin.send(JSON.stringify({ type: 'plugin.result', requestId: message.requestId, value }));
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const overview = await client.callTool({ name: 'get_file_overview', arguments: {} });
    expect(overview.content).toEqual([{ type: 'text', text: JSON.stringify({ fileName: 'Test file', pages: [{ id: '0:1', name: 'Home' }] }) }]);

    const created = await client.callTool({ name: 'create_screen', arguments: {
      pageId: '0:1', name: 'Landing', x: 0, y: 0, width: 1440, height: 900, children: [],
    } });
    expect(created.content).toEqual([{ type: 'text', text: JSON.stringify({ screenId: '2:1', childIds: [] }) }]);
  } finally {
    await client.close();
    await server.close();
    plugin.close();
    await bridge.close();
  }
});

it('lists named files and lets Codex choose the target without dropping either connection', async () => {
  const bridge = await startBridgeSocketServer({ port: 0, token: 'a'.repeat(64) });
  const sockets = ['First file', 'Second file'].map(() => new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' }));
  const opened = sockets.map((socket) => once(socket, 'open'));
  const server = createBridgeServer({
    call: (method, args) => bridge.session.call(method, args),
    listFiles: () => bridge.session.listFiles(),
    activateFile: (file) => bridge.session.activateFile(file),
    pinCurrentFile: () => bridge.session.pinCurrentFile(),
  });
  const client = new Client({ name: 'multi-file-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    for (const [index, socket] of sockets.entries()) {
      await opened[index];
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token: 'a'.repeat(64), fileName: ['First file', 'Second file'][index] }));
      await hello;
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw));
        if (request.type !== 'plugin.call') return;
        socket.send(JSON.stringify({ type: 'plugin.result', requestId: request.requestId, value: { fileName: ['First file', 'Second file'][index] } }));
      });
    }
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.callTool({ name: 'list_connected_files', arguments: {} });
    expect(listed.isError).not.toBe(true);
    const files = JSON.parse((listed.content[0] as { text: string }).text);
    expect(files.map((file: { name: string }) => file.name)).toEqual(['First file', 'Second file']);

    const selected = await client.callTool({ name: 'select_file', arguments: { file: 'First file' } });
    expect(selected.isError).not.toBe(true);
    const overview = await client.callTool({ name: 'get_file_overview', arguments: {} });
    expect(JSON.parse((overview.content[0] as { text: string }).text).fileName).toBe('First file');
    expect(bridge.session.connectionCount).toBe(2);
  } finally {
    await client.close();
    await server.close();
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});
