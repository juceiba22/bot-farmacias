import type { PharmacyConfig } from './config.ts';

/** Fecha de la última revisión del texto; cambiala cuando edites las páginas. */
const UPDATED = '26 de octubre de 2026';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escape(title)}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="legal">
  <main>
${body}
  </main>
</body>
</html>
`;
}

const contactLine = (cfg: PharmacyConfig) =>
  [cfg.contactEmail && `por mail a ${escape(cfg.contactEmail)}`, `por teléfono al ${escape(cfg.phone)}`, `o personalmente en ${escape(cfg.address)}`]
    .filter(Boolean)
    .join(', ');

export function renderPrivacyPolicy(cfg: PharmacyConfig, retentionDays: number): string {
  const name = escape(cfg.name);
  return page(`Política de privacidad — ${cfg.name}`, `
    <h1>Política de privacidad</h1>
    <p class="meta">${name} · Última actualización: ${UPDATED}</p>

    <h2>1. Quién es responsable de tus datos</h2>
    <p>${name}, ${escape(cfg.address)}. Podés contactarnos ${contactLine(cfg)}.</p>

    <h2>2. Qué datos guardamos</h2>
    <p>Cuando nos escribís por WhatsApp guardamos tu número de teléfono, el nombre de tu perfil de WhatsApp, los mensajes que intercambiamos y los archivos que nos enviás (por ejemplo, fotos o PDF de recetas). También guardamos tus pedidos y, si los pedís, los recordatorios de reposición con el nombre del medicamento y la fecha.</p>
    <p>Son datos que pueden referirse a tu salud, así que los tratamos con especial cuidado y solo después de que aceptes el aviso de privacidad que te mostramos al comenzar la conversación.</p>

    <h2>3. Para qué los usamos</h2>
    <ul>
      <li>Responder tus consultas y preparar tus pedidos y recetas.</li>
      <li>Avisarte cuando tu pedido está listo.</li>
      <li>Enviarte los recordatorios que nos hayas pedido.</li>
      <li>Pasar la conversación a una persona del equipo cuando corresponda.</li>
    </ul>
    <p>No vendemos tus datos ni los usamos para publicidad de terceros.</p>

    <h2>4. Asistente automático</h2>
    <p>Te atiende un asistente automático que usa inteligencia artificial. Para responderte, el contenido de tus mensajes se procesa con un modelo de lenguaje de Anthropic. El asistente no da indicaciones sobre medicamentos ni sobre síntomas: esas consultas las responde un farmacéutico del equipo.</p>

    <h2>5. Con quién compartimos los datos</h2>
    <p>Solo con los proveedores necesarios para brindarte el servicio: Meta (WhatsApp), Anthropic (procesamiento del asistente), y los servicios de alojamiento y automatización que usamos para operar el sistema. Algunos de ellos pueden almacenar o procesar datos fuera de la Argentina.</p>

    <h2>6. Cuánto tiempo los conservamos</h2>
    <p>Conservamos los mensajes, archivos y pedidos cerrados hasta ${retentionDays} días. Pasado ese plazo se eliminan automáticamente.</p>

    <h2>7. Tus derechos</h2>
    <p>Podés acceder a tus datos, rectificarlos y pedir que los eliminemos. La forma más rápida es escribir <strong>borrar mis datos</strong> en el chat. Las instrucciones completas están en <a href="/eliminacion-datos">Eliminación de datos</a>.</p>

    <h2>8. Seguridad</h2>
    <p>Las conexiones están cifradas y el acceso del personal a las conversaciones y pedidos requiere usuario y contraseña.</p>

    <h2>9. Autoridad de control</h2>
    <p>La Agencia de Acceso a la Información Pública, en su carácter de Órgano de Control de la Ley N.º 25.326, tiene la atribución de atender las denuncias y reclamos de quienes resulten afectados en sus derechos por el incumplimiento de las normas de protección de datos personales.</p>

    <h2>10. Cambios</h2>
    <p>Si modificamos esta política, publicaremos la nueva versión en esta misma dirección con su fecha de actualización.</p>`);
}

export function renderDataDeletion(cfg: PharmacyConfig, retentionDays: number): string {
  const name = escape(cfg.name);
  return page(`Eliminación de datos — ${cfg.name}`, `
    <h1>Eliminación de tus datos</h1>
    <p class="meta">${name} · Última actualización: ${UPDATED}</p>

    <h2>Desde el chat de WhatsApp (inmediato)</h2>
    <ol>
      <li>Escribí <strong>borrar mis datos</strong> en la conversación con ${name}.</li>
      <li>El asistente te pide confirmación: respondé <strong>1</strong>.</li>
      <li>Se eliminan tu número, tus mensajes, los archivos que enviaste, tus pedidos y tus recordatorios.</li>
    </ol>

    <h2>Si no podés usar el chat</h2>
    <p>Escribinos ${contactLine(cfg)}, indicando el número de WhatsApp con el que nos contactaste. Eliminamos tus datos y te lo confirmamos.</p>

    <h2>Qué más tenés que saber</h2>
    <ul>
      <li>Si no pedís la eliminación, los datos se borran solos pasados ${retentionDays} días.</li>
      <li>Meta (WhatsApp) puede conservar su propia copia de los mensajes según sus políticas. Para eso tenés que dirigirte a Meta.</li>
    </ul>
    <p>Más información en la <a href="/privacidad">política de privacidad</a>.</p>`);
}
