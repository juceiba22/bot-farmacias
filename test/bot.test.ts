import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBot } from '../src/bot.ts';
import type { Incoming } from '../src/bot.ts';
import { loadPharmacy } from '../src/config.ts';
import { createStore } from '../src/db.ts';
import { formatHours, isOpenNow } from '../src/hours.ts';
import { createReminderRunner } from '../src/reminders.ts';

const PHONE = '5493875550001';
const OPEN = new Date('2026-03-04T15:00:00Z'); // miércoles 12:00 en Argentina
const CLOSED = new Date('2026-03-04T05:00:00Z'); // miércoles 02:00 en Argentina
const JPEG = { file: '11111111-1111-1111-1111-111111111111.jpg', mime: 'image/jpeg' };

function setup(start = OPEN) {
  const clock = { now: start };
  const store = createStore(':memory:', () => clock.now);
  const cfg = loadPharmacy();
  const deleted: string[] = [];
  const bot = createBot({ store, cfg, deleteFiles: (files) => deleted.push(...files) });
  const say = (text: string, from = PHONE) => bot.handle({ from, type: 'text', text });
  const send = (msg: Incoming) => bot.handle(msg);
  const join = (replies: string[]) => replies.join('\n');
  const consent = (from = PHONE) => {
    say('hola', from);
    say('1', from);
  };
  return { clock, store, cfg, bot, say, send, join, consent, deleted };
}

test('la primera vez pide consentimiento y no guarda nada hasta que lo den', () => {
  const { say, store, join } = setup();
  assert.match(join(say('hola')), /Respondé \*1\* para aceptar/);
  assert.equal(store.getCustomer(PHONE), undefined);
  assert.equal(store.messagesFor(PHONE).length, 0);

  assert.match(join(say('2')), /no guardamos nada/);
  assert.equal(store.getSession(PHONE), undefined);
  assert.equal(store.getCustomer(PHONE), undefined);
});

test('al aceptar se muestra el menú y se registra el consentimiento', () => {
  const { say, store, join } = setup();
  say('hola');
  const reply = join(say('1'));
  assert.match(reply, /1\. Horarios y ubicación/);
  assert.ok(store.hasConsent(PHONE));
});

test('pedido con retiro en la farmacia', () => {
  const { say, store, consent, join } = setup();
  consent();
  assert.match(join(say('2')), /Contame qué necesitás/);
  say('ibuprofeno 400 x 20');
  say('y un alcohol en gel');
  assert.match(join(say('listo')), /Retiro en la farmacia/);
  assert.match(join(say('1')), /Resumen de tu pedido[\s\S]*ibuprofeno[\s\S]*alcohol[\s\S]*Retiro/);
  assert.match(join(say('1')), /Recibimos tu pedido \*#1\*/);

  const [order] = store.listOrders();
  assert.equal(order.status, 'nuevo');
  assert.equal(order.delivery, 'retiro');
  assert.equal(order.detail, 'ibuprofeno 400 x 20\ny un alcohol en gel');
});

test('pedido con envío pide la dirección', () => {
  const { say, store, consent, join } = setup();
  consent();
  say('2');
  say('pañales talle G');
  say('listo');
  assert.match(join(say('2')), /dirección/);
  assert.match(join(say('x')), /dirección completa/);
  assert.match(join(say('Av. Siempre Viva 742, Barrio Centro')), /Envío a: Av\. Siempre Viva 742/);
  say('1');
  assert.equal(store.listOrders()[0].address, 'Av. Siempre Viva 742, Barrio Centro');
});

test('"listo" sin nada cargado no avanza', () => {
  const { say, consent, join } = setup();
  consent();
  say('2');
  assert.match(join(say('listo')), /Todavía no me dijiste/);
});

test('texto libre en el menú empieza un pedido con ese texto', () => {
  const { say, consent, join, store } = setup();
  consent();
  assert.match(join(say('necesito paracetamol 500')), /Anotado/);
  say('listo');
  say('1');
  say('1');
  assert.equal(store.listOrders()[0].detail, 'necesito paracetamol 500');
});

test('la receta exige un adjunto y lo guarda con el pedido', () => {
  const { say, send, store, consent, join } = setup();
  consent();
  say('3');
  assert.match(join(say('listo')), /al menos una foto o PDF/);
  assert.match(join(send({ from: PHONE, type: 'media', text: 'obra social PAMI', media: JPEG })), /Anotado/);
  say('listo');
  say('1');
  assert.match(join(say('1')), /Recibimos tu receta \*#1\*/);

  const order = store.getOrder(1);
  assert.equal(order?.kind, 'receta');
  assert.deepEqual(order?.media, [JPEG]);
  assert.match(order?.detail ?? '', /PAMI/);
});

test('una foto suelta en el menú no se toma como receta', () => {
  const { send, consent, join, store } = setup();
  consent();
  assert.match(join(send({ from: PHONE, type: 'media', text: '', media: JPEG })), /elegí qué querés hacer/);
  assert.equal(store.listOrders().length, 0);
});

test('fuera de horario el pedido avisa cuándo responden', () => {
  const { say, consent, join } = setup(CLOSED);
  consent();
  say('2');
  say('curitas');
  say('listo');
  say('1');
  assert.match(join(say('1')), /Ahora estamos cerrados/);
});

test('una consulta médica no la responde el bot: deriva y se queda callado', () => {
  const { say, store, consent, join } = setup();
  consent();
  const reply = join(say('¿puedo tomar ibuprofeno con alcohol?'));
  assert.match(reply, /no puedo dar indicaciones/);
  assert.match(reply, /ya avisé al equipo/);
  assert.equal(store.getSession(PHONE)?.state, 'humano');
  assert.deepEqual(say('hola?'), []);
  assert.match(join(say('menu')), /Horarios y ubicación/);
});

test('pedir una persona deriva; en un pedido solo si lo dicen explícito', () => {
  const { say, store, consent, join } = setup();
  consent();
  say('2');
  say('algo para una persona mayor con diabetes');
  assert.equal(store.getSession(PHONE)?.state, 'pedido_detalle');
  assert.match(join(say('quiero hablar con una persona')), /ya avisé al equipo/);
});

test('emergencia: manda los teléfonos y marca el chat como urgente', () => {
  const { say, store, consent, cfg } = setup();
  consent();
  assert.deepEqual(say('mi hijo tomó de más y se desmayó'), [cfg.emergencyText]);
  const session = store.getSession(PHONE);
  assert.equal(session?.state, 'humano');
  assert.equal(session?.data.urgent, true);
});

test('una emergencia de alguien sin consentimiento responde pero no guarda nada', () => {
  const { say, store, cfg } = setup();
  assert.deepEqual(say('sobredosis'), [cfg.emergencyText]);
  assert.equal(store.getCustomer(PHONE), undefined);
  assert.equal(store.getSession(PHONE), undefined);
  assert.equal(store.messagesFor(PHONE).length, 0);
});

test('recordatorio: se crea con la fecha pedida y "baja" lo cancela', () => {
  const { say, store, consent, join, clock } = setup();
  consent();
  say('4');
  say('Enalapril 10 mg x 30');
  assert.match(join(say('veinticinco')), /entre 1 y 365/);
  assert.match(join(say('25')), /Enalapril 10 mg x 30/);
  assert.equal(store.activeReminderCount(PHONE), 1);

  clock.now = new Date(OPEN.getTime() + 26 * 86_400_000);
  assert.equal(store.dueReminders().length, 1);
  assert.match(join(say('baja')), /no vas a recibir más recordatorios/);
  assert.equal(store.activeReminderCount(PHONE), 0);
  assert.equal(store.dueReminders().length, 0);
});

test('el recordatorio vencido se envía y la respuesta "1" arma el pedido de reposición', async () => {
  const { say, store, consent, join, clock, cfg } = setup();
  consent();
  say('4');
  say('Levotiroxina 100');
  say('30');

  const sent: string[] = [];
  const wa = { sendReminder: async (_to: string, text: string) => void sent.push(text) } as never;
  const run = createReminderRunner({ store, cfg, wa });

  clock.now = new Date('2026-04-03T15:00:00Z'); // 30 días después, 12:00
  await run();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Levotiroxina 100/);
  assert.equal(store.getSession(PHONE)?.state, 'recordatorio_respuesta');

  await run(); // ya no queda nada pendiente
  assert.equal(sent.length, 1);

  assert.match(join(say('1')), /Retiro en la farmacia/);
  say('1');
  say('1');
  assert.equal(store.listOrders()[0].detail, 'Reposición: Levotiroxina 100 (recordatorio)');
});

test('los recordatorios no se mandan de madrugada ni a mitad de otra conversación', async () => {
  const { say, store, consent, clock, cfg } = setup();
  consent();
  say('4');
  say('Metformina');
  say('1');

  const sent: string[] = [];
  const run = createReminderRunner({ store, cfg, wa: { sendReminder: async (_t: string, text: string) => void sent.push(text) } as never });

  clock.now = new Date('2026-03-05T05:00:00Z'); // 02:00 en Argentina
  await run();
  assert.equal(sent.length, 0);

  clock.now = new Date('2026-03-05T15:00:00Z');
  say('2'); // empieza un pedido
  await run();
  assert.equal(sent.length, 0, 'no interrumpe un pedido en curso');
});

test('un envío fallido reprograma el recordatorio en vez de perderlo', async () => {
  const { say, store, consent, clock, cfg } = setup();
  consent();
  say('4');
  say('Metformina');
  say('1');
  clock.now = new Date('2026-03-05T15:00:00Z');
  const run = createReminderRunner({ store, cfg, wa: { sendReminder: async () => { throw new Error('boom'); } } as never });
  const originalError = console.error;
  console.error = () => {};
  try { await run(); } finally { console.error = originalError; }
  assert.equal(store.activeReminderCount(PHONE), 1);
  assert.equal(store.dueReminders().length, 0, 'queda postergado una hora');
});

test('"borrar mis datos" elimina todo y borra los archivos', () => {
  const { say, send, store, consent, join, deleted } = setup();
  consent();
  say('3');
  send({ from: PHONE, type: 'media', text: '', media: JPEG });
  say('listo');
  say('1');
  say('1');
  assert.equal(store.listOrders().length, 1);

  assert.match(join(say('borrar mis datos')), /no se puede deshacer/);
  assert.match(join(say('1')), /borramos todos tus datos/);
  assert.equal(store.getCustomer(PHONE), undefined);
  assert.equal(store.listOrders().length, 0);
  assert.equal(store.messagesFor(PHONE).length, 0);
  assert.deepEqual(deleted, [JPEG.file]);
});

test('un flujo abandonado vuelve al menú después de unas horas', () => {
  const { say, consent, join, clock } = setup();
  consent();
  say('2');
  clock.now = new Date(OPEN.getTime() + 7 * 3_600_000);
  assert.match(join(say('hola')), /Horarios y ubicación/);
});

test('mensajes no soportados (audio, ubicación) se contestan sin romper el flujo', () => {
  const { say, send, consent, join, store } = setup();
  consent();
  say('2');
  assert.match(join(send({ from: PHONE, type: 'unsupported' })), /solo puedo leer texto, fotos y PDF/);
  assert.equal(store.getSession(PHONE)?.state, 'pedido_detalle');
});

test('horarios: agrupa días iguales y sabe si está abierto', () => {
  const { cfg } = setup();
  assert.match(formatHours(cfg), /Lun a Vie: 08:30 a 13:00 y 16:30 a 21:00 hs/);
  assert.match(formatHours(cfg), /Dom: Cerrado/);
  assert.equal(isOpenNow(cfg, OPEN), true);
  assert.equal(isOpenNow(cfg, CLOSED), false);
  assert.equal(isOpenNow(cfg, new Date('2026-03-04T17:00:00Z')), false, '14:00 es la siesta');
});

test('la limpieza borra lo viejo y conserva lo reciente y los pedidos abiertos', () => {
  const { say, send, store, consent, clock } = setup();
  consent();
  say('3');
  send({ from: PHONE, type: 'media', text: '', media: JPEG });
  say('listo');
  say('1');
  say('1');
  store.setOrderStatus(1, 'entregado');
  say('2');
  say('gasas');
  say('listo');
  say('1');
  say('1'); // pedido #2 queda abierto

  clock.now = new Date(OPEN.getTime() + 100 * 86_400_000);
  const files = store.purge(90);
  assert.deepEqual(files, [JPEG.file]);
  assert.equal(store.getOrder(1), undefined);
  assert.ok(store.getOrder(2));
  assert.equal(store.messagesFor(PHONE).length, 0);
});

test('un mensaje de WhatsApp reintentado se procesa una sola vez', () => {
  const { store } = setup();
  assert.equal(store.markProcessed('wamid.ABC'), true);
  assert.equal(store.markProcessed('wamid.ABC'), false);
});
