import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { createAgentApi } from '../src/agent-api.ts';
import { createAgentRunner } from '../src/agent-llm.ts';
import type { MessagesClient } from '../src/agent-llm.ts';
import { createBot } from '../src/bot.ts';
import { loadPharmacy } from '../src/config.ts';
import { createStore } from '../src/db.ts';
import { HttpError, json } from '../src/http.ts';

const TOKEN = 'token-de-prueba-con-mas-de-24-caracteres';
const NOW = new Date('2026-03-04T15:00:00Z');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

type Step = { stop_reason: Anthropic.Message['stop_reason']; content: Anthropic.ContentBlock[] };
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;
const toolUse = (name: string, input: unknown) => ({ type: 'tool_use', id: `toolu_${name}`, name, input }) as Anthropic.ToolUseBlock;

let dir: string;
let server: Server;
let base: string;
const store = createStore(':memory:', () => NOW);

// Lo que Claude "hace" en cada llamada, en orden.
let script: Step[] = [];
const modelCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fakeClient: MessagesClient = {
  messages: {
    async create(params) {
      modelCalls.push(structuredClone(params));
      const step = script.shift();
      if (!step) throw new Error('el guion se quedó sin respuestas');
      return { id: 'msg', type: 'message', role: 'assistant', model: params.model, ...step, usage: {} } as unknown as Anthropic.Message;
    },
  },
};

// Lo que "devuelve WhatsApp" al pedir un adjunto.
const downloads: string[] = [];
let download: (id: string) => Promise<Buffer> = async () => JPEG;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'farmacia-media-'));
  const cfg = loadPharmacy();
  const bot = createBot({ store, cfg });
  const api = createAgentApi({
    store, cfg, bot, token: TOKEN, dataDir: dir,
    downloadMedia: async (id) => {
      downloads.push(id);
      return download(id);
    },
    makeRunner: (ops) => createAgentRunner({ client: fakeClient, model: 'claude-opus-5-5', cfg, ops, bot }),
  });
  server = createServer(async (req, res) => {
    try {
      await api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
    } catch (err) {
      json(res, err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function respond(body: object) {
  const res = await fetch(`${base}/agent/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const message = (phone: string, extra: object) => ({ phone, name: 'Ana', type: 'text', text: '', ...extra });

async function consented(phone: string) {
  await respond(message(phone, { text: 'hola' }));
  await respond(message(phone, { text: '1' }));
}

test('una foto de receta se descarga, se guarda y Claude la ve como adjunto', async () => {
  const phone = '5491166814208';
  await consented(phone);
  downloads.length = 0;
  script = [{ stop_reason: 'end_turn', content: [text('Recibida ✅ ¿Tenés obra social?')] }];

  const res = await respond(message(phone, { type: 'media', media_id: '1234567890', text: 'receta de mi mamá', message_id: 'wamid.FOTO1' }));

  assert.deepEqual(downloads, ['1234567890']);
  assert.equal(res.body.source, 'claude');
  assert.deepEqual(res.body.replies, ['Recibida ✅ ¿Tenés obra social?']);
  const last = modelCalls.at(-1)!.messages.at(-1)!;
  assert.match(String(last.content), /archivo adjunto.*receta de mi mamá/);
  const [saved] = store.unattachedMedia(phone, new Date(NOW.getTime() - 3_600_000).toISOString());
  assert.equal(saved.mime, 'image/jpeg');
  assert.equal(existsSync(join(dir, 'media', saved.file)), true);
});

test('la foto se adjunta sola a la receta que registra Claude', async () => {
  const phone = '5491166814209';
  await consented(phone);
  script = [{ stop_reason: 'end_turn', content: [text('Recibida ✅ ¿Tenés obra social?')] }];
  await respond(message(phone, { type: 'media', media_id: '2222222222', message_id: 'wamid.FOTO2' }));
  script = [
    { stop_reason: 'tool_use', content: [toolUse('create_order', { kind: 'receta', detail: 'Obra social PAMI', delivery: 'retiro' })] },
    { stop_reason: 'end_turn', content: [text('Listo, tu receta quedó registrada.')] },
  ];

  const res = await respond(message(phone, { text: 'sí, confirmo', message_id: 'wamid.TXT2' }));

  assert.match(res.body.replies[0], /quedó registrada/);
  const [order] = store.ordersForPhone(phone);
  assert.equal(order.kind, 'receta');
  assert.equal(order.media.length, 1);
  assert.equal(order.detail, 'Obra social PAMI');
});

test('sin consentimiento no se descarga nada: se responde el aviso de privacidad', async () => {
  const phone = '5491166814210';
  downloads.length = 0;
  const res = await respond(message(phone, { type: 'media', media_id: '3333333333', message_id: 'wamid.FOTO3' }));
  assert.deepEqual(downloads, []);
  assert.equal(res.body.source, 'rules');
  assert.match(res.body.replies[0], /Respondé \*1\* para aceptar/);
  assert.equal(store.getCustomer(phone), undefined);
});

test('un archivo que no es foto ni PDF se trata como no soportado', async () => {
  const phone = '5491166814211';
  await consented(phone);
  download = async () => Buffer.from('esto es texto plano, no una imagen ni un PDF de verdad');
  try {
    const res = await respond(message(phone, { type: 'media', media_id: '4444444444', message_id: 'wamid.FOTO4' }));
    assert.equal(res.body.source, 'rules');
    assert.match(res.body.replies[0], /no puedo abrir ese tipo de mensaje/);
    assert.deepEqual(store.unattachedMedia(phone, new Date(NOW.getTime() - 3_600_000).toISOString()), []);
  } finally {
    download = async () => JPEG;
  }
});

test('si WhatsApp falla al entregar el adjunto, el cliente recibe un aviso y no se rompe nada', async () => {
  const phone = '5491166814212';
  await consented(phone);
  download = async () => {
    throw new Error('WhatsApp media 500');
  };
  const original = console.error;
  console.error = () => {};
  try {
    const res = await respond(message(phone, { type: 'media', media_id: '5555555555', message_id: 'wamid.FOTO5' }));
    assert.equal(res.status, 200);
    assert.match(res.body.replies[0], /no puedo abrir ese tipo de mensaje/);
  } finally {
    console.error = original;
    download = async () => JPEG;
  }
});

test('un media_id que no es numérico se rechaza', async () => {
  const phone = '5491166814213';
  await consented(phone);
  const res = await respond(message(phone, { type: 'media', media_id: '../../etc/passwd', message_id: 'wamid.FOTO6' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /media_id inválido/);
});

test('un reintento de Meta con el mismo mensaje no descarga la foto dos veces', async () => {
  const phone = '5491166814214';
  await consented(phone);
  downloads.length = 0;
  script = [{ stop_reason: 'end_turn', content: [text('Recibida ✅')] }];
  await respond(message(phone, { type: 'media', media_id: '6666666666', message_id: 'wamid.FOTO7' }));
  const again = await respond(message(phone, { type: 'media', media_id: '6666666666', message_id: 'wamid.FOTO7' }));
  assert.deepEqual(again.body, { action: 'silent', reason: 'duplicate' });
  assert.deepEqual(downloads, ['6666666666']);
});

test('sin WA_ACCESS_TOKEN el servidor avisa que no puede bajar adjuntos', async () => {
  const cfg = loadPharmacy();
  const bot = createBot({ store, cfg });
  const api = createAgentApi({
    store, cfg, bot, token: TOKEN, dataDir: dir,
    makeRunner: (ops) => createAgentRunner({ client: fakeClient, model: 'claude-opus-5-5', cfg, ops, bot }),
  });
  const phone = '5491166814215';
  await consented(phone);
  const srv = createServer(async (req, res) => {
    try {
      await api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
    } catch (err) {
      json(res, err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/agent/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message(phone, { type: 'media', media_id: '7777777777', message_id: 'wamid.FOTO8' })),
    });
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /WA_ACCESS_TOKEN/);
  } finally {
    srv.close();
  }
});
