import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as z from 'zod/v4';
import { SyncController } from './controller.js';

const action = z.object({ componentId: z.string().min(1).max(80) }).strict();
const accept = action.extend({ snapshotId: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
const bind = z.object({ fileKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), connectionId: z.string().uuid(), componentId: z.string().min(1).max(80).optional() }).strict();
const origins = new Set([6006, 6007, 6008].flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]));

export async function startSyncHttp(controller: SyncController, port = 3847) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin) || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'ORIGIN_NOT_ALLOWED' })); return;
    }
    if (req.headers.host !== `127.0.0.1:${server.address() && typeof server.address() === 'object' ? (server.address() as { port: number }).port : port}`) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'HOST_NOT_ALLOWED' })); return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Figma-Sync-Project');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.writeHead(204); res.end(); return;
    }
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${controller.accessCode}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'SYNC_ACCESS_CODE_REQUIRED' })); return;
    }
    try {
      const expectedProject = req.headers['x-figma-sync-project'];
      if (expectedProject !== undefined) {
        if (typeof expectedProject !== 'string' || !/^[a-z0-9-]{1,80}$/.test(expectedProject)) throw new Error('INVALID_PROJECT_ID');
        await controller.assertProject(expectedProject);
      }
      if (req.method === 'GET' && req.url === '/sync/components') { res.end(JSON.stringify(await controller.list())); return; }
      if (req.method === 'GET' && req.url?.startsWith('/sync/previews?')) {
        const query = new URL(req.url, 'http://127.0.0.1').searchParams;
        const data = action.parse(Object.fromEntries(query));
        res.end(JSON.stringify(await controller.previews(data.componentId))); return;
      }
      if (req.method !== 'POST' || !['/sync/compare', '/sync/accept', '/sync/bind'].includes(req.url ?? '')) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'NOT_FOUND' })); return;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON_REQUIRED');
      let body = ''; let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) throw new Error('REQUEST_TOO_LARGE');
        body += String(chunk);
      }
      const value = JSON.parse(body);
      let result: unknown;
      if (req.url === '/sync/compare') { const data = action.parse(value); result = await controller.compare(data.componentId); }
      else if (req.url === '/sync/accept') { const data = accept.parse(value); result = await controller.accept(data.componentId, data.snapshotId, data.revision); }
      else { const data = bind.parse(value); result = await controller.bind(data.fileKey, data.connectionId, data.componentId); }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(409);
      const code = error instanceof z.ZodError ? 'INVALID_REQUEST' : error instanceof Error ? error.message : 'SYNC_ERROR';
      res.end(JSON.stringify({ error: code.slice(0, 160) }));
    }
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
