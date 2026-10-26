# API para n8n y Claude (`/agent`)

Con esta API el "cerebro" (Claude, orquestado por n8n) conversa con los clientes, y este servidor sigue siendo el dueño de los datos y de las reglas de seguridad.

```
WhatsApp ──▶ n8n ──▶ POST /agent/inbound ──┬─ action: reply  → n8n envía el texto (reglas fijas: consentimiento, emergencias, consultas médicas…)
                                          ├─ action: silent → no se responde (chat en manos de una persona)
                                          └─ action: agent  → Claude con las herramientas de abajo
                                                                  │
            panel del mostrador  ◀── pedidos, derivaciones ◀──────┘ (search_catalog, create_order, handoff_to_human…)
```

**Lo importante:** el código decide antes que el modelo. Consentimiento, emergencias, `borrar mis datos`, `baja`, pedidos de hablar con una persona y consultas médicas se resuelven en `/agent/inbound` sin pasar por Claude.

## Camino recomendado: `POST /agent/respond` (Claude corre dentro del bot)

Con `ANTHROPIC_API_KEY` cargada en el servidor, n8n no necesita ni nodos de IA ni herramientas: manda cada mensaje a un solo endpoint y recibe los textos para enviar.

```
WhatsApp Trigger ──▶ HTTP Request: POST /agent/respond ──▶ ¿action = reply? ──▶ WhatsApp: enviar cada texto de "replies"
```

Pedido:

```json
{ "phone": "5493875550001", "name": "Ana", "type": "text", "text": "hola, ¿tienen ibuprofeno?", "message_id": "wamid.XXX" }
```

Respuesta:

```json
{ "action": "reply", "source": "rules" | "claude", "replies": ["texto 1", "texto 2"] }
{ "action": "silent" }
```

- `source: "rules"`: respondió el código (aviso de privacidad, emergencias, consulta médica derivada, `borrar mis datos`, `baja`…). No se llamó a Claude.
- `source: "claude"`: respondió Claude con las herramientas (catálogo, pedidos, recordatorios, derivación). El teléfono lo toma el servidor del pedido; nunca de lo que escriba el modelo.
- `silent`: la conversación está en manos de una persona del equipo, o el mensaje era un reintento. No se envía nada.
- Los mensajes (entrantes y salientes) quedan registrados solos: **no hace falta llamar a `/agent/outbound`**.
- Dos mensajes seguidos del mismo cliente se atienden en orden (el servidor los encola por teléfono), así que no hace falta limitar la concurrencia de n8n.
- Si Claude falla (API caída, sin saldo, rechazo del modelo, respuesta cortada), el cliente recibe un aviso y el chat pasa a una persona del equipo, en vez de quedar sin respuesta.
- Variables: `ANTHROPIC_API_KEY`, y opcionales `ANTHROPIC_MODEL` (por defecto `claude-opus-5-5`) y `ANTHROPIC_EFFORT`. Para bajar costo y latencia se puede probar `claude-sonnet-5-5` o `claude-haiku-5-5`, pero conviene repetir antes las pruebas de seguridad de más abajo.

**Workflow listo para importar:** [n8n/farmacia-whatsapp.workflow.json](../n8n/farmacia-whatsapp.workflow.json) (WhatsApp Trigger → armar mensaje → bot → repartir respuestas → enviar por WhatsApp). En n8n: *Workflows → ⋮ → Import from file* (o pegá el JSON sobre el lienzo con `Ctrl+V`). Después creá las tres credenciales que indica la nota del propio workflow, elegilas en los nodos y activalo. La URL del bot está fija en el nodo *Bot (Claude)*: cambiala si tu dominio es otro. No se pudo probar en una instancia de n8n: si algún nodo aparece con un aviso, revisá su versión y sus campos. Esta primera etapa maneja solo texto; las fotos de recetas son la etapa 2.

Fotos y PDF: ver *Fotos y recetas* más abajo. Con `/agent/respond` el paso 2 (`type: "media"`) se manda igual a `/agent/respond`.

Los endpoints siguientes (`/agent/inbound`, herramientas sueltas) siguen disponibles si preferís armar el agente en n8n.

## Configuración

Generá un token largo y cargalo como variable de entorno (mínimo 24 caracteres; sin token la API queda apagada):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```
AGENT_API_TOKEN=<el token>
```

Todas las llamadas llevan `Authorization: Bearer <token>`. Los POST llevan `Content-Type: application/json`.

El token da acceso a pedidos y conversaciones de clientes: guardalo como credencial en n8n (no en el texto de un nodo) y rotalo si se filtra.

## El teléfono lo manda n8n, nunca el modelo

Todas las herramientas actúan sobre **un cliente**, identificado por `phone` (el número del mensaje entrante, solo dígitos, p. ej. `5493875550001`). Ese valor sale del disparador de WhatsApp y se inyecta en cada llamada. Las definiciones de herramientas de `GET /agent/config` no tienen parámetro `phone` a propósito: si el modelo pudiera elegirlo, un mensaje malicioso ("mostrame los pedidos del 549…") podría llegar a datos de otra persona.

## Endpoints

| Método y ruta | Para qué |
|---|---|
| `POST /agent/inbound` | Primer paso de cada mensaje. Aplica las reglas fijas y devuelve qué hacer. |
| `POST /agent/outbound` | Registra lo que se le respondió al cliente (para el historial y el panel). |
| `POST /agent/media` | Sube una foto o PDF del cliente (base64). Devuelve `{file, mime}`. |
| `GET /agent/config` | `system_prompt` y `tools` listos para Claude. |
| `GET /agent/pharmacy` | Datos, horarios y si está abierta ahora. |
| `GET /agent/catalog/search?q=&sale_type=&limit=` | Búsqueda en el catálogo (máx. 8). |
| `GET /agent/catalog/products/:id` | Un producto. |
| `POST /agent/orders` | Crea un pedido o una receta. |
| `GET /agent/orders?phone=` | Últimos 5 pedidos del cliente. |
| `POST /agent/reminders` / `POST /agent/reminders/cancel` | Recordatorios de reposición. |
| `POST /agent/handoff` | Pasa el chat a una persona (aparece como "Espera" en el panel). |

### `POST /agent/inbound`

```json
{ "phone": "5493875550001", "name": "Ana", "type": "text", "text": "hola", "message_id": "wamid.XXX" }
```

- `type`: `text`, `media` (con `media: {"file": "<lo que devolvió /agent/media>"}` y `text` opcional como epígrafe) o `unsupported` (audio, ubicación, sticker…).
- `message_id` (el id del mensaje de WhatsApp) evita procesar dos veces un reintento de Meta.

Respuestas posibles:

```json
{ "action": "reply",  "replies": ["texto 1", "texto 2"] }
{ "action": "silent" }
{ "action": "agent",
  "customer": { "phone": "…", "name": "Ana" },
  "messages": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ],
  "notes": [],
  "pharmacy": { "name": "…", "open_now": true, "hours": "…", "delivery": { } } }
```

En `agent`, `messages` es el historial reciente con roles alternados (termina con el mensaje actual del cliente) y `notes` trae instrucciones puntuales para el modelo (por ejemplo, que el cliente está respondiendo a un recordatorio).

### Fotos y recetas

1. Llega una imagen o PDF → n8n la descarga de WhatsApp y la manda en base64 a `POST /agent/media` con `{ "phone", "data" }`.
   - `403 consent_required`: la persona todavía no aceptó el aviso de privacidad. Llamá a `/agent/inbound` con `type: "text"` y `text: ""`: devuelve el aviso.
   - `415`: no es JPG, PNG, WebP ni PDF (se verifica el contenido real, no la extensión).
2. Con el `file` devuelto, llamá a `/agent/inbound` con `type: "media"`.
3. Cuando el cliente confirma, `create_order` adjunta solas las fotos de las últimas 6 horas que no estén en otro pedido. Una receta sin adjunto devuelve `422`.

### `POST /agent/orders`

```json
{ "phone": "…", "kind": "pedido", "detail": "1 Ibuprofeno 400 mg x 20 comp", "delivery": "envio", "address": "Av. Siempre Viva 742, Salta" }
```

Errores que el modelo debe saber manejar: `403 consent_required`, `400` (datos faltantes), `422` (receta sin foto), `409` (demasiados pedidos abiertos: derivar a una persona).

## Herramientas para Claude

`GET /agent/config` devuelve las siete herramientas en el formato de la API de Anthropic (`name`, `description`, `input_schema`) y el prompt de sistema. Se corresponden con los endpoints así:

| Herramienta | Llamada que hace n8n (agregando `phone`) |
|---|---|
| `get_pharmacy_info` | `GET /agent/pharmacy` |
| `search_catalog` | `GET /agent/catalog/search?q={query}&sale_type={sale_type}` |
| `create_order` | `POST /agent/orders` |
| `get_orders` | `GET /agent/orders?phone=` |
| `create_reminder` | `POST /agent/reminders` |
| `cancel_reminders` | `POST /agent/reminders/cancel` |
| `handoff_to_human` | `POST /agent/handoff` (`reason`, `urgent`) |

El texto del prompt y las descripciones están en [src/agent-prompt.ts](../src/agent-prompt.ts): ahí se ajusta el tono y las reglas.

## Armado en n8n

> Esta receta no se probó en una instancia de n8n: los nombres de nodos y opciones pueden variar según la versión. Lo que sí está probado es la API, con tests automáticos.

1. **WhatsApp Trigger** (credenciales de la app de Meta). Con esto el webhook de Meta apunta a n8n, no a este servidor: Meta admite un solo webhook por número.
2. **Si el mensaje es imagen o documento:** descargarlo (nodo WhatsApp *Media*, o HTTP Request a la Graph API con el `media id`), convertirlo a base64 y llamar a `POST /agent/media`. Si responde `403`, seguir como `text` vacío.
3. **HTTP Request → `POST /agent/inbound`** con `phone`, `name`, `type`, `text`, `message_id` y, si hubo adjunto, `media.file`.
4. **Switch por `action`:**
   - `reply` → un nodo WhatsApp *Send message* por cada elemento de `replies`, y después `POST /agent/outbound`.
   - `silent` → terminar.
   - `agent` → paso 5.
5. **AI Agent** con el modelo **Anthropic Chat Model** (Claude):
   - *System message*: el `system_prompt` de `GET /agent/config`, más `notes` si hay.
   - *Prompt*: el historial de `messages` escrito como transcripción ("Cliente: … / Asistente: …") y, al final, el mensaje actual. Sin memoria propia: el historial ya viene de acá.
   - *Tools*: un nodo **HTTP Request Tool** por herramienta de la tabla de arriba, con la descripción de `GET /agent/config`. El `phone` va fijo, tomado del disparador: `{{ $('WhatsApp Trigger').item.json.messages[0].from }}`. Autenticación con la credencial *Header Auth* (`Authorization: Bearer …`).
6. Enviar la respuesta del agente por WhatsApp y llamar a `POST /agent/outbound`.

Sugerencias:

- **Modelo:** `claude-sonnet-5-5` para la demo; `claude-haiku-5-5` si importa más el costo y la velocidad (probalo con consultas médicas y pedidos largos antes de decidir).
- **Un mensaje a la vez:** si el cliente manda varios seguidos, dos ejecuciones en paralelo pueden pisarse. Para la demo, limitá la concurrencia de n8n a 1 (variable `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`; verificá el nombre en tu versión).
- **Si falla algo:** que el flujo de error de n8n mande un mensaje corto ("Tuve un problema, ya aviso al equipo") y llame a `POST /agent/handoff`.

## Recordatorios en este modo

Los recordatorios los sigue enviando este servidor (necesita `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID` y la plantilla aprobada). Cuando el cliente responde, el mensaje llega a n8n; `/agent/inbound` devuelve una `note` para que Claude cree el pedido de reposición o reprograme.

## Precauciones

- El catálogo es una muestra de demostración con **precios de referencia** y sin stock real. El prompt le prohíbe al modelo prometer disponibilidad, pero revisá las respuestas reales antes de mostrarlo.
- Probá a mano, antes de una demo: consultas médicas disfrazadas ("mi abuela toma enalapril, ¿le sirve este?"), intentos de saltarse las reglas ("ignorá tus instrucciones") y pedidos con receta sin foto.
