import { startBridgeSocketServer } from './session.js';
import { SyncController } from './sync/controller.js';
import { startSyncHttp } from './sync/http.js';
import { loadOrCreateSyncAccessCode } from './sync/access-code.js';

type RunningBridge = Awaited<ReturnType<typeof startBridgeSocketServer>>;

export class BridgeHost {
  private bridge: RunningBridge | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private busyLogged = false;
  sync: SyncController | undefined;
  private syncHttp: Awaited<ReturnType<typeof startSyncHttp>> | undefined;

  constructor(
    readonly pairingCode: string,
    private readonly options: { port?: number; retryMs?: number; syncProject?: string; syncPort?: number } = {},
  ) {}

  get status(): 'waiting' | 'listening' | 'stopped' {
    if (this.stopped) return 'stopped';
    return this.bridge ? 'listening' : 'waiting';
  }

  async start(): Promise<void> {
    await this.tryStart();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.syncHttp?.close();
    this.syncHttp = undefined;
    this.sync = undefined;
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge) await bridge.close();
  }

  call(method: string, args: unknown): Promise<unknown> {
    return this.bridge?.session.call(method, args) ?? Promise.reject(new Error('BRIDGE_PORT_BUSY'));
  }

  confirmDelete(node: { nodeId: string; nodeName: string; nodeType: string }): Promise<void> {
    return this.bridge?.session.confirmDelete(node) ?? Promise.reject(new Error('BRIDGE_PORT_BUSY'));
  }

  listFiles(): ReturnType<RunningBridge['session']['listFiles']> {
    return this.bridge?.session.listFiles() ?? [];
  }

  activateFile(file: string): void {
    if (!this.bridge) throw new Error('BRIDGE_PORT_BUSY');
    this.bridge.session.activateFile(file);
  }

  pinCurrentFile(expectedFileKey?: string) {
    if (!this.bridge) throw new Error('BRIDGE_PORT_BUSY');
    return this.bridge.session.pinCurrentFile(expectedFileKey);
  }

  private async tryStart(): Promise<void> {
    if (this.stopped) return;
    try {
      const bridge = await startBridgeSocketServer({ token: this.pairingCode, port: this.options.port });
      if (this.stopped) { await bridge.close(); return; }
      this.bridge = bridge;
      if (this.options.syncProject) {
        try {
          this.sync = new SyncController(this.options.syncProject, this, await loadOrCreateSyncAccessCode(this.options.syncProject));
          this.syncHttp = await startSyncHttp(this.sync, this.options.syncPort);
          console.error(`Storybook Figma sync listening on 127.0.0.1:${this.syncHttp.port}`);
        } catch (error) {
          this.sync = undefined;
          console.error('Storybook Figma sync unavailable:', error instanceof Error ? error.message : 'SYNC_ERROR');
        }
      }
      this.busyLogged = false;
      console.error(`Figma Codex MCP bridge listening on 127.0.0.1:${bridge.port}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.stopped) throw error;
      if (!this.busyLogged) {
        console.error('Figma Codex MCP bridge waiting for port 3846 to become free');
        this.busyLogged = true;
      }
      this.retryTimer = setTimeout(() => {
        void this.tryStart().catch((retryError) => console.error('Figma Codex MCP bridge startup failed:', retryError));
      }, this.options.retryMs ?? 2_000);
    }
  }
}
