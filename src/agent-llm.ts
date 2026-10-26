import type Anthropic from '@anthropic-ai/sdk';
import type { AgentOps } from './agent-ops.ts';
import { systemPrompt, TOOLS } from './agent-prompt.ts';
import type { Bot } from './bot.ts';
import type { PharmacyConfig } from './config.ts';
import { HttpError } from './http.ts';

/** Lo único que se usa del SDK: así los tests pueden poner un cliente simulado. */
export type MessagesClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

export type AgentContext = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  notes: string[];
  pharmacy: unknown;
};

const MAX_STEPS = 6;
// Con thinking siempre activo, max_tokens cubre razonamiento + respuesta.
const MAX_TOKENS = 4096;
const MAX_REPLY_CHARS = 3500;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

type Deps = {
  client: MessagesClient;
  model: string;
  effort?: string;
  cfg: PharmacyConfig;
  ops: AgentOps;
  bot: Bot;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** WhatsApp usa *negrita* con un asterisco; el modelo a veces escribe **así**. */
const toWhatsApp = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '*$1*').trim();

/**
 * Bucle de Claude con herramientas para UN cliente. El teléfono entra como argumento y se usa en cada herramienta:
 * lo que el modelo ponga en los parámetros (aunque incluya un "phone") nunca cambia sobre quién actúa.
 */
export function createAgentRunner({ client, model, effort, cfg, ops, bot }: Deps) {
  const effortParam = EFFORTS.includes(effort as Effort) ? { output_config: { effort: effort as Effort } } : {};

  function execute(name: string, input: Record<string, unknown>, phone: string): unknown {
    switch (name) {
      case 'get_pharmacy_info': return ops.pharmacyInfo();
      case 'search_catalog': return ops.searchCatalog({ query: input.query, saleType: input.sale_type });
      case 'create_order': return ops.createOrder(phone, input);
      case 'get_orders': return ops.listOrders(phone);
      case 'create_reminder': return ops.createReminder(phone, input);
      case 'cancel_reminders': return ops.cancelReminders(phone);
      case 'handoff_to_human': return ops.handoff(phone, { reason: input.reason, urgent: input.urgent });
      default: throw new Error(`Herramienta desconocida: ${name}`);
    }
  }

  function runTool(block: Anthropic.ToolUseBlock, phone: string): Anthropic.ToolResultBlockParam {
    try {
      const result = execute(block.name, isRecord(block.input) ? block.input : {}, phone);
      return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
    } catch (err) {
      // El modelo ve el error y puede corregir el pedido o avisarle al cliente.
      const message = err instanceof HttpError || err instanceof Error ? err.message : 'Error inesperado';
      return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: message }), is_error: true };
    }
  }

  /** Si algo falla (API caída, cuota, rechazo del modelo), la conversación pasa a una persona en vez de quedar colgada. */
  function fallback(phone: string, reason: string): string[] {
    console.error(`Agente: ${reason} (cliente ${phone.slice(0, 4)}…)`);
    return [`Tuve un problema para responderte. ${bot.handoffPhone(phone, `El asistente automático falló: ${reason}`)}`];
  }

  async function run(phone: string, context: AgentContext): Promise<string[]> {
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemPrompt(cfg) },
      {
        type: 'text',
        text:
          `Datos de la farmacia ahora mismo:\n${JSON.stringify(context.pharmacy)}` +
          (context.notes.length ? `\n\nNotas de esta conversación:\n- ${context.notes.join('\n- ')}` : ''),
      },
    ];
    const messages: Anthropic.MessageParam[] = context.messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools: TOOLS,
          messages,
          ...effortParam,
        });

        if (response.stop_reason === 'refusal') return fallback(phone, 'el modelo se negó a responder');
        if (response.stop_reason === 'max_tokens') return fallback(phone, 'la respuesta se cortó por largo');

        // Se devuelve el contenido tal cual lo mandó el modelo (con sus bloques de razonamiento) para seguir el turno.
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
          const text = toWhatsApp(
            response.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('\n'),
          );
          if (!text) return fallback(phone, 'respuesta vacía');
          return [text.slice(0, MAX_REPLY_CHARS)];
        }

        const results = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use').map((b) => runTool(b, phone));
        messages.push({ role: 'user', content: results });
      }
      return fallback(phone, 'demasiados pasos con herramientas');
    } catch (err) {
      return fallback(phone, err instanceof Error ? err.message.slice(0, 200) : 'error desconocido');
    }
  }

  return { run };
}

export type AgentRunner = ReturnType<typeof createAgentRunner>;
