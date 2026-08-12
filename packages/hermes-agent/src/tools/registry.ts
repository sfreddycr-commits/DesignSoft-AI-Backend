// ============================================================
// Hermes Agent — Tools
// ============================================================
// Herramientas que Hermes puede invocar durante el agent loop:
//   - crm_get_customer:  buscar cliente por telefono
//   - crm_update_profile: guardar preferencia / nota
//   - send_message:       enviar respuesta al cliente
//   - calendar_check:     placeholder para futuro
// ============================================================

import axios from 'axios'
import { LLMTool } from '../llm/client.js'
import { saveKnowledge, getKnowledge, logAudit } from '../memory/db.js'
import 'dotenv/config'

const CRM_URL = process.env.CRM_URL ?? 'http://crm:4400'
const WHATSAPP_WORKER_URL = process.env.WHATSAPP_WORKER_URL ?? 'http://whatsapp-worker:4500'

export const tools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'crm_get_customer',
      description: 'Busca un cliente en el CRM por su numero de telefono. Devuelve nombre, email, company, notas, y conversaciones previas.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Numero de telefono del cliente (con o sin prefijo +)' },
        },
        required: ['phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crm_update_profile',
      description: 'Guarda una preferencia, dato o nota sobre el cliente para futuras conversaciones. Ej: "prefiere email", "su nombre es Juan".',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Numero de telefono del cliente' },
          key: { type: 'string', description: 'Nombre del dato (ej: "nombre", "email", "preferencia_contacto", "vehiculo")' },
          value: { type: 'string', description: 'Valor a guardar' },
        },
        required: ['phone', 'key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Envia una respuesta al cliente via WhatsApp o el canal de voz. Usa esto cuando estes listo para responder al usuario.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Numero de telefono destino' },
          text: { type: 'string', description: 'Contenido del mensaje a enviar' },
          channel: { type: 'string', enum: ['whatsapp', 'voice'], description: 'Canal por donde enviar (default whatsapp)' },
        },
        required: ['phone', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_check',
      description: '(FUTURO) Consulta la disponibilidad en la agenda. Por ahora devuelve un placeholder.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
]

// --- Implementaciones ---

export async function executeTool(
  name: string,
  args: Record<string, any>,
  customerPhone: string,
): Promise<{ ok: boolean; result: string }> {
  logAudit(customerPhone, 'tool_call', `${name}(${JSON.stringify(args).slice(0, 200)})`)
  try {
    switch (name) {
      case 'crm_get_customer': {
        const phone = normalizePhone(String(args.phone ?? customerPhone))
        try {
          const r = await axios.get(`${CRM_URL}/api/customers`, {
            params: { phone },
            timeout: 10000,
          })
          const data = r.data
          return { ok: true, result: JSON.stringify({
            id: data?.id,
            name: data?.name,
            email: data?.email,
            company: data?.company,
            notes: data?.notes,
            conversations_count: data?.conversations?.length ?? 0,
          }) }
        } catch (err: any) {
          // fallback: usar memoria local
          const knowledge = getKnowledge(phone)
          return {
            ok: true,
            result: JSON.stringify({
              source: 'local_memory',
              phone,
              knowledge: knowledge.map(k => `${k.key}=${k.value}`).join('; ') || 'sin datos',
            }),
          }
        }
      }

      case 'crm_update_profile': {
        const phone = normalizePhone(String(args.phone ?? customerPhone))
        const key = String(args.key).slice(0, 100)
        const value = String(args.value).slice(0, 500)
        try {
          await axios.put(`${CRM_URL}/api/customers/${phone}/profile`, {
            key, value,
          }, { timeout: 10000 })
        } catch {
          // fallback: guardar en memoria local
        }
        saveKnowledge(phone, key, value, 'agent')
        return { ok: true, result: `Guardado: ${key}=${value} para ${phone}` }
      }

      case 'send_message': {
        const phone = normalizePhone(String(args.phone ?? customerPhone))
        const text = String(args.text).slice(0, 4000)
        const channel = String(args.channel ?? 'whatsapp')
        try {
          if (channel === 'whatsapp') {
            // Enviamos al worker por HTTP
            const r = await axios.post(`${WHATSAPP_WORKER_URL}/api/send`, {
              phone, text,
            }, { timeout: 10000 })
            return { ok: true, result: `Enviado a ${phone}: ${r.data?.status ?? 'ok'}` }
          }
          // voice: placeholder
          return { ok: true, result: `[voice] Mensaje encolado a ${phone}` }
        } catch (err: any) {
          return { ok: false, result: `Error enviando: ${err?.message}` }
        }
      }

      case 'calendar_check': {
        return { ok: true, result: 'Calendar no disponible todavia (placeholder).' }
      }

      default:
        return { ok: false, result: `Tool desconocida: ${name}` }
    }
  } catch (err: any) {
    return { ok: false, result: `Error: ${err?.message ?? String(err)}` }
  }
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '').replace(/^\+?/, '+') || phone
}
