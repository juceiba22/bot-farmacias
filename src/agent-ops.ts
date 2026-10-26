import type { Bot } from './bot.ts';
import type { Catalog, CatalogProduct, SaleType } from './catalog.ts';
import type { PharmacyConfig } from './config.ts';
import type { Store } from './db.ts';
import { formatHours, isOpenNow } from './hours.ts';
import { HttpError, str } from './http.ts';

const MEDIA_WINDOW_MS = 6 * 3_600_000;
const MAX_OPEN_ORDERS = 5;
const MAX_ACTIVE_REMINDERS = 5;
const SALE_TYPES: SaleType[] = ['libre', 'receta', 'otro'];

type Deps = { store: Store; cfg: PharmacyConfig; bot: Bot; catalog?: Catalog };

/**
 * Las acciones que puede hacer el agente sobre UN cliente. Las usan tanto las rutas HTTP (n8n) como las
 * herramientas de Claude, así que las reglas (consentimiento, topes, validaciones) viven en un solo lugar.
 * Todas reciben el teléfono aparte: nunca sale de lo que escribe el modelo ni el cliente.
 */
export function createAgentOps({ store, cfg, bot, catalog }: Deps) {
  /** Casi todo exige que la persona haya aceptado el aviso de privacidad. */
  function requireConsent(phone: string) {
    if (!store.hasConsent(phone)) throw new HttpError(403, 'consent_required');
  }

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

  return {
    requireConsent,

    pharmacyInfo: () => ({
      name: cfg.name,
      address: cfg.address,
      phone: cfg.phone,
      open_now: isOpenNow(cfg, store.clock()),
      hours: formatHours(cfg),
      delivery: cfg.delivery,
    }),

    searchCatalog(input: { query: unknown; saleType?: unknown; limit?: unknown }) {
      if (!catalog) throw new HttpError(503, 'Catálogo no cargado: corré npm run catalog:scrape');
      const query = str(input.query, 120);
      if (!query) throw new HttpError(400, 'Falta q');
      const saleType = str(input.saleType, 10) as SaleType | '';
      if (saleType && !SALE_TYPES.includes(saleType)) throw new HttpError(400, 'sale_type debe ser libre, receta u otro');
      const limit = Math.min(Number(input.limit) || 8, 8);
      // Se pide de más y se filtra después: el índice no filtra por tipo de venta.
      const found = catalog.search(query, saleType ? 40 : limit).filter((p) => !saleType || p.sale_type === saleType);
      return {
        note: 'Precios de referencia de una muestra de demostración; el equipo confirma el total. El catálogo no informa stock.',
        results: found.slice(0, limit).map(publicProduct),
      };
    },

    getProduct: (id: string) => {
      const found = catalog?.get(id);
      if (!found) throw new HttpError(404, 'Producto inexistente');
      return publicProduct(found);
    },

    createOrder(phone: string, input: Record<string, unknown>) {
      requireConsent(phone);
      const kind = str(input.kind, 10);
      if (kind !== 'pedido' && kind !== 'receta') throw new HttpError(400, 'kind debe ser pedido o receta');
      const delivery = str(input.delivery, 10);
      if (delivery !== 'retiro' && delivery !== 'envio') throw new HttpError(400, 'delivery debe ser retiro o envio');
      const detail = str(input.detail, 2000);
      if (kind === 'pedido' && !detail) throw new HttpError(400, 'Falta detail');
      const address = str(input.address, 300);
      if (delivery === 'envio' && address.length < 5) throw new HttpError(400, 'Para un envío hace falta la dirección completa');

      const open = store.ordersForPhone(phone, 20).filter((o) => o.status !== 'entregado' && o.status !== 'cancelado');
      if (open.length >= MAX_OPEN_ORDERS) throw new HttpError(409, 'Ya hay demasiados pedidos abiertos para esta persona: derivala al equipo');

      const media = store.unattachedMedia(phone, new Date(store.clock().getTime() - MEDIA_WINDOW_MS).toISOString());
      if (kind === 'receta' && !media.length) throw new HttpError(422, 'Falta la foto o el PDF de la receta: pedíselo al cliente');

      const id = store.createOrder({ phone, kind, detail, delivery, address: delivery === 'envio' ? address : undefined, media });
      return {
        order_id: id,
        status: 'nuevo',
        attached_files: media.length,
        open_now: isOpenNow(cfg, store.clock()),
        message: `Registrado como ${kind} #${id}. El equipo revisa disponibilidad y confirma el total por este chat.`,
      };
    },

    listOrders(phone: string) {
      requireConsent(phone);
      return store.ordersForPhone(phone, 5).map((o) => ({
        order_id: o.id, kind: o.kind, status: o.status, detail: o.detail.slice(0, 300), delivery: o.delivery, created_at: o.created_at,
      }));
    },

    createReminder(phone: string, input: Record<string, unknown>) {
      requireConsent(phone);
      const medication = str(input.medication, 120);
      const days = Number(input.days);
      if (medication.length < 3) throw new HttpError(400, 'Falta medication');
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'days debe ser un entero entre 1 y 365');
      if (store.activeReminderCount(phone) >= MAX_ACTIVE_REMINDERS) throw new HttpError(409, 'Ya tiene el máximo de recordatorios activos');
      const due = new Date(store.clock().getTime() + days * 86_400_000);
      store.createReminder(phone, medication, due.toISOString());
      return { ok: true, due_date: due.toLocaleDateString('es-AR', { timeZone: cfg.timezone, day: 'numeric', month: 'long' }) };
    },

    cancelReminders(phone: string) {
      requireConsent(phone);
      return { ok: true, cancelled: store.cancelReminders(phone) };
    },

    handoff(phone: string, input: { reason?: unknown; urgent?: unknown }) {
      requireConsent(phone);
      return { ok: true, message: bot.handoffPhone(phone, str(input.reason, 300), input.urgent === true) };
    },
  };
}

export type AgentOps = ReturnType<typeof createAgentOps>;
