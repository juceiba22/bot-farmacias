import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WhatsAppEnv } from './config.ts';
import { MAX_MEDIA_BYTES } from './media.ts';

export type InboundMessage = {
  waId?: string;
  from: string;
  name?: string;
  type: 'text' | 'media' | 'unsupported';
  text?: string;
  mediaId?: string;
};

/** Extrae los mensajes del payload del webhook de la Cloud API. */
export function parseWebhook(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const names = new Map<string, string>();
      for (const c of value?.contacts ?? []) if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), String(c.profile.name));

      for (const m of value?.messages ?? []) {
        const from = String(m?.from ?? '');
        if (!/^\d{8,15}$/.test(from)) continue;
        const base = { waId: typeof m.id === 'string' ? m.id : undefined, from, name: names.get(from) };
        switch (m.type) {
          case 'text':
            out.push({ ...base, type: 'text', text: String(m.text?.body ?? '') });
            break;
          case 'button':
            out.push({ ...base, type: 'text', text: String(m.button?.text ?? '') });
            break;
          case 'interactive':
            out.push({ ...base, type: 'text', text: String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '') });
            break;
          case 'image':
          case 'document': {
            const media = m[m.type];
            if (media?.id) out.push({ ...base, type: 'media', text: String(media.caption ?? ''), mediaId: String(media.id) });
            else out.push({ ...base, type: 'unsupported' });
            break;
          }
          default:
            out.push({ ...base, type: 'unsupported' });
        }
      }
    }
  }
  return out;
}

export function createWhatsApp(cfg: WhatsAppEnv) {
  const api = (path: string) => `https://graph.facebook.com/${cfg.apiVersion}/${path}`;
  const auth = { Authorization: `Bearer ${cfg.token}` };
  const isSim = (to: string) => to.startsWith('sim-');

  async function post(payload: object) {
    const res = await fetch(api(`${cfg.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null))?.error?.message ?? res.statusText;
      throw new Error(`WhatsApp ${res.status}: ${detail}`);
    }
  }

  return {
    enabled: cfg.enabled,

    async sendText(to: string, body: string) {
      if (isSim(to)) return;
      if (!cfg.enabled) return console.log(`[whatsapp apagado] → ${to}: ${body.slice(0, 80)}`);
      await post({ to, type: 'text', text: { body, preview_url: false } });
    },

    /** Los recordatorios los inicia la farmacia: fuera de las 24 h de la última respuesta, WhatsApp exige una plantilla aprobada. */
    async sendReminder(to: string, text: string, medication: string, pharmacy: string) {
      if (isSim(to) || !cfg.enabled || !cfg.reminderTemplate) return this.sendText(to, text);
      await post({
        to,
        type: 'template',
        template: {
          name: cfg.reminderTemplate,
          language: { code: cfg.templateLang },
          components: [{ type: 'body', parameters: [{ type: 'text', text: medication }, { type: 'text', text: pharmacy }] }],
        },
      });
    },

    async downloadMedia(mediaId: string): Promise<Buffer> {
      const meta = await fetch(api(encodeURIComponent(mediaId)), { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (!meta.ok) throw new Error(`WhatsApp media ${meta.status}`);
      const { url, file_size } = (await meta.json()) as { url: string; file_size?: number };
      if (file_size && file_size > MAX_MEDIA_BYTES) throw new Error('Archivo demasiado grande');
      if (new URL(url).protocol !== 'https:') throw new Error('URL de media inválida');
      const file = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!file.ok) throw new Error(`WhatsApp media download ${file.status}`);
      return Buffer.from(await file.arrayBuffer());
    },

    verifySignature(raw: Buffer, header: string | undefined): boolean {
      if (!cfg.appSecret || !header?.startsWith('sha256=')) return false;
      const expected = createHmac('sha256', cfg.appSecret).update(raw).digest();
      const given = Buffer.from(header.slice(7), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}

export type WhatsApp = ReturnType<typeof createWhatsApp>;
