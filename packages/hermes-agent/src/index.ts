// ============================================================
// Hermes Agent — API HTTP
// ============================================================
// Endpoints:
//   GET  /health              -> status, LLM config, DB path
//   GET  /ping                -> liveness probe
//   POST /messages            -> mensaje de cliente, devuelve respuesta
//   GET  /memory/:phone       -> historial + conocimiento del cliente
//   POST /tools/:name         -> ejecución directa de tool (testing)
//   GET  /audit               -> log de razonamiento reciente
// ============================================================

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { processMessage } from './agent/loop.js'
import {
  getRecentMessages, getKnowledge, searchMemory, getAuditLog, logAudit,
  closeMemory,
} from './memory/db.js'
import { tools, executeTool } from './tools/registry.js'

const PORT = Number(process.env.PORT ?? 5000)
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'openrouter'
const LLM_MODEL = process.env.LLM_MODEL ?? 'deepseek/deepseek-v4-pro'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ---- Health ----
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'hermes-agent',
    version: '1.0.0',
    llm: { provider: LLM_PROVIDER, model: LLM_MODEL, configured: !!(OPENAI_API_KEY || OPENROUTER_API_KEY) },
    db: process.env.HERMES_DB_URL ?? '/data/memory/hermes.db',
    tools: tools.length,
    uptime: process.uptime(),
  })
})

app.get('/ping', (_req, res) => res.json({ pong: true, ts: Date.now() }))

// ---- Main endpoint: process incoming message ----
app.post('/messages', async (req, res) => {
  try {
    const { phone, message, source, customer_id } = req.body as {
      phone: string; message: string; source?: 'whatsapp' | 'voice' | 'web'; customer_id?: string
    }
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message required' })
    }

    logAudit(phone, 'incoming', `[${source ?? 'unknown'}] ${message.slice(0, 200)}`)

    const result = await processMessage(phone, message, source)

    res.json({
      received: true,
      phone,
      reply: result.reply,
      reasoning: result.reasoning,
      steps: result.steps,
    })
  } catch (err: any) {
    console.error('[hermes/messages] error:', err)
    res.status(500).json({ error: err?.message ?? 'internal error' })
  }
})

// ---- Memory endpoints ----
app.get('/memory/:phone', (req, res) => {
  const phone = req.params.phone
  const history = getRecentMessages(phone, 50)
  const knowledge = getKnowledge(phone)
  res.json({ phone, history, knowledge })
})

app.get('/memory/:phone/search', (req, res) => {
  const phone = req.params.phone
  const q = String(req.query.q ?? '')
  if (!q) return res.status(400).json({ error: 'q query param required' })
  const result = searchMemory(phone, q)
  res.json(result)
})

// ---- Tools (direct execution for testing) ----
app.get('/tools', (_req, res) => {
  res.json({ tools: tools.map(t => ({ name: t.function.name, description: t.function.description })) })
})

app.post('/tools/:name', async (req, res) => {
  try {
    const name = req.params.name
    const args = req.body ?? {}
    const phone = String(args.phone ?? 'unknown')
    const result = await executeTool(name, args, phone)
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err?.message })
  }
})

// ---- Audit log (reasoning trace) ----
app.get('/audit', (req, res) => {
  const limit = Number(req.query.limit ?? 100)
  const phone = req.query.phone as string | undefined
  let log = getAuditLog(limit)
  if (phone) log = log.filter(e => e.customer_phone === phone)
  res.json({ entries: log })
})

// ---- Graceful shutdown ----
process.on('SIGTERM', () => {
  console.log('[hermes] SIGTERM, closing...')
  closeMemory()
  process.exit(0)
})

app.listen(PORT, () => {
  console.log(`[hermes-agent] listening on :${PORT}`)
  console.log(`[hermes-agent] LLM: ${LLM_PROVIDER} / ${LLM_MODEL}`)
  console.log(`[hermes-agent] Tools: ${tools.length}`)
})
