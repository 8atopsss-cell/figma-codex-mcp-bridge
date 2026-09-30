import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { confirmationReplySchema, confirmationRequestSchema, pluginReplySchema, pluginRequestSchema } from '../shared/protocol.js';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set(['null', 'https://www.figma.com', 'https://figma.com']);

type Pending = { connectionId: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Connection = { socket: WebSocket; fileName: string; visible: boolean };

export class BridgeSession {
  private readonly connections = new Map<string, Connection>();
  private activeId: string | undefined;
  private manualId: string | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly confirmations = new Map<string, Pending>();

  get connectionCount(): number { return this.connections.size; }

  attach(plugin: WebSocket, fileName = 'Figma file'): string {
    const connectionId = randomUUID();
    this.connections.set(connectionId, { socket: plugin, fileName, visible: true });
    this.activeId = connectionId;
    this.manualId = undefined;
    plugin.on('message', (raw) => {
      if (this.connections.get(connectionId)?.socket === plugin) this.receive(connectionId, String(raw));
    });
    plugin.on('close', () => {
      if (this.connections.get(connectionId)?.socket !== plugin) return;
      this.connections.delete(connectionId);
      if (this.activeId === connectionId) this.activeId = undefined;
      if (this.manualId === connectionId) this.manualId = undefined;
      this.failPending('FIGMA_DISCONNECTED', connectionId);
    });
    plugin.send(JSON.stringify({ type: 'hello.ok' }));
    return connectionId;
  }

  listFiles(): Array<{ id: string; name: string; active: boolean; visible: boolean }> {
    const activeId = this.effectiveActiveId();
    return [...this.connections].map(([id, connection]) => ({
      id, name: connection.fileName, active: id === activeId, visible: connection.visible,
    }));
  }

  activateFile(file: string): void {
    const matches = [...this.connections].filter(([id, connection]) => id === file || connection.fileName === file);
    if (matches.length > 1) throw new Error('AMBIGUOUS_FILE_NAME');
    const connectionId = matches[0]?.[0];
    const connection = this.connections.get(connectionId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) throw new Error('FILE_NOT_CONNECTED');
    connection.visible = true;
    this.activeId = connectionId;
    this.manualId = connectionId;
  }

  pinCurrentFile() {
    const connectionId = this.currentId();
    return {
      call: (method: string, args: unknown) => this.callOn(connectionId, method, args),
      confirmDelete: (node: { nodeId: string; nodeName: string; nodeType: string }) => this.confirmDeleteOn(connectionId, node),
    };
  }

  call(method: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    try { return this.callOn(this.currentId(), method, args, timeoutMs); }
    catch (error) { return Promise.reject(error); }
  }

  callOn(connectionId: string, method: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    const plugin = this.connections.get(connectionId)?.socket;
    if (!plugin || plugin.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NOT_CONNECTED'));
    const requestId = randomUUID();
    const request = pluginRequestSchema.parse({ type: 'plugin.call', requestId, method, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      this.pending.set(requestId, { connectionId, resolve, reject, timer });
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
    try { return this.confirmDeleteOn(this.currentId(), node); }
    catch (error) { return Promise.reject(error); }
  }

  confirmDeleteOn(connectionId: string, node: { nodeId: string; nodeName: string; nodeType: string }): Promise<void> {
    const plugin = this.connections.get(connectionId)?.socket;
    if (!plugin || plugin.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NOT_CONNECTED'));
    if ([...this.confirmations.values()].some((pending) => pending.connectionId === connectionId)) {
      return Promise.reject(new Error('CONFIRMATION_REQUIRED'));
    }
    const confirmationId = randomUUID();
    const request = confirmationRequestSchema.parse({ type: 'confirmation.request', confirmationId, ...node });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.confirmations.delete(confirmationId);
        reject(new Error('CONFIRMATION_REQUIRED'));
      }, 60_000);
      this.confirmations.set(confirmationId, { connectionId, resolve: () => resolve(), reject, timer });
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
    for (const connection of this.connections.values()) connection.socket.terminate();
    this.connections.clear();
    this.activeId = undefined;
    this.manualId = undefined;
    this.failPending('FIGMA_DISCONNECTED');
  }

  private effectiveActiveId(): string | undefined {
    if (this.connections.size === 1) return this.connections.keys().next().value;
    if (this.manualId && this.connections.has(this.manualId)) return this.manualId;
    if (this.activeId && this.connections.get(this.activeId)?.visible) return this.activeId;
    return undefined;
  }

  private currentId(): string {
    const id = this.effectiveActiveId();
    if (id) return id;
    throw new Error(this.connections.size ? 'FILE_SELECTION_REQUIRED' : 'NOT_CONNECTED');
  }

  private receive(connectionId: string, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      if (parsed.type === 'file.presence' && 'visible' in parsed && typeof parsed.visible === 'boolean'
        && 'active' in parsed && typeof parsed.active === 'boolean') {
        const connection = this.connections.get(connectionId)!;
        connection.visible = parsed.visible;
        if (parsed.visible && parsed.active) {
          this.activeId = connectionId;
          this.manualId = undefined;
        }
        else if (!parsed.visible && this.activeId === connectionId) this.activeId = undefined;
        return;
      }
    }
    const confirmation = confirmationReplySchema.safeParse(parsed);
    if (confirmation.success) {
      const pending = this.confirmations.get(confirmation.data.confirmationId);
      if (!pending || pending.connectionId !== connectionId) return;
      clearTimeout(pending.timer);
      this.confirmations.delete(confirmation.data.confirmationId);
      if (confirmation.data.accepted) pending.resolve(undefined);
      else pending.reject(new Error('CONFIRMATION_REQUIRED'));
      return;
    }
    const reply = pluginReplySchema.safeParse(parsed);
    if (!reply.success) return;
    const pending = this.pending.get(reply.data.requestId);
    if (!pending || pending.connectionId !== connectionId) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.data.requestId);
    if (reply.data.type === 'plugin.error') pending.reject(new Error(reply.data.code));
    else pending.resolve(reply.data.value);
  }

  private failPending(code: string, connectionId?: string): void {
    for (const [requestId, pending] of this.pending) {
      if (connectionId && pending.connectionId !== connectionId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
      this.pending.delete(requestId);
    }
    for (const [confirmationId, pending] of this.confirmations) {
      if (connectionId && pending.connectionId !== connectionId) continue;
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
      const fileName = hello && typeof hello === 'object' && 'fileName' in hello && typeof hello.fileName === 'string'
        ? hello.fileName.slice(0, 200) : 'Figma file';
      session.attach(socket, fileName);
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
