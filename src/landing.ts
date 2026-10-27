/** Página de inicio pública: presenta el servicio. Los datos de contacto vienen de la configuración y son opcionales. */
export type LandingOptions = {
  /** Número de WhatsApp del bot, solo dígitos con código de país. Vacío = no se muestra el botón "Probalo". */
  whatsapp: string;
  /** Mail de contacto comercial. Vacío = no se muestra el botón de contacto. */
  email: string;
  retentionDays: number;
};

const SERVICE = 'Farma-asistente';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const icon = (paths: string) =>
  `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  clock: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  bag: icon('<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  doc: icon('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 13h5M10 17h5"/>'),
  search: icon('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>'),
  bell: icon('<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>'),
  person: icon('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  shield: icon('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>'),
  alert: icon('<path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17v.5"/>'),
  check: icon('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
  lock: icon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
};

const LOGO = `<svg class="logo" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="#fff"/></svg>`;

const FEATURES: [keyof typeof ICONS, string, string][] = [
  ['clock', 'Horarios, dirección y envíos', 'Responde al instante lo que más preguntan, a cualquier hora, y avisa si la farmacia está abierta.'],
  ['bag', 'Pedidos sin vueltas', 'Arma el pedido con el cliente, pregunta si retira o prefiere envío y lo deja listo para que tu equipo lo prepare.'],
  ['doc', 'Recetas por foto', 'El cliente manda la foto o el PDF de la receta. Llega al panel junto con la obra social y la forma de entrega.'],
  ['search', 'Búsqueda de productos', 'Encuentra productos por nombre, marca o principio activo, y avisa cuáles se venden solo con receta.'],
  ['bell', 'Recordatorios de reposición', 'Si el cliente lo pide, le avisa cuando le toca renovar su medicación crónica.'],
  ['person', 'Pasa a una persona', 'Ante una consulta de salud, o cuando el cliente lo pide, la conversación pasa a tu equipo.'],
];

const STEPS: [string, string][] = [
  ['El cliente escribe a tu WhatsApp', 'No instala nada. La primera vez acepta un aviso de privacidad, y desde ahí ya puede consultar.'],
  ['El asistente lo atiende', 'Responde dudas del local, busca productos, arma el pedido o recibe la receta, y pregunta cómo prefiere recibirlo.'],
  ['Tu equipo confirma y prepara', 'Cada pedido llega a un panel con el detalle y las fotos. Tu equipo confirma disponibilidad y total, y avisa con un clic cuando está listo.'],
];

const SAFETY: [keyof typeof ICONS, string, string][] = [
  ['shield', 'No da consejos médicos', 'Dosis, interacciones, síntomas, embarazo: el asistente no responde esas consultas. Las pasa a un farmacéutico.'],
  ['alert', 'Detecta emergencias', 'Si alguien describe una emergencia, muestra los teléfonos para llamar de inmediato y avisa al equipo con prioridad.'],
  ['check', 'Tu equipo tiene la última palabra', 'Los precios son de referencia y el asistente nunca promete stock: cada pedido lo confirma una persona.'],
  ['lock', 'Datos bajo control del cliente', 'Pide consentimiento antes de guardar nada, permite borrar todo con un mensaje y elimina automáticamente lo que ya no hace falta.'],
];

function faq(retentionDays: number): [string, string][] {
  return [
    ['¿Reemplaza al farmacéutico?', 'No. Atiende lo repetitivo para que tu equipo se concentre en lo que requiere criterio profesional, y deriva toda consulta de salud.'],
    ['¿Qué se necesita para usarlo?', 'Un número de WhatsApp para la farmacia, que funciona sobre la plataforma oficial WhatsApp Business, y los datos básicos del local: horarios, dirección y si hacen envíos.'],
    ['¿Se conecta con mi sistema de gestión?', 'Hoy los precios y el stock los confirma tu equipo. La conexión con tu sistema se evalúa según cuál uses.'],
    ['¿Qué pasa con la foto de la receta?', 'Llega al panel junto con el pedido. El asistente no interpreta su contenido: la revisa tu equipo.'],
    ['¿Qué pasa con los datos de los clientes?', `Se guardan solo después de que la persona acepta, se conservan hasta ${retentionDays} días y se pueden borrar escribiendo «borrar mis datos». Más detalle en la <a href="/privacidad">política de privacidad</a>.`],
    ['¿Esto que veo es una demostración?', 'Sí. Los ejemplos de esta página son ilustrativos, y el catálogo de la demostración es de ejemplo, con precios de referencia.'],
  ];
}

export function renderLanding(options: LandingOptions): string {
  const { whatsapp, email, retentionDays } = options;
  const tryLink = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent('Hola')}` : '';
  const contactLink = email ? `mailto:${escape(email)}?subject=${encodeURIComponent('Quiero el asistente para mi farmacia')}` : '';

  const tryButton = tryLink ? `<a class="btn primary" href="${escape(tryLink)}" rel="noopener">Probalo por WhatsApp</a>` : '';
  const contactButton = contactLink ? `<a class="btn ${tryLink ? 'ghost' : 'primary'}" href="${contactLink}">Quiero uno para mi farmacia</a>` : '';
  const heroActions = `<div class="actions">${tryButton}${contactButton}<a class="btn ghost" href="#como-funciona">Cómo funciona</a></div>`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${SERVICE} — Asistente de WhatsApp para farmacias</title>
  <meta name="description" content="Un asistente de WhatsApp que atiende consultas, toma pedidos y recibe recetas por foto. Tu equipo confirma todo desde un panel simple, y las consultas de salud las responde siempre un farmacéutico.">
  <meta property="og:title" content="${SERVICE} — Asistente de WhatsApp para farmacias">
  <meta property="og:description" content="Atiende consultas, toma pedidos y recibe recetas por foto, las 24 horas. Tu equipo confirma todo.">
  <meta property="og:type" content="website">
  <meta name="theme-color" content="#1f7a4d">
  <link rel="stylesheet" href="/landing.css">
</head>
<body class="landing">
  <a class="skip" href="#contenido">Saltar al contenido</a>
  <header class="top">
    <div class="wrap bar-inner">
      <a class="brand" href="/">${LOGO}<span>${SERVICE}</span></a>
      <nav aria-label="Secciones">
        <a href="#que-hace">Qué hace</a>
        <a href="#como-funciona">Cómo funciona</a>
        <a href="#seguridad">Seguridad</a>
        <a href="#preguntas">Preguntas</a>
      </nav>
    </div>
  </header>

  <main id="contenido">
    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Asistente con inteligencia artificial para WhatsApp</p>
          <h1>Tu farmacia atiende por WhatsApp, también cuando está cerrada.</h1>
          <p class="lead">Responde consultas, toma pedidos y recibe recetas por foto. Tu equipo confirma todo desde un panel simple, y las consultas de salud las responde siempre un farmacéutico.</p>
          ${heroActions}
        </div>
        <figure class="phone" aria-label="Ejemplo de conversación">
          <div class="phone-head"><span class="avatar" aria-hidden="true">+</span><span>Tu farmacia</span></div>
          <div class="chat">
            <p class="bubble in">Hola, ¿tienen ibuprofeno 400?</p>
            <p class="bubble out">¡Hola! Sí, tengo <strong>Ibuprofeno 400 mg x 20 comp</strong>. El precio de referencia es $5.900 y el equipo te confirma el total. ¿Lo sumo a tu pedido?</p>
            <p class="bubble in">Sí, lo retiro por la farmacia</p>
            <p class="bubble out">Listo ✅ Registré tu pedido <strong>#12</strong>. Te confirmamos la disponibilidad por acá.</p>
          </div>
          <figcaption>Ejemplo ilustrativo</figcaption>
        </figure>
      </div>
    </section>

    <section id="que-hace" class="section">
      <div class="wrap">
        <h2>Lo que hace por tu farmacia</h2>
        <p class="section-lead">Se ocupa de lo repetitivo para que tu equipo dedique el tiempo a lo que importa.</p>
        <ul class="cards">
          ${FEATURES.map(([key, title, text]) => `<li class="card">${ICONS[key]}<h3>${title}</h3><p>${text}</p></li>`).join('\n          ')}
        </ul>
      </div>
    </section>

    <section id="como-funciona" class="section alt">
      <div class="wrap">
        <h2>Cómo funciona</h2>
        <ol class="steps">
          ${STEPS.map(([title, text], i) => `<li><span class="num" aria-hidden="true">${i + 1}</span><div><h3>${title}</h3><p>${text}</p></div></li>`).join('\n          ')}
        </ol>
      </div>
    </section>

    <section id="seguridad" class="section">
      <div class="wrap">
        <h2>Pensado para una farmacia</h2>
        <p class="section-lead">Un asistente que sabe hasta dónde llega, y cuándo pasarle la conversación a una persona.</p>
        <div class="safety-grid">
          <ul class="cards two">
            ${SAFETY.map(([key, title, text]) => `<li class="card">${ICONS[key]}<h3>${title}</h3><p>${text}</p></li>`).join('\n            ')}
          </ul>
          <figure class="phone small" aria-label="Ejemplo de derivación a un farmacéutico">
            <div class="chat">
              <p class="bubble in">¿Puedo tomarlo con alcohol?</p>
              <p class="bubble out">Esa consulta la responde un farmacéutico. Ya avisé al equipo y te van a escribir por acá.</p>
            </div>
            <figcaption>Ejemplo ilustrativo</figcaption>
          </figure>
        </div>
      </div>
    </section>

    <section id="preguntas" class="section alt">
      <div class="wrap narrow">
        <h2>Preguntas frecuentes</h2>
        <div class="faq">
          ${faq(retentionDays).map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('\n          ')}
        </div>
      </div>
    </section>

    <section class="section cta">
      <div class="wrap narrow center">
        <h2>Contanos cómo trabaja tu farmacia</h2>
        <p class="section-lead">Lo adaptamos a tus horarios, tu zona de envíos y tu forma de atender.</p>
        <div class="actions center">${tryButton}${contactButton}</div>
      </div>
    </section>
  </main>

  <footer class="foot">
    <div class="wrap foot-inner">
      <span>${SERVICE}</span>
      <nav aria-label="Información legal">
        <a href="/privacidad">Política de privacidad</a>
        <a href="/eliminacion-datos">Eliminación de datos</a>
      </nav>
    </div>
    <p class="wrap fine">Los ejemplos de esta página son ilustrativos. La demostración usa un catálogo de ejemplo con precios de referencia.</p>
  </footer>
</body>
</html>
`;
}
