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
