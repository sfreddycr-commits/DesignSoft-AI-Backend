// ============================================================
// Hermes Agent — Agent Loop
// ============================================================
// Flujo:
//   1. Cargar historial + knowledge del cliente
//   2. Llamar al LLM con system prompt + tools
//   3. Si LLM devuelve tool_calls -> ejecutar tools -> volver al LLM
//   4. Si LLM devuelve contenido -> enviar al cliente (vía send_message)
//   5. Log de cada paso (reasoning trace)
// ============================================================

import { callLLM, LLMMessage, LLMResponse } from '../llm/client.js'
import { tools, executeTool } from '../tools/registry.js'
import {
  saveMessage, getRecentMessages, getKnowledge, searchMemory,
  logAudit, MemoryEntry, KnowledgeEntry,
} from '../memory/db.js'
import 'dotenv/config'

const SYSTEM_PROMPT = `Eres Hermes, el asistente omnicanal de DesignSoft S.A., una empresa costarricense de software con +15.000 clientes en 13 paises.

PRODUCTOS DE DESIGNSOFT:
- Factura Electronica (desde $15/mes) - 13 paises
- POS Restaurantes (desde $25/mes)
- TallerAlpha (desde $20/mes) - gestion de talleres mecanicos
- POS Ferreteria (desde $25/mes)
- Medicals (desde $20/mes) - gestion de consultorios medicos
- Facturar Online (desde $10/mes)
- Taller Bike / Taller Motos

INSTRUCCIONES:
1. Eres amable, profesional y conciso. Respondes en espanol.
2. Tu trabajo principal es responder al cliente de forma util y resolver su problema.
3. ANTES de responder, usa las herramientas disponibles para conocer al cliente:
   - crm_get_customer: para ver su historial y datos
   - search_memory: para recordar conversaciones pasadas (puedes llamarla mentalmente)
4. Despues de responder, SIEMPRE debes llamar a send_message para enviar la respuesta al cliente.
5. Si no sabes la respuesta, ofrece escalar a un humano: "Te voy a conectar con un asesor humano para ayudarte mejor."
6. Si el cliente se pone agresivo, mantén la calma y ofrece escalar.
7. NO inventes informacion. Si no la tienes, búscala o admítelo.

FLUJO OBLIGATORIO:
1. Recibir mensaje del cliente
2. Pensar: que necesita el cliente? que herramientas debo usar?
3. Llamar herramientas si es necesario
4. Una vez que tengas la respuesta, llamar send_message para enviarla
5. El parametro phone de send_message es el numero del cliente

MEMORIA: Tienes acceso a la memoria del cliente (conversaciones previas y datos guardados). Usala para personalizar la atencion.`

export interface ProcessResult {
  reply: string | null
  reasoning: string[]
  steps: Array<{ step: string; detail: string; ts: string }>
}

export async function processMessage(
  customerPhone: string,
  userMessage: string,
  source: 'whatsapp' | 'voice' | 'web' = 'whatsapp',
): Promise<ProcessResult> {
  const phone = customerPhone.replace(/[^\d+]/g, '')
  const steps: ProcessResult['steps'] = []
  const reasoning: string[] = []

  const log = (step: string, detail: string) => {
    const entry = { step, detail, ts: new Date().toISOString() }
    steps.push(entry)
    logAudit(phone, step, detail)
    console.log(`[hermes:${step}] ${detail}`)
  }

  log('inicio', `Mensaje de ${phone} via ${source}: ${userMessage.slice(0, 200)}`)

  // 1. Cargar historial + knowledge
  const history = getRecentMessages(phone, 10)
  const knowledge = getKnowledge(phone)
  const memoryContext = knowledge.length > 0
    ? `\n\nDATOS GUARDADOS DEL CLIENTE:\n${knowledge.map(k => `- ${k.key}: ${k.value}`).join('\n')}`
    : ''

  // 2. Guardar mensaje del usuario
  saveMessage(phone, 'user', `[${source}] ${userMessage}`)

  // 3. Armar mensajes para el LLM
  const messages: LLMMessage[] = [
    ...history.map(h => ({
      role: h.role as LLMMessage['role'],
      content: h.content,
    })),
    { role: 'user' as const, content: userMessage + memoryContext },
  ]

  log('pensar', `LLM invocando con ${messages.length} mensajes, ${tools.length} tools`)

  // 4. Agent loop: max 5 iteraciones (tool calls)
  let finalReply: string | null = null
  let iteration = 0
  const MAX_ITER = 5

  while (iteration < MAX_ITER) {
    iteration++
    const response: LLMResponse = await callLLM(SYSTEM_PROMPT, messages, tools)
    reasoning.push(`Iter ${iteration}: ${response.content ?? '(no content)'} tools=${response.tool_calls.length}`)

    if (response.tool_calls.length > 0) {
      // Guardar tool calls en mensajes
      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      })

      for (const tc of response.tool_calls) {
        log('tool', `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 150)})`)
        const result = await executeTool(tc.name, tc.arguments, phone)
        log('tool_result', result.result.slice(0, 200))
        messages.push({
          role: 'tool',
          name: tc.name,
          tool_call_id: tc.id,
          content: result.result,
        })
      }
      // Continuar el loop para que el LLM responda
      continue
    }

    // Sin tool calls -> respuesta final
    finalReply = response.content
    break
  }

  // 5. Guardar respuesta del agente
  if (finalReply) {
    saveMessage(phone, 'assistant', finalReply)
    log('respuesta', finalReply.slice(0, 200))
  } else {
    log('error', 'No se obtuvo respuesta del LLM')
  }

  // 6. Fallback: si el LLM no llamó send_message, lo hacemos automáticamente
  const lastToolCalls = messages.filter(m => m.role === 'assistant' && m.tool_calls)
    .flatMap(m => m.tool_calls ?? [])
  const alreadySent = lastToolCalls.some(tc => tc?.function?.name === 'send_message')

  if (finalReply && !alreadySent) {
    log('auto_send', 'LLM no llamó send_message → enviando automáticamente')
    await executeTool('send_message', { phone, text: finalReply }, phone)
  }

  return { reply: finalReply, reasoning, steps }
}
