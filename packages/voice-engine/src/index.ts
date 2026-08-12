/**
 * Voice Engine - AI Call Center
 *
 * Modulo encargado del procesamiento de audio entre la llamada SIP
 * (Asterisk) y el agente IA.
 *
 * Estado: implementacion inicial.
 *   - TTS stub que devuelve un media URI (p.ej. `sound:greeting`).
 *   - STT con soporte para OpenAI Whisper API (si OPENAI_API_KEY esta
 *     definida) y fallback a stub en caso contrario.
 *
 * Proveedores reales adicionales (VOSK, ElevenLabs, Google TTS, etc.)
 * llegan en pasos siguientes.
 */

import { Buffer } from 'node:buffer'
import type { VoiceEngine, VoiceEngineConfig } from './types.ts'

export type { VoiceEngine, VoiceEngineConfig } from './types.ts'

export function createVoiceEngine(config: VoiceEngineConfig = {}): VoiceEngine {
  const provider = config.ttsProvider ?? 'stub'
  const defaultStubUri = config.defaultStubUri ?? 'sound:greeting'
  const language = config.language ?? 'es-CR'
  const sttProvider = config.sttProvider ?? 'stub'
  const openaiApiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY

  if (provider !== 'stub') {
    console.warn(
      `[voice-engine] provider "${provider}" todavia no implementado. ` +
        `Se usara el comportamiento stub.`,
    )
  }
  if (sttProvider === 'openai' && !openaiApiKey) {
    console.warn(
      '[voice-engine] STT provider "openai" solicitado pero OPENAI_API_KEY no definida. ' +
        'Se usara el stub STT.',
    )
  }

  return {
    provider,
    language,
    sttProvider,

    async transcribe(audio: Buffer): Promise<string> {
      console.log(
        `[voice-engine] transcribe() sttProvider=${sttProvider} size=${audio.length} bytes`,
      )

      if (audio.length === 0) {
        // Caso real: el caller todavia no ha hablado o no hay captura
        console.log('[voice-engine] transcribe() buffer vacio, placeholder')
        return '(silencio)'
      }

      if (sttProvider === 'openai' && openaiApiKey) {
        return await transcribeWithOpenAI(audio, openaiApiKey, language)
      }

      // Stub: devuelve un placeholder visible
      return '(transcripcion stub - el caller dijo algo)'
    },

    async synthesize(text: string): Promise<string> {
      console.log(`[voice-engine] synthesize() provider=${provider} text=${JSON.stringify(text)}`)
      return defaultStubUri
    },
  }
}

async function transcribeWithOpenAI(
  audio: Buffer,
  apiKey: string,
  language: string,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-1')
  if (language) {
    // Whisper acepta codigo ISO-639-1 (e.g. 'es'); recortamos la region
    form.append('language', language.split('-')[0])
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI Whisper API error: ${response.status} ${text}`)
  }

  const data = (await response.json()) as { text?: string }
  return data.text ?? ''
}
