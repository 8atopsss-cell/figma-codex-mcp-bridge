import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createBridgeServer } from '../src/bridge/mcp.js';

describe('MCP bridge', () => {
  it('exposes Figma overview and reports a disconnected file', async () => {
    const server = createBridgeServer({
      call: async () => { throw new Error('NOT_CONNECTED'); },
      pairingCode: 'a'.repeat(64),
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('get_file_overview');
      expect(tools.map((tool) => tool.name)).toContain('get_pairing_code');

      const pairing = await client.callTool({ name: 'get_pairing_code', arguments: {} });
      expect(pairing.content).toEqual([{ type: 'text', text: 'a'.repeat(64) }]);

      const result = await client.callTool({ name: 'get_file_overview', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'NOT_CONNECTED' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('forwards tree arguments and returns a PNG as image content', async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const server = createBridgeServer({
      call: async (method, args) => {
        calls.push({ method, args });
        return method === 'node.preview' ? { mimeType: 'image/png', data: 'iVBORw==' } : { id: '3:1', name: 'Screen' };
      },
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: 'get_node_tree', arguments: { nodeId: '3:1' } });
      expect(calls[0]).toEqual({ method: 'node.tree', args: { nodeId: '3:1', depth: 2, offset: 0, limit: 50 } });
      const image = await client.callTool({ name: 'get_node_preview', arguments: { nodeId: '3:1' } });
      expect(image.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('deletes only after the plugin confirms the named node', async () => {
    const calls: string[] = [];
    let accepted = false;
    const server = createBridgeServer({
      call: async (method) => {
        calls.push(method);
        return method === 'node.tree' ? { id: '2:2', name: 'Card', type: 'FRAME' } : { nodeId: '2:2' };
      },
      confirmDelete: async (node) => {
        expect(node).toEqual({ nodeId: '2:2', nodeName: 'Card', nodeType: 'FRAME' });
        if (!accepted) throw new Error('CONFIRMATION_REQUIRED');
      },
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const rejected = await client.callTool({ name: 'delete_node', arguments: { nodeId: '2:2' } });
      expect(rejected.isError).toBe(true);
      expect(calls).toEqual(['node.tree']);
      accepted = true;
      const deleted = await client.callTool({ name: 'delete_node', arguments: { nodeId: '2:2' } });
      expect(deleted.isError).not.toBe(true);
      expect(calls).toEqual(['node.tree', 'node.tree', 'node.delete']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
