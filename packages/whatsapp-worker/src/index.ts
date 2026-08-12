// ============================================================
// DesignSoft AI — WhatsApp Worker
// ============================================================
// Cliente Baileys que:
//  1. Mantiene sesión activa (credenciales persistidas)
//  2. Escucha mensajes entrantes
//  3. Crea/actualiza contacto en CRM
//  4. Envía texto al ai-agent
//  5. Responde al usuario en WhatsApp
//  6. Mensajes de audio → voice-engine para transcripción
//
// Seguridad: el QR NO se expone por HTTP. Solo se emite vía
// WebSocket autenticado al Dashboard.
// ============================================================

import 'dotenv/config'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import pino from 'pino'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import fs from 'fs'

// ---- Config ----
const PORT = Number(process.env.PORT ?? 4500)
const WS_PORT = Number(process.env.WS_PORT ?? 4501)
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
const SESSION_DIR = process.env.SESSION_DIR ?? '/data/whatsapp-session'
const AI_AGENT_URL = process.env.AI_AGENT_URL ?? 'http://ai-agent:4300'
const CRM_URL = process.env.CRM_URL ?? 'http://crm:4400'
const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL ?? 'http://voice-engine:3000'
const AGENT_DEPARTMENT = process.env.AGENT_DEPARTMENT ?? 'soporte'
// Token compartido entre Dashboard y Worker. El Dashboard lo envía
// en la query string del WebSocket: ws://host:port/?token=XXXX
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
let currentQR: string | null = null
let currentSocket: WASocket | null = null
let sessionConnected = false
const wsClients = new Set<WebSocket>()

function broadcast(msg: Record<string, unknown>) {
  const payload = JSON.stringify(msg)
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
  logger.debug({ clients: wsClients.size }, 'Broadcast sent')
}

// ---- Express app (solo health, SIN QR público) ----
const app = express()
app.get('/health', (_req, res) => {
  res.json({
    status: sessionConnected ? 'connected' : 'disconnected',
    service: 'whatsapp-worker',
    qr_available: !!currentQR,
    ws_clients: wsClients.size,
  })
})

// ---- WebSocket server (autenticado, emite QR) ----
const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' })

wss.on('connection', (ws, req) => {
  // Autenticación via query string: ?token=XXXX
  const reqUrl = req.url ?? '/'
  const url = new URL(reqUrl, `http://${req.headers.host ?? 'localhost'}`)
  const token = url.searchParams.get('token')

  if (token !== WS_AUTH_TOKEN) {
    logger.warn({ ip: req.socket.remoteAddress }, 'WS auth rejected')
    ws.close(4001, 'Unauthorized')
    return
  }

  // CORS: aceptar el origen del Dashboard
  const allowedOrigins = [
    'https://omnichannel.wiazart.com',
    'https://wiazart.com',
    'http://localhost:5173', // dev
    'http://localhost:3000',
  ]
  const origin = req.headers.origin
  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn({ origin }, 'WS origin rejected')
    ws.close(4003, 'Origin not allowed')
    return
  }

  wsClients.add(ws)
  logger.info(
    { ip: req.socket.remoteAddress, total: wsClients.size },
    'WS client authenticated',
  )

  // Enviar estado actual al conectarse
  ws.send(
    JSON.stringify({
      type: 'status',
      connected: sessionConnected,
      qr_available: !!currentQR,
    }),
  )

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      await handleWsMessage(ws, msg)
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'WS message error')
      ws.send(JSON.stringify({ type: 'error', error: (err as Error).message }))
    }
  })

  ws.on('close', () => {
    wsClients.delete(ws)
    logger.info({ total: wsClients.size }, 'WS client disconnected')
  })

  ws.on('error', (err) => {
    logger.error({ err: err.message }, 'WS error')
  })
})

async function handleWsMessage(ws: WebSocket, msg: any): Promise<void> {
  logger.info({ type: msg?.type }, 'WS message received')

  switch (msg?.type) {
    case 'get_qr': {
      // Si ya está conectado, no hay QR
      if (sessionConnected) {
        ws.send(JSON.stringify({ type: 'status', connected: true, qr_available: false }))
        return
      }
      // Devolver QR actual (puede ser null si no se ha generado aún)
      ws.send({
        type: 'qr',
        data: currentQR,
        generated: !!currentQR,
      } as any)
      break
    }

    case 'get_status': {
      ws.send(JSON.stringify({
        type: 'status',
        connected: sessionConnected,
        qr_available: !!currentQR,
      }))
      break
    }

    case 'logout': {
      logger.info('Logout requested via WS')
      if (currentSocket) {
        try {
          await currentSocket.logout()
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'Logout failed')
        }
      }
      break
    }

    case 'restart': {
      logger.info('Restart requested via WS')
      if (currentSocket) {
        try {
          await (currentSocket as any).end({})
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'End failed')
        }
      }
      // Re-arrancar después de un delay
      setTimeout(() => startWhatsAppClient(), 2000)
      break
    }

    default:
      ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg?.type}` }))
  }
}

// ---- Cliente WhatsApp ----
async function startWhatsAppClient() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }) as any,
    generateHighQualityLinkPreview: true,
    getMessage: async () => undefined as any,
  })

  currentSocket = sock

  // ── Manejo de conexión / QR ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      currentQR = qr
      logger.info('📱 QR code generated (broadcasting to WS clients)')
      // EMITIR QR a todos los dashboards conectados
      broadcast({ type: 'qr', data: qr, generated: true })
    }

    if (connection === 'open') {
      sessionConnected = true
      currentQR = null
      logger.info('✅ WhatsApp Session Authenticated')
      broadcast({ type: 'status', connected: true, qr_available: false })
    }

    if (connection === 'close') {
      sessionConnected = false
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      logger.warn({ reason, shouldReconnect }, '⚠️  Connection closed')
      broadcast({ type: 'status', connected: false, qr_available: !!currentQR })
      if (shouldReconnect) {
        logger.info('Reconnecting in 5s...')
        setTimeout(() => startWhatsAppClient(), 5000)
      } else {
        logger.error('Logged out. Delete session dir and scan QR again.')
        broadcast({ type: 'status', connected: false, qr_available: true, logged_out: true })
      }
    }
  })

  // ── Persistir credenciales ──
  sock.ev.on('creds.update', saveCreds)

  // ── Mensajes entrantes ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message) continue
      if (msg.key?.fromMe) continue

      await handleIncomingMessage(sock, msg).catch((err) => {
        logger.error({ err }, 'Error handling message')
      })
    }
  })
}

// ---- Manejo de mensaje individual ----
async function handleIncomingMessage(
  sock: WASocket,
  msg: proto.IWebMessageInfo
): Promise<void> {
  const from = msg.key?.remoteJid ?? ''
  const isGroup = from.endsWith('@g.us')
  const phone = from.replace(/@s\.whatsapp\.net|@c\.us|@g\.us/g, '')

  logger.info({ from }, '📩 Message received')

  // Notificar al dashboard que hay una nueva conversación
  broadcast({ type: 'message', direction: 'in', from, phone })

  // 1) Crear/actualizar contacto en CRM
  const customer = await upsertCustomer(phone, isGroup)

  // 2) Extraer texto (o transcribir audio)
  let text: string | null = null
  const message = msg.message
  if (!message) return
  const audio = (message as any).audioMessage

  if ((message as any).conversation) {
    text = (message as any).conversation
  } else if ((message as any).extendedTextMessage?.text) {
    text = (message as any).extendedTextMessage.text
  } else if (audio) {
    text = await transcribeAudio(sock, msg, audio)
  } else if ((message as any).imageMessage?.caption) {
    text = (message as any).imageMessage.caption || '[imagen]'
  } else if ((message as any).documentMessage?.caption) {
    text = (message as any).documentMessage.caption || '[documento]'
  } else if ((message as any).videoMessage?.caption) {
    text = (message as any).videoMessage.caption || '[video]'
  }

  if (!text) return

  // 3) Enviar al ai-agent
  const agentReply = await processWithAgent(text, customer.id, phone)
  if (!agentReply) return

  // 4) Responder al usuario en WhatsApp
  await sock.sendMessage(from, { text: agentReply })

  // 5) Notificar al dashboard
  broadcast({
    type: 'message',
    direction: 'out',
    from,
    reply: agentReply,
    text,
  })
}

// ---- CRM: upsert customer ----
async function upsertCustomer(phone: string, isGroup: boolean) {
  try {
    const name = isGroup ? `Grupo ${phone}` : phone
    const res = await axios.post(
      `${CRM_URL}/api/customers`,
      { phone, name, notes: isGroup ? 'WhatsApp group' : 'WhatsApp contact' },
      { timeout: 10000 },
    )
    return res.data
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'CRM: failed to upsert customer')
    return { id: `tmp-${phone}`, phone, name: phone }
  }
}

// ---- Voice engine: transcribir audio ----
async function transcribeAudio(
  sock: WASocket,
  msg: proto.IWebMessageInfo,
  audio: any,
): Promise<string | null> {
  try {
    const downloadFn = (sock as any).downloadMediaMessage
    if (!downloadFn) {
      return '[nota de voz — descargador no disponible]'
    }
    const stream = await downloadFn.call(sock, { message: msg.message })
    const buffer = await stream.toBuffer()
    logger.info({ size: buffer.length, mimetype: audio?.mimetype }, '🎙️ Audio received')

    const FormData = (await import('form-data')).default
    const form = new FormData()
    form.append('audio', buffer, {
      filename: 'audio.ogg',
      contentType: audio?.mimetype ?? 'audio/ogg',
    })

    const res = await axios.post(`${VOICE_ENGINE_URL}/api/stt`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    })
    return res.data?.text ? `[nota de voz transcrita] ${res.data.text}` : null
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Voice engine: failed to transcribe')
    return '[nota de voz — no pude transcribir]'
  }
}

// ---- AI agent: procesar mensaje ----
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
        context: { source: 'whatsapp', phone },
      },
      { timeout: 30000 },
    )
    return res.data?.reply ?? null
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'AI agent: failed to process')
    return null
  }
}

// ---- Init ----
async function main() {
  // HTTP server (solo health, SIN QR público)
  app.listen(PORT, () => {
    logger.info(`WhatsApp Worker HTTP on :${PORT}`)
    logger.info('  GET  /health  — status (no QR exposed)')
  })

  // WebSocket server (autenticado, para el Dashboard)
  wss.on('listening', () => {
    logger.info(`WhatsApp Worker WebSocket on :${WS_PORT}`)
    logger.info('  WS   /?token=XXX  — authenticated QR + status stream')
  })

  await startWhatsAppClient()
  logger.info('WhatsApp Worker initialized')
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start WhatsApp Worker')
  process.exit(1)
})
