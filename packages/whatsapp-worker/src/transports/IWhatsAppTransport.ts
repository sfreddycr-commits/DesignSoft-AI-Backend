// ============================================================
// DesignSoft AI — WhatsApp Transport Interface
// ============================================================
// Strategy Pattern para WhatsApp (Baileys | Meta Cloud API).
// Ambos adaptadores implementan esta interfaz.
// ============================================================

export interface WhatsAppMessage {
  from: string        // número o JID del remitente
  phone: string       // número normalizado
  text: string        // texto del mensaje
  isGroup: boolean    // true si viene de un grupo
  raw: any            // objeto original del proveedor
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'other'
  hasAudio: boolean   // true si es nota de voz
}

export type TransportStatus = 'disconnected' | 'qr_pending' | 'connecting' | 'connected' | 'error'

export interface WhatsAppTransport {
  /** Inicializa la conexión. En Baileys abre el socket, en Meta levanta webhook. */
  initialize(): Promise<void>

  /** Envía un mensaje de texto al número especificado. */
  sendMessage(to: string, content: string): Promise<void>

  /** Registra un callback que se ejecuta cuando llega un mensaje entrante. */
  onMessage(callback: (msg: WhatsAppMessage) => Promise<void>): void

  /** Registra un callback para cambios de estado (QR, conexión, error). */
  onStatusChange(callback: (status: TransportStatus, data?: any) => void): void

  /** Obtiene el estado actual del transporte. */
  getStatus(): TransportStatus

  /** Cierra la conexión limpiamente. */
  shutdown(): Promise<void>
}
