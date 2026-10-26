import type { PharmacyConfig } from './config.ts';
import type { MediaRef, OrderKind, Session, SessionData, Store } from './db.ts';
import { formatHours, isOpenNow } from './hours.ts';

export type Incoming =
  | { from: string; name?: string; type: 'text'; text: string }
  | { from: string; name?: string; type: 'media'; text: string; media: MediaRef }
  | { from: string; name?: string; type: 'unsupported' };

const HOUR = 3_600_000;
const STALE_FLOW_MS = 6 * HOUR;
const STALE_REMINDER_REPLY_MS = 48 * HOUR;
const MAX_MEDIA = 10;
const MAX_DETAIL_CHARS = 2000;
const MAX_ACTIVE_REMINDERS = 5;

const COLLECTING = new Set(['pedido_detalle', 'receta_adjunto']);
const FREE_TEXT_STATES = new Set(['pedido_detalle', 'receta_adjunto', 'direccion', 'recordatorio_med']);

/** Minúsculas, sin tildes ni signos: para comparar lo que escribe la gente. */
export const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const EMERGENCY =
  /\b(sobredosis|intoxic|envenen|no puedo respirar|me ahogo|se ahoga|convulsion|se desmayo|me desmayo|infarto|anafilax|tome de mas|se tomo de mas|ingirio de mas|emergencia)/;
const MEDICAL =
  /\b(dosis|posologia|cuantas? (pastillas?|gotas|comprimidos?|capsulas?)|cada cuanto|puedo (tomar|tomarlo|darle|dar|mezclar|combinar|usar)|se puede (tomar|mezclar|combinar)|interaccion|interactua|efectos? (secundarios?|adversos?)|contraindica|embaraz|lactancia|amamant|sintomas?|me duele|le duele|tengo (fiebre|dolor|tos|diarrea|vomitos?|alergia)|que (me )?(recomiendas?|recomienda|puedo tomar|me doy|le doy)|para que sirve)/;
const PERSONA_STRICT =
  /^(persona|humano|asesor|asesora|operador|operadora|farmaceutico|farmaceutica|hablar con (una |un )?(persona|farmaceutico|farmaceutica)|quiero hablar con (una |un )?(persona|farmaceutico|farmaceutica))$/;
const PERSONA_LOOSE = /\b(persona|humano|asesor|asesora|operador|operadora|farmaceutic[oa])\b/;
const STOP = /^(baja|stop|parar|darme de baja|no quiero mas (avisos|recordatorios|mensajes))$/;
const MENU_WORDS = /^(menu|inicio|volver|cancelar|0)$/;
const ERASE = /^(borrar mis datos|eliminar mis datos|borrar datos|borrar mi informacion)$/;
const YES = /^(1|si|s|ok|dale|claro|confirmo|confirmar|acepto|de acuerdo)$/;
const NO = /^(2|no|n|cancelar|no gracias)$/;

const INFO = /\b(horarios?|ubicacion|direccion|donde (estan|queda)|a que hora (abren|cierran)|abren|cierran|telefono)\b/;
const PEDIDO_FREE = /\b(necesito|quiero|busco|tienen|tenes|tendran|me mandan|mandame|enviame)\b/;
const RECETA = /\breceta/;
const REMINDER = /\b(recordatorio|recordar|recordame|avisame|reposicion)\b/;

type Mode = 'menu' | 'agent';
type Ctx = { phone: string; msg: Incoming; text: string; t: string; session: Session };

function isStale(session: Session, nowMs: number): boolean {
  if (session.state === 'humano' || session.state === 'menu') return false;
  const age = nowMs - Date.parse(session.updatedAt);
  return age > (session.state === 'recordatorio_respuesta' ? STALE_REMINDER_REPLY_MS : STALE_FLOW_MS);
}

/** Un recordatorio solo se manda si la persona no está a mitad de otra cosa. */
export function isIdle(session: Session | undefined, nowMs: number): boolean {
  if (!session || session.state === 'menu') return true;
  if (session.state === 'humano') return false;
  return nowMs - Date.parse(session.updatedAt) > STALE_FLOW_MS;
}

export function reminderMessage(cfg: PharmacyConfig, medication: string): string {
  return (
    `Hola! 👋 Te escribimos de *${cfg.name}* para recordarte reponer *${medication}*.\n` +
    '¿Querés que lo vayamos preparando?\n\n' +
    '1. Sí, prepárenlo\n2. Todavía no (avisame en 3 días)\n3. No quiero más recordatorios'
  );
}

export function createBot(deps: { store: Store; cfg: PharmacyConfig; deleteFiles?: (files: string[]) => void }) {
  const { store, cfg } = deps;

  const go = (c: Ctx, state: string, data: SessionData = {}) => {
    store.saveSession(c.phone, state, data);
    c.session = { state, data, updatedAt: store.nowIso() };
  };

  const closedNote = () =>
    isOpenNow(cfg, store.clock()) ? '' : `\n\nAhora estamos cerrados: te respondemos apenas abramos.\n🕒 Horarios\n${formatHours(cfg)}`;

  function menuText(name?: string, prefix = ''): string {
    const first = name?.split(' ')[0];
    const hello = first && /^\p{L}{2,20}$/u.test(first) ? `Hola ${first}! 👋` : 'Hola! 👋';
    return (
      `${prefix}${hello} Soy el asistente de *${cfg.name}*. ¿En qué te puedo ayudar?\n\n` +
      '1. Horarios y ubicación\n2. Hacer un pedido\n3. Enviar una receta\n4. Recordatorio de medicación\n5. Hablar con el equipo de la farmacia\n\n' +
      'Respondé con el número de la opción.'
    );
  }

  function infoText(): string {
    const open = isOpenNow(cfg, store.clock()) ? 'Ahora estamos abiertos ✅' : 'Ahora estamos cerrados';
    const delivery = cfg.delivery.enabled ? `\n\n🛵 ${cfg.delivery.note}` : '';
    return `📍 *${cfg.name}*\n${cfg.address}\n📞 ${cfg.phone}\n\n🕒 Horarios\n${formatHours(cfg)}\n${open}${delivery}\n\nEscribí *menu* para volver.`;
  }

  function handoff(c: Ctx, urgent = false, intro = '', reason?: string): string[] {
    go(c, 'humano', { handoffAt: store.nowIso(), urgent, reason: reason?.slice(0, 300) });
    const text = isOpenNow(cfg, store.clock())
      ? 'Listo, ya avisé al equipo de la farmacia. Te van a responder por acá en unos minutos 🙌\n\nCuando quieras volver al asistente, escribí *menu*.'
      : `Dejé tu mensaje para el equipo y te responden apenas abramos.\n\n🕒 Horarios\n${formatHours(cfg)}\n\nSi es urgente, llamanos al ${cfg.phone}.`;
    return [intro + text];
  }

  // --- consentimiento (Ley 25.326: datos de salud) ---
  function consentStep(phone: string, t: string, mode: Mode, name?: string): string[] {
    const session = store.getSession(phone);
    if (session?.state === 'consent') {
      if (YES.test(t)) {
        store.grantConsent(phone, name);
        store.saveSession(phone, 'menu');
        return mode === 'menu' ? ['¡Gracias! Ya podemos empezar.', menuText(name)] : ['¡Gracias! Ya podemos empezar. ¿En qué te puedo ayudar?'];
      }
      if (NO.test(t)) {
        store.deleteSession(phone);
        return [`Entendido, no guardamos nada. Por cualquier consulta podés llamarnos al ${cfg.phone} o pasar por ${cfg.address}.`];
      }
    }
    store.saveSession(phone, 'consent');
    return [
      `Hola! 👋 Soy el asistente automático de *${cfg.name}*.\n\n` +
        'Para atenderte vamos a guardar tu número, tu nombre de WhatsApp y los mensajes, fotos y recetas que nos mandes. ' +
        'Los usamos solo para gestionar tus consultas y pedidos, y los borramos pasado un tiempo. ' +
        'Podés pedir que borremos todo cuando quieras escribiendo *borrar mis datos*.\n\n' +
        'Respondé *1* para aceptar y continuar, o *2* si preferís no hacerlo.',
    ];
  }

  // --- pedidos y recetas ---
  function startCollecting(c: Ctx, kind: OrderKind, initial?: string): string[] {
    go(c, kind === 'pedido' ? 'pedido_detalle' : 'receta_adjunto', { kind, detail: initial ? [initial] : [], media: [] });
    if (initial) return ['✅ Anotado. Podés mandar más mensajes o fotos de los envases. Cuando termines, escribí *listo*.'];
    return kind === 'pedido'
      ? ['Contame qué necesitás. Podés mandar varios mensajes o fotos de los envases.\nCuando termines, escribí *listo*.']
      : ['Mandame una foto o PDF de la receta (si son varias hojas, mandalas todas). Si querés, sumá un mensaje con tu obra social o alguna aclaración.\nCuando termines, escribí *listo*.'];
  }

  function onCollect(c: Ctx, kind: OrderKind): string[] {
    const data: SessionData = { ...c.session.data, kind };
    const detail = data.detail ?? [];
    const media = data.media ?? [];

    if (c.t === 'listo' || c.t === 'listo gracias') {
      if (kind === 'receta' && media.length === 0) return ['Necesito al menos una foto o PDF de la receta. Mandala y después escribí *listo*.'];
      if (detail.length === 0 && media.length === 0) return ['Todavía no me dijiste qué necesitás. Escribilo o mandá una foto, y después escribí *listo*.'];
      return askDelivery(c, data);
    }

    const used = detail.join('\n').length;
    if (c.msg.type === 'media') {
      if (media.length >= MAX_MEDIA) return ['Llegaste al máximo de archivos. Escribí *listo* para continuar.'];
      media.push(c.msg.media);
    }
    if (c.text) {
      if (used + c.text.length > MAX_DETAIL_CHARS) return ['Ese mensaje es muy largo. Escribí *listo* para continuar o mandalo más corto.'];
      detail.push(c.text.slice(0, 500));
    }
    const first = detail.length + media.length === 1;
    go(c, c.session.state, { ...data, detail, media });
    return [first ? '✅ Anotado. Podés mandar más (texto o fotos). Cuando termines, escribí *listo*.' : '✅ Anotado. Escribí *listo* cuando termines.'];
  }

  function askDelivery(c: Ctx, data: SessionData): string[] {
    if (!cfg.delivery.enabled) return askConfirm(c, { ...data, delivery: 'retiro' });
    go(c, 'entrega', data);
    return ['¿Cómo lo querés recibir?\n\n1. Retiro en la farmacia\n2. Envío a domicilio'];
  }

  function onEntrega(c: Ctx): string[] {
    if (c.t === '1' || /\b(retir|buscar|paso)/.test(c.t)) return askConfirm(c, { ...c.session.data, delivery: 'retiro' });
    if (c.t === '2' || /\b(envio|domicilio|enviar|mandar)/.test(c.t)) {
      go(c, 'direccion', { ...c.session.data, delivery: 'envio' });
      return ['¿A qué dirección lo enviamos? (calle, número, barrio y alguna referencia)'];
    }
    return ['Elegí una opción:\n\n1. Retiro en la farmacia\n2. Envío a domicilio'];
  }

  function onDireccion(c: Ctx): string[] {
    if (c.t.length < 5) return ['Necesito la dirección completa: calle, número y barrio.'];
    return askConfirm(c, { ...c.session.data, address: c.text.slice(0, 300) });
  }

  function askConfirm(c: Ctx, data: SessionData): string[] {
    go(c, 'confirmar', data);
    const kind = data.kind ?? 'pedido';
    const detail = (data.detail ?? []).join('\n');
    const lines = [`Resumen de tu ${kind}:`];
    if (detail) lines.push(detail.length > 500 ? `${detail.slice(0, 500)}…` : detail);
    if (data.media?.length) lines.push(`📎 ${data.media.length} ${data.media.length === 1 ? 'archivo adjunto' : 'archivos adjuntos'}`);
    lines.push(data.delivery === 'envio' ? `🛵 Envío a: ${data.address}` : '🏪 Retiro en la farmacia');
    return [`${lines.join('\n')}\n\n1. Confirmar\n2. Cancelar`];
  }

  function onConfirmar(c: Ctx): string[] {
    const d = c.session.data;
    if (YES.test(c.t)) {
      const id = store.createOrder({
        phone: c.phone,
        kind: d.kind ?? 'pedido',
        detail: (d.detail ?? []).join('\n'),
        delivery: d.delivery ?? 'retiro',
        address: d.address,
        media: d.media ?? [],
      });
      go(c, 'menu');
      return [
        `✅ Recibimos tu ${d.kind ?? 'pedido'} *#${id}*. El equipo revisa disponibilidad y te confirma el total por este chat.${closedNote()}\n\n` +
          'Si tenés dudas sobre cómo usar un medicamento, escribí *persona* para hablar con el farmacéutico. Para volver al menú, escribí *menu*.',
      ];
    }
    if (NO.test(c.t)) {
      go(c, 'menu');
      return ['Listo, lo cancelé. Escribí *menu* si necesitás otra cosa.'];
    }
    return ['Respondé *1* para confirmar o *2* para cancelar.'];
  }

  // --- recordatorios ---
  function onReminderMed(c: Ctx): string[] {
    if (c.t.length < 3) return ['Escribime el nombre del medicamento y la presentación (por ejemplo: "Enalapril 10 mg x 30").'];
    go(c, 'recordatorio_dias', { medication: c.text.slice(0, 120) });
    return ['¿En cuántos días querés que te avise? Escribí un número (por ejemplo: 25).'];
  }

  function onReminderDays(c: Ctx): string[] {
    const days = Number(/\d+/.exec(c.t)?.[0]);
    if (!Number.isInteger(days) || days < 1 || days > 365) return ['Escribí un número de días entre 1 y 365.'];
    const med = c.session.data.medication ?? '';
    if (store.activeReminderCount(c.phone) >= MAX_ACTIVE_REMINDERS) {
      go(c, 'menu');
      return [`Ya tenés ${MAX_ACTIVE_REMINDERS} recordatorios activos. Escribí *baja* para cancelarlos y crear uno nuevo.`];
    }
    const due = new Date(store.clock().getTime() + days * 24 * HOUR);
    store.createReminder(c.phone, med, due.toISOString());
    go(c, 'menu');
    const date = new Intl.DateTimeFormat('es-AR', { timeZone: cfg.timezone, day: 'numeric', month: 'long' }).format(due);
    return [`Listo ✅ Te escribo alrededor del *${date}* para recordarte reponer *${med}*.\n\nPara dejar de recibir recordatorios, escribí *baja* en cualquier momento.`];
  }

  function onReminderReply(c: Ctx): string[] {
    const { reminderId, medication } = c.session.data;
    if (c.t === '1') {
      const med = medication ?? (reminderId ? store.getReminder(reminderId)?.medication : '') ?? '';
      return askDelivery(c, { kind: 'pedido', detail: [`Reposición: ${med} (recordatorio)`], media: [] });
    }
    if (c.t === '2') {
      store.createReminder(c.phone, medication ?? '', new Date(store.clock().getTime() + 72 * HOUR).toISOString());
      go(c, 'menu');
      return ['Dale, te vuelvo a avisar en 3 días. 👍'];
    }
    if (c.t === '3') {
      store.cancelReminders(c.phone);
      go(c, 'menu');
      return ['Listo, no vas a recibir más recordatorios. Si querés activarlos de nuevo, escribí *menu* y elegí la opción 4.'];
    }
    return ['Respondé:\n\n1. Sí, prepárenlo\n2. Todavía no (avisame en 3 días)\n3. No quiero más recordatorios'];
  }

  // --- menú ---
  function onMenu(c: Ctx): string[] {
    const { t } = c;
    if (c.msg.type === 'media') return ['Recibí tu archivo, pero primero elegí qué querés hacer: *2* para un pedido o *3* para enviar una receta. Después lo mandás de nuevo.'];
    if (t === '1' || INFO.test(t)) return [infoText()];
    if (t === '2' || /^(pedido|pedir|hacer un pedido)$/.test(t)) return startCollecting(c, 'pedido');
    if (t === '3' || RECETA.test(t)) return startCollecting(c, 'receta');
    if (t === '4' || REMINDER.test(t)) {
      go(c, 'recordatorio_med');
      return ['¿Qué medicamento querés que te recuerde reponer? Escribime el nombre y la presentación.\n\nGuardamos ese dato solo para mandarte el recordatorio.'];
    }
    if (t === '5') return handoff(c);
    if (PEDIDO_FREE.test(t)) return startCollecting(c, 'pedido', c.text.slice(0, 500));
    return [menuText(c.msg.type === 'unsupported' ? undefined : c.msg.name, /^(hola|buenas|buen dia|hey|buenos dias)/.test(t) || !t ? '' : 'No te entendí. ')];
  }

  /**
   * Filtros que corren antes de cualquier conversación, con menú o con modelo de lenguaje:
   * consentimiento, emergencias, borrado de datos, baja, derivación y consultas médicas.
   * Devuelve la respuesta final (lista vacía = quedarse callado) o el contexto para seguir.
   */
  function screen(msg: Incoming, mode: Mode): string[] | Ctx {
    const phone = msg.from;
    const text = msg.type === 'unsupported' ? '' : msg.text;
    const t = norm(text);
    const consented = store.hasConsent(phone);
    if (store.canLog(phone)) logIn(msg);

    if (msg.type !== 'unsupported' && EMERGENCY.test(t)) {
      if (consented) go(context(msg, text, t), 'humano', { handoffAt: store.nowIso(), urgent: true });
      return [cfg.emergencyText];
    }

    if (!consented) return consentStep(phone, t, mode, msg.name);

    store.touchCustomer(phone, msg.name);
    const c = context(msg, text, t);

    if (ERASE.test(t)) {
      go(c, 'borrar_confirmar');
      return ['Vamos a borrar tu número, tus mensajes, recetas, pedidos y recordatorios. Esto no se puede deshacer.\n\n1. Sí, borrar todo\n2. No, volver'];
    }
    if (c.session.state === 'borrar_confirmar') {
      if (YES.test(t)) {
        const files = store.eraseCustomer(phone);
        deps.deleteFiles?.(files);
        return ['Listo, borramos todos tus datos. Si más adelante querés usar el asistente, escribinos de nuevo.'];
      }
      go(c, 'menu');
      return mode === 'menu' ? ['Perfecto, no borramos nada.', menuText(msg.name)] : ['Perfecto, no borramos nada. ¿En qué te puedo ayudar?'];
    }

    if (STOP.test(t)) {
      store.cancelReminders(phone);
      return [
        mode === 'menu'
          ? 'Listo, no vas a recibir más recordatorios. Si querés activarlos de nuevo, escribí *menu* y elegí la opción 4.'
          : 'Listo, no vas a recibir más recordatorios. Si querés activarlos de nuevo, pedímelo cuando quieras.',
      ];
    }
    if (MENU_WORDS.test(t) && (mode === 'menu' || c.session.state === 'humano')) {
      go(c, 'menu');
      return mode === 'menu' ? [menuText(msg.name)] : ['Listo, sigo yo. ¿En qué te puedo ayudar?'];
    }

    const inFreeText = FREE_TEXT_STATES.has(c.session.state);
    const asksForPerson = inFreeText ? PERSONA_STRICT.test(t) : t.length <= 40 && PERSONA_LOOSE.test(t);
    if (c.session.state === 'humano') return [];
    if (asksForPerson) return handoff(c);

    if (msg.type === 'unsupported') return ['Por ahora solo puedo leer texto, fotos y PDF. ¿Me lo escribís?'];

    if (!COLLECTING.has(c.session.state) && MEDICAL.test(t)) {
      return handoff(c, false, 'Soy un asistente automático y no puedo dar indicaciones sobre medicamentos ni síntomas: eso lo tiene que responder un farmacéutico o tu médico.\n\n');
    }

    return c;
  }

  /** Conversación por menús numerados (sin modelo de lenguaje). */
  function handle(msg: Incoming): string[] {
    const screened = screen(msg, 'menu');
    if (Array.isArray(screened)) return screened;
    const c = screened;
    switch (c.session.state) {
      case 'pedido_detalle': return onCollect(c, 'pedido');
      case 'receta_adjunto': return onCollect(c, 'receta');
      case 'entrega': return onEntrega(c);
      case 'direccion': return onDireccion(c);
      case 'confirmar': return onConfirmar(c);
      case 'recordatorio_med': return onReminderMed(c);
      case 'recordatorio_dias': return onReminderDays(c);
      case 'recordatorio_respuesta': return onReminderReply(c);
      default: return onMenu(c);
    }
  }

  type AgentDecision =
    | { action: 'reply'; replies: string[] }
    | { action: 'silent' }
    | { action: 'agent'; notes: string[] };

  /** Para el modo con modelo de lenguaje: decide si responde el código, nadie, o el agente. */
  function screenForAgent(msg: Incoming): AgentDecision {
    const screened = screen(msg, 'agent');
    if (Array.isArray(screened)) return screened.length ? { action: 'reply', replies: screened } : { action: 'silent' };
    const notes: string[] = [];
    const { state, data } = screened.session;
    if (state === 'recordatorio_respuesta') {
      notes.push(
        `Le mandamos un recordatorio para reponer "${data.medication ?? 'su medicación'}". Si responde que sí, creá un pedido de reposición; ` +
          'si dice que todavía no, creá otro recordatorio en 3 días; si no quiere más, cancelá sus recordatorios.',
      );
    }
    if (state !== 'menu') go(screened, 'menu');
    return { action: 'agent', notes };
  }

  /** Pasa la conversación a una persona del equipo y devuelve el texto para avisarle al cliente. */
  function handoffPhone(phone: string, reason?: string, urgent = false): string {
    return handoff(context({ from: phone, type: 'unsupported' }, '', ''), urgent, '', reason)[0];
  }

  function logIn(msg: Incoming) {
    if (msg.type === 'unsupported') store.logMessage({ phone: msg.from, direction: 'in', body: '[mensaje no soportado]' });
    else store.logMessage({ phone: msg.from, direction: 'in', body: msg.text || (msg.type === 'media' ? '[adjunto]' : ''), media: msg.type === 'media' ? msg.media : undefined });
  }

  function context(msg: Incoming, text: string, t: string): Ctx {
    const now = store.clock().getTime();
    let session = store.getSession(msg.from) ?? { state: 'menu', data: {}, updatedAt: store.nowIso() };
    if (isStale(session, now)) session = { state: 'menu', data: {}, updatedAt: store.nowIso() };
    return { phone: msg.from, msg, text, t, session };
  }

  return { handle, screenForAgent, handoffPhone };
}

export type Bot = ReturnType<typeof createBot>;
