import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBridgeServer } from './mcp.js';

void serveStdio(() => createBridgeServer({
  call: async () => { throw new Error('NOT_CONNECTED'); },
}));

console.error('Figma Codex MCP bridge started; Figma connection is not implemented yet.');
