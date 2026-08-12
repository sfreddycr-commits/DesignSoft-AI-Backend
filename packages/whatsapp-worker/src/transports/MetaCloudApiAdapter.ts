// ============================================================
// DesignSoft AI — Meta Cloud API Adapter
// ============================================================
// Implementa IWhatsAppTransport usando la API oficial de Meta.
// Webhook para recibir mensajes, Graph API para enviar.
// ============================================================

import express, { type Request, type Response } from 'express'
import type { WhatsAppTransport, WhatsAppMessage, TransportStatus } from './IWhatsAppTransport'
import pino from 'pino'

export class MetaCloudApiAdapter implements WhatsAppTransport {
  private status: TransportStatus = 'disconnected'
  private messageCallbacks: Array<(msg: WhatsAppMessage) => Promise<void>> = []
  private statusCallbacks: Array<(status: TransportStatus, data?: any) => void> = []
  private app: express.Application | null = null
  private server: ReturnType<typeof express.prototype.listen> | null = null
  private logger = pino({ level: 'info' })

  constructor(
    private token: string,
    private phoneNumberId: string,
    private verifyToken: string,
    private webhookPort: number = 4500,
  ) {}

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
    const app = express()
    app.use(express.json())

    this.emitStatus('connecting')

    // Verification endpoint (Meta GET request)
    app.get('/webhook', (req: Request, res: Response) => {
      const mode = req.query['hub.mode']
      const token = req.query['hub.verify_token']
      const challenge = req.query['hub.challenge']

      if (mode === 'subscribe' && token === this.verifyToken) {
        this.logger.info('Meta webhook verified')
        res.status(200).send(challenge)
      } else {
        res.sendStatus(403)
      }
    })

    // Incoming messages + statuses (Meta POST request)
    app.post('/webhook', async (req: Request, res: Response) => {
      const body = req.body

      try {
        const entries = body?.entry ?? []
        for (const entry of entries) {
          const changes = entry?.changes ?? []
          for (const change of changes) {
            const value = change?.value ?? {}
            const messages = value?.messages ?? []
            const statuses = value?.statuses ?? []

            // Process messages
            for (const msg of messages) {
              const from = msg.from ?? value?.contacts?.[0]?.wa_id ?? ''
              const profileName = value?.contacts?.[0]?.profile?.name ?? from

              let text: string | null = null
              let msgType: WhatsAppMessage['type'] = 'other'
              let hasAudio = false

              if (msg.type === 'text') {
                text = msg.text?.body ?? ''
                msgType = 'text'
              } else if (msg.type === 'audio' || msg.type === 'voice') {
                hasAudio = true
                msgType = 'audio'
                text = '[nota de voz]'
              } else if (msg.type === 'image') {
                text = msg.image?.caption || '[imagen]'
                msgType = 'image'
              } else if (msg.type === 'video') {
                text = msg.video?.caption || '[video]'
                msgType = 'video'
              } else if (msg.type === 'document') {
                text = msg.document?.caption || '[documento]'
                msgType = 'document'
              } else {
                this.logger.info({ msgType: msg.type }, 'Unhandled message type')
                continue
              }

              if (!text) continue

              await this.emitMessage({
                from,
                phone: from,
                text,
                isGroup: false,
                raw: msg,
                type: msgType,
                hasAudio,
              })
            }

            // Process statuses (sent/delivered/read)
            for (const _status of statuses) {
              // Status callbacks can be added in future
              this.logger.debug({ status: _status.status, id: _status.id }, 'Message status update')
            }
          }
        }

        res.sendStatus(200)
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, 'Webhook processing error')
        res.sendStatus(500)
      }
    })

    return new Promise<void>((resolve) => {
      this.server = app.listen(this.webhookPort, () => {
        this.logger.info(`Meta API webhook listening on :${this.webhookPort}`)
        this.emitStatus('connected', { provider: 'meta_api' })
        resolve()
      })
    })
  }

  async sendMessage(to: string, content: string): Promise<void> {
    const url = `https://graph.facebook.com/v22.0/${this.phoneNumberId}/messages`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: content },
        }),
      })

      if (!res.ok) {
        const err = await res.text()
        this.logger.error({ status: res.status, err }, 'Meta sendMessage failed')
        throw new Error(`Meta API ${res.status}: ${err}`)
      }

      this.logger.info({ to, length: content.length }, 'Meta message sent')
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'Meta sendMessage error')
      throw err
    }
  }

  async shutdown(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = null
    }
    this.emitStatus('disconnected')
  }
}
