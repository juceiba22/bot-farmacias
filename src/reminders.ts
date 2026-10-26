import { isIdle, reminderMessage } from './bot.ts';
import type { PharmacyConfig } from './config.ts';
import type { Store } from './db.ts';
import { localParts } from './hours.ts';
import type { WhatsApp } from './whatsapp.ts';

const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 20;
const RETRY_MS = 3_600_000;

/** Manda los recordatorios vencidos, solo en horario razonable y sin interrumpir otra conversación. */
export function createReminderRunner(deps: { store: Store; cfg: PharmacyConfig; wa: WhatsApp }) {
  const { store, cfg, wa } = deps;

  return async function sendDueReminders() {
    const { hour } = localParts(store.clock(), cfg.timezone);
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return;

    for (const r of store.dueReminders()) {
      if (!isIdle(store.getSession(r.phone), store.clock().getTime())) continue;
      const text = reminderMessage(cfg, r.medication);
      try {
        await wa.sendReminder(r.phone, text, r.medication, cfg.name);
      } catch (err) {
        console.error(`Recordatorio #${r.id} no enviado:`, err instanceof Error ? err.message : err);
        store.postponeReminder(r.id, new Date(store.clock().getTime() + RETRY_MS).toISOString());
        continue;
      }
      store.markReminderSent(r.id);
      store.saveSession(r.phone, 'recordatorio_respuesta', { reminderId: r.id, medication: r.medication });
      store.logMessage({ phone: r.phone, direction: 'out', body: text });
    }
  };
}
