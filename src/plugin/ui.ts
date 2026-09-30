import { confirmationRequestSchema, pluginReplySchema, pluginRequestSchema } from '../shared/protocol.js';

const form = document.querySelector<HTMLFormElement>('#pair-form')!;
const pluginView = document.querySelector<HTMLElement>('#plugin-view')!;
const codeInput = document.querySelector<HTMLInputElement>('#pairing-code')!;
const status = document.querySelector<HTMLElement>('#status')!;
const confirmation = document.querySelector<HTMLElement>('#confirmation')!;
const confirmTarget = document.querySelector<HTMLElement>('#confirm-target')!;
let socket: WebSocket | undefined;
let confirmationId: string | undefined;

function setConnected(connected: boolean) {
  pluginView.dataset.connected = String(connected);
  form.hidden = connected;
}

function answerConfirmation(accepted: boolean) {
  if (!confirmationId) return;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'confirmation.reply', confirmationId, accepted }));
  }
  confirmationId = undefined;
  confirmation.hidden = true;
}

document.querySelector('#cancel-delete')!.addEventListener('click', () => answerConfirmation(false));
document.querySelector('#confirm-delete')!.addEventListener('click', () => answerConfirmation(true));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!code) return;
  socket?.close();
  status.textContent = 'Подключение…';
  const next = new WebSocket('ws://localhost:3846');
  socket = next;
  next.addEventListener('open', () => next.send(JSON.stringify({ type: 'hello', token: code })));
  next.addEventListener('message', (event) => {
    let value: unknown;
    try { value = JSON.parse(String(event.data)); } catch { return; }
    if (value && typeof value === 'object' && 'type' in value && value.type === 'hello.ok') {
      status.textContent = 'Figma подключена к Codex';
      codeInput.value = '';
      setConnected(true);
      return;
    }
    const request = pluginRequestSchema.safeParse(value);
    if (request.success) parent.postMessage({ pluginMessage: request.data }, '*');
    const prompt = confirmationRequestSchema.safeParse(value);
    if (prompt.success) {
      confirmationId = prompt.data.confirmationId;
      confirmTarget.textContent = `${prompt.data.nodeName} (${prompt.data.nodeType}, ${prompt.data.nodeId})`;
      confirmation.hidden = false;
    }
  });
  next.addEventListener('close', () => {
    confirmation.hidden = true;
    confirmationId = undefined;
    if (socket === next) {
      setConnected(false);
      status.textContent = 'Нет соединения. Получите новый код в Codex.';
    }
  });
  next.addEventListener('error', () => {
    if (socket === next) status.textContent = 'Не удалось подключиться к локальному мосту.';
  });
});

window.addEventListener('message', (event) => {
  const reply = pluginReplySchema.safeParse(event.data?.pluginMessage);
  if (reply.success && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply.data));
});
