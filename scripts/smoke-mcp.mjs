import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'figma-bridge-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/bridge/index.js'],
  cwd: process.cwd(),
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some((tool) => tool.name === 'get_file_overview'));
  const result = await client.callTool({ name: 'get_file_overview', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'NOT_CONNECTED' }]);
  console.log('MCP stdio handshake and tool call: OK');
} finally {
  await client.close();
}
