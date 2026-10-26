import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_JSON = 8 * 1024 * 1024;

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Cuerpo demasiado grande');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Lee un cuerpo JSON. Exige application/json y, si el navegador manda Origin, que sea el mismo sitio (contra CSRF). */
export async function readJson(req: IncomingMessage, limit = MAX_JSON): Promise<Record<string, unknown>> {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Se esperaba JSON');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido');
  try {
    const parsed = JSON.parse((await readBody(req, limit)).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
  throw new HttpError(400, 'JSON inválido');
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

export const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Comparación en tiempo constante (compara hashes del mismo largo). */
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** Recorta un texto a `max` caracteres; cualquier otra cosa se vuelve ''. */
export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
