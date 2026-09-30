import { confirmationRequestSchema, pluginReplySchema, pluginRequestSchema } from '../shared/protocol.js';

const form = document.querySelector<HTMLFormElement>('#pair-form')!;
const pluginView = document.querySelector<HTMLElement>('#plugin-view')!;
const codeInput = document.querySelector<HTMLInputElement>('#pairing-code')!;
const status = document.querySelector<HTMLElement>('#status')!;
const confirmation = document.querySelector<HTMLElement>('#confirmation')!;
const confirmTarget = document.querySelector<HTMLElement>('#confirm-target')!;
let socket: WebSocket | undefined;
let confirmationId: string | undefined;
let savedToken: string | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let fileName: string | undefined;
let paired = false;

form.hidden = true;

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

function connect(code: string) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  status.textContent = 'Подключение…';
  const next = new WebSocket('ws://localhost:3846');
  socket = next;
  paired = false;
  next.addEventListener('open', () => next.send(JSON.stringify({ type: 'hello', token: code, ...(fileName ? { fileName } : {}) })));
  next.addEventListener('message', (event) => {
    if (socket !== next) return;
    let value: unknown;
    try { value = JSON.parse(String(event.data)); } catch { return; }
    if (value && typeof value === 'object' && 'type' in value && value.type === 'hello.ok') {
      paired = true;
      status.textContent = 'Figma подключена к Codex';
      savedToken = code;
      parent.postMessage({ pluginMessage: { type: 'pairing.save', token: code } }, '*');
      codeInput.value = '';
      setConnected(true);
      sendPresence(document.visibilityState !== 'hidden');
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
  next.addEventListener('close', (event) => {
    if (socket !== next) return;
    confirmation.hidden = true;
    confirmationId = undefined;
    socket = undefined;
    paired = false;
    setConnected(false);
    if (event.code === 1008 && event.reason === 'Invalid pairing code') {
      savedToken = undefined;
      parent.postMessage({ pluginMessage: { type: 'pairing.clear' } }, '*');
      form.hidden = false;
      status.textContent = 'Код недействителен. Получите код в Codex.';
      return;
    }
    if (savedToken) {
      form.hidden = true;
      status.textContent = event.code === 1013
        ? 'Другой файл Figma подключён. Ожидание…'
        : 'Нет соединения. Ожидание Codex…';
      retryTimer = setTimeout(() => connect(savedToken!), 2_000);
      return;
    }
    form.hidden = false;
    status.textContent = 'Нет соединения. Проверьте, запущен ли Codex.';
  });
  next.addEventListener('error', () => {
    if (socket === next) status.textContent = 'Не удалось подключиться к локальному мосту.';
  });
}

function sendPresence(active: boolean) {
  if (!paired || socket?.readyState !== WebSocket.OPEN) return;
  const visible = document.visibilityState !== 'hidden';
  socket.send(JSON.stringify({ type: 'file.presence', visible, active: active && visible }));
}

document.addEventListener('visibilitychange', () => sendPresence(document.visibilityState !== 'hidden'));
window.addEventListener('focus', () => sendPresence(true));
window.addEventListener('pointerdown', () => sendPresence(true));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!/^[a-f0-9]{64}$/.test(code)) {
    status.textContent = 'Нужен код из 64 символов.';
    return;
  }
  savedToken = undefined;
  socket?.close();
  connect(code);
});

window.addEventListener('message', (event) => {
  const message = event.data?.pluginMessage;
  if (message?.type === 'pairing.saved') {
    fileName = typeof message.fileName === 'string' ? message.fileName.slice(0, 200) : undefined;
    if (typeof message.token === 'string' && /^[a-f0-9]{64}$/.test(message.token)) {
      savedToken = message.token;
      form.hidden = true;
      connect(message.token);
    } else {
      form.hidden = false;
      status.textContent = 'Нет соединения. Получите код в Codex.';
    }
    return;
  }
  const reply = pluginReplySchema.safeParse(message);
  if (reply.success && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply.data));
});

parent.postMessage({ pluginMessage: { type: 'pairing.load' } }, '*');
