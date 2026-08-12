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
// ============================================================

import 'dotenv/config'
import express from 'express'
import pino from 'pino'
import qrcode from 'qrcode'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

// ---- Config ----
const PORT = Number(process.env.PORT ?? 4500)
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
const SESSION_DIR = process.env.SESSION_DIR ?? '/data/whatsapp-session'
const AI_AGENT_URL = process.env.AI_AGENT_URL ?? 'http://ai-agent:4300'
const CRM_URL = process.env.CRM_URL ?? 'http://crm:4400'
const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL ?? 'http://voice-engine:3000'
const AGENT_DEPARTMENT = process.env.AGENT_DEPARTMENT ?? 'soporte'

// ---- Logger ----
const logger = pino({
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
  },
})

// ---- Express app (QR + health) ----
const app = express()
let currentQR: string | null = null
let currentSocket: WASocket | null = null
let sessionConnected = false

app.get('/health', (_req, res) => {
  res.json({
    status: sessionConnected ? 'connected' : 'disconnected',
    service: 'whatsapp-worker',
    qr_available: !!currentQR,
  })
})

app.get('/qr', async (_req, res) => {
  if (!currentQR) {
    return res.status(404).json({ error: 'No QR pending. Already authenticated.' })
  }
  try {
    const png = await qrcode.toBuffer(currentQR, { width: 400, margin: 2 })
    res.type('png').send(png)
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR' })
  }
})

app.get('/qr-text', (_req, res) => {
  if (!currentQR) {
    return res.status(404).json({ error: 'No QR pending' })
  }
  res.json({ qr: currentQR })
})

// ---- Cliente WhatsApp ----
async function startWhatsAppClient() {
  // Asegurar que el directorio de sesión existe
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
      logger.info('📱 QR code generated. Scan at: GET /qr (image) or GET /qr-text')
    }

    if (connection === 'open') {
      sessionConnected = true
      currentQR = null
      logger.info('✅ WhatsApp Session Authenticated')
    }

    if (connection === 'close') {
      sessionConnected = false
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      logger.warn({ reason, shouldReconnect }, '⚠️  Connection closed')
      if (shouldReconnect) {
        logger.info('Reconnecting in 5s...')
        setTimeout(() => startWhatsAppClient(), 5000)
      } else {
        logger.error('Logged out. Delete session dir and scan QR again.')
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
      if (msg.key.fromMe) continue

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
  const from = msg.key.remoteJid ?? ''
  const isGroup = from.endsWith('@g.us')
  const phone = from.replace(/@s\.whatsapp\.net|@c\.us|@g\.us/g, '')

  logger.info({ from, type: msg.messageType }, '📩 Message received')

  // 1) Crear/actualizar contacto en CRM
  const customer = await upsertCustomer(phone, isGroup)

  // 2) Extraer texto (o transcribir audio)
  let text: string | null = null
  const audio = msg.message.audioMessage

  if (msg.message.conversation) {
    text = msg.message.conversation
  } else if (msg.message.extendedTextMessage?.text) {
    text = msg.message.extendedTextMessage.text
  } else if (audio) {
    // Audio → voice-engine
    text = await transcribeAudio(sock, msg, audio)
  } else if (msg.message.imageMessage?.caption) {
    text = msg.message.imageMessage.caption || '[imagen]'
  } else if (msg.message.documentMessage?.caption) {
    text = msg.message.documentMessage.caption || '[documento]'
  } else if (msg.message.videoMessage?.caption) {
    text = msg.message.videoMessage.caption || '[video]'
  }

  if (!text) {
    logger.info({ from }, 'Non-text message without caption, ignored')
    return
  }

  // 3) Enviar al ai-agent
  const agentReply = await processWithAgent(text, customer.id, phone)

  if (!agentReply) {
    logger.warn('Agent returned no reply')
    return
  }

  // 4) Responder al usuario en WhatsApp
  await sock.sendMessage(from, { text: agentReply })
  logger.info({ to: from, length: agentReply.length }, '✅ Reply sent')
}

// ---- CRM: upsert customer ----
async function upsertCustomer(phone: string, isGroup: boolean) {
  try {
    const name = isGroup ? `Grupo ${phone}` : phone
    const res = await axios.post(
      `${CRM_URL}/api/customers`,
      { phone, name, notes: isGroup ? 'WhatsApp group' : 'WhatsApp contact' },
      { timeout: 10000 }
    )
    logger.info({ phone, customerId: res.data?.id }, 'CRM: customer upserted')
    return res.data
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'CRM: failed to upsert customer')
    // Fallback: return minimal object so flow continues
    return { id: `tmp-${phone}`, phone, name: phone }
  }
}

// ---- Voice engine: transcribir audio ----
async function transcribeAudio(
  sock: WASocket,
  msg: proto.IWebMessageInfo,
  audio: proto.IAudioMessage
): Promise<string | null> {
  try {
    // Descargar el audio
    const stream = await sock.downloadMediaMessage({ message: msg.message! } as any)
    const buffer = await stream.toBuffer()
    logger.info({ size: buffer.length, mimetype: audio.mimetype }, '🎙️ Audio received')

    // Subir a voice-engine
    const FormData = (await import('form-data')).default
    const form = new FormData()
    form.append('audio', buffer, { filename: 'audio.ogg', contentType: audio.mimetype ?? 'audio/ogg' })

    const res = await axios.post(`${VOICE_ENGINE_URL}/api/stt`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    })

    const text = res.data?.text ?? null
    logger.info({ text }, '🎙️ Audio transcribed')
    return text ? `[nota de voz transcrita] ${text}` : null
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Voice engine: failed to transcribe')
    return '[nota de voz — no pude transcribir]'
  }
}

// ---- AI agent: procesar mensaje ----
async function processWithAgent(
  text: string,
  customerId: string,
  phone: string
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
      { timeout: 30000 }
    )
    return res.data?.reply ?? null
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'AI agent: failed to process')
    return null
  }
}

// ---- Init ----
async function main() {
  app.listen(PORT, () => {
    logger.info(`WhatsApp Worker API on :${PORT}`)
    logger.info(`  GET  /health     — status`)
    logger.info(`  GET  /qr         — QR code as PNG`)
    logger.info(`  GET  /qr-text    — QR code as text`)
  })

  await startWhatsAppClient()
  logger.info('WhatsApp Worker initialized')
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start WhatsApp Worker')
  process.exit(1)
})
