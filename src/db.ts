import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type MediaRef = { file: string; mime: string };
export type OrderKind = 'pedido' | 'receta';
export type OrderStatus = 'nuevo' | 'preparando' | 'listo' | 'entregado' | 'cancelado';
export const ORDER_STATUSES: OrderStatus[] = ['nuevo', 'preparando', 'listo', 'entregado', 'cancelado'];
export const CLOSED_STATUSES: OrderStatus[] = ['entregado', 'cancelado'];

export type SessionData = {
  detail?: string[];
  media?: MediaRef[];
  delivery?: 'retiro' | 'envio';
  address?: string;
  medication?: string;
  reminderId?: number;
  urgent?: boolean;
  handoffAt?: string;
  reason?: string;
  kind?: OrderKind;
};
export type Session = { state: string; data: SessionData; updatedAt: string };
export type Customer = { phone: string; name: string | null; consent_at: string | null };

export type OrderRow = {
  id: number;
  phone: string;
  name: string | null;
  kind: OrderKind;
  detail: string;
  delivery: 'retiro' | 'envio';
  address: string | null;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
  media: MediaRef[];
};
export type ReminderRow = { id: number; phone: string; name: string | null; medication: string; due_at: string };
export type ChatRow = {
  phone: string;
  name: string | null;
  state: string | null;
  urgent: boolean;
  last_body: string;
  last_at: string;
};
export type MessageRow = {
  id: number;
  direction: 'in' | 'out';
  body: string;
  media_file: string | null;
  media_mime: string | null;
  created_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,
  name TEXT,
  consent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  phone TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body TEXT NOT NULL DEFAULT '',
  media_file TEXT,
  media_mime TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (phone, id);
CREATE TABLE IF NOT EXISTS processed_messages (
  wa_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pedido', 'receta')),
  detail TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL CHECK (delivery IN ('retiro', 'envio')),
  address TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  mime TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  medication TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'enviado', 'cancelado')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, due_at);
`;

export function createStore(file: string, clock: () => Date = () => new Date()) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const nowIso = () => clock().toISOString();
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);
  const get = <T>(sql: string, ...params: SQLInputValue[]) =>
    db.prepare(sql).get(...params) as unknown as T | undefined;
  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];

  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const mediaFor = (orderId: number): MediaRef[] =>
    all<MediaRef>('SELECT file, mime FROM order_media WHERE order_id = ? ORDER BY id', orderId).map(({ file, mime }) => ({ file, mime }));

  const withMedia = (row: Omit<OrderRow, 'media'>): OrderRow => ({ ...row, media: mediaFor(row.id) });

  const ORDER_SELECT = `SELECT o.*, c.name FROM orders o LEFT JOIN customers c ON c.phone = o.phone`;

  return {
    clock,
    nowIso,
    close: () => db.close(),

    // --- clientes y consentimiento ---
    getCustomer: (phone: string) =>
      get<Customer>('SELECT phone, name, consent_at FROM customers WHERE phone = ?', phone),
    hasConsent: (phone: string) =>
      Boolean(get<{ consent_at: string | null }>('SELECT consent_at FROM customers WHERE phone = ?', phone)?.consent_at),
    /** Sin consentimiento no se guarda nada de una persona real; los números de prueba (sim-) del simulador sí. */
    canLog: (phone: string) =>
      phone.startsWith('sim-') ||
      Boolean(get<{ consent_at: string | null }>('SELECT consent_at FROM customers WHERE phone = ?', phone)?.consent_at),
    grantConsent(phone: string, name?: string) {
      const at = nowIso();
      run(
        `INSERT INTO customers (phone, name, consent_at, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (phone) DO UPDATE SET consent_at = excluded.consent_at, name = COALESCE(excluded.name, name)`,
        phone, name ?? null, at, at,
      );
    },
    touchCustomer(phone: string, name?: string) {
      if (name) run('UPDATE customers SET name = ? WHERE phone = ?', name, phone);
    },
    /** Borra todo lo que se guardó de una persona (pedido de supresión). */
    eraseCustomer(phone: string): string[] {
      const files = [
        ...all<{ file: string }>(
          'SELECT m.file FROM order_media m JOIN orders o ON o.id = m.order_id WHERE o.phone = ?', phone),
        ...all<{ file: string }>('SELECT media_file AS file FROM messages WHERE phone = ? AND media_file IS NOT NULL', phone),
      ].map((r) => r.file);
      transaction(() => {
        run('DELETE FROM orders WHERE phone = ?', phone);
        for (const table of ['messages', 'reminders', 'sessions', 'customers']) {
          run(`DELETE FROM ${table} WHERE phone = ?`, phone);
        }
      });
      return [...new Set(files)];
    },

    // --- sesión de conversación ---
    getSession(phone: string): Session | undefined {
      const row = get<{ state: string; data: string; updated_at: string }>(
        'SELECT state, data, updated_at FROM sessions WHERE phone = ?', phone);
      return row && { state: row.state, data: JSON.parse(row.data) as SessionData, updatedAt: row.updated_at };
    },
    saveSession(phone: string, state: string, data: SessionData = {}) {
      run(
        `INSERT INTO sessions (phone, state, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (phone) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
        phone, state, JSON.stringify(data), nowIso(),
      );
    },
    deleteSession: (phone: string) => run('DELETE FROM sessions WHERE phone = ?', phone),

    // --- mensajes ---
    logMessage(m: { phone: string; direction: 'in' | 'out'; body: string; media?: MediaRef }) {
      run(
        'INSERT INTO messages (phone, direction, body, media_file, media_mime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        m.phone, m.direction, m.body, m.media?.file ?? null, m.media?.mime ?? null, nowIso(),
      );
    },
    messagesFor: (phone: string, afterId = 0, limit = 200) =>
      all<MessageRow>(
        `SELECT id, direction, body, media_file, media_mime, created_at FROM messages
         WHERE phone = ? AND id > ? ORDER BY id LIMIT ?`, phone, afterId, limit),
    /** true si el mensaje de WhatsApp es nuevo; false si ya se había procesado (reintentos de Meta). */
    markProcessed: (waId: string) =>
      Number(run('INSERT OR IGNORE INTO processed_messages (wa_id, created_at) VALUES (?, ?)', waId, nowIso()).changes) === 1,

    chats(): ChatRow[] {
      const rows = all<{ phone: string; name: string | null; state: string | null; data: string | null; last_body: string; last_at: string }>(`
        SELECT * FROM (
          SELECT c.phone, c.name, s.state, s.data,
            (SELECT body FROM messages m WHERE m.phone = c.phone ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT created_at FROM messages m WHERE m.phone = c.phone ORDER BY id DESC LIMIT 1) AS last_at
          FROM customers c LEFT JOIN sessions s ON s.phone = c.phone
        ) WHERE last_at IS NOT NULL
        ORDER BY (state = 'humano') DESC, last_at DESC LIMIT 60`);
      return rows.map(({ data, ...r }) => ({ ...r, urgent: Boolean(data && (JSON.parse(data) as SessionData).urgent) }));
    },

    // --- pedidos y recetas ---
    createOrder(o: {
      phone: string; kind: OrderKind; detail: string; delivery: 'retiro' | 'envio'; address?: string; media: MediaRef[];
    }): number {
      return transaction(() => {
        const at = nowIso();
        const { lastInsertRowid } = run(
          `INSERT INTO orders (phone, kind, detail, delivery, address, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'nuevo', ?, ?)`,
          o.phone, o.kind, o.detail, o.delivery, o.address ?? null, at, at,
        );
        const id = Number(lastInsertRowid);
        for (const m of o.media) run('INSERT INTO order_media (order_id, file, mime) VALUES (?, ?, ?)', id, m.file, m.mime);
        return id;
      });
    },
    getOrder(id: number): OrderRow | undefined {
      const row = get<Omit<OrderRow, 'media'>>(`${ORDER_SELECT} WHERE o.id = ?`, id);
      return row && withMedia(row);
    },
    ordersForPhone: (phone: string, limit = 5): OrderRow[] =>
      all<Omit<OrderRow, 'media'>>(`${ORDER_SELECT} WHERE o.phone = ? ORDER BY o.id DESC LIMIT ?`, phone, limit).map(withMedia),
    /** Fotos y PDF que mandó la persona en las últimas horas y todavía no están en ningún pedido. */
    unattachedMedia: (phone: string, sinceIso: string, limit = 10): MediaRef[] =>
      all<{ media_file: string; media_mime: string }>(
        `SELECT media_file, media_mime FROM messages
         WHERE phone = ? AND direction = 'in' AND media_file IS NOT NULL AND created_at >= ?
           AND media_file NOT IN (SELECT file FROM order_media)
         ORDER BY id LIMIT ?`, phone, sinceIso, limit).map((r) => ({ file: r.media_file, mime: r.media_mime })),
    lastMessages: (phone: string, count = 20): MessageRow[] =>
      all<MessageRow>(
        `SELECT * FROM (
           SELECT id, direction, body, media_file, media_mime, created_at FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id`, phone, count).map((r) => ({ ...r })),
    listOrders(): OrderRow[] {
      const open = all<Omit<OrderRow, 'media'>>(
        `${ORDER_SELECT} WHERE o.status NOT IN ('entregado', 'cancelado') ORDER BY o.id`);
      const closed = all<Omit<OrderRow, 'media'>>(
        `${ORDER_SELECT} WHERE o.status IN ('entregado', 'cancelado') ORDER BY o.updated_at DESC LIMIT 30`);
      return [...open, ...closed].map(withMedia);
    },
    setOrderStatus: (id: number, status: OrderStatus) =>
      Number(run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id).changes) === 1,

    // --- recordatorios ---
    createReminder(phone: string, medication: string, dueAt: string): number {
      const { lastInsertRowid } = run(
        'INSERT INTO reminders (phone, medication, due_at, created_at) VALUES (?, ?, ?, ?)',
        phone, medication, dueAt, nowIso(),
      );
      return Number(lastInsertRowid);
    },
    activeReminderCount: (phone: string) =>
      get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders WHERE phone = ? AND status = 'activo'", phone)?.n ?? 0,
    getReminder: (id: number) =>
      get<{ id: number; phone: string; medication: string }>('SELECT id, phone, medication FROM reminders WHERE id = ?', id),
    dueReminders: (limit = 20) =>
      all<ReminderRow>(
        `SELECT r.id, r.phone, c.name, r.medication, r.due_at FROM reminders r
         JOIN customers c ON c.phone = r.phone AND c.consent_at IS NOT NULL
         WHERE r.status = 'activo' AND r.due_at <= ? ORDER BY r.due_at LIMIT ?`, nowIso(), limit),
    markReminderSent: (id: number) => run("UPDATE reminders SET status = 'enviado' WHERE id = ?", id),
    postponeReminder: (id: number, dueAt: string) => run('UPDATE reminders SET due_at = ? WHERE id = ?', dueAt, id),
    cancelReminders: (phone: string) =>
      Number(run("UPDATE reminders SET status = 'cancelado' WHERE phone = ? AND status = 'activo'", phone).changes),

    // --- retención de datos ---
    /** Borra datos viejos; devuelve los archivos de media que hay que eliminar del disco. */
    purge(days: number): string[] {
      const cutoff = new Date(clock().getTime() - days * 86_400_000).toISOString();
      const files = new Set<string>();
      return transaction(() => {
        for (const r of all<{ media_file: string }>(
          `SELECT DISTINCT media_file FROM messages WHERE created_at < ? AND media_file IS NOT NULL
             AND media_file NOT IN (SELECT file FROM order_media)`, cutoff)) files.add(r.media_file);
        run('DELETE FROM messages WHERE created_at < ?', cutoff);

        const old = all<{ id: number }>(
          "SELECT id FROM orders WHERE status IN ('entregado', 'cancelado') AND updated_at < ?", cutoff);
        for (const { id } of old) {
          for (const m of mediaFor(id)) files.add(m.file);
          run('DELETE FROM orders WHERE id = ?', id);
        }
        run('DELETE FROM processed_messages WHERE created_at < ?', cutoff);
        run("DELETE FROM reminders WHERE status != 'activo' AND created_at < ?", cutoff);
        return [...files];
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
