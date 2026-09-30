import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createBridgeServer } from '../src/bridge/mcp.js';

describe('MCP bridge', () => {
  it('exposes Figma overview and reports a disconnected file', async () => {
    const server = createBridgeServer({
      call: async () => { throw new Error('NOT_CONNECTED'); },
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('get_file_overview');

      const result = await client.callTool({ name: 'get_file_overview', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'NOT_CONNECTED' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
