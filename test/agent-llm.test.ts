import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { createAgentApi } from '../src/agent-api.ts';
import { createAgentRunner } from '../src/agent-llm.ts';
import type { AgentContext, MessagesClient } from '../src/agent-llm.ts';
import { createAgentOps } from '../src/agent-ops.ts';
import { createBot } from '../src/bot.ts';
import { loadPharmacy } from '../src/config.ts';
import { createStore } from '../src/db.ts';
import { HttpError, json } from '../src/http.ts';

const PHONE = '5493875550001';
const OTHER = '5493875550002';
const NOW = new Date('2026-03-04T15:00:00Z'); // miércoles 12:00 en Argentina
const TOKEN = 'token-de-prueba-con-mas-de-24-caracteres';

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Step = { stop_reason: Anthropic.Message['stop_reason']; content: Anthropic.ContentBlock[] };

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;
const toolUse = (name: string, input: unknown, id = `toolu_${name}`): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;
const say = (t: string): Step => ({ stop_reason: 'end_turn', content: [text(t)] });
const callTool = (...blocks: Anthropic.ToolUseBlock[]): Step => ({ stop_reason: 'tool_use', content: blocks });

/** Cliente simulado: devuelve respuestas guionadas y guarda una copia de cada pedido que recibió. */
function fakeClient(script: Step[] | ((params: Params, n: number) => Promise<Step> | Step)) {
  const calls: Params[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const n = calls.length - 1;
        const step = typeof script === 'function' ? await script(params, n) : script[n];
        if (!step) throw new Error('el guion se quedó sin respuestas');
        return { id: `msg_${n}`, type: 'message', role: 'assistant', model: params.model, ...step, usage: {} } as unknown as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

function setup(script: Parameters<typeof fakeClient>[0], effort?: string) {
  const store = createStore(':memory:', () => NOW);
  const cfg = loadPharmacy();
  const bot = createBot({ store, cfg });
  const ops = createAgentOps({ store, cfg, bot });
  const fake = fakeClient(script);
  const runner = createAgentRunner({ client: fake.client, model: 'claude-opus-5-5', effort, cfg, ops, bot });
  store.grantConsent(PHONE, 'Ana');
  const context = (content = 'hola'): AgentContext => ({ messages: [{ role: 'user', content }], notes: [], pharmacy: ops.pharmacyInfo() });
  return { store, runner, calls: fake.calls, context };
}

// ---------------------------------------------------------------- bucle de Claude

test('una respuesta sin herramientas se devuelve como un solo mensaje', async () => {
  const { runner, calls, context } = setup([say('Hola! ¿En qué te puedo ayudar?')]);
  const replies = await runner.run(PHONE, { ...context('hola'), notes: ['Nota de prueba'] });

  assert.deepEqual(replies, ['Hola! ¿En qué te puedo ayudar?']);
  const [params] = calls;
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.tools?.length, 7);
  assert.deepEqual(params.messages, [{ role: 'user', content: 'hola' }]);
  const system = (params.system as Anthropic.TextBlockParam[]).map((b) => b.text).join('\n');
  assert.match(system, /NUNCA des indicaciones de salud/);
  assert.match(system, /Farmacia Demo/);
  assert.match(system, /Nota de prueba/);
  assert.equal('temperature' in params, false, 'los modelos nuevos rechazan temperature');
  assert.equal('thinking' in params, false);
  assert.equal('output_config' in params, false, 'sin ANTHROPIC_EFFORT se usa el valor del modelo');
});

test('el esfuerzo se manda solo si es un valor válido', async () => {
  const withEffort = setup([say('ok')], 'low');
  await withEffort.runner.run(PHONE, withEffort.context());
  assert.deepEqual((withEffort.calls[0] as { output_config?: unknown }).output_config, { effort: 'low' });

  const invalid = setup([say('ok')], 'rapidisimo');
  await invalid.runner.run(PHONE, invalid.context());
  assert.equal('output_config' in invalid.calls[0], false);
});

test('el modelo busca en el catálogo y responde con lo que devolvió la herramienta', async () => {
  const search = toolUse('search_catalog', { query: 'ibuprofeno' }, 'toolu_1');
  const { runner, calls, context, store } = setup([callTool(search), say('Tengo *Ibuprofeno*, ¿lo agrego al pedido?')]);
  // Sin catálogo cargado, la herramienta devuelve el error al modelo (no rompe el turno).
  const replies = await runner.run(PHONE, context('quiero ibuprofeno'));

  assert.deepEqual(replies, ['Tengo *Ibuprofeno*, ¿lo agrego al pedido?']);
  assert.equal(calls.length, 2);
  const second = calls[1].messages;
  assert.equal(second.length, 3);
  assert.deepEqual(second[1], { role: 'assistant', content: [search] }, 'el turno del modelo se reenvía tal cual');
  const result = (second[2].content as Anthropic.ToolResultBlockParam[])[0];
  assert.equal(result.tool_use_id, 'toolu_1');
  assert.equal(result.is_error, true);
  assert.match(String(result.content), /Catálogo no cargado/);
  store.close();
});

test('el teléfono sale siempre del mensaje entrante: lo que escriba el modelo no cambia sobre quién actúa', async () => {
  const { runner, store, context } = setup([
    callTool(toolUse('create_order', { kind: 'pedido', detail: '1 gasa', delivery: 'retiro', phone: OTHER })),
    say('Listo'),
  ]);
  store.grantConsent(OTHER, 'Otra');
  await runner.run(PHONE, context('quiero una gasa'));
  assert.equal(store.ordersForPhone(PHONE).length, 1);
  assert.equal(store.ordersForPhone(OTHER).length, 0);
});

test('un pedido inválido vuelve como error de herramienta y el modelo puede corregirlo', async () => {
  const { runner, calls, context, store } = setup([
    callTool(toolUse('create_order', { kind: 'pedido', detail: '', delivery: 'envio' }, 'toolu_a')),
    say('Me falta la dirección, ¿me la pasás?'),
  ]);
  const replies = await runner.run(PHONE, context('mandame gasas'));
  assert.deepEqual(replies, ['Me falta la dirección, ¿me la pasás?']);
  const result = (calls[1].messages[2].content as Anthropic.ToolResultBlockParam[])[0];
  assert.equal(result.is_error, true);
  assert.equal(store.ordersForPhone(PHONE).length, 0);
});

test('varias herramientas en un mismo turno se resuelven y vuelven en un solo mensaje', async () => {
  const { runner, calls, context } = setup([
    callTool(toolUse('get_pharmacy_info', {}, 'toolu_1'), toolUse('get_orders', {}, 'toolu_2')),
    say('Estamos abiertos y no tenés pedidos.'),
  ]);
  await runner.run(PHONE, context('hola'));
  const results = calls[1].messages[2].content as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ['toolu_1', 'toolu_2']);
  assert.match(String(results[0].content), /"open_now":true/);
  assert.equal(results[1].content, '[]');
});

test('derivar a una persona deja el chat en espera con el motivo', async () => {
  const { runner, context, store } = setup([
    callTool(toolUse('handoff_to_human', { reason: 'Consulta por interacción de medicamentos', urgent: false })),
    say('Te paso con el equipo.'),
  ]);
  await runner.run(PHONE, context('¿qué pasa si mezclo dos pastillas?'));
  const session = store.getSession(PHONE);
  assert.equal(session?.state, 'humano');
  assert.match(session?.data.reason ?? '', /interacción/);
});

test('si la API falla, el cliente no queda colgado: pasa a una persona', async () => {
  const { runner, context, store } = setup(() => {
    throw new Error('529 overloaded');
  });
  const original = console.error;
  console.error = () => {};
  try {
    const replies = await runner.run(PHONE, context('hola'));
    assert.match(replies[0], /Tuve un problema para responderte/);
    assert.match(replies[0], /avisé al equipo/);
  } finally {
    console.error = original;
  }
  assert.equal(store.getSession(PHONE)?.state, 'humano');
  assert.match(store.getSession(PHONE)?.data.reason ?? '', /529 overloaded/);
});

test('un rechazo del modelo, una respuesta cortada o vacía también derivan a una persona', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    for (const step of [
      { stop_reason: 'refusal', content: [] },
      { stop_reason: 'max_tokens', content: [text('Te cuento que…')] },
      { stop_reason: 'end_turn', content: [text('   ')] },
    ] as Step[]) {
      const { runner, context, store } = setup([step]);
      const replies = await runner.run(PHONE, context('hola'));
      assert.match(replies[0], /Tuve un problema/);
      assert.equal(store.getSession(PHONE)?.state, 'humano');
    }
  } finally {
    console.error = original;
  }
});

test('un modelo que no deja de pedir herramientas se corta a los 6 pasos', async () => {
  const { runner, calls, context } = setup(() => callTool(toolUse('get_pharmacy_info', {})));
  const original = console.error;
  console.error = () => {};
  try {
    const replies = await runner.run(PHONE, context('hola'));
    assert.match(replies[0], /Tuve un problema/);
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 6);
});

test('la negrita doble de Markdown pasa a la negrita de WhatsApp y las respuestas largas se recortan', async () => {
  const { runner, context } = setup([say('El **total** lo confirma el equipo'), say('x'.repeat(5000))]);
  assert.deepEqual(await runner.run(PHONE, context()), ['El *total* lo confirma el equipo']);
  assert.equal((await runner.run(PHONE, context()))[0].length, 3500);
});

// ---------------------------------------------------------------- POST /agent/respond

async function startApi(script?: Parameters<typeof fakeClient>[0]) {
  const store = createStore(':memory:', () => NOW);
  const cfg = loadPharmacy();
  const bot = createBot({ store, cfg });
  const fake = script ? fakeClient(script) : undefined;
  const api = createAgentApi({
    store, cfg, bot, token: TOKEN, dataDir: '.',
    makeRunner: fake ? (ops) => createAgentRunner({ client: fake.client, model: 'claude-opus-5-5', cfg, ops, bot }) : undefined,
  });
  const server: Server = createServer(async (req, res) => {
    try {
      await api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
    } catch (err) {
      json(res, err instanceof HttpError ? err.status : 500, { error: String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const respond = async (body: object) => {
    const res = await fetch(`${base}/agent/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { store, calls: fake?.calls ?? [], respond, close: () => { server.close(); store.close(); } };
}

const msg = (phone: string, text: string, extra: object = {}) => ({ phone, name: 'Ana López', type: 'text', text, ...extra });

test('respond: sin clave de Anthropic el endpoint queda apagado', async () => {
  const api = await startApi();
  try {
    assert.equal((await api.respond(msg(PHONE, 'hola'))).status, 503);
  } finally {
    api.close();
  }
});

test('respond: las reglas fijas contestan solas y Claude solo entra cuando corresponde', async () => {
  const api = await startApi([say('Tenemos ibuprofeno. ¿Cuántas cajas?')]);
  try {
    const first = await api.respond(msg(PHONE, 'hola'));
    assert.equal(first.body.source, 'rules');
    assert.match(first.body.replies[0], /Respondé \*1\* para aceptar/);
    assert.equal(api.calls.length, 0, 'sin consentimiento no se llama a Claude');

    const accepted = await api.respond(msg(PHONE, '1'));
    assert.equal(accepted.body.source, 'rules');

    const medical = await api.respond(msg(PHONE, '¿puedo tomar ibuprofeno con alcohol?'));
    assert.equal(medical.body.source, 'rules');
    assert.equal(api.calls.length, 0, 'las consultas médicas las corta el código antes que el modelo');
    assert.deepEqual((await api.respond(msg(PHONE, 'gracias'))).body, { action: 'silent' });

    await api.respond(msg(PHONE, 'menu'));
    const asked = await api.respond(msg(PHONE, '¿tienen ibuprofeno?'));
    assert.equal(asked.body.source, 'claude');
    assert.deepEqual(asked.body.replies, ['Tenemos ibuprofeno. ¿Cuántas cajas?']);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].messages.at(-1)?.content, '¿tienen ibuprofeno?');

    const stored = api.store.lastMessages(PHONE, 2).map((m) => `${m.direction}:${m.body}`);
    assert.deepEqual(stored, ['in:¿tienen ibuprofeno?', 'out:Tenemos ibuprofeno. ¿Cuántas cajas?']);
  } finally {
    api.close();
  }
});

test('respond: dos mensajes seguidos del mismo cliente se atienden en orden, no en paralelo', async () => {
  let running = 0;
  let overlapped = false;
  let firstCallStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstCallStarted = resolve; });
  const api = await startApi(async (_params, n) => {
    running++;
    if (running > 1) overlapped = true;
    if (n === 0) firstCallStarted();
    await new Promise((resolve) => setTimeout(resolve, n === 0 ? 80 : 5));
    running--;
    return say(`respuesta ${n + 1}`);
  });
  try {
    await api.respond(msg(PHONE, 'hola'));
    await api.respond(msg(PHONE, '1'));
    // El segundo mensaje se manda recién cuando Claude ya está procesando el primero: así el orden no depende de la red.
    const first = api.respond(msg(PHONE, 'primero'));
    await started;
    const second = api.respond(msg(PHONE, 'segundo'));
    const [a, b] = await Promise.all([first, second]);

    assert.deepEqual(a.body.replies, ['respuesta 1']);
    assert.deepEqual(b.body.replies, ['respuesta 2']);
    assert.equal(overlapped, false);
    const history = api.calls[1].messages;
    assert.deepEqual(
      history.map((m) => m.content),
      ['primero', 'respuesta 1', 'segundo'],
      'el segundo turno ya ve la respuesta al primero',
    );
  } finally {
    api.close();
  }
});

test('respond: un mensaje repetido por su id no se contesta dos veces', async () => {
  const api = await startApi([say('ok')]);
  try {
    await api.respond(msg(PHONE, 'hola'));
    await api.respond(msg(PHONE, '1'));
    const first = await api.respond(msg(PHONE, 'hola de nuevo', { message_id: 'wamid.X' }));
    const again = await api.respond(msg(PHONE, 'hola de nuevo', { message_id: 'wamid.X' }));
    assert.equal(first.body.source, 'claude');
    assert.deepEqual(again.body, { action: 'silent', reason: 'duplicate' });
    assert.equal(api.calls.length, 1);
  } finally {
    api.close();
  }
});
