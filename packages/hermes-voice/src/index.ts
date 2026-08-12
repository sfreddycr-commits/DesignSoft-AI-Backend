// ============================================================
// Hermes Voice Gateway — Deepgram + ElevenLabs (REST mode)
// ============================================================
// Flujo: llamada → grabar audio → Deepgram REST → Hermes → ElevenLabs → reproducir
// ============================================================

import 'dotenv/config'
import axios from 'axios'
import WebSocket from 'ws'
import fs from 'fs'
import FormData from 'form-data'

const ARI_URL = process.env.ARI_URL ?? 'http://187.124.151.78:8088'
const ARI_USER = process.env.ARI_USER ?? 'admin'
const ARI_PASS = process.env.ARI_PASS ?? 'adminpass'
const HERMES_URL = process.env.HERMES_URL ?? 'http://dsai-hermes-agent-f31skt:5000'
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? ''
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB'
const SOUNDS_DIR = process.env.SOUNDS_DIR ?? '/var/lib/asterisk/sounds/custom'

const AUTH = `${ARI_USER}:${ARI_PASS}`
const ARI_HEADERS = { Authorization: `Basic ${Buffer.from(AUTH).toString('base64')}`, 'Content-Type': 'application/json' }

function log(msg: string) { console.log(`[hermes-voice] ${msg}`) }

async function ariGet(path: string) {
  const r = await axios.get(`${ARI_URL}/ari${path}`, { headers: ARI_HEADERS })
  return r.data
}

async function ariPost(path: string, body?: any) {
  const r = await axios.post(`${ARI_URL}/ari${path}`, body ?? {}, { headers: ARI_HEADERS })
  return r.data
}

async function ariGetBuffer(path: string) {
  const r = await axios.get(`${ARI_URL}/ari${path}`, { headers: ARI_HEADERS, responseType: 'arraybuffer' })
  return Buffer.from(r.data)
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Fallback TTS: genera un tono + reproduce el texto como "digits" si es corto
async function fallbackTTS(channelId: string, text: string) {
  log(`TTS fallback: "${text.slice(0, 80)}"`)
  // Reproducir un beep para marcar la respuesta
  try { await ariPost(`/channels/${channelId}/play`, { media: 'tone:beep' }) } catch {}
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  log('=== Hermes Voice Gateway ===')
  log(`Deepgram: ${DEEPGRAM_API_KEY ? '✅' : '❌ sin key'}`)
  log(`ElevenLabs: ${ELEVENLABS_API_KEY ? '✅' : '❌ sin key'}`)

  if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true })

  connectToARI()
}

function connectToARI() {
  const wsUrl = `${ARI_URL.replace('http', 'ws')}/ari/events?api_key=${ARI_USER}:${ARI_PASS}&app=hermes-voice`
  const ws = new WebSocket(wsUrl)

  ws.on('open', () => log('Conectado a ARI'))
  ws.on('close', () => { log('WS closed, reconectando...'); setTimeout(connectToARI, 5000) })
  ws.on('error', () => {})

  ws.on('message', async (raw) => {
    const event = JSON.parse(raw.toString())
    if (event.type === 'StasisStart') await handleCall(event.channel.id)
    if (event.type === 'StasisEnd') log(`Llamada finalizada: ${event.channel.id}`)
  })
}

async function handleCall(channelId: string) {
  const phone = channelId.replace(/\D/g, '').slice(-8) || 'unknown'
  log(`📞 Llamada: ${channelId}`)

  try {
    await ariPost(`/channels/${channelId}/answer`)
    log('Contestado')

    // Greeting con sound:greeting (16KB WAV que SÍ existe)
    try { await ariPost(`/channels/${channelId}/play`, { media: 'sound:greeting' }) } catch (e: any) { log(`Greeting error: ${e.message}`) }
    await sleep(500)

    // Generar saludo personalizado con ElevenLabs (voces naturales)
    if (ELEVENLABS_API_KEY) {
      try {
        const text = 'Hola, soy Hermes, el asistente virtual de DesignSoft. ¿En qué puedo ayudarte hoy?'
        const r = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
          text, model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }, {
          headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer', timeout: 15000,
        })
        const fname = `greeting-${Date.now()}.mp3`
        const fpath = `${SOUNDS_DIR}/${fname}`
        fs.writeFileSync(fpath, Buffer.from(r.data))
        const sname = `custom/${path.basename(fpath).replace('.mp3','')}`
        log(`TTS greeting: ${sname}`)
        await ariPost(`/channels/${channelId}/play`, { media: `sound:${sname}` }).catch((e: any) => log(`TTS play: ${e.message}`))
      } catch (e: any) { log(`TTS error: ${e.message}`) }
    }
    await sleep(1000)

    // Ciclo de 5 turnos
    for (let turn = 0; turn < 5; turn++) {
      // Grabar audio del caller
      const recName = `hrec-${Date.now()}`
      try {
        await ariPost(`/channels/${channelId}/record`, {
          name: recName, format: 'wav', maxDurationSeconds: 12, maxSilenceSeconds: 4, beep: false,
        })
        await sleep(9000)
        try { await ariPost(`/recordings/live/${recName}/stop`) } catch {}
      } catch (err: any) { log(`Record error: ${err.message}`); break }

      // Descargar audio
      let audioBuffer: Buffer | null = null
      try { audioBuffer = await ariGetBuffer(`/recordings/stored/${recName}/file`) } catch {}
      if (!audioBuffer || audioBuffer.length < 1000) { log('Audio muy corto, colgando'); break }

      // Deepgram STT
      let transcript = ''
      if (DEEPGRAM_API_KEY) {
        try {
          const form = new FormData()
          form.append('audio', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' })
          const r = await axios.post(`https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true`, audioBuffer, {
            headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
            timeout: 15000,
          })
          transcript = r.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
        } catch (err: any) { log(`Deepgram error: ${err.message}`) }
      } else {
        transcript = '[Deepgram no configurado]'
      }
      if (!transcript || transcript.trim().length < 2) { log('Sin transcripción'); break }
      log(`🗣️ "${transcript}"`)

      // Hermes Agent
      let reply = ''
      try {
        const r = await axios.post(`${HERMES_URL}/messages`, { phone, message: transcript, source: 'voice' }, { timeout: 20000 })
        reply = r.data?.reply ?? ''
      } catch (err: any) { log(`Hermes error: ${err.message}`); break }
      if (!reply) break
      log(`🧠 "${reply.slice(0, 120)}..."`)

      // ElevenLabs TTS (o fallback)
      if (ELEVENLABS_API_KEY && ELEVENLABS_API_KEY.startsWith('sk_')) {
        try {
          const r = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
            text: reply, model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }, {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer', timeout: 15000,
          })
          const wavFile = `${SOUNDS_DIR}/tts-${Date.now()}.mp3`
          fs.writeFileSync(wavFile, Buffer.from(r.data))
          const soundName = `custom/${path.basename(wavFile).replace('.mp3', '')}`
          log(`TTS ElevenLabs: ${soundName}`)
          await ariPost(`/channels/${channelId}/play`, { media: `sound:${soundName}` })
        } catch (err: any) { log(`ElevenLabs error: ${err.message}`) }
      } else {
        // Fallback: generar WAV con espeak o beep
        await fallbackTTS(channelId, reply)
      }
    }
  } catch (err: any) { log(`Error: ${err.message}`) }
}

import path from 'path'
main().catch(err => { console.error('[hermes-voice] fatal:', err); process.exit(1) })
