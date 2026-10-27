import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderLanding } from '../src/landing.ts';

const base = { whatsapp: '', email: '', retentionDays: 90 };

test('la página presenta el servicio y enlaza a las páginas legales', () => {
  const html = renderLanding(base);
  assert.match(html, /<title>Farma-asistente — Asistente de WhatsApp para farmacias<\/title>/);
  assert.match(html, /<h1>Tu farmacia atiende por WhatsApp/);
  assert.match(html, /href="\/privacidad"/);
  assert.match(html, /href="\/eliminacion-datos"/);
  assert.match(html, /hasta 90 días/);
});

test('los botones de contacto aparecen solo si están configurados', () => {
  const none = renderLanding(base);
  assert.doesNotMatch(none, /wa\.me/);
  assert.doesNotMatch(none, /mailto:/);

  const both = renderLanding({ whatsapp: '5491178142296', email: 'hola@ejemplo.test', retentionDays: 90 });
  assert.match(both, /href="https:\/\/wa\.me\/5491178142296\?text=Hola"/);
  assert.match(both, /href="mailto:hola@ejemplo\.test\?subject=/);
});

test('si solo hay mail, el botón de contacto es el principal', () => {
  const html = renderLanding({ ...base, email: 'hola@ejemplo.test' });
  assert.match(html, /<a class="btn primary" href="mailto:/);
});

test('el mail se escapa en el atributo', () => {
  const html = renderLanding({ ...base, email: 'a"><script>alert(1)</script>@x.test' });
  assert.doesNotMatch(html, /<script>alert/);
});

test('no carga nada de afuera ni usa scripts o estilos en línea (compatible con la política de seguridad)', () => {
  const html = renderLanding({ whatsapp: '5491178142296', email: 'hola@ejemplo.test', retentionDays: 90 });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /<(img|iframe|link)[^>]+(src|href)="https?:/i);
  assert.match(html, /<link rel="stylesheet" href="\/landing\.css">/);
});

test('no promete lo que el servicio no hace', () => {
  const html = renderLanding(base);
  assert.match(html, /No da consejos médicos/);
  assert.match(html, /nunca promete stock/);
  assert.match(html, /demostración/);
  assert.doesNotMatch(html, /garantiz|100 ?%|cumple con la ley|aprobado por/i);
});
