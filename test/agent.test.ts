import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createAgentApi } from '../src/agent-api.ts';
import { TOOLS } from '../src/agent-prompt.ts';
import { createBot } from '../src/bot.ts';
import { openCatalog } from '../src/catalog.ts';
import type { CatalogProduct } from '../src/catalog.ts';
import { loadPharmacy } from '../src/config.ts';
import { createStore } from '../src/db.ts';
import { HttpError, json } from '../src/http.ts';

const TOKEN = 'token-de-prueba-con-mas-de-24-caracteres';
const PHONE = '5493875550001';
const OTHER = '5493875550002';
const NOW = new Date('2026-03-04T15:00:00Z'); // miércoles 12:00 en Argentina (abierto)
const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');

const product = (id: string, name: string, extra: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id, name, brand: null, category: 'Medicamentos Venta Libre > Analgésicos', categories: 'Medicamentos Venta Libre',
  ingredients: null, presentation: null, dose: null, sale_type: 'libre', ean: null, price: 5000, list_price: 5000,
  description: 'Descripción de prueba', url: `https://example.test/${id}`, image_url: null, scraped_at: NOW.toISOString(), ...extra,
});

let server: Server;
let base: string;
let dir: string;
let catalog: ReturnType<typeof openCatalog>;
const store = createStore(':memory:', () => NOW);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'farmacia-agent-'));
  const cfg = loadPharmacy();
  catalog = openCatalog(join(dir, 'catalog.db'));
  catalog.upsert(product('1', 'Ibuprofeno 400 mg x 20 Comp', { ingredients: 'Ibuprofeno' }));
  catalog.upsert(product('2', 'Ibu 600 Ibuprofeno 600 mg x 10 Comp', { ingredients: 'Ibuprofeno', sale_type: 'receta', price: 7200 }));
  catalog.upsert(product('3', 'Termómetro Digital', { sale_type: 'otro', category: 'Electrosalud' }));
  catalog.reindex();

  const api = createAgentApi({ store, cfg, bot: createBot({ store, cfg }), catalog, token: TOKEN, dataDir: dir });
  server = createServer(async (req, res) => {
    try {
      const handled = await api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
      if (!handled) json(res, 404, { error: 'no es /agent' });
    } catch (err) {
      if (err instanceof HttpError) json(res, err.status, { error: err.message });
      else json(res, 500, { error: String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  catalog.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

const say = (text: string, phone = PHONE, extra: object = {}) => call('POST', '/agent/inbound', { phone, name: 'Ana López', type: 'text', text, ...extra });

async function consent(phone = PHONE) {
  await say('hola', phone);
  await say('1', phone);
}

test('sin token o con token incorrecto no se puede usar la API', async () => {
  assert.equal((await call('GET', '/agent/pharmacy', undefined, null)).status, 401);
  assert.equal((await call('GET', '/agent/pharmacy', undefined, 'otro-token-distinto-pero-largo-1234')).status, 401);
  assert.equal((await call('GET', '/agent/pharmacy')).status, 200);
});

test('si la API se crea sin token, queda apagada', async () => {
  const cfg = loadPharmacy();
  const off = createAgentApi({ store, cfg, bot: createBot({ store, cfg }), token: '', dataDir: dir });
  const srv = createServer(async (req, res) => {
    try {
      await off.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
    } catch (err) {
      json(res, err instanceof HttpError ? err.status : 500, { error: String(err) });
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/agent/pharmacy`, { headers: { Authorization: 'Bearer cualquiera' } });
    assert.equal(res.status, 503);
  } finally {
    srv.close();
  }
});

test('el primer mensaje devuelve el aviso de privacidad; al aceptar, el agente toma la conversación', async () => {
  const first = await say('hola');
  assert.equal(first.body.action, 'reply');
  assert.match(first.body.replies[0], /Respondé \*1\* para aceptar/);
  assert.equal(store.getCustomer(PHONE), undefined, 'no se guarda nada antes del consentimiento');

  const accepted = await say('1');
  assert.equal(accepted.body.action, 'reply');
  assert.doesNotMatch(accepted.body.replies.join(' '), /1\. Horarios/, 'en modo agente no hay menú numerado');

  const turn = await say('¿tienen ibuprofeno?');
  assert.equal(turn.body.action, 'agent');
  assert.equal(turn.body.customer.name, 'Ana López');
  assert.equal(turn.body.messages.at(-1).role, 'user');
  assert.equal(turn.body.messages.at(-1).content, '¿tienen ibuprofeno?');
  assert.equal(turn.body.messages[0].role, 'user', 'el historial arranca con el cliente');
  assert.equal(turn.body.pharmacy.open_now, true);
});

test('una consulta médica la corta el código y deja el chat para una persona', async () => {
  const phone = OTHER;
  await consent(phone);
  const asked = await say('¿puedo tomar ibuprofeno con alcohol?', phone);
  assert.equal(asked.body.action, 'reply');
  assert.match(asked.body.replies[0], /no puedo dar indicaciones/);
  assert.equal((await say('gracias', phone)).body.action, 'silent');
  const back = await say('menu', phone);
  assert.match(back.body.replies[0], /sigo yo/);
  assert.equal((await say('hola de nuevo', phone)).body.action, 'agent');
});

test('un mensaje que el bot no puede leer (audio, imagen sin soporte) se contesta sin prometer fotos', async () => {
  const phone = '5493875552222';
  await consent(phone);
  const res = await call('POST', '/agent/inbound', { phone, type: 'unsupported' });
  assert.equal(res.body.action, 'reply');
  assert.match(res.body.replies[0], /no puedo abrir ese tipo de mensaje/);
  assert.doesNotMatch(res.body.replies[0], /fotos/);
});

test('una emergencia responde con los teléfonos aunque la persona no haya dado consentimiento', async () => {
  const res = await say('sobredosis de pastillas', '5493875559999');
  assert.equal(res.body.action, 'reply');
  assert.match(res.body.replies[0], /107/);
  assert.equal(store.getCustomer('5493875559999'), undefined);
});

test('un mensaje repetido por su id se ignora', async () => {
  const a = await say('hola', PHONE, { message_id: 'wamid.DUP' });
  const b = await say('hola', PHONE, { message_id: 'wamid.DUP' });
  assert.notEqual(a.body.reason, 'duplicate');
  assert.deepEqual(b.body, { action: 'silent', reason: 'duplicate' });
});

test('catálogo: busca por principio activo, marca las recetas y filtra por tipo de venta', async () => {
  const found = await call('GET', '/agent/catalog/search?q=ibuprofeno');
  assert.equal(found.status, 200);
  assert.equal(found.body.results.length, 2);
  assert.match(found.body.note, /no informa stock/);
  const rx = found.body.results.find((p: any) => p.id === '2');
  assert.equal(rx.requires_prescription, true);
  assert.equal(rx.reference_price_ars, 7200);
  assert.equal(rx.url, undefined, 'no se exponen links del sitio de origen');

  const free = await call('GET', '/agent/catalog/search?q=ibuprofeno&sale_type=libre');
  assert.deepEqual(free.body.results.map((p: any) => p.id), ['1']);
  assert.equal((await call('GET', '/agent/catalog/search?q=termometro')).body.results[0].id, '3');
  assert.equal((await call('GET', '/agent/catalog/search')).status, 400);
  assert.equal((await call('GET', '/agent/catalog/products/1')).body.name, 'Ibuprofeno 400 mg x 20 Comp');
  assert.equal((await call('GET', '/agent/catalog/products/999')).status, 404);
});

test('pedidos: exigen consentimiento, validan los datos y quedan en el panel', async () => {
  const stranger = '5493875558888';
  const noConsent = await call('POST', '/agent/orders', { phone: stranger, kind: 'pedido', detail: 'x', delivery: 'retiro' });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.body.error, 'consent_required');

  assert.equal((await call('POST', '/agent/orders', { phone: PHONE, kind: 'pedido', detail: '', delivery: 'retiro' })).status, 400);
  assert.equal((await call('POST', '/agent/orders', { phone: PHONE, kind: 'regalo', detail: 'x', delivery: 'retiro' })).status, 400);
  assert.equal((await call('POST', '/agent/orders', { phone: PHONE, kind: 'pedido', detail: 'x', delivery: 'envio' })).status, 400);

  const ok = await call('POST', '/agent/orders', { phone: PHONE, kind: 'pedido', detail: '1 Ibuprofeno 400 x 20', delivery: 'envio', address: 'Av. Siempre Viva 742, Salta' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'nuevo');

  const order = store.getOrder(ok.body.order_id);
  assert.equal(order?.phone, PHONE);
  assert.equal(order?.address, 'Av. Siempre Viva 742, Salta');

  const mine = await call('GET', `/agent/orders?phone=${PHONE}`);
  assert.equal(mine.body[0].order_id, ok.body.order_id);
  assert.equal(mine.body[0].status, 'nuevo');
});

test('recetas: la foto se sube aparte, se verifica y se adjunta sola al pedido', async () => {
  const phone = '5493875557777';
  assert.equal((await call('POST', '/agent/media', { phone, data: JPEG_B64 })).status, 403, 'sin consentimiento no se guarda nada');
  await consent(phone);

  assert.equal((await call('POST', '/agent/orders', { phone, kind: 'receta', detail: 'PAMI', delivery: 'retiro' })).status, 422, 'sin foto no hay receta');
  assert.equal((await call('POST', '/agent/media', { phone, data: Buffer.from('no soy una imagen, soy texto plano').toString('base64') })).status, 415);

  const up = await call('POST', '/agent/media', { phone, data: JPEG_B64 });
  assert.equal(up.status, 200);
  assert.equal(up.body.mime, 'image/jpeg');
  assert.equal((await call('POST', '/agent/inbound', { phone, type: 'media', media: { file: '../../etc/passwd' } })).status, 400);

  const turn = await call('POST', '/agent/inbound', { phone, type: 'media', text: 'receta de mi mamá', media: { file: up.body.file } });
  assert.equal(turn.body.action, 'agent');
  assert.match(turn.body.messages.at(-1).content, /archivo adjunto.*receta de mi mamá/);

  const order = await call('POST', '/agent/orders', { phone, kind: 'receta', detail: 'Obra social PAMI', delivery: 'retiro' });
  assert.equal(order.status, 200);
  assert.equal(order.body.attached_files, 1);
  assert.deepEqual(store.getOrder(order.body.order_id)?.media.map((m) => m.file), [up.body.file]);

  const again = await call('POST', '/agent/orders', { phone, kind: 'receta', detail: 'otra vez', delivery: 'retiro' });
  assert.equal(again.status, 422, 'la misma foto no se reutiliza en otra receta');
});

test('un cliente no puede acumular pedidos abiertos sin límite', async () => {
  const phone = '5493875556666';
  await consent(phone);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/agent/orders', { phone, kind: 'pedido', detail: `pedido ${i}`, delivery: 'retiro' })).status, 200);
  }
  assert.equal((await call('POST', '/agent/orders', { phone, kind: 'pedido', detail: 'uno más', delivery: 'retiro' })).status, 409);
});

test('recordatorios: se crean con validación y se cancelan', async () => {
  const phone = '5493875555555';
  await consent(phone);
  assert.equal((await call('POST', '/agent/reminders', { phone, medication: 'Enalapril 10 mg', days: 0 })).status, 400);
  assert.equal((await call('POST', '/agent/reminders', { phone, medication: 'Enalapril 10 mg', days: 400 })).status, 400);
  const ok = await call('POST', '/agent/reminders', { phone, medication: 'Enalapril 10 mg', days: 25 });
  assert.equal(ok.status, 200);
  assert.equal(store.activeReminderCount(phone), 1);
  assert.equal((await call('POST', '/agent/reminders/cancel', { phone })).body.cancelled, 1);
  assert.equal(store.activeReminderCount(phone), 0);
});

test('derivar a una persona deja el chat en espera con el motivo', async () => {
  const phone = '5493875554444';
  await consent(phone);
  const res = await call('POST', '/agent/handoff', { phone, reason: 'Pregunta por interacción de medicamentos', urgent: true });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /avisé al equipo/);
  const session = store.getSession(phone);
  assert.equal(session?.state, 'humano');
  assert.equal(session?.data.urgent, true);
  assert.match(session?.data.reason ?? '', /interacción/);
  assert.equal((await say('hola?', phone)).body.action, 'silent');
});

test('outbound registra lo que respondió el agente y vuelve en el historial', async () => {
  const phone = '5493875553333';
  await consent(phone);
  await say('quiero pañales', phone);
  assert.equal((await call('POST', '/agent/outbound', { phone, replies: ['Te muestro opciones', 'Cuál talle?'] })).body.logged, 2);
  const turn = await say('talle G', phone);
  const roles = turn.body.messages.map((m: any) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user']);
  assert.match(turn.body.messages[1].content, /Te muestro opciones\nCuál talle\?/);
});

test('la configuración para el modelo no deja que el modelo elija el teléfono', async () => {
  const res = await call('GET', '/agent/config');
  assert.equal(res.status, 200);
  assert.match(res.body.system_prompt, /Farmacia Demo/);
  assert.match(res.body.system_prompt, /NUNCA des indicaciones de salud/);
  assert.deepEqual(res.body.tools.map((t: any) => t.name), TOOLS.map((t) => t.name));
  for (const tool of res.body.tools) {
    assert.equal('phone' in (tool.input_schema.properties ?? {}), false, `${tool.name} no debería recibir phone`);
  }
});

test('rutas inexistentes y teléfonos inválidos responden con error claro', async () => {
  assert.equal((await call('GET', '/agent/nada')).status, 404);
  assert.equal((await call('POST', '/agent/handoff', { phone: "5493'; DROP TABLE orders;--" })).status, 400);
  assert.equal((await call('GET', '/agent/orders?phone=abc')).status, 400);
});
