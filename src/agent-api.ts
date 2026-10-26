import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { systemPrompt, TOOLS } from './agent-prompt.ts';
import type { Bot, Incoming } from './bot.ts';
import type { Catalog, CatalogProduct, SaleType } from './catalog.ts';
import type { PharmacyConfig } from './config.ts';
import type { Store } from './db.ts';
import { formatHours, isOpenNow } from './hours.ts';
import { HttpError, json, readJson, safeEqual, str } from './http.ts';
import { contentTypeFor, MEDIA_FILE_RE, mediaPath, saveMedia } from './media.ts';

const PHONE_RE = /^(\d{8,15}|sim-[a-z0-9]{3,12})$/;
const MEDIA_WINDOW_MS = 6 * 3_600_000;
const MAX_OPEN_ORDERS = 5;
const MAX_ACTIVE_REMINDERS = 5;
const HISTORY_MESSAGES = 20;

type Deps = {
  store: Store;
  cfg: PharmacyConfig;
  bot: Bot;
  catalog?: Catalog;
  token: string;
  dataDir: string;
};

/**
 * API para el orquestador (n8n) y el modelo de lenguaje. Todo cuelga de /agent y exige `Authorization: Bearer <token>`.
 * El teléfono del cliente lo manda siempre el orquestador, nunca el modelo.
 */
export function createAgentApi(deps: Deps) {
  const { store, cfg, bot, catalog, dataDir } = deps;

  function authenticate(req: IncomingMessage) {
    if (!deps.token) throw new HttpError(503, 'API de agente apagada: falta AGENT_API_TOKEN (mínimo 24 caracteres)');
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), deps.token)) throw new HttpError(401, 'Token inválido');
  }

  const phoneOf = (value: unknown) => {
    const phone = str(value, 20);
    if (!PHONE_RE.test(phone)) throw new HttpError(400, 'phone inválido');
    return phone;
  };

  /** Casi todo exige que la persona haya aceptado el aviso de privacidad. */
  function requireConsent(phone: string) {
    if (!store.hasConsent(phone)) throw new HttpError(403, 'consent_required');
  }

  const pharmacyInfo = () => ({
    name: cfg.name,
    address: cfg.address,
    phone: cfg.phone,
    open_now: isOpenNow(cfg, store.clock()),
    hours: formatHours(cfg),
    delivery: cfg.delivery,
  });

  const publicProduct = (p: CatalogProduct) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    active_ingredient: p.ingredients,
    presentation: p.presentation,
    dose: p.dose,
    sale_type: p.sale_type,
    requires_prescription: p.sale_type === 'receta',
    reference_price_ars: p.price,
    description: p.description.slice(0, 300),
  });

  /** Historial para el modelo: roles alternados que empiezan con el cliente. */
  function history(phone: string) {
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of store.lastMessages(phone, HISTORY_MESSAGES)) {
      const role = m.direction === 'in' ? 'user' : 'assistant';
      const content = m.media_file ? `[el cliente mandó un archivo adjunto]${m.body && m.body !== '[adjunto]' ? ` ${m.body}` : ''}` : m.body;
      const last = turns[turns.length - 1];
      if (last?.role === role) last.content += `\n${content}`;
      else turns.push({ role, content });
    }
    while (turns[0]?.role === 'assistant') turns.shift();
    return turns;
  }

  // ---------------------------------------------------------------- rutas

  async function inbound(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const phone = phoneOf(body.phone);
    const name = str(body.name, 40) || undefined;
    const messageId = str(body.message_id, 200);
    if (messageId && !store.markProcessed(messageId)) return json(res, 200, { action: 'silent', reason: 'duplicate' });

    const type = str(body.type, 12) || 'text';
    let incoming: Incoming;
    if (type === 'media') {
      const file = str((body.media as { file?: unknown } | undefined)?.file, 80);
      if (!MEDIA_FILE_RE.test(file) || !existsSync(mediaPath(dataDir, file))) throw new HttpError(400, 'media.file inválido: subilo antes con /agent/media');
      incoming = { from: phone, name, type: 'media', text: str(body.text, 2000), media: { file, mime: contentTypeFor(file) } };
    } else if (type === 'unsupported') {
      incoming = { from: phone, name, type: 'unsupported' };
    } else {
      incoming = { from: phone, name, type: 'text', text: str(body.text, 2000) };
    }

    const decision = bot.screenForAgent(incoming);
    if (decision.action !== 'agent') return json(res, 200, decision);
    json(res, 200, {
      action: 'agent',
      customer: { phone, name: store.getCustomer(phone)?.name ?? name ?? null },
      messages: history(phone),
      notes: decision.notes,
      pharmacy: pharmacyInfo(),
    });
  }

  async function outbound(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const phone = phoneOf(body.phone);
    const texts = Array.isArray(body.replies) ? body.replies : [body.text];
    let logged = 0;
    for (const text of texts) {
      const clean = str(text, 4000);
      if (clean && store.canLog(phone)) {
        store.logMessage({ phone, direction: 'out', body: clean });
        logged++;
      }
    }
    json(res, 200, { ok: true, logged });
  }

  async function uploadMedia(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req, 16 * 1024 * 1024);
    const phone = phoneOf(body.phone);
    if (!store.canLog(phone)) throw new HttpError(403, 'consent_required');
    if (typeof body.data !== 'string') throw new HttpError(400, 'Falta data (base64)');
    const saved = saveMedia(dataDir, Buffer.from(body.data, 'base64'));
    if (!saved) throw new HttpError(415, 'Solo se aceptan JPG, PNG, WebP o PDF de hasta 10 MB');
    json(res, 200, saved);
  }

  function searchCatalog(res: ServerResponse, url: URL) {
    if (!catalog) throw new HttpError(503, 'Catálogo no cargado: corré npm run catalog:scrape');
    const query = str(url.searchParams.get('q'), 120);
    if (!query) throw new HttpError(400, 'Falta q');
    const saleType = url.searchParams.get('sale_type');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 8, 8);
    // Se pide de más y se filtra después: el índice no filtra por tipo de venta.
    const found = catalog.search(query, saleType ? 40 : limit).filter((p) => !saleType || p.sale_type === (saleType as SaleType));
    json(res, 200, {
      note: 'Precios de referencia de una muestra de demostración; el equipo confirma el total. El catálogo no informa stock.',
      results: found.slice(0, limit).map(publicProduct),
    });
  }

  async function createOrder(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const phone = phoneOf(body.phone);
    requireConsent(phone);

    const kind = str(body.kind, 10);
    if (kind !== 'pedido' && kind !== 'receta') throw new HttpError(400, 'kind debe ser pedido o receta');
    const delivery = str(body.delivery, 10);
    if (delivery !== 'retiro' && delivery !== 'envio') throw new HttpError(400, 'delivery debe ser retiro o envio');
    const detail = str(body.detail, 2000);
    if (kind === 'pedido' && !detail) throw new HttpError(400, 'Falta detail');
    const address = str(body.address, 300);
    if (delivery === 'envio' && address.length < 5) throw new HttpError(400, 'Para un envío hace falta la dirección completa');

    const open = store.ordersForPhone(phone, 20).filter((o) => o.status !== 'entregado' && o.status !== 'cancelado');
    if (open.length >= MAX_OPEN_ORDERS) throw new HttpError(409, 'Ya hay demasiados pedidos abiertos para esta persona: derivala al equipo');

    const media = store.unattachedMedia(phone, new Date(store.clock().getTime() - MEDIA_WINDOW_MS).toISOString());
    if (kind === 'receta' && !media.length) throw new HttpError(422, 'Falta la foto o el PDF de la receta: pedíselo al cliente');

    const id = store.createOrder({ phone, kind, detail, delivery, address: delivery === 'envio' ? address : undefined, media });
    json(res, 200, {
      order_id: id,
      status: 'nuevo',
      attached_files: media.length,
      open_now: isOpenNow(cfg, store.clock()),
      message: `Registrado como ${kind} #${id}. El equipo revisa disponibilidad y confirma el total por este chat.`,
    });
  }

  async function createReminder(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const phone = phoneOf(body.phone);
    requireConsent(phone);
    const medication = str(body.medication, 120);
    const days = Number(body.days);
    if (medication.length < 3) throw new HttpError(400, 'Falta medication');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'days debe ser un entero entre 1 y 365');
    if (store.activeReminderCount(phone) >= MAX_ACTIVE_REMINDERS) throw new HttpError(409, 'Ya tiene el máximo de recordatorios activos');
    const due = new Date(store.clock().getTime() + days * 86_400_000);
    store.createReminder(phone, medication, due.toISOString());
    json(res, 200, { ok: true, due_date: due.toLocaleDateString('es-AR', { timeZone: cfg.timezone, day: 'numeric', month: 'long' }) });
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/agent/config') {
      return json(res, 200, { system_prompt: systemPrompt(cfg), tools: TOOLS });
    }
    if (method === 'GET' && path === '/agent/pharmacy') return json(res, 200, pharmacyInfo());
    if (method === 'GET' && path === '/agent/catalog/search') return searchCatalog(res, url);

    const product = /^\/agent\/catalog\/products\/(\d{1,12})$/.exec(path);
    if (method === 'GET' && product) {
      const found = catalog?.get(product[1]);
      if (!found) throw new HttpError(404, 'Producto inexistente');
      return json(res, 200, publicProduct(found));
    }

    if (method === 'POST' && path === '/agent/inbound') return inbound(req, res);
    if (method === 'POST' && path === '/agent/outbound') return outbound(req, res);
    if (method === 'POST' && path === '/agent/media') return uploadMedia(req, res);
    if (method === 'POST' && path === '/agent/orders') return createOrder(req, res);
    if (method === 'POST' && path === '/agent/reminders') return createReminder(req, res);

    if (method === 'GET' && path === '/agent/orders') {
      const phone = phoneOf(url.searchParams.get('phone'));
      requireConsent(phone);
      return json(res, 200, store.ordersForPhone(phone, 5).map((o) => ({
        order_id: o.id, kind: o.kind, status: o.status, detail: o.detail.slice(0, 300), delivery: o.delivery, created_at: o.created_at,
      })));
    }

    if (method === 'POST' && path === '/agent/reminders/cancel') {
      const phone = phoneOf((await readJson(req)).phone);
      requireConsent(phone);
      return json(res, 200, { ok: true, cancelled: store.cancelReminders(phone) });
    }

    if (method === 'POST' && path === '/agent/handoff') {
      const body = await readJson(req);
      const phone = phoneOf(body.phone);
      requireConsent(phone);
      const message = bot.handoffPhone(phone, str(body.reason, 300), body.urgent === true);
      return json(res, 200, { ok: true, message });
    }

    throw new HttpError(404, 'No encontrado');
  }

  return {
    /** Atiende cualquier request que empiece con /agent. Devuelve false si no era para esta API. */
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!url.pathname.startsWith('/agent/')) return false;
      authenticate(req);
      await route(req, res, url);
      return true;
    },
  };
}

export type AgentApi = ReturnType<typeof createAgentApi>;
