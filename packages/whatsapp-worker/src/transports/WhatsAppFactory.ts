// ============================================================
// DesignSoft AI — WhatsApp Transport Factory
// ============================================================
// Instancia el adaptador correcto según WHATSAPP_PROVIDER.
// ============================================================

import type { WhatsAppTransport } from './IWhatsAppTransport'
import { BaileysAdapter } from './BaileysAdapter'
import { MetaCloudApiAdapter } from './MetaCloudApiAdapter'

export type WhatsAppProvider = 'baileys' | 'meta_api'

export interface WhatsAppFactoryConfig {
  provider: WhatsAppProvider
  /** Baileys: directorio de sesión */
  sessionDir?: string
  /** Meta API: token de acceso permanente */
  metaToken?: string
  /** Meta API: Phone Number ID */
  phoneNumberId?: string
  /** Meta API: token de verificación del webhook */
  verifyToken?: string
  /** Puerto del webhook (Meta API) */
  webhookPort?: number
}

/**
 * Crea el adaptador de WhatsApp según la variable WHATSAPP_PROVIDER.
 */
export function createWhatsAppTransport(config: WhatsAppFactoryConfig): WhatsAppTransport {
  switch (config.provider) {
    case 'baileys':
      return new BaileysAdapter(config.sessionDir ?? '/data/whatsapp-session')

    case 'meta_api':
      if (!config.metaToken || !config.phoneNumberId) {
        throw new Error(
          'Meta API requires META_TOKEN and PHONE_NUMBER_ID env vars'
        )
      }
      return new MetaCloudApiAdapter(
        config.metaToken,
        config.phoneNumberId,
        config.verifyToken ?? 'designsoft_webhook_2026',
        config.webhookPort ?? 4500,
      )

    default:
      throw new Error(`Unknown WhatsApp provider: ${config.provider}`)
  }
}
