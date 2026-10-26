const $ = (sel) => document.querySelector(sel);

function newPhone() {
  return `sim-${Math.random().toString(36).slice(2, 8)}`;
}

let phone;
try {
  phone = localStorage.getItem('sim-phone');
} catch {
  // sin almacenamiento: se usa un número nuevo en cada carga
}
if (!phone) {
  phone = newPhone();
  try { localStorage.setItem('sim-phone', phone); } catch { /* idem */ }
}

let lastId = 0;
const MAX_FILE = 5 * 1024 * 1024;

function bubble(msg) {
  const el = document.createElement('div');
  // En el simulador el "cliente" es quien escribe: sus mensajes van a la derecha.
  el.className = `bubble ${msg.direction === 'in' ? 'out' : 'in'}`;
  // WhatsApp muestra *texto* en negrita; se arma con nodos de texto, nunca con HTML.
  const body = msg.media_file ? `📎 ${msg.body}` : msg.body;
  body.split(/\*([^*\n]+)\*/).forEach((part, i) => {
    if (i % 2) {
      const strong = document.createElement('strong');
      strong.textContent = part;
      el.append(strong);
    } else {
      el.append(part);
    }
  });
  const time = document.createElement('time');
  time.textContent = new Date(msg.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  el.append(time);
  return el;
}

async function poll() {
  try {
    const res = await fetch(`/sim/messages?phone=${phone}&after=${lastId}`);
    if (!res.ok) return;
    const messages = await res.json();
    if (!messages.length) return;
    const box = $('#messages');
    box.append(...messages.map(bubble));
    lastId = messages[messages.length - 1].id;
    box.scrollTop = box.scrollHeight;
  } catch {
    // reintenta en el próximo ciclo
  }
}

async function send(payload) {
  const res = await fetch('/sim/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name: 'Cliente de prueba', ...payload }),
  });
  if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Error al enviar');
  await poll();
}

$('#who').textContent = phone;

$('#form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await send({ text });
});

$('#file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE) return alert('El archivo pesa más de 5 MB.');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  await send({ text: $('#text').value.trim(), media: { data } });
  $('#text').value = '';
});

$('#new-customer').addEventListener('click', () => {
  phone = newPhone();
  try { localStorage.setItem('sim-phone', phone); } catch { /* idem */ }
  location.reload();
});

poll();
setInterval(poll, 1500);
