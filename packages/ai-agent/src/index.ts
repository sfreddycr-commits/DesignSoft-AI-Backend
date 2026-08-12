/**
 * AI Agent - AI Call Center
 *
 * Modulo del agente conversacional. Recibe texto del STT (voz del
 * caller -> texto), lo envia al LLM (OpenAI) y devuelve la respuesta
 * para que el TTS la sintetice.
 *
 * Estado: implementacion con proveedor real.
 *   - Provider 'openai' (gpt-4o-mini por defecto) si OPENAI_API_KEY
 *     esta disponible.
 *   - Fallback a 'stub' (eco) si no hay API key.
 *   - Primer mensaje -> greeting fijo (no consume tokens).
 *   - Mensajes siguientes -> llamada al provider configurado.
 */

import type { Agent, ConversationContext, ConversationTurn, AgentConfig } from './types.ts'

export type { Agent, ConversationContext, ConversationTurn, AgentConfig } from './types.ts'

// ============================================================
// Prompt del sistema por defecto
// ============================================================

const DEFAULT_SYSTEM_PROMPT = [
  'Eres un asistente virtual de atencion al cliente de una empresa en Costa Rica.',
  'Tu objetivo es ayudar al cliente de manera amable, concisa y profesional.',
  'Hablas en espanol de Costa Rica (usa "vos" solo si el cliente lo usa primero).',
  'Responde de forma breve (maximo 2-3 oraciones por turno).',
  'No inventes datos. Si no sabes algo, indicale al cliente que no tienes esa informacion.',
  'Si el cliente pide hablar con un humano, una transferencia a un agente, o si la conversacion lo requiere,',
  'indica que lo transferiras (el orquestador se encarga del resto).',
].join(' ')

const DEFAULT_GREETING =
  'Hola, soy el asistente virtual del call center. ¿En que puedo ayudarle?'

// ============================================================
// Implementacion
// ============================================================

const sessions = new Map<string, ConversationContext>()

export function createAgent(config: AgentConfig = {}): Agent {
  const requestedProvider = config.provider ?? 'stub'
  const apiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY
  const model = config.model ?? 'gpt-4o-mini'
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const staticGreeting = config.staticGreeting ?? true

  // Provider efectivo: si pidieron openai pero no hay key, fallback a stub
  const useOpenAI = requestedProvider === 'openai' && Boolean(apiKey)
  const effectiveProvider = useOpenAI ? 'openai' : 'stub'

  if (requestedProvider === 'openai' && !apiKey) {
    console.warn(
      '[ai-agent] provider "openai" solicitado pero OPENAI_API_KEY no definida. ' +
        'Usando fallback stub.',
    )
  }

  return {
    name: effectiveProvider,
    model: useOpenAI ? model : 'stub',

    async chat(message: string, context: ConversationContext): Promise<string> {
      // Inicializar historial si la sesion es nueva
      const existing = sessions.get(context.sessionId)
      if (existing) {
        context.history = existing.history
      } else {
        context.history = [
          { role: 'system', content: systemPrompt, timestamp: Date.now() },
        ]
        sessions.set(context.sessionId, context)
      }

      // Primer turno: greeting fijo (no consume tokens del LLM)
      const hasGreeted = context.history.some((t) => t.role === 'assistant')
      if (!hasGreeted) {
        if (message) {
          context.history.push({ role: 'user', content: message, timestamp: Date.now() })
        }
        context.history.push({ role: 'assistant', content: DEFAULT_GREETING, timestamp: Date.now() })
        return DEFAULT_GREETING
      }

      // Turnos siguientes: push del user y llamada al provider
      if (message) {
        context.history.push({ role: 'user', content: message, timestamp: Date.now() })
      }

      let reply: string
      if (config.forceTransferTo) {
        // Stub con transferencia forzada: no llama al LLM, emite marcador
        reply = `[TRANSFER:${config.forceTransferTo}]`
      } else if (useOpenAI) {
        try {
          reply = await callOpenAI(apiKey as string, model, context.history, {
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 400,
          })
        } catch (err) {
          console.error('[ai-agent] openai call failed, falling back to stub:', err)
          reply = stubReply(message)
        }
      } else {
        reply = stubReply(message)
      }

      context.history.push({ role: 'assistant', content: reply, timestamp: Date.now() })
      return reply
    },

    async resetConversation(sessionId: string): Promise<void> {
      sessions.delete(sessionId)
    },
  }
}

function stubReply(message: string): string {
  return `Recibido: "${message}". (stub - no hay OPENAI_API_KEY configurada)`
}

async function callOpenAI(
  apiKey: string,
  model: string,
  history: ConversationTurn[],
  opts: { temperature: number; maxTokens: number },
): Promise<string> {
  const messages = history.map((t) => ({ role: t.role, content: t.content }))

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI API error: ${response.status} ${text}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const reply = data.choices?.[0]?.message?.content ?? ''
  if (!reply) throw new Error('OpenAI respuesta vacia')
  return reply
}
