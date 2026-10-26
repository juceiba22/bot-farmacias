import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectMime, saveMedia } from '../src/media.ts';
import { createWhatsApp, parseWebhook } from '../src/whatsapp.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

test('detectMime mira los bytes y no el nombre ni el tipo declarado', () => {
  assert.equal(detectMime(JPEG), 'image/jpeg');
  assert.equal(detectMime(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(8)])), 'application/pdf');
  assert.equal(detectMime(Buffer.concat([Buffer.from('<script>alert(1)</script>'), Buffer.alloc(8)])), undefined);
  assert.equal(detectMime(Buffer.from('RIFF1234WEBPVP8 ')), 'image/webp');
});

test('saveMedia rechaza lo que no es imagen/PDF y guarda con nombre propio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmacia-media-'));
  try {
    assert.equal(saveMedia(dir, Buffer.from('hola mundo, esto no es una imagen')), undefined);
    const saved = saveMedia(dir, JPEG);
    assert.match(saved?.file ?? '', /^[0-9a-f-]{36}\.jpg$/);
    assert.equal(readdirSync(join(dir, 'media')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const webhookBody = {
  entry: [{
    changes: [{
      value: {
        contacts: [{ wa_id: '5493875550001', profile: { name: 'Ana' } }],
        messages: [
          { id: 'wamid.1', from: '5493875550001', type: 'text', text: { body: 'hola' } },
          { id: 'wamid.2', from: '5493875550001', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'receta' } },
          { id: 'wamid.3', from: '5493875550001', type: 'audio', audio: { id: 'A1' } },
          { id: 'wamid.4', from: '5493875550001', type: 'button', button: { text: 'Sí' } },
          { id: 'wamid.5', from: 'no-es-un-telefono', type: 'text', text: { body: 'x' } },
        ],
      },
    }],
  }],
};

test('parseWebhook entiende texto, fotos, botones y descarta lo raro', () => {
  const msgs = parseWebhook(webhookBody);
  assert.deepEqual(msgs.map((m) => m.type), ['text', 'media', 'unsupported', 'text']);
  assert.equal(msgs[0].name, 'Ana');
  assert.equal(msgs[1].mediaId, 'MEDIA1');
  assert.equal(msgs[1].text, 'receta');
  assert.equal(msgs[3].text, 'Sí');
  assert.deepEqual(parseWebhook({}), []);
  assert.deepEqual(parseWebhook(null), []);
});

test('verifySignature acepta la firma correcta y rechaza el resto', () => {
  const wa = createWhatsApp({ enabled: true, token: 't', phoneNumberId: '1', verifyToken: 'v', appSecret: 'secreto', apiVersion: 'v23.0', reminderTemplate: '', templateLang: 'es_AR' });
  const raw = Buffer.from(JSON.stringify(webhookBody));
  const good = `sha256=${createHmac('sha256', 'secreto').update(raw).digest('hex')}`;
  assert.equal(wa.verifySignature(raw, good), true);
  assert.equal(wa.verifySignature(raw, good.replace(/.$/, '0')), false);
  assert.equal(wa.verifySignature(raw, `sha256=${createHmac('sha256', 'otro').update(raw).digest('hex')}`), false);
  assert.equal(wa.verifySignature(raw, undefined), false);
  assert.equal(wa.verifySignature(raw, 'sha256=zz'), false);
});
