import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBridgeServer } from './mcp.js';
import { BridgeHost } from './host.js';
import { loadOrCreatePairingCode } from './pairing.js';
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';

let syncProject = process.env.FIGMA_SYNC_PROJECT;
if (!syncProject) {
  try {
    const config = z.object({ project: z.string().min(1) }).strict().parse(JSON.parse(await readFile(new URL('../../figma-sync.local.json', import.meta.url), 'utf8')));
    syncProject = config.project;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Invalid local Figma sync configuration');
  }
}
const bridge = new BridgeHost(await loadOrCreatePairingCode(), { syncProject });
void serveStdio(() => {
  const server = createBridgeServer({
    call: (method, args) => bridge.call(method, args),
    pairingCode: bridge.pairingCode,
    confirmDelete: (node) => bridge.confirmDelete(node),
    listFiles: () => bridge.listFiles(),
    activateFile: (file) => bridge.activateFile(file),
    pinCurrentFile: () => bridge.pinCurrentFile(),
    getSync: () => bridge.sync,
  });
  server.server.onclose = () => { void bridge.stop(); };
  return server;
});

await bridge.start();
