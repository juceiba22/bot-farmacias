# Bot de WhatsApp para farmacia (MVP)

Asistente que atiende por WhatsApp lo repetitivo y deja lo importante en manos del equipo:

- **Horarios y ubicación** (y si está abierto ahora).
- **Pedidos**: el cliente escribe o manda fotos de envases; elige retiro o envío; confirma. El pedido aparece en el panel.
- **Recetas**: foto o PDF (varias hojas), con retiro o envío.
- **Recordatorios de reposición** para medicación crónica (el cliente elige en cuántos días; el bot le escribe y, si responde que sí, arma el pedido).
- **Derivación a una persona** en cualquier momento (`persona`), y automática ante consultas sobre dosis, síntomas, interacciones, embarazo, etc.
- **Emergencias**: ante palabras como "sobredosis" o "se desmayó" responde con los teléfonos de emergencia y marca el chat como urgente.
- **Privacidad**: pide consentimiento antes de guardar nada, permite `borrar mis datos` y purga automáticamente lo viejo.

El bot **nunca da indicaciones sobre medicamentos** y **nunca promete stock ni precio**: todo pedido lo revisa una persona del mostrador.

## Cómo probarlo (sin WhatsApp)

Requiere Node 24 o superior.

```bash
npm install
npm start
```

- Simulador de chat (hace de "cliente"): <http://127.0.0.1:3000/sim>
- Panel del mostrador: <http://127.0.0.1:3000/panel> (usuario `farmacia`; la clave se imprime en la consola si no definís `PANEL_PASSWORD`)

Probá un pedido completo en el simulador y mirá cómo aparece en el panel. Desde el panel podés marcar el pedido como *listo* (el cliente recibe el aviso), o responder a mano en la pestaña *Chats*.

```bash
npm test         # 60 pruebas: bot, base de datos, webhook, API de agente, bucle de Claude y catálogo semilla
npm run typecheck
```

## Catálogo de demostración y API para Claude / n8n

- `npm run catalog:scrape` arma `data/catalog.db` con una muestra del catálogo público de Farmacity (unos 1.600 productos; una consulta por segundo, solo endpoints que su `robots.txt` no excluye). Los precios son una foto de referencia y el sitio no informa stock real. Es solo para demos: no la uses para vender ni muestres su marca.
- `npm run catalog:search -- ibuprofeno` prueba la búsqueda.
- `npm run catalog:export` empaqueta el catálogo en `seed/catalog.json.gz` (412 KB), que viaja con el código: al arrancar sin catálogo, el servidor lo importa solo.
- Con `AGENT_API_TOKEN` definido, el servidor expone `/agent/*` para que n8n y Claude conversen, busquen en el catálogo y creen pedidos. Los filtros de seguridad (consentimiento, emergencias, consultas médicas) siguen aplicándose por código antes de que intervenga el modelo. Con `ANTHROPIC_API_KEY` cargada, `POST /agent/respond` hace todo en una llamada (reglas fijas y, si corresponde, Claude con herramientas), y n8n queda con tres nodos. Detalle en [docs/agent-api.md](docs/agent-api.md).
- Para publicarlo en Railway (Dockerfile, volumen, variables y n8n): [docs/railway.md](docs/railway.md).

## Personalizar

Todo lo propio de la farmacia está en [pharmacy.json](pharmacy.json): nombre, dirección, teléfono, horarios, envíos y el texto de emergencia. **Revisá los teléfonos de emergencia** antes de usarlo.

Los textos de las respuestas están en [src/bot.ts](src/bot.ts).

## Conectarlo a WhatsApp

1. En [Meta for Developers](https://developers.facebook.com) creá una app con el producto **WhatsApp** y conseguí un número (el de prueba sirve para empezar).
2. Copiá `.env.example` a `.env` y completá `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` (inventalo) y `WA_APP_SECRET` (el *App Secret* de la app: sin él el servidor rechaza los webhooks).
3. Publicá el servidor con HTTPS (un proxy como Caddy/nginx, o un túnel como Cloudflare Tunnel mientras probás) y ponele `HOST=0.0.0.0` solo si el proxy corre en otra máquina.
4. En la configuración de WhatsApp de la app, cargá como webhook `https://TU-DOMINIO/webhook` con tu `WA_VERIFY_TOKEN` y suscribite al campo `messages`.
5. Para los recordatorios necesitás una **plantilla aprobada** (categoría *utility*) con dos variables y cargar su nombre en `WA_REMINDER_TEMPLATE`:
   `Hola! Te escribimos de {{2}} para recordarte reponer {{1}}. ¿Querés que lo vayamos preparando? Respondé 1 para sí, 2 para más adelante o 3 para no recibir más recordatorios.`
   Sin plantilla, los recordatorios solo llegan si el cliente escribió en las últimas 24 horas.

Al conectar WhatsApp el simulador se apaga solo (podés forzarlo con `ENABLE_SIMULATOR`; no lo dejes activo en un servidor público).

## Antes de usarlo con clientes reales

- **Datos de salud**: son datos sensibles (Ley 25.326). El texto del consentimiento y los plazos de conservación (`RETENTION_DAYS`, 90 por defecto) los tiene que validar quien asesore legalmente a la farmacia; también quién figura como responsable de la base.
- **Responsabilidad profesional**: definí con el director técnico qué se puede cerrar por chat (venta libre, bajo receta, envíos) según la normativa de venta online de tu jurisdicción.
- **Panel**: usá una clave larga y servilo solo por HTTPS. Quien lo abre ve recetas y datos de clientes.
- **Backups**: todo vive en `data/` (base SQLite y archivos adjuntos). Hacé copia periódica y cuidá el acceso a esa carpeta.
- **Número de envío en Argentina**: si un envío falla para un número que sí escribió, revisá el formato del teléfono (con o sin el 9 después del 54).

## Cómo está armado

```
src/bot.ts        conversación: estados, menús, derivación, consentimiento
src/db.ts         SQLite (node:sqlite): clientes, sesiones, mensajes, pedidos, recordatorios
src/server.ts     HTTP: webhook de WhatsApp, simulador, API y panel
src/whatsapp.ts   Cloud API: envío, descarga de adjuntos, firma del webhook
src/reminders.ts  envío de recordatorios (solo de 9 a 20 h y sin interrumpir otro chat)
src/media.ts      guardado de adjuntos (valida el tipo real por contenido)
public/           panel del mostrador y simulador
```

Sin dependencias en producción: usa solo Node 24 (TypeScript nativo y `node:sqlite`).

## Límites conocidos del MVP

- No consulta stock ni precios (hace falta integrar el sistema de gestión de la farmacia).
- El equipo se entera de pedidos y derivaciones mirando el panel (el título de la pestaña muestra cuántos hay pendientes); no hay aviso por WhatsApp/mail.
- Una sola farmacia por instalación.
- Entiende palabras clave, no lenguaje libre: lo que no reconoce, vuelve al menú.
