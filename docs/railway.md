# Despliegue en Railway

Dos servicios en un mismo proyecto de Railway:

```
WhatsApp (Meta) ──webhook──▶  n8n  ──HTTP privado──▶  farmacia-bot (este repo)
                                │                         ├─ volumen /app/data  (SQLite, adjuntos, catálogo)
                                └─ Claude (API Anthropic) └─ panel del mostrador (público, con clave)
```

> **Estado:** el `Dockerfile` y `railway.json` están preparados, pero la imagen no se construyó en esta máquina (no hay Docker instalado). Lo que sí se probó es el arranque en modo producción, con las mismas variables que usa el contenedor. El primer despliegue es el que lo confirma: si algo falla, el log de build de Railway lo dice.

## 1. Subir el código a un repositorio privado

El repo incluye `seed/catalog.json.gz` (412 KB): el catálogo de demostración, que viaja con el código y se importa solo la primera vez. Contiene datos tomados de un sitio de terceros, así que **el repositorio tiene que ser privado**.

```bash
cd D:\Codigardos\farmacia-bot
git add -A
git commit -m "Bot de farmacia: MVP, API de agente y despliegue"
```

Creá un repositorio privado vacío en GitHub y seguí las instrucciones que te da para `git remote add origin …` y `git push -u origin master`.

Sin GitHub también se puede desplegar desde esta carpeta con la CLI de Railway (`railway up`).

## 2. Crear el servicio `farmacia-bot`

1. En Railway: **New Project → Deploy from GitHub repo** y elegí el repositorio. Railway detecta el `Dockerfile` (lo indica `railway.json`).
2. **Volumen:** en el servicio, *Add Volume* con *mount path* `/app/data`. Sin volumen, cada redeploy borra pedidos, recetas y conversaciones.
3. **Variables** (pestaña *Variables*):

| Variable | Valor |
|---|---|
| `PANEL_PASSWORD` | Una clave larga. **Obligatoria**: en producción el servidor no arranca sin ella. |
| `AGENT_API_TOKEN` | Un token de 24+ caracteres: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `ANTHROPIC_API_KEY` | La API key de Anthropic (console.anthropic.com). Activa `POST /agent/respond`: Claude corre dentro del bot. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | Opcionales. Por defecto `claude-opus-5-5` y el esfuerzo del modelo. Para gastar menos: `claude-sonnet-5-5` o `claude-haiku-5-5`. |
| `WA_ACCESS_TOKEN` | El **token permanente** de Meta (el mismo que usa n8n para enviar). Lo necesita el bot para **descargar las fotos de recetas**. Sin él, los adjuntos no se pueden recibir. |
| `LANDING_WHATSAPP`, `LANDING_CONTACT_EMAIL` | Opcionales. Datos de contacto de la página de inicio (`/`): el número de WhatsApp del bot (solo dígitos, con código de país, por ejemplo `5491178142296`) y un mail comercial. Sin ellos, la página no muestra los botones correspondientes. |
| `LANDING_COMPANY`, `LANDING_COMPANY_URL` | Opcionales. La marca de la que es el servicio y su sitio web (https), por ejemplo `AgroTabaco` y `https://agrotabaco.com/`. La landing muestra "Farma-asistente es un servicio de …", que es lo que Meta compara con el nombre visible de WhatsApp. |
| `LANDING_LEGAL` | Opcional. El titular legal que se muestra en el pie de la landing (nombre y CUIT, como en cualquier sitio comercial). Conecta la marca con el nombre legal verificado en Meta. |
| `PORT` | `3000` (fijalo para que n8n sepa a qué puerto llamar por la red privada) |
| `RETENTION_DAYS` | `90`, o lo que defina la farmacia |
| `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_REMINDER_TEMPLATE` | Solo si el servidor tiene que **enviar recordatorios** (ver más abajo) |

`NODE_ENV`, `HOST` y `DATA_DIR` ya vienen configurados en el `Dockerfile`.

4. **Dominio público:** *Settings → Networking → Generate Domain*. Con eso queda el panel en `https://<dominio>/panel` (usuario `farmacia`).

### Comprobar

```bash
curl https://<dominio>/health                       # ok
curl -H "Authorization: Bearer <AGENT_API_TOKEN>" "https://<dominio>/agent/catalog/search?q=ibuprofeno&limit=2"
```

En los logs del primer arranque tiene que aparecer `Catálogo importado desde la semilla: 1639 productos`. En los siguientes ya no.

Si el log dice `Falta PANEL_PASSWORD`, falta esa variable.

## 3. Crear n8n

1. En el mismo proyecto: **New → Template** y buscá la plantilla de **n8n** (trae su propia base Postgres).
2. Variables importantes de n8n (la plantilla suele cargar varias; revisá estas):
   - `WEBHOOK_URL`: la URL pública de n8n (`https://<n8n>.up.railway.app/`). Es la que Meta va a llamar.
   - `N8N_ENCRYPTION_KEY`: fija y guardada aparte; si cambia, se pierden las credenciales guardadas.
   - Para la demo, `N8N_CONCURRENCY_PRODUCTION_LIMIT=1` evita que dos mensajes seguidos de un mismo cliente se pisen (verificá el nombre en tu versión).
3. Para que n8n llame a `farmacia-bot` **sin salir a internet**, usá la red privada de Railway: `http://farmacia-bot.railway.internal:3000` (cambiá `farmacia-bot` por el nombre real del servicio).
4. Armá el flujo con [docs/agent-api.md](agent-api.md) (sección *Armado en n8n*). Credenciales a crear en n8n: *Header Auth* con `Authorization: Bearer <AGENT_API_TOKEN>`, la API key de Anthropic y las credenciales de WhatsApp.

## 4. Conectar WhatsApp

- El **webhook de Meta apunta a n8n**, no a `farmacia-bot` (Meta admite un solo webhook por número). Cargá la URL del *WhatsApp Trigger* de n8n y suscribite al campo `messages`.
- Los **recordatorios** salen desde `farmacia-bot`, así que necesita `WA_ACCESS_TOKEN` y `WA_PHONE_NUMBER_ID`, y una plantilla aprobada en `WA_REMINDER_TEMPLATE` (texto sugerido en el [README](../README.md)).
  - Ojo: con `WA_ACCESS_TOKEN` cargado, `/webhook` del servidor se activa pero queda sin uso; es inofensivo y rechaza todo si no hay `WA_APP_SECRET`.
- Con un token de prueba de Meta solo se puede escribir a los números que agregaste como destinatarios de prueba.

## Cosas a tener en cuenta

- **Una sola instancia.** SQLite vive en un volumen: no escales a más de una réplica. Para varias farmacias hay que pasar a Postgres.
- **Redeploys con corte breve.** Un servicio con volumen se detiene un momento al redeployar. Para la demo no importa; hacelo fuera de horario de atención.
- **Backups.** Todo lo que importa está en `/app/data`. Revisá si tu plan de Railway ofrece backups de volumen y activalos antes de guardar datos reales.
- **Panel por HTTPS.** Railway lo da en su dominio. La clave viaja en cada request (autenticación Basic): usá una larga y no la compartas.
- **Simulador cerrado.** En producción `/sim` no se abre (no tiene contraseña). Para una demo pública se prueba por WhatsApp. Si de verdad lo necesitás, `ENABLE_SIMULATOR=1`, sabiendo que cualquiera con la URL puede cargar pedidos de prueba.
- **Actualizar el catálogo.** Corré `npm run catalog:scrape` y `npm run catalog:export` en tu máquina, commiteá el nuevo `seed/catalog.json.gz`, y borrá `catalog.db` del volumen (o poné `CATALOG_DB` en otra ruta) para que se vuelva a importar.
