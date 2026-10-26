import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAgentOps } from './agent-ops.ts';
import type { AgentOps } from './agent-ops.ts';
import type { AgentRunner } from './agent-llm.ts';
import { systemPrompt, TOOLS } from './agent-prompt.ts';
import type { Bot, Incoming } from './bot.ts';
import type { Catalog } from './catalog.ts';
import type { PharmacyConfig } from './config.ts';
import type { Store } from './db.ts';
import { HttpError, json, readJson, safeEqual, str } from './http.ts';
import { contentTypeFor, MEDIA_FILE_RE, mediaPath, saveMedia } from './media.ts';

const PHONE_RE = /^(\d{8,15}|sim-[a-z0-9]{3,12})$/;
const HISTORY_MESSAGES = 20;

type Deps = {
  store: Store;
  cfg: PharmacyConfig;
  bot: Bot;
  catalog?: Catalog;
  token: string;
  dataDir: string;
  /** Si se pasa, habilita POST /agent/respond (Claude corre dentro del bot). */
  makeRunner?: (ops: AgentOps) => AgentRunner;
};

/**
 * API para el orquestador (n8n) y el modelo de lenguaje. Todo cuelga de /agent y exige `Authorization: Bearer <token>`.
 * El teléfono del cliente lo manda siempre el orquestador, nunca el modelo.
 */
export function createAgentApi(deps: Deps) {
  const { store, cfg, bot, dataDir } = deps;
  const ops = createAgentOps({ store, cfg, bot, catalog: deps.catalog });
  const runner = deps.makeRunner?.(ops);

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

  /** Historial para el modelo: roles alternados que empiezan con el cliente. */
  function history(phone: string) {
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of store.lastMessages(phone, HISTORY_MESSAGES)) {
      const role = m.direction === 'in' ? 'user' : 'assistant';
      const content = m.media_file ? `[el cliente mandó un archivo adjunto]${m.body && m.body !== '[adjunto]' ? ` ${m.body}` : ''}` : m.body;
      if (!content.trim()) continue;
      const last = turns[turns.length - 1];
      if (last?.role === role) last.content += `\n${content}`;
      else turns.push({ role, content });
    }
    while (turns[0]?.role === 'assistant') turns.shift();
    return turns;
  }

  /** Un mensaje entrante: aplica las reglas fijas y decide si responde el código, nadie, o Claude. */
  function screenInbound(body: Record<string, unknown>) {
    const phone = phoneOf(body.phone);
    const name = str(body.name, 40) || undefined;
    const messageId = str(body.message_id, 200);
    if (messageId && !store.markProcessed(messageId)) return { phone, duplicate: true as const };

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
    return { phone, duplicate: false as const, decision: bot.screenForAgent(incoming), name };
  }

  const agentContext = (phone: string, notes: string[]) => ({
    messages: history(phone),
    notes,
    pharmacy: ops.pharmacyInfo(),
  });

  const logReplies = (phone: string, replies: string[]) => {
    if (!store.canLog(phone)) return;
    for (const body of replies) store.logMessage({ phone, direction: 'out', body });
  };

  // Un cliente a la vez: si manda dos mensajes seguidos, el segundo espera a que termine el primero.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.then(job);
    const tail = result.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return result;
  }

  // ---------------------------------------------------------------- rutas

  async function inbound(req: IncomingMessage, res: ServerResponse) {
    const screened = screenInbound(await readJson(req));
    if (screened.duplicate) return json(res, 200, { action: 'silent', reason: 'duplicate' });
    const { phone, decision, name } = screened;
    if (decision.action !== 'agent') return json(res, 200, decision);
    json(res, 200, {
      action: 'agent',
      customer: { phone, name: store.getCustomer(phone)?.name ?? name ?? null },
      ...agentContext(phone, decision.notes),
    });
  }

  /** Todo en una llamada: reglas fijas y, si corresponde, Claude. Devuelve siempre los textos a enviar. */
  async function respond(req: IncomingMessage, res: ServerResponse) {
    if (!runner) throw new HttpError(503, 'Claude apagado: falta ANTHROPIC_API_KEY');
    const body = await readJson(req);
    const phone = phoneOf(body.phone);
    const out = await withLock(phone, async () => {
      const screened = screenInbound(body);
      if (screened.duplicate) return { action: 'silent', reason: 'duplicate' };
      const { decision } = screened;
      if (decision.action === 'silent') return { action: 'silent' };
      if (decision.action === 'reply') {
        logReplies(phone, decision.replies);
        return { action: 'reply', source: 'rules', replies: decision.replies };
      }
      const replies = await runner.run(phone, agentContext(phone, decision.notes));
      logReplies(phone, replies);
      return { action: 'reply', source: 'claude', replies };
    });
    json(res, 200, out);
  }

  async function outbound(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const phone = phoneOf(body.phone);
    const texts = (Array.isArray(body.replies) ? body.replies : [body.text]).map((t) => str(t, 4000)).filter(Boolean);
    logReplies(phone, texts);
    json(res, 200, { ok: true, logged: store.canLog(phone) ? texts.length : 0 });
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

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/agent/config') return json(res, 200, { system_prompt: systemPrompt(cfg), tools: TOOLS });
    if (method === 'GET' && path === '/agent/pharmacy') return json(res, 200, ops.pharmacyInfo());
    if (method === 'GET' && path === '/agent/catalog/search') {
      return json(res, 200, ops.searchCatalog({ query: url.searchParams.get('q'), saleType: url.searchParams.get('sale_type'), limit: url.searchParams.get('limit') }));
    }

    const product = /^\/agent\/catalog\/products\/(\d{1,12})$/.exec(path);
    if (method === 'GET' && product) return json(res, 200, ops.getProduct(product[1]));

    if (method === 'GET' && path === '/agent/orders') return json(res, 200, ops.listOrders(phoneOf(url.searchParams.get('phone'))));

    if (method === 'POST') {
      if (path === '/agent/respond') return respond(req, res);
      if (path === '/agent/inbound') return inbound(req, res);
      if (path === '/agent/outbound') return outbound(req, res);
      if (path === '/agent/media') return uploadMedia(req, res);

      const withPhone: Record<string, (phone: string, body: Record<string, unknown>) => unknown> = {
        '/agent/orders': ops.createOrder,
        '/agent/reminders': ops.createReminder,
        '/agent/reminders/cancel': (phone) => ops.cancelReminders(phone),
        '/agent/handoff': (phone, body) => ops.handoff(phone, body),
      };
      const action = withPhone[path];
      if (action) {
        const body = await readJson(req);
        return json(res, 200, action(phoneOf(body.phone), body));
      }
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
