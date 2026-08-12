// ============================================================
// DesignSoft AI — Baileys Adapter (QR-based WhatsApp)
// ============================================================
// Implementa IWhatsAppTransport usando Baileys (WhatsApp Web).
// Autenticación vía QR, persistencia de sesión en disco.
// ============================================================

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import type { WhatsAppTransport, WhatsAppMessage, TransportStatus } from './IWhatsAppTransport.js'

export class BaileysAdapter implements WhatsAppTransport {
  private sock: WASocket | null = null
  private status: TransportStatus = 'disconnected'
  private qrData: string | null = null
  private messageCallbacks: Array<(msg: WhatsAppMessage) => Promise<void>> = []
  private statusCallbacks: Array<(status: TransportStatus, data?: any) => void> = []
  private sessionDir: string
  private logger: pino.Logger

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir
    this.logger = pino({ level: 'warn' })
  }

  getStatus(): TransportStatus {
    return this.status
  }

  onMessage(callback: (msg: WhatsAppMessage) => Promise<void>): void {
    this.messageCallbacks.push(callback)
  }

  onStatusChange(callback: (status: TransportStatus, data?: any) => void): void {
    this.statusCallbacks.push(callback)
  }

  private emitStatus(status: TransportStatus, data?: any) {
    this.status = status
    for (const cb of this.statusCallbacks) {
      cb(status, data)
    }
  }

  private async emitMessage(msg: WhatsAppMessage) {
    for (const cb of this.messageCallbacks) {
      await cb(msg).catch((err) => this.logger.error({ err }, 'Message callback error'))
    }
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true })
    }

    this.emitStatus('connecting')

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: this.logger as any,
      generateHighQualityLinkPreview: true,
      getMessage: async () => undefined as any,
    })

    this.sock = sock

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.qrData = qr
        this.emitStatus('qr_pending', { qr })
      }

      if (connection === 'open') {
        this.qrData = null
        this.emitStatus('connected')
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
        if (reason === DisconnectReason.loggedOut) {
          this.emitStatus('error', { message: 'Logged out. Delete session and rescan.', loggedOut: true })
          return
        }
        this.emitStatus('disconnected')
        // Reconnect
        setTimeout(() => this.initialize(), 5000)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        if (!msg.message) continue
        if (msg.key?.fromMe) continue

        const from = msg.key?.remoteJid ?? ''
        const isGroup = from.endsWith('@g.us')
        const phone = from.replace(/@s\.whatsapp\.net|@c\.us|@g\.us/g, '')

        const message = msg.message
        let text: string | null = null
        let msgType: WhatsAppMessage['type'] = 'other'
        let hasAudio = false

        if ((message as any).conversation) {
          text = (message as any).conversation
          msgType = 'text'
        } else if ((message as any).extendedTextMessage?.text) {
          text = (message as any).extendedTextMessage.text
          msgType = 'text'
        } else if ((message as any).audioMessage) {
          hasAudio = true
          msgType = 'audio'
          text = '[nota de voz]'
        } else if ((message as any).imageMessage) {
          msgType = 'image'
          text = (message as any).imageMessage?.caption || '[imagen]'
        } else if ((message as any).videoMessage) {
          msgType = 'video'
          text = (message as any).videoMessage?.caption || '[video]'
        } else if ((message as any).documentMessage) {
          msgType = 'document'
          text = (message as any).documentMessage?.caption || '[documento]'
        }

        if (!text) continue

        await this.emitMessage({
          from,
          phone,
          text,
          isGroup,
          raw: msg,
          type: msgType,
          hasAudio,
        })
      }
    })
  }

  async sendMessage(to: string, content: string): Promise<void> {
    if (!this.sock) throw new Error('Baileys not connected')
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    await this.sock.sendMessage(jid, { text: content })
  }

  async shutdown(): Promise<void> {
    if (this.sock) {
      await (this.sock as any).end?.({})
      this.sock = null
    }
    this.emitStatus('disconnected')
  }
}
