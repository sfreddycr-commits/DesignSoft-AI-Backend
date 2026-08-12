// ============================================================
// Hermes Agent — Agent Loop
// ============================================================
// Flujo:
//   1. Cargar historial + knowledge del cliente
//   2. Llamar al LLM con system prompt + tools
//   3. Si LLM devuelve tool_calls -> ejecutar tools -> volver al LLM
//   4. Si LLM devuelve contenido -> enviar al cliente (vía send_message)
//   5. Log de cada paso (reasoning trace)
// ============================================================

import { callLLM, LLMMessage, LLMResponse } from '../llm/client.js'
import { tools, executeTool } from '../tools/registry.js'
import {
  saveMessage, getRecentMessages, getKnowledge, searchMemory,
  logAudit, MemoryEntry, KnowledgeEntry,
} from '../memory/db.js'
import 'dotenv/config'

const SYSTEM_PROMPT = `Eres Hermes, el Consultor Comercial y Tecnico Especialista de DesignSoft S.A., empresa costarricense con mas de 15 anos de trayectoria en software de gestion empresarial. Atendemos +15.000 clientes en 13 paises.

Tu tono es profesional, agil, empatico y experto en operaciones gastronomicas (restaurantes, sodas, bares, cafeterias y cadenas de comida rapida).

PRODUCTOS DE DESIGNSOFT (todos con factura electronica incluida):
- POS Restaurantes (desde $25/mes) — nuestro producto estrella para gastronomia
- Factura Electronica (desde $15/mes) — compatible con Hacienda CR y otros 12 paises
- TallerAlpha (desde $20/mes) — gestion de talleres mecanicos
- POS Ferreteria (desde $25/mes)
- Medicals (desde $20/mes) — consultorios medicos y dentales
- Facturar Online (desde $10/mes)
- Taller Bike / Taller Motos

CONOCIMIENTO DETALLADO DE POS RESTAURANTES:

GESTION DE SALON Y MESAS:
- Plano visual del salon en tiempo real. Mesas con estados de color: libre (verde), ocupada (rojo), por pagar (amarillo), reservada (azul).
- Cambio de mesa entre cuentas activas sin perder lo consumido.
- Cuentas divididas (50/50, por persona, por item) y cuentas separadas desde el inicio.
- Apertura de mesa con cantidad de comensales y nombre del mesero asignado.

COMANDAS Y COCINA:
- Envio instantaneo de comandas a impresoras termicas de cocina/barra (Epson, Bixolon, Star) o pantallas KDS (Kitchen Display System).
- Modificadores por platillo: termino de coccion (rojo, medio, 3/4, azul), ingredientes extra, sin ingredientes (ej: sin cebolla, sin gluten), aditivos con costo.
- Prioridad de comandas y alertas de tiempo excedido en cocina.
- Impresion de comandas por area: cocina caliente, cocina fria, barra, postres.

CONTROL DE INVENTARIOS POR RECETAS:
- Descuento automatico de insumos de bodega por cada platillo vendido (receta desglosada).
- Costeo real de ingredientes: calcula el costo exacto de cada plato basado en precios de compra.
- Alertas de stock bajo y stock minimo con notificaciones al administrador.
- Inventario por sucursal con transferencias entre bodegas.
- Soporte para inventario inicial, entradas, salidas, mermas y ajustes.

MODULOS DE VENTA:
- Salon (servicio en mesa con mesero asignado).
- Para Llevar / Takeout (pedidos telefonicos o en linea).
- Expreso / Domicilio con asignacion de repartidores.
- Delivery con seguimiento de direcciones y zonas de cobertura.

NORMATIVA TRIBUTARIA COSTA RICA:
- Factura Electronica (Hacienda/ATV) integrada nativamente con envio automatico al Ministerio de Hacienda.
- Tiquete Electronico para consumidor final.
- Desglose automatico del IVA (13%) en facturas.
- Impuesto de Servicio de Salon (10%) configurable por defecto y por tipo de servicio.
- Pagos mixtos en una misma cuenta: Efectivo, Tarjeta (Credito/Debito), SINPE Movil, Transferencia.
- Notas de credito y debito electronicas.
- Cumplimiento total con resolucion DGT-R-48-2016 y actualizaciones fiscales.

CAJAS Y REPORTES:
- Arqueos de caja ciegos (el cajero ingresa montos sin ver el esperado del sistema).
- Cierres de caja X (parcial, sin cerrar turno) y Z (cierre total, fin de turno).
- Reporte de platos mas vendidos, horas pico, rendimiento por mesero.
- Calculo de utilidad bruta y neta por dia/semana/mes.
- Comisiones de meseros configurables sobre venta neta o utilidad.
- Exportacion a Excel/PDF/CSV de todos los reportes.

OTRAS CAPACIDADES:
- App movil para Android (POS Movil Restaurante) disponible en Play Store.
- Modo OFFLINE: si se cae internet, el POS sigue funcionando y sincroniza al reconectar.
- Multi-idioma: espanol e ingles.
- Multi-sucursal con consolidacion de datos.
- Integracion con pasarelas de pago (BAC, Credomatic, PayPal).
- DEMO gratuita disponible en demo.posrestaurantes.com.

INSTRUCCIONES:
1. Responde SIEMPRE en espanol. Se amable, profesional y conciso.
2. Antes de responder, usa crm_get_customer para ver el historial del cliente.
3. Si el cliente pregunta sobre funcionalidades, da respuestas PRECISAS basadas en el conocimiento anterior. NO inventes.
4. Despues de responder, SIEMPRE debes llamar a send_message para enviar la respuesta al cliente. Si no lo haces, el sistema lo hara automaticamente.
5. Si no sabes algo, ofreces escalar a un humano: "Te voy a conectar con un asesor humano para ayudarte mejor."
6. Si detectas una oportunidad de venta, menciona el precio ($25/mes) y ofrece la DEMO gratuita en demo.posrestaurantes.com.
7. Si el cliente se pone agresivo, mantén la calma y ofrece escalar.`

export interface ProcessResult {
  reply: string | null
  reasoning: string[]
  steps: Array<{ step: string; detail: string; ts: string }>
}

export async function processMessage(
  customerPhone: string,
  userMessage: string,
  source: 'whatsapp' | 'voice' | 'web' = 'whatsapp',
): Promise<ProcessResult> {
  const phone = customerPhone.replace(/[^\d+]/g, '')
  const steps: ProcessResult['steps'] = []
  const reasoning: string[] = []

  const log = (step: string, detail: string) => {
    const entry = { step, detail, ts: new Date().toISOString() }
    steps.push(entry)
    logAudit(phone, step, detail)
    console.log(`[hermes:${step}] ${detail}`)
  }

  log('inicio', `Mensaje de ${phone} via ${source}: ${userMessage.slice(0, 200)}`)

  // 1. Cargar historial + knowledge
  const history = getRecentMessages(phone, 10)
  const knowledge = getKnowledge(phone)
  const memoryContext = knowledge.length > 0
    ? `\n\nDATOS GUARDADOS DEL CLIENTE:\n${knowledge.map(k => `- ${k.key}: ${k.value}`).join('\n')}`
    : ''

  // 2. Guardar mensaje del usuario
  saveMessage(phone, 'user', `[${source}] ${userMessage}`)

  // 3. Armar mensajes para el LLM
  const messages: LLMMessage[] = [
    ...history.map(h => ({
      role: h.role as LLMMessage['role'],
      content: h.content,
    })),
    { role: 'user' as const, content: userMessage + memoryContext },
  ]

  log('pensar', `LLM invocando con ${messages.length} mensajes, ${tools.length} tools`)

  // 4. Agent loop: max 5 iteraciones (tool calls)
  let finalReply: string | null = null
  let iteration = 0
  const MAX_ITER = 5

  while (iteration < MAX_ITER) {
    iteration++
    const response: LLMResponse = await callLLM(SYSTEM_PROMPT, messages, tools)
    reasoning.push(`Iter ${iteration}: ${response.content ?? '(no content)'} tools=${response.tool_calls.length}`)

    if (response.tool_calls.length > 0) {
      // Guardar tool calls en mensajes
      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      })

      for (const tc of response.tool_calls) {
        log('tool', `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 150)})`)
        const result = await executeTool(tc.name, tc.arguments, phone)
        log('tool_result', result.result.slice(0, 200))
        messages.push({
          role: 'tool',
          name: tc.name,
          tool_call_id: tc.id,
          content: result.result,
        })
      }
      // Continuar el loop para que el LLM responda
      continue
    }

    // Sin tool calls -> respuesta final
    finalReply = response.content
    break
  }

  // 5. Guardar respuesta del agente
  if (finalReply) {
    saveMessage(phone, 'assistant', finalReply)
    log('respuesta', finalReply.slice(0, 200))
  } else {
    log('error', 'No se obtuvo respuesta del LLM')
  }

  // 6. Fallback: si el LLM no llamó send_message, lo hacemos automáticamente
  const lastToolCalls = messages.filter(m => m.role === 'assistant' && m.tool_calls)
    .flatMap(m => m.tool_calls ?? [])
  const alreadySent = lastToolCalls.some(tc => tc?.function?.name === 'send_message')

  if (finalReply && !alreadySent) {
    log('auto_send', 'LLM no llamó send_message → enviando automáticamente')
    await executeTool('send_message', { phone, text: finalReply }, phone)
  }

  return { reply: finalReply, reasoning, steps }
}
