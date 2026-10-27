import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DAYS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
export type DayKey = (typeof DAYS)[number];
export type Interval = [from: string, to: string];

export type PharmacyConfig = {
  name: string;
  address: string;
  phone: string;
  /** Mail de contacto para consultas y pedidos de eliminación de datos (opcional; se muestra en las páginas de privacidad). */
  contactEmail?: string;
  timezone: string;
  hours: Partial<Record<DayKey, Interval[]>>;
  delivery: { enabled: boolean; note: string };
  emergencyText: string;
};

export function loadPharmacy(file = join(ROOT, 'pharmacy.json')): PharmacyConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as PharmacyConfig;
}

const e = process.env;
const waToken = e.WA_ACCESS_TOKEN || '';
const waPhoneNumberId = e.WA_PHONE_NUMBER_ID || '';

export const env = {
  /** En producción (NODE_ENV=production, como en el Dockerfile) el servidor exige clave de panel y no abre el simulador por defecto. */
  production: e.NODE_ENV === 'production',
  port: Number(e.PORT) || 3000,
  host: e.HOST || '127.0.0.1',
  dataDir: e.DATA_DIR || join(ROOT, 'data'),
  panelUser: e.PANEL_USER || 'farmacia',
  panelPassword: e.PANEL_PASSWORD || randomBytes(9).toString('base64url'),
  panelPasswordGenerated: !e.PANEL_PASSWORD,
  retentionDays: Number(e.RETENTION_DAYS) || 90,
  /** Token que usa n8n (o cualquier otro cliente) para llamar a /agent. Mínimo 24 caracteres; si falta, la API queda apagada. */
  agentToken: (e.AGENT_API_TOKEN || '').length >= 24 ? (e.AGENT_API_TOKEN as string) : '',
  agentTokenTooShort: Boolean(e.AGENT_API_TOKEN) && (e.AGENT_API_TOKEN as string).length < 24,
  /** Claude corre dentro del bot (POST /agent/respond). Sin clave, ese endpoint queda apagado. */
  anthropic: {
    apiKey: e.ANTHROPIC_API_KEY || '',
    model: e.ANTHROPIC_MODEL || 'claude-opus-5-5',
    /** low | medium | high | xhigh | max. Vacío = el valor por defecto del modelo. */
    effort: e.ANTHROPIC_EFFORT || '',
  },
  /** Datos de contacto que muestra la página de inicio (/). Los dos son opcionales: sin ellos, no se muestran los botones. */
  landing: {
    /** Número de WhatsApp del bot, solo dígitos con código de país (por ejemplo, 5491112345678). */
    whatsapp: /^\d{8,15}$/.test(e.LANDING_WHATSAPP || '') ? (e.LANDING_WHATSAPP as string) : '',
    email: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e.LANDING_CONTACT_EMAIL || '') ? (e.LANDING_CONTACT_EMAIL as string) : '',
    /** Marca o empresa de la que es el servicio ("Farma-asistente es un servicio de …"). Respalda el nombre visible de WhatsApp. */
    company: (e.LANDING_COMPANY || '').trim().slice(0, 80),
    /** Sitio web de esa marca o empresa; tiene que ser https. Si falta, se muestra el nombre sin enlace. */
    companyUrl: /^https:\/\/[^\s"'<>]+$/.test(e.LANDING_COMPANY_URL || '') ? (e.LANDING_COMPANY_URL as string) : '',
    /** Titular legal que se muestra en el pie (por ejemplo, "Julio César Ibarra · CUIT 20-…"). Opcional. */
    legal: (e.LANDING_LEGAL || '').trim().slice(0, 160),
  },
  catalogFile: e.CATALOG_DB || join(e.DATA_DIR || join(ROOT, 'data'), 'catalog.db'),
  /** Catálogo comprimido que viaja con el código; se importa solo la primera vez que arranca sin catálogo. */
  catalogSeed: e.CATALOG_SEED || join(ROOT, 'seed', 'catalog.json.gz'),
  wa: {
    enabled: Boolean(waToken && waPhoneNumberId),
    token: waToken,
    phoneNumberId: waPhoneNumberId,
    verifyToken: e.WA_VERIFY_TOKEN || '',
    appSecret: e.WA_APP_SECRET || '',
    apiVersion: e.WA_API_VERSION || 'v23.0',
    reminderTemplate: e.WA_REMINDER_TEMPLATE || '',
    templateLang: e.WA_TEMPLATE_LANG || 'es_AR',
  },
  // El simulador no tiene contraseña: por defecto solo se abre en desarrollo y sin WhatsApp conectado.
  simulator: (e.ENABLE_SIMULATOR ?? (waToken || e.NODE_ENV === 'production' ? '0' : '1')) === '1',
};

export type WhatsAppEnv = typeof env.wa;
