import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPharmacy } from '../src/config.ts';
import { renderDataDeletion, renderPrivacyPolicy } from '../src/legal.ts';

test('la política de privacidad nombra a la farmacia, el plazo de conservación y cómo borrar los datos', () => {
  const cfg = loadPharmacy();
  const html = renderPrivacyPolicy(cfg, 90);
  assert.ok(html.includes(`<title>Política de privacidad — ${cfg.name}</title>`));
  assert.match(html, /hasta 90 días/);
  assert.match(html, /borrar mis datos/);
  assert.match(html, /href="\/eliminacion-datos"/);
  assert.match(html, /Anthropic/);
  assert.match(html, /Ley N\.º 25\.326/);
});

test('la página de eliminación explica el borrado desde el chat y por contacto directo', () => {
  const html = renderDataDeletion(loadPharmacy(), 30);
  assert.match(html, /borrar mis datos/);
  assert.match(html, /pasados 30 días/);
  assert.match(html, /href="\/privacidad"/);
});

test('el mail de contacto aparece solo si está configurado', () => {
  const cfg = loadPharmacy();
  assert.doesNotMatch(renderPrivacyPolicy(cfg, 90), /por mail a/);
  assert.match(renderPrivacyPolicy({ ...cfg, contactEmail: 'hola@farmacia.test' }, 90), /por mail a hola@farmacia\.test/);
});

test('los datos de la farmacia se escapan: no se puede inyectar HTML desde la configuración', () => {
  const html = renderPrivacyPolicy({ ...loadPharmacy(), name: '<script>alert(1)</script>', address: 'Calle "x" & <b>y</b>' }, 90);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Calle &quot;x&quot; &amp; &lt;b&gt;y&lt;\/b&gt;/);
});
