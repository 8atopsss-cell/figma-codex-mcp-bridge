import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBridgeServer } from './mcp.js';
import { startBridgeSocketServer } from './session.js';
import { loadOrCreatePairingCode } from './pairing.js';

const bridge = await startBridgeSocketServer({ token: await loadOrCreatePairingCode() });
void serveStdio(() => {
  const server = createBridgeServer({
    call: (method, args) => bridge.session.call(method, args),
    pairingCode: bridge.pairingCode,
    confirmDelete: (node) => bridge.session.confirmDelete(node),
    listFiles: () => bridge.session.listFiles(),
    activateFile: (file) => bridge.session.activateFile(file),
    pinCurrentFile: () => bridge.session.pinCurrentFile(),
  });
  server.server.onclose = () => { void bridge.close(); };
  return server;
});

console.error(`Figma Codex MCP bridge listening on 127.0.0.1:${bridge.port}`);
