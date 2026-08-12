// ============================================================
// DesignSoft AI — WhatsApp Worker (Transport-Agnostic)
// ============================================================
// Soporta Baileys (QR) y Meta Cloud API (Webhook) vía
// Strategy Pattern. Cambia con WHATSAPP_PROVIDER en .env
// ============================================================

import 'dotenv/config'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import pino from 'pino'
import axios from 'axios'
import type { WhatsAppTransport, TransportStatus } from './transports/IWhatsAppTransport.js'
import { createWhatsAppTransport } from './transports/WhatsAppFactory.js'

// ---- Config ----
const PORT = Number(process.env.PORT ?? 4500)
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
const PROVIDER = (process.env.WHATSAPP_PROVIDER ?? 'baileys') as 'baileys' | 'meta_api'
const SESSION_DIR = process.env.SESSION_DIR ?? '/data/whatsapp-session'
const META_TOKEN = process.env.META_TOKEN ?? ''
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID ?? ''
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN ?? 'designsoft_webhook_2026'
const AI_AGENT_URL = process.env.AI_AGENT_URL ?? 'http://ai-agent:4300'
const CRM_URL = process.env.CRM_URL ?? 'http://crm:4400'
const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL ?? 'http://voice-engine:3000'
const AGENT_DEPARTMENT = process.env.AGENT_DEPARTMENT ?? 'soporte'
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN ?? 'change-me-in-prod'

// ---- Logger ----
const logger = pino({
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
  },
})

// ---- Estado ----
let transportStatus: TransportStatus = 'disconnected'
let currentQR: string | null = null
const wsClients = new Set<WebSocket>()

function broadcast(msg: Record<string, unknown>) {
  const payload = JSON.stringify(msg)
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
}

// ---- Express + WebSocket (mismo puerto) ----
const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({
    status: transportStatus,
    service: 'whatsapp-worker',
    provider: PROVIDER,
    qr_available: !!currentQR,
    ws_clients: wsClients.size,
  })
})

const httpServer = app.listen(PORT, () => {
  logger.info({ provider: PROVIDER }, `WhatsApp Worker on :${PORT}`)
})

const wss = new WebSocketServer({ server: httpServer, path: '/' })

wss.on('connection', (ws, req) => {
  const reqUrl = req.url ?? '/'
  const url = new URL(reqUrl, `http://${req.headers.host ?? 'localhost'}`)
  const token = url.searchParams.get('token')

  if (token !== WS_AUTH_TOKEN) {
    logger.warn({ ip: req.socket.remoteAddress }, 'WS auth rejected')
    ws.close(4001, 'Unauthorized')
    return
  }

  const allowedOrigins = [
    'https://omnichannel.wiazart.com',
    'https://wiazart.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ]
  const origin = req.headers.origin
  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn({ origin }, 'WS origin rejected')
    ws.close(4003, 'Origin not allowed')
    return
  }

  wsClients.add(ws)
  logger.info({ total: wsClients.size }, 'WS client authenticated')

  // Enviar estado actual
  ws.send(JSON.stringify({
    type: 'status',
    connected: transportStatus === 'connected',
    qr_available: !!currentQR,
    provider: PROVIDER,
  }))

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      switch (msg?.type) {
        case 'get_qr':
          ws.send(typeof msg !== 'string' ? JSON.stringify({
            type: 'qr',
            data: currentQR,
            generated: !!currentQR,
          }) : msg)
          break
        case 'get_status':
          ws.send(JSON.stringify({
            type: 'status',
            connected: transportStatus === 'connected',
            qr_available: !!currentQR,
            provider: PROVIDER,
          }))
          break
        default:
          break
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'WS message error')
    }
  })

  ws.on('close', () => {
    wsClients.delete(ws)
    logger.info({ total: wsClients.size }, 'WS client disconnected')
  })
})

// ---- CRM ----
async function upsertCustomer(phone: string, isGroup: boolean) {
  try {
    const name = isGroup ? `Grupo ${phone}` : phone
    const res = await axios.post(
      `${CRM_URL}/api/customers`,
      { phone, name, notes: isGroup ? 'WhatsApp group' : 'WhatsApp contact' },
      { timeout: 10000 },
    )
    return res.data
  } catch {
    return { id: `tmp-${phone}`, phone, name: phone }
  }
}

// ---- AI Agent ----
async function processWithAgent(
  text: string,
  customerId: string,
  phone: string,
): Promise<string | null> {
  try {
    const res = await axios.post(
      `${AI_AGENT_URL}/api/chat`,
      {
        department: AGENT_DEPARTMENT,
        messages: [{ role: 'user', content: text }],
        customerId,
        context: { source: 'whatsapp', phone, provider: PROVIDER },
      },
      { timeout: 30000 },
    )
    return res.data?.reply ?? null
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'AI agent failed')
    return null
  }
}

// ---- Voice Engine (audio transcription) ----
async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string | null> {
  try {
    const FormData = (await import('form-data')).default
    const form = new FormData()
    form.append('audio', buffer, { filename: 'audio.ogg', contentType: mimetype })
    const res = await axios.post(`${VOICE_ENGINE_URL}/api/stt`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    })
    return res.data?.text ?? null
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Voice engine failed')
    return null
  }
}

// ---- Pipeline: procesar mensaje entrante ----
async function handleMessage(transport: WhatsAppTransport, msg: any) {
  const { phone, text, isGroup, hasAudio, raw } = msg

  logger.info({ phone }, '📩 Message received')

  const customer = await upsertCustomer(phone, isGroup)

  let finalText = text

  if (hasAudio && raw) {
    // En Baileys se puede descargar el audio
    const downloadFn = (raw as any)?.downloadMediaMessage
    if (downloadFn) {
      try {
        const stream = await downloadFn.call(raw, { message: raw.message })
        const buffer = await stream.toBuffer()
        const transcript = await transcribeAudio(buffer, 'audio/ogg')
        if (transcript) finalText = `[nota de voz transcrita] ${transcript}`
      } catch {}
    }
  }

  const agentReply = await processWithAgent(finalText, customer.id, phone)
  if (!agentReply) return

  await transport.sendMessage(phone, agentReply)

  broadcast({
    type: 'message',
    direction: 'out',
    phone,
    reply: agentReply,
  })
}

// ---- Init ----
async function main() {
  logger.info({ provider: PROVIDER }, 'Creating WhatsApp transport')

  const transport: WhatsAppTransport = createWhatsAppTransport({
    provider: PROVIDER,
    sessionDir: SESSION_DIR,
    metaToken: META_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    verifyToken: WEBHOOK_VERIFY_TOKEN,
    webhookPort: PORT,
  })

  // Registrar callbacks
  transport.onMessage(async (msg) => {
    await handleMessage(transport, msg).catch((err) =>
      logger.error({ err }, 'Handle message error'),
    )
  })

  transport.onStatusChange((status, data) => {
    transportStatus = status
    logger.info({ status, data }, 'Transport status changed')

    if (status === 'qr_pending' && data?.qr) {
      currentQR = data.qr
      broadcast({ type: 'qr', data: data.qr, generated: true })
    }

    if (status === 'connected') {
      currentQR = null
      broadcast({ type: 'status', connected: true, qr_available: false, provider: PROVIDER })
    }

    if (status === 'disconnected' || status === 'error') {
      currentQR = null
      broadcast({ type: 'status', connected: false, qr_available: false, error: data?.message })
    }
  })

  await transport.initialize()
  logger.info({ provider: PROVIDER }, 'WhatsApp Worker initialized')
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start WhatsApp Worker')
  process.exit(1)
})
