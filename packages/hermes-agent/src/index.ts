// ============================================================
// DesignSoft AI — Hermes Agent (placeholder)
// ============================================================
// Servicio placeholder. Este agente será el "cerebro" del proyecto
// que recibe mensajes de WhatsApp/Voz y los enruta al departamento
// correcto (Soporte, Ventas, Cobros) usando IA.
//
// Por ahora, este contenedor solo:
//  1. Responde health checks
//  2. Acepta mensajes en POST /messages
//  3. Verifica que puede comunicarse con crm, whatsapp-worker, voice-engine
// ============================================================

import 'dotenv/config'
import express from 'express'
import cors from 'cors'

const PORT = Number(process.env.PORT ?? 5000)
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'openrouter'
const LLM_MODEL = process.env.LLM_MODEL ?? 'deepseek/deepseek-v4-pro'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const CRM_URL = process.env.CRM_URL ?? 'http://crm:4400'
const WHATSAPP_WORKER_URL = process.env.WHATSAPP_WORKER_URL ?? 'http://whatsapp-worker:4500'
const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL ?? 'http://voice-engine:3000'
const AI_AGENT_URL = process.env.AI_AGENT_URL ?? 'http://ai-agent:4300'

// Almacenamiento temporal para "memoria" (placeholder)
interface MemoryEntry {
  id: string
  type: 'conversation' | 'learning' | 'context'
  content: string
  metadata: Record<string, unknown>
  created_at: string
}
const memory: MemoryEntry[] = []

const app = express()
app.use(cors())
app.use(express.json())

// ---- Health ----
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'hermes-agent',
    version: '0.1.0',
    llm: { provider: LLM_PROVIDER, model: LLM_MODEL, configured: !!(OPENAI_API_KEY || OPENROUTER_API_KEY) },
    memory_entries: memory.length,
    upstream: {
      crm: CRM_URL,
      whatsapp_worker: WHATSAPP_WORKER_URL,
      voice_engine: VOICE_ENGINE_URL,
      ai_agent: AI_AGENT_URL,
    },
    uptime: process.uptime(),
  })
})

// ---- Inbox: endpoint principal que el whatsapp-worker llamará ----
app.post('/messages', async (req, res) => {
  try {
    const { phone, message, source, customer_id, metadata } = req.body as {
      phone: string
      message: string
      source?: string
      customer_id?: string
      metadata?: Record<string, unknown>
    }

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message required' })
    }

    const entry: MemoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'conversation',
      content: `[${source ?? 'unknown'}] ${phone}: ${message}`,
      metadata: { phone, customer_id, ...metadata },
      created_at: new Date().toISOString(),
    }
    memory.push(entry)

    // TODO: aqui iria la logica real de Hermes (clasificar departamento,
    // llamar al LLM, generar respuesta, enviar via whatsapp-worker)
    // Por ahora solo devolvemos un ack
    res.json({
      received: true,
      memory_id: entry.id,
      todo: 'implement Hermes brain (classify dept, call LLM, send response)',
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ---- Memory endpoints (placeholder) ----
app.get('/memory', (_req, res) => {
  res.json({ entries: memory.slice(-50), total: memory.length })
})

app.delete('/memory', (_req, res) => {
  memory.length = 0
  res.json({ cleared: true })
})

// ---- Liveness probe (internal) ----
app.get('/ping', (_req, res) => res.json({ pong: true, ts: Date.now() }))

app.listen(PORT, () => {
  console.log(`[hermes-agent] listening on :${PORT}`)
  console.log(`[hermes-agent] LLM: ${LLM_PROVIDER} / ${LLM_MODEL}`)
  console.log(`[hermes-agent] memory: in-memory only (placeholder)`)
})
