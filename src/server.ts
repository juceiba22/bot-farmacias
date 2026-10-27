import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createAgentApi } from './agent-api.ts';
import { createAgentRunner } from './agent-llm.ts';
import { createBot } from './bot.ts';
import type { Incoming } from './bot.ts';
import { openCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { seedCatalogIfMissing } from './catalog-seed.ts';
import { env, loadPharmacy, ROOT } from './config.ts';
import { createStore, ORDER_STATUSES } from './db.ts';
import type { OrderStatus } from './db.ts';
import { HttpError, json, readBody, readJson, safeEqual, send, str } from './http.ts';
import { renderDataDeletion, renderPrivacyPolicy } from './legal.ts';
import { contentTypeFor, deleteMedia, MEDIA_FILE_RE, mediaPath, saveMedia } from './media.ts';
import { createReminderRunner } from './reminders.ts';
import { createWhatsApp, parseWebhook } from './whatsapp.ts';
import type { InboundMessage } from './whatsapp.ts';

if (env.production && env.panelPasswordGenerated) {
  console.error('Falta PANEL_PASSWORD: en producción hay que definir la clave del panel (una clave al azar por arranque no sirve).');
  process.exit(1);
}

const cfg = loadPharmacy();
mkdirSync(join(env.dataDir, 'media'), { recursive: true });
const wa = createWhatsApp(env.wa);
const store = createStore(join(env.dataDir, 'farmacia.db'));
const bot = createBot({ store, cfg, deleteFiles: (files) => deleteMedia(env.dataDir, files) });
const sendDueReminders = createReminderRunner({ store, cfg, wa });

try {
  const imported = seedCatalogIfMissing(env.catalogFile, env.catalogSeed);
  if (imported) console.log(`Catálogo importado desde la semilla: ${imported} productos`);
} catch (err) {
  console.error('No se pudo importar el catálogo semilla:', err instanceof Error ? err.message : err);
}

let catalog: Catalog | undefined;
if (existsSync(env.catalogFile)) {
  try {
    catalog = openCatalog(env.catalogFile, true);
  } catch (err) {
    console.error('No se pudo abrir el catálogo:', err instanceof Error ? err.message : err);
  }
}
const anthropicClient = env.anthropic.apiKey ? new Anthropic({ apiKey: env.anthropic.apiKey }) : undefined;
const agentApi = createAgentApi({
  store,
  cfg,
  bot,
  catalog,
  token: env.agentToken,
  dataDir: env.dataDir,
  downloadMedia: env.wa.token ? (mediaId) => wa.downloadMedia(mediaId) : undefined,
  makeRunner: anthropicClient
    ? (ops) => createAgentRunner({ client: anthropicClient, model: env.anthropic.model, effort: env.anthropic.effort, cfg, ops, bot })
    : undefined,
});

// ---------------------------------------------------------------- mensajes

/** Los mensajes se procesan de a uno: evita que dos mensajes seguidos de la misma persona pisen su sesión. */
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(job: () => Promise<T>): Promise<T | undefined> => {
  const next = queue.then(job).catch((err) => {
    console.error('Error procesando mensaje:', err);
    return undefined;
  });
  queue = next;
  return next;
};

async function deliver(phone: string, replies: string[]) {
  for (const body of replies) {
    try {
      await wa.sendText(phone, body);
    } catch (err) {
      console.error(`No se pudo enviar a ${phone}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (store.canLog(phone)) store.logMessage({ phone, direction: 'out', body });
  }
}

type Inbound = Omit<InboundMessage, 'mediaId'> & { load?: () => Promise<Buffer> };

async function ingest(m: Inbound) {
  if (m.waId && !store.markProcessed(m.waId)) return;

  let incoming: Incoming;
  if (m.type === 'text') {
    incoming = { from: m.from, name: m.name, type: 'text', text: (m.text ?? '').slice(0, 2000) };
  } else if (m.type === 'media') {
    if (!store.canLog(m.from)) {
      // Sin consentimiento no se descarga ni se guarda nada: el bot responde con el aviso de privacidad.
      incoming = { from: m.from, name: m.name, type: 'text', text: '' };
    } else {
      const media = await loadMedia(m);
      incoming = media
        ? { from: m.from, name: m.name, type: 'media', text: (m.text ?? '').slice(0, 2000), media }
        : { from: m.from, name: m.name, type: 'unsupported' };
    }
  } else {
    incoming = { from: m.from, name: m.name, type: 'unsupported' };
  }

  await deliver(m.from, bot.handle(incoming));
}

async function loadMedia(m: Inbound) {
  try {
    const buf = await m.load?.();
    return buf ? saveMedia(env.dataDir, buf) : undefined;
  } catch (err) {
    console.error('No se pudo descargar el archivo:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

// ---------------------------------------------------------------- archivos públicos y autenticación

const HTML_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const PUBLIC_FILES: Record<string, { file: string; type: string }> = {
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/panel': { file: 'panel.html', type: 'text/html; charset=utf-8' },
  '/panel.js': { file: 'panel.js', type: 'text/javascript; charset=utf-8' },
  '/sim': { file: 'sim.html', type: 'text/html; charset=utf-8' },
  '/sim.js': { file: 'sim.js', type: 'text/javascript; charset=utf-8' },
};

function sendPublic(res: ServerResponse, path: string) {
  const entry = PUBLIC_FILES[path];
  const file = entry && join(ROOT, 'public', entry.file);
  if (!entry || !existsSync(file)) throw new HttpError(404, 'No encontrado');
  const headers: Record<string, string> = { 'Content-Type': entry.type };
  if (entry.type.startsWith('text/html')) headers['Content-Security-Policy'] = HTML_CSP;
  send(res, 200, readFileSync(file), headers);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Se evalúan las dos comparaciones siempre, para no filtrar cuál falló.
  const userOk = safeEqual(decoded.slice(0, i), env.panelUser);
  const passOk = safeEqual(decoded.slice(i + 1), env.panelPassword);
  return userOk && passOk;
}

const PHONE_RE = /^(\d{8,15}|sim-[a-z0-9]{3,12})$/;

// ---------------------------------------------------------------- rutas

async function webhook(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'GET') {
    const q = url.searchParams;
    const ok = q.get('hub.mode') === 'subscribe' && env.wa.verifyToken && safeEqual(q.get('hub.verify_token') ?? '', env.wa.verifyToken);
    if (!ok) throw new HttpError(403, 'Verificación fallida');
    return send(res, 200, q.get('hub.challenge') ?? '', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (req.method !== 'POST' || !env.wa.enabled) throw new HttpError(404, 'No encontrado');
  if (!env.wa.appSecret) throw new HttpError(503, 'Falta WA_APP_SECRET: no se pueden validar los webhooks');

  const raw = await readBody(req, 1024 * 1024);
  if (!wa.verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) throw new HttpError(401, 'Firma inválida');

  send(res, 200, 'ok');
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  for (const m of parseWebhook(payload)) {
    const { mediaId, ...rest } = m;
    void enqueue(() => ingest({ ...rest, load: mediaId ? () => wa.downloadMedia(mediaId) : undefined }));
  }
}

async function simulator(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'POST' && url.pathname === '/sim/send') {
    const body = await readJson(req);
    const phone = str(body.phone, 20);
    if (!/^sim-[a-z0-9]{3,12}$/.test(phone)) throw new HttpError(400, 'Teléfono de prueba inválido');
    const media = body.media as { data?: unknown } | undefined;
    const m: Inbound = {
      from: phone,
      name: str(body.name, 40) || undefined,
      type: media ? 'media' : 'text',
      text: str(body.text, 2000),
      load: typeof media?.data === 'string' ? async () => Buffer.from(media.data as string, 'base64') : undefined,
    };
    await enqueue(() => ingest(m));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/sim/messages') {
    const phone = url.searchParams.get('phone') ?? '';
    if (!/^sim-[a-z0-9]{3,12}$/.test(phone)) throw new HttpError(400, 'Teléfono de prueba inválido');
    return json(res, 200, store.messagesFor(phone, Number(url.searchParams.get('after')) || 0));
  }
  if (req.method === 'GET') return sendPublic(res, url.pathname);
  throw new HttpError(404, 'No encontrado');
}

const LISTO_TEXT = (kind: string, id: number, delivery: string, address: string | null) =>
  `✅ Tu ${kind} *#${id}* está ${kind === 'receta' ? 'lista' : 'listo'} ` +
  (delivery === 'envio' ? `y sale hacia ${address}.` : `para retirar en ${cfg.address}.`);

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const { pathname: path } = url;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/me') return json(res, 200, { pharmacy: cfg.name });
  if (method === 'GET' && path === '/api/orders') return json(res, 200, store.listOrders());
  if (method === 'GET' && path === '/api/chats') return json(res, 200, store.chats());

  let m = /^\/api\/orders\/(\d+)\/status$/.exec(path);
  if (method === 'POST' && m) {
    const id = Number(m[1]);
    const status = str((await readJson(req)).status, 20) as OrderStatus;
    if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Estado inválido');
    const order = store.getOrder(id);
    if (!order) throw new HttpError(404, 'Pedido inexistente');
    store.setOrderStatus(id, status);
    if (status === 'listo' && order.status !== 'listo') {
      await deliver(order.phone, [LISTO_TEXT(order.kind, id, order.delivery, order.address)]);
    }
    return json(res, 200, { ok: true });
  }

  m = /^\/api\/media\/([\w.-]+)$/.exec(path);
  if (method === 'GET' && m) {
    const file = m[1];
    if (!MEDIA_FILE_RE.test(file) || !existsSync(mediaPath(env.dataDir, file))) throw new HttpError(404, 'No encontrado');
    return send(res, 200, readFileSync(mediaPath(env.dataDir, file)), {
      'Content-Type': contentTypeFor(file),
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  }

  m = /^\/api\/chats\/([\w+-]+)\/(messages|reply|resolve)$/.exec(path);
  if (m && PHONE_RE.test(m[1])) {
    const [, phone, action] = m;
    if (method === 'GET' && action === 'messages') {
      return json(res, 200, store.messagesFor(phone, Number(url.searchParams.get('after')) || 0));
    }
    if (method === 'POST' && action === 'reply') {
      const text = str((await readJson(req)).text, 1000);
      if (!text) throw new HttpError(400, 'Mensaje vacío');
      try {
        await wa.sendText(phone, text);
      } catch (err) {
        throw new HttpError(502, err instanceof Error ? err.message : 'No se pudo enviar');
      }
      if (store.canLog(phone)) store.logMessage({ phone, direction: 'out', body: text });
      // Si el equipo responde a mano, el bot deja de intervenir hasta que se resuelva el chat.
      const session = store.getSession(phone);
      if (session?.state !== 'humano') store.saveSession(phone, 'humano', { handoffAt: store.nowIso() });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'resolve') {
      store.saveSession(phone, 'menu');
      await deliver(phone, ['Gracias por escribirnos 🙌 Si necesitás algo más, escribí *menu*.']);
      return json(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'No encontrado');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname: path } = url;

    if (path === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (path === '/webhook') return await webhook(req, res, url);
    if (await agentApi.handle(req, res, url)) return;
    if (path === '/app.css') return sendPublic(res, path);
    if (req.method === 'GET' && (path === '/privacidad' || path === '/eliminacion-datos')) {
      const html = path === '/privacidad' ? renderPrivacyPolicy(cfg, env.retentionDays) : renderDataDeletion(cfg, env.retentionDays);
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HTML_CSP });
    }
    if (env.simulator && path.startsWith('/sim')) return await simulator(req, res, url);
    if (path === '/') return send(res, 302, '', { Location: '/panel' });

    if (!authorized(req)) {
      return send(res, 401, 'Se necesita usuario y clave', { 'WWW-Authenticate': 'Basic realm="Farmacia", charset="UTF-8"' });
    }
    if (path.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' && (path === '/panel' || path === '/panel.js')) return sendPublic(res, path);
    throw new HttpError(404, 'No encontrado');
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Error interno' });
  }
});

// ---------------------------------------------------------------- tareas periódicas y arranque

const MINUTE = 60_000;
setInterval(() => void sendDueReminders().catch((e) => console.error('Recordatorios:', e)), MINUTE);

const purge = () => deleteMedia(env.dataDir, store.purge(env.retentionDays));
purge();
setInterval(purge, 6 * 60 * MINUTE);

server.listen(env.port, env.host, () => {
  const base = `http://${env.host}:${env.port}`;
  console.log(`\n${cfg.name} — bot de farmacia`);
  console.log(`  Panel del mostrador: ${base}/panel  (usuario: ${env.panelUser})`);
  if (env.panelPasswordGenerated) console.log(`  Clave generada para esta sesión: ${env.panelPassword}  (fijala con PANEL_PASSWORD en .env)`);
  if (env.simulator) console.log(`  Simulador de chat:   ${base}/sim`);
  if (env.agentToken) console.log(`  API para n8n/Claude: ${base}/agent/*  (Bearer token)${catalog ? ` · catálogo: ${catalog.count()} productos` : ' · ⚠ sin catálogo (npm run catalog:scrape)'}`);
  if (env.agentToken) console.log(`  Claude (/agent/respond): ${anthropicClient ? `activo · modelo ${env.anthropic.model}${env.anthropic.effort ? ` · esfuerzo ${env.anthropic.effort}` : ''}` : 'apagado (falta ANTHROPIC_API_KEY)'}`);
  else console.log(`  API para n8n/Claude: apagada. ${env.agentTokenTooShort ? 'AGENT_API_TOKEN tiene menos de 24 caracteres.' : 'Definí AGENT_API_TOKEN (24+ caracteres) para activarla.'}`);
  if (env.wa.enabled) {
    console.log('  WhatsApp: conectado. Webhook en /webhook');
    if (!env.wa.appSecret) console.warn('  ⚠ Falta WA_APP_SECRET: los mensajes entrantes se van a rechazar.');
    if (!env.wa.reminderTemplate) console.warn('  ⚠ Sin WA_REMINDER_TEMPLATE: los recordatorios solo llegan dentro de las 24 h de la última respuesta.');
  } else {
    console.log('  WhatsApp directo: apagado (los mensajes entran por el simulador o por n8n). Completá WA_* para conectarlo a este servidor.');
  }
});
