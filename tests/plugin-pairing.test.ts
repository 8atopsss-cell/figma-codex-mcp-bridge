import { afterEach, expect, it, vi } from 'vitest';

class FakeElement extends EventTarget {
  hidden = false;
  value = '';
  textContent = '';
  dataset: Record<string, string> = {};
}

class FakeSocket extends EventTarget {
  static sockets: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];

  constructor(public readonly url: string) {
    super();
    FakeSocket.sockets.push(this);
  }

  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event('open')); }
  receive(value: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) }));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeSocket.sockets = [];
});

it('loads saved pairing, connects automatically, saves successful pairing and retries after disconnect', async () => {
  vi.useFakeTimers();
  const elements = new Map<string, FakeElement>();
  for (const id of ['#pair-form', '#plugin-view', '#pairing-code', '#status', '#confirmation', '#confirm-target', '#cancel-delete', '#confirm-delete']) {
    elements.set(id, new FakeElement());
  }
  const messages: unknown[] = [];
  const fakeWindow = new EventTarget();
  const fakeDocument = Object.assign(new EventTarget(), { querySelector: (id: string) => elements.get(id), visibilityState: 'visible' });
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('parent', { postMessage: (message: unknown) => messages.push(message) });
  vi.stubGlobal('WebSocket', FakeSocket);
  await import('../src/plugin/ui.js');

  expect(messages).toContainEqual({ pluginMessage: { type: 'pairing.load' } });
  const token = 'a'.repeat(64);
  fakeWindow.dispatchEvent(Object.assign(new Event('message'), { data: { pluginMessage: { type: 'pairing.saved', token, fileName: 'First file' } } }));
  expect(FakeSocket.sockets).toHaveLength(1);
  const first = FakeSocket.sockets[0];
  first.open();
  expect(first.sent).toContainEqual({ type: 'hello', token, fileName: 'First file' });
  first.receive({ type: 'hello.ok' });
  expect(first.sent).toContainEqual({ type: 'file.presence', visible: true, active: true });
  fakeDocument.visibilityState = 'hidden';
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  expect(first.sent).toContainEqual({ type: 'file.presence', visible: false, active: false });
  expect(elements.get('#pair-form')!.hidden).toBe(true);
  expect(messages).toContainEqual({ pluginMessage: { type: 'pairing.save', token } });

  first.close();
  expect(elements.get('#pair-form')!.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(2_100);
  expect(FakeSocket.sockets).toHaveLength(2);
  FakeSocket.sockets[1].open();
  expect(FakeSocket.sockets[1].sent).toContainEqual({ type: 'hello', token, fileName: 'First file' });
});

it('exposes the code form when the saved pairing is rejected', async () => {
  const elements = new Map<string, FakeElement>();
  for (const id of ['#pair-form', '#plugin-view', '#pairing-code', '#status', '#confirmation', '#confirm-target', '#cancel-delete', '#confirm-delete']) {
    elements.set(id, new FakeElement());
  }
  const messages: unknown[] = [];
  const fakeWindow = new EventTarget();
  const fakeDocument = Object.assign(new EventTarget(), { querySelector: (id: string) => elements.get(id), visibilityState: 'visible' });
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('parent', { postMessage: (message: unknown) => messages.push(message) });
  vi.stubGlobal('WebSocket', FakeSocket);
  await import('../src/plugin/ui.js');

  fakeWindow.dispatchEvent(Object.assign(new Event('message'), { data: { pluginMessage: { type: 'pairing.saved', token: 'a'.repeat(64) } } }));
  const socket = FakeSocket.sockets[0];
  socket.open();
  socket.dispatchEvent(Object.assign(new Event('close'), { code: 1008, reason: 'Invalid pairing code' }));
  expect(elements.get('#pair-form')!.hidden).toBe(false);
  expect(messages).toContainEqual({ pluginMessage: { type: 'pairing.clear' } });

  const replacement = 'b'.repeat(64);
  elements.get('#pairing-code')!.value = replacement;
  elements.get('#pair-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  const next = FakeSocket.sockets[1];
  next.open();
  expect(next.sent).toContainEqual({ type: 'hello', token: replacement });
  next.receive({ type: 'hello.ok' });
  expect(messages).toContainEqual({ pluginMessage: { type: 'pairing.save', token: replacement } });
});
