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
  assert(tools.some((tool) => tool.name === 'list_connected_files'));
  assert(tools.some((tool) => tool.name === 'get_variables' && tool.annotations?.readOnlyHint === true));
  for (const name of ['list_components', 'plan_theme_conversion']) {
    assert(tools.some(tool => tool.name === name && tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
  }
  assert(tools.some((tool) => tool.name === 'create_component_variants' && tool.annotations?.readOnlyHint === false));
  const themeCopyTool = tools.find(tool => tool.name === 'copy_theme_component');
  assert(themeCopyTool?.annotations?.readOnlyHint === false && themeCopyTool?.annotations?.destructiveHint === false);
  for (const property of ['nodeId', 'layerMap', 'expectedState', 'operationId']) assert(themeCopyTool.inputSchema.properties[property]);
  const duplicateTool = tools.find((tool) => tool.name === 'duplicate_node');
  assert(duplicateTool && duplicateTool.annotations?.readOnlyHint === false);
  assert(duplicateTool.inputSchema.properties.sourceNodeId);
  assert(duplicateTool.inputSchema.properties.layerStyles);
  assert(duplicateTool.inputSchema.properties.expectedState);
  const variantsTool = tools.find((tool) => tool.name === 'create_component_variants');
  assert(variantsTool.inputSchema.properties.componentSetSize);
  assert(variantsTool.inputSchema.properties.newVariantValues);
  const result = await client.callTool({ name: 'get_file_overview', arguments: {} });
  if (result.isError) {
    assert(['NOT_CONNECTED', 'BRIDGE_PORT_BUSY', 'FILE_SELECTION_REQUIRED'].includes(result.content[0]?.text));
  } else {
    assert.equal(typeof JSON.parse(result.content[0]?.text).fileName, 'string');
  }
  console.log('MCP stdio handshake and tool call: OK');
} finally {
  await client.close();
}
