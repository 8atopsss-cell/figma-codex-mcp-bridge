import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { confirmationReplySchema, confirmationRequestSchema, pluginReplySchema, pluginRequestSchema } from '../shared/protocol.js';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set(['null', 'https://www.figma.com', 'https://figma.com']);

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class BridgeSession {
  private plugin: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly confirmations = new Map<string, Pending>();

  attach(plugin: WebSocket): boolean {
    if (this.plugin?.readyState === WebSocket.OPEN) return false;
    if (this.plugin) this.failPending('FIGMA_DISCONNECTED');
    this.plugin = plugin;
    plugin.on('message', (raw) => {
      if (this.plugin === plugin) this.receive(String(raw));
    });
    plugin.on('close', () => {
      if (this.plugin !== plugin) return;
      this.plugin = undefined;
      this.failPending('FIGMA_DISCONNECTED');
    });
    plugin.send(JSON.stringify({ type: 'hello.ok' }));
    return true;
  }

  call(method: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    const plugin = this.plugin;
    if (!plugin || plugin.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NOT_CONNECTED'));
    const requestId = randomUUID();
    const request = pluginRequestSchema.parse({ type: 'plugin.call', requestId, method, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      plugin.send(JSON.stringify(request), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(new Error('FIGMA_DISCONNECTED'));
      });
    });
  }

  confirmDelete(node: { nodeId: string; nodeName: string; nodeType: string }): Promise<void> {
    const plugin = this.plugin;
    if (!plugin || plugin.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NOT_CONNECTED'));
    if (this.confirmations.size > 0) return Promise.reject(new Error('CONFIRMATION_REQUIRED'));
    const confirmationId = randomUUID();
    const request = confirmationRequestSchema.parse({ type: 'confirmation.request', confirmationId, ...node });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.confirmations.delete(confirmationId);
        reject(new Error('CONFIRMATION_REQUIRED'));
      }, 60_000);
      this.confirmations.set(confirmationId, { resolve: () => resolve(), reject, timer });
      plugin.send(JSON.stringify(request), (error) => {
        if (!error) return;
        const pending = this.confirmations.get(confirmationId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.confirmations.delete(confirmationId);
        reject(new Error('FIGMA_DISCONNECTED'));
      });
    });
  }

  disconnect(): void {
    this.plugin?.terminate();
    this.plugin = undefined;
    this.failPending('FIGMA_DISCONNECTED');
  }

  private receive(raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    const confirmation = confirmationReplySchema.safeParse(parsed);
    if (confirmation.success) {
      const pending = this.confirmations.get(confirmation.data.confirmationId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.confirmations.delete(confirmation.data.confirmationId);
      if (confirmation.data.accepted) pending.resolve(undefined);
      else pending.reject(new Error('CONFIRMATION_REQUIRED'));
      return;
    }
    const reply = pluginReplySchema.safeParse(parsed);
    if (!reply.success) return;
    const pending = this.pending.get(reply.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.data.requestId);
    if (reply.data.type === 'plugin.error') pending.reject(new Error(reply.data.code));
    else pending.resolve(reply.data.value);
  }

  private failPending(code: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
      this.pending.delete(requestId);
    }
    for (const [confirmationId, pending] of this.confirmations) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
      this.confirmations.delete(confirmationId);
    }
  }
}

export interface SocketServerOptions { port?: number; token?: string }

export async function startBridgeSocketServer(options: SocketServerOptions = {}) {
  const pairingCode = options.token ?? randomBytes(32).toString('hex');
  const session = new BridgeSession();
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port ?? 3846,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: (info, done) => done(ALLOWED_ORIGINS.has(info.origin), 403),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', (socket) => {
    const timer = setTimeout(() => socket.close(1008, 'Pairing timed out'), 5_000);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      let hello: unknown;
      try { hello = JSON.parse(String(raw)); } catch { socket.close(1008, 'Invalid hello'); return; }
      if (!isValidHello(hello, pairingCode)) { socket.close(1008, 'Invalid pairing code'); return; }
      if (!session.attach(socket)) socket.close(1013, 'Another Figma file is connected');
    });
    socket.once('close', () => clearTimeout(timer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebSocket server has no port');
  return {
    session,
    pairingCode,
    port: address.port,
    close: async () => {
      session.disconnect();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function isValidHello(value: unknown, token: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const hello = value as Record<string, unknown>;
  if (hello.type !== 'hello' || typeof hello.token !== 'string') return false;
  const actual = Buffer.from(hello.token);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
