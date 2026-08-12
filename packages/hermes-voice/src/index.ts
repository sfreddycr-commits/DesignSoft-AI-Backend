// ============================================================
// Hermes Voice Gateway — Asterisk ARI + Hermes Agent
// ============================================================
// Conecta a Asterisk via ARI, registra Stasis(hermes-voice),
// y canaliza llamadas de voz hacia Hermes Agent.
// ============================================================

import 'dotenv/config'
import axios from 'axios'
import WebSocket from 'ws'

const ARI_URL = process.env.ARI_URL ?? 'http://187.124.151.78:8088'
const ARI_USER = process.env.ARI_USER ?? 'admin'
const ARI_PASS = process.env.ARI_PASS ?? 'dsai_ari_pass_2026'
const HERMES_URL = process.env.HERMES_URL ?? 'http://hermes-agent:5000'
const STT_TTS_URL = process.env.STT_TTS_URL ?? 'http://voice-engine:3000'

const AUTH = Buffer.from(`${ARI_USER}:${ARI_PASS}`).toString('base64')
const AUTH_HEADER = { Authorization: `Basic ${AUTH}` }

function log(msg: string) { console.log(`[hermes-voice] ${msg}`) }

async function ariGet(path: string) {
  const r = await axios.get(`${ARI_URL}/ari${path}`, { headers: AUTH_HEADER })
  return r.data
}

async function ariPost(path: string, body?: any) {
  const r = await axios.post(`${ARI_URL}/ari${path}`, body ?? {}, { headers: AUTH_HEADER })
  return r.data
}

async function main() {
  log('Starting Hermes Voice Gateway')
  log(`ARI: ${ARI_URL}`)
  log(`Hermes: ${HERMES_URL}`)

  // 1. Conectar a ARI via WebSocket para eventos Stasis
  const wsUrl = `${ARI_URL.replace('http', 'ws')}/ari/events?api_key=${ARI_USER}:${ARI_PASS}&app=hermes-voice`
  const ws = new WebSocket(wsUrl)

  ws.on('open', () => log('Connected to ARI WebSocket'))

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString())
      if (event.type === 'StasisStart') {
        await handleCall(event.channel.id)
      } else if (event.type === 'StasisEnd') {
        log(`Call ended: ${event.channel.id}`)
      }
    } catch (err: any) {
      console.error('[hermes-voice] event error:', err.message)
    }
  })

  ws.on('error', (err) => log(`WS error: ${err.message}`))
  ws.on('close', () => {
    log('WS closed, reconnecting in 5s...')
    setTimeout(main, 5000)
  })

  log('Voice Gateway ready. Waiting for calls on Stasis(hermes-voice)...')
}

async function handleCall(channelId: string) {
  log(`Call received: ${channelId}`)
  const phone = channelId.replace(/\D/g, '').slice(-8) || 'unknown'

  try {
    // 1. Contestar
    await ariPost(`/channels/${channelId}/answer`)
    log('Answered channel')

    // 2. Reproducir greeting
    try {
      await ariPost(`/channels/${channelId}/play`, { media: 'sound:beep' })
    } catch {
      // sound might not exist, continue
    }

    // 3. Ciclo de conversación (max 5 turnos)
    for (let turn = 0; turn < 5; turn++) {
      // Grabar audio del caller (3 segundos de silencio máximo)
      const recordingName = `hermes-${channelId}-${turn}`
      try {
        await ariPost(`/channels/${channelId}/record`, {
          name: recordingName,
          format: 'wav',
          maxDurationSeconds: 5,
          maxSilenceSeconds: 2,
          beep: true,
        })
        // Esperar a que termine la grabación
        await sleep(6000)
        await ariPost(`/recordings/live/${recordingName}/stop`)
      } catch {
        // recording might have ended on silence
      }

      // Transcribir audio
      let transcript = ''
      try {
        const audioUrl = `${ARI_URL}/ari/recordings/stored/${recordingName}/file`
        const resp = await axios.post(`${STT_TTS_URL}/api/transcribe`, {
          audio_url: audioUrl,
          auth: AUTH,
        }, { timeout: 15000 })
        transcript = resp.data?.text ?? ''
      } catch {
        transcript = ''
      }

      if (!transcript || transcript.trim().length < 2) {
        log('No speech detected, ending call')
        break
      }
      log(`Transcript: "${transcript}"`)

      // Enviar a Hermes Agent
      let agentReply = ''
      try {
        const resp = await axios.post(`${HERMES_URL}/messages`, {
          phone,
          message: transcript,
          source: 'voice',
        }, { timeout: 15000 })
        agentReply = resp.data?.reply ?? ''
      } catch {
        agentReply = 'Lo siento, no pude procesar tu mensaje.'
      }

      if (!agentReply) break
      log(`Agent reply: "${agentReply.slice(0, 100)}..."`)

      // Convertir texto a voz y reproducir
      try {
        const ttsResp = await axios.post(`${STT_TTS_URL}/api/tts`, {
          text: agentReply,
        }, { timeout: 15000 })

        if (ttsResp.data?.audio_url) {
          await ariPost(`/channels/${channelId}/play`, { media: ttsResp.data.audio_url })
        }
      } catch {
        log('TTS failed, cannot play response')
        break
      }
    }
  } catch (err: any) {
    log(`Error in call: ${err.message}`)
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

main().catch(err => {
  console.error('[hermes-voice] fatal:', err)
  process.exit(1)
})
