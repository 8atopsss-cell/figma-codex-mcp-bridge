import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBridgeServer } from './mcp.js';
import { BridgeHost } from './host.js';
import { loadOrCreatePairingCode } from './pairing.js';

const bridge = new BridgeHost(await loadOrCreatePairingCode());
void serveStdio(() => {
  const server = createBridgeServer({
    call: (method, args) => bridge.call(method, args),
    pairingCode: bridge.pairingCode,
    confirmDelete: (node) => bridge.confirmDelete(node),
    listFiles: () => bridge.listFiles(),
    activateFile: (file) => bridge.activateFile(file),
    pinCurrentFile: () => bridge.pinCurrentFile(),
  });
  server.server.onclose = () => { void bridge.stop(); };
  return server;
});

await bridge.start();
