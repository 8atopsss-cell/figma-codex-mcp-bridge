import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBridgeServer } from './mcp.js';
import { startBridgeSocketServer } from './session.js';

const bridge = await startBridgeSocketServer();
void serveStdio(() => {
  const server = createBridgeServer({
    call: (method, args) => bridge.session.call(method, args),
    pairingCode: bridge.pairingCode,
  });
  server.server.onclose = () => { void bridge.close(); };
  return server;
});

console.error(`Figma Codex MCP bridge listening on 127.0.0.1:${bridge.port}`);
