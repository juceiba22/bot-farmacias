const $ = (sel) => document.querySelector(sel);

/** Crea un elemento. Todo el texto entra como texto (nunca como HTML): los mensajes los escriben los clientes. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) el.append(child instanceof Node ? child : String(child ?? ''));
  return el;
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showError(message) {
  const el = $('#error');
  el.textContent = message || '';
  el.hidden = !message;
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const state = { tab: 'orders', orders: [], chats: [], phone: null, lastMessageId: 0 };

// ------------------------------------------------------------------ pedidos

const COLUMNS = [
  { title: 'Nuevos', statuses: ['nuevo'] },
  { title: 'En preparación', statuses: ['preparando'] },
  { title: 'Listos', statuses: ['listo'] },
  { title: 'Cerrados', statuses: ['entregado', 'cancelado'] },
];
const ACTIONS = {
  nuevo: [['Preparar', 'preparando', 'primary'], ['Ya está listo', 'listo'], ['Cancelar', 'cancelado', 'danger']],
  preparando: [['Marcar listo', 'listo', 'primary'], ['Cancelar', 'cancelado', 'danger']],
  listo: [['Entregado', 'entregado', 'primary']],
};

async function setStatus(order, status) {
  if (status === 'cancelado' && !confirm(`¿Cancelar el pedido #${order.id}? Avisale al cliente desde el chat.`)) return;
  try {
    await api(`/api/orders/${order.id}/status`, 'POST', { status });
    await refreshOrders();
  } catch (err) {
    showError(err.message);
  }
}

function orderCard(order) {
  const who = order.name ? `${order.name} · ${order.phone}` : order.phone;
  const media = order.media.map((m) => {
    const url = `/api/media/${m.file}`;
    return m.mime === 'application/pdf'
      ? h('a', { class: 'file', href: url, target: '_blank', rel: 'noopener' }, '📄 Ver PDF')
      : h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: 'Adjunto' }));
  });
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title' }, `#${order.id} · ${order.kind === 'receta' ? 'Receta' : 'Pedido'}`),
      h('span', { class: 'badge' }, order.status)),
    h('div', { class: 'meta' }, `${who} · ${fmtTime(order.created_at)}`),
    order.detail ? h('div', { class: 'detail' }, order.detail) : null,
    media.length ? h('div', { class: 'thumbs' }, media) : null,
    h('div', { class: 'meta' }, order.delivery === 'envio' ? `🛵 Envío a: ${order.address}` : '🏪 Retira en la farmacia'),
    h('div', { class: 'actions' },
      (ACTIONS[order.status] ?? []).map(([label, status, kind]) =>
        h('button', { class: `btn ${kind ?? ''}`, onclick: () => setStatus(order, status) }, label)),
      h('button', { class: 'btn', onclick: () => openChat(order.phone) }, 'Chat')));
}

function renderOrders() {
  $('#columns').replaceChildren(...COLUMNS.map(({ title, statuses }) => {
    const orders = state.orders.filter((o) => statuses.includes(o.status));
    return h('div', { class: 'column' },
      h('h2', {}, `${title} (${orders.length})`),
      orders.length ? orders.map(orderCard) : h('div', { class: 'empty' }, 'Nada por acá'));
  }));
}

async function refreshOrders() {
  state.orders = await api('/api/orders');
  renderOrders();
  updateBadges();
}

// ------------------------------------------------------------------ chats

function renderChatList() {
  $('#chat-list').replaceChildren(...state.chats.map((chat) =>
    h('li', { class: chat.phone === state.phone ? 'active' : '', onclick: () => openChat(chat.phone) },
      h('div', { class: 'who' },
        h('span', {}, chat.name || chat.phone),
        chat.state === 'humano' ? h('span', { class: `tag ${chat.urgent ? 'urgent' : ''}` }, chat.urgent ? 'URGENTE' : 'Espera') : null),
      h('div', { class: 'snippet' }, chat.last_body))));
  if (!state.chats.length) $('#chat-list').replaceChildren(h('li', {}, h('span', { class: 'meta' }, 'Todavía no hay conversaciones')));
}

/** WhatsApp muestra *texto* en negrita; se arma con nodos, nunca con HTML. */
const rich = (text) => text.split(/\*([^*\n]+)\*/).map((part, i) => (i % 2 ? h('strong', {}, part) : part));

function bubble(msg) {
  const media = msg.media_file
    ? (msg.media_mime === 'application/pdf'
        ? h('a', { href: `/api/media/${msg.media_file}`, target: '_blank', rel: 'noopener' }, '📄 Ver PDF')
        : h('a', { href: `/api/media/${msg.media_file}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/media/${msg.media_file}`, alt: 'Adjunto' })))
    : null;
  return h('div', { class: `bubble ${msg.direction === 'in' ? 'in' : 'out'}` }, media, rich(msg.body), h('time', {}, fmtTime(msg.created_at)));
}

function renderChatHead() {
  if (!state.phone) return $('#chat-head').replaceChildren(h('span', { class: 'meta' }, 'Elegí una conversación'));
  const chat = state.chats.find((c) => c.phone === state.phone);
  $('#chat-head').replaceChildren(
    h('div', {}, h('strong', {}, chat?.name || state.phone), h('div', { class: 'meta' }, state.phone)),
    chat?.state === 'humano'
      ? h('button', { class: 'btn', onclick: resolveChat }, 'Resolver y devolver al bot')
      : h('span', { class: 'meta' }, 'Atiende el bot'));
}

async function openChat(phone) {
  state.phone = phone;
  state.lastMessageId = 0;
  $('#chat-messages').replaceChildren();
  $('#chat-form').hidden = false;
  setTab('chats');
  await refreshChats();
  await refreshMessages();
  $('#chat-input').focus();
}

async function refreshMessages() {
  if (!state.phone) return;
  const phone = state.phone;
  const messages = await api(`/api/chats/${phone}/messages?after=${state.lastMessageId}`);
  if (phone !== state.phone || !messages.length) return;
  const box = $('#chat-messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40 || state.lastMessageId === 0;
  box.append(...messages.map(bubble));
  state.lastMessageId = messages[messages.length - 1].id;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function refreshChats() {
  state.chats = await api('/api/chats');
  renderChatList();
  renderChatHead();
  updateBadges();
}

async function resolveChat() {
  try {
    await api(`/api/chats/${state.phone}/resolve`, 'POST', {});
    await refreshChats();
    await refreshMessages();
  } catch (err) {
    showError(err.message);
  }
}

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !state.phone) return;
  try {
    await api(`/api/chats/${state.phone}/reply`, 'POST', { text });
    input.value = '';
    showError('');
    await refreshChats();
    await refreshMessages();
  } catch (err) {
    showError(`No se pudo enviar: ${err.message}`);
  }
});

// ------------------------------------------------------------------ general

function updateBadges() {
  const news = state.orders.filter((o) => o.status === 'nuevo').length;
  const waiting = state.chats.filter((c) => c.state === 'humano').length;
  for (const [id, n] of [['#badge-orders', news], ['#badge-chats', waiting]]) {
    $(id).textContent = n;
    $(id).hidden = n === 0;
  }
  const total = news + waiting;
  document.title = `${total ? `(${total}) ` : ''}Panel de la farmacia`;
}

function setTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll('.tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  $('#view-orders').hidden = tab !== 'orders';
  $('#view-chats').hidden = tab !== 'chats';
}
for (const btn of document.querySelectorAll('.tab')) btn.addEventListener('click', () => setTab(btn.dataset.tab));

async function tick() {
  try {
    await Promise.all([refreshOrders(), refreshChats(), refreshMessages()]);
    showError('');
  } catch (err) {
    showError(`Sin conexión con el servidor: ${err.message}`);
  }
}

api('/api/me').then(({ pharmacy }) => { $('#title').textContent = pharmacy; }).catch(() => {});
tick();
setInterval(tick, 5000);
