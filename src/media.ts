import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaRef } from './db.ts';

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_FILE_RE = /^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
const CONTENT_TYPE = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));

/** Mira los primeros bytes: no nos fiamos del tipo que declara quien manda el archivo. */
export function detectMime(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return undefined;
}

export function saveMedia(dataDir: string, buf: Buffer): MediaRef | undefined {
  if (buf.length === 0 || buf.length > MAX_MEDIA_BYTES) return undefined;
  const mime = detectMime(buf);
  if (!mime) return undefined;
  const dir = join(dataDir, 'media');
  mkdirSync(dir, { recursive: true });
  const file = `${randomUUID()}.${EXT[mime]}`;
  writeFileSync(join(dir, file), buf);
  return { file, mime };
}

export const mediaPath = (dataDir: string, file: string) => join(dataDir, 'media', file);

export const contentTypeFor = (file: string) => CONTENT_TYPE[file.split('.').pop() ?? ''] ?? 'application/octet-stream';

export function deleteMedia(dataDir: string, files: string[]) {
  for (const file of files) {
    if (!MEDIA_FILE_RE.test(file)) continue;
    try {
      unlinkSync(mediaPath(dataDir, file));
    } catch {
      // ya no estaba
    }
  }
}
