import { pluginReplySchema, pluginRequestSchema } from '../shared/protocol.js';

const form = document.querySelector<HTMLFormElement>('#pair-form')!;
const codeInput = document.querySelector<HTMLInputElement>('#pairing-code')!;
const status = document.querySelector<HTMLElement>('#status')!;
let socket: WebSocket | undefined;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!code) return;
  socket?.close();
  status.textContent = 'Подключение…';
  const next = new WebSocket('ws://127.0.0.1:3846');
  socket = next;
  next.addEventListener('open', () => next.send(JSON.stringify({ type: 'hello', token: code })));
  next.addEventListener('message', (event) => {
    let value: unknown;
    try { value = JSON.parse(String(event.data)); } catch { return; }
    if (value && typeof value === 'object' && 'type' in value && value.type === 'hello.ok') {
      status.textContent = 'Figma подключена к Codex';
      codeInput.value = '';
      return;
    }
    const request = pluginRequestSchema.safeParse(value);
    if (request.success) parent.postMessage({ pluginMessage: request.data }, '*');
  });
  next.addEventListener('close', () => {
    if (socket === next) status.textContent = 'Нет соединения. Получите новый код в Codex.';
  });
  next.addEventListener('error', () => {
    if (socket === next) status.textContent = 'Не удалось подключиться к локальному мосту.';
  });
});

window.addEventListener('message', (event) => {
  const reply = pluginReplySchema.safeParse(event.data?.pluginMessage);
  if (reply.success && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply.data));
});
