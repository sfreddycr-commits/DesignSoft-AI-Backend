// ============================================================
// Hermes Voice Gateway — Deepgram + ElevenLabs (Audio Server + RTP)
// ============================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import dgram from 'dgram';

const PORT = Number(process.env.PORT ?? 8080);
const RTP_PORT = Number(process.env.RTP_PORT ?? 8090);
const ARI_URL = process.env.ARI_URL ?? 'http://187.124.151.78:8088';
const ARI_USER = process.env.ARI_USER ?? 'admin';
const ARI_PASS = process.env.ARI_PASS ?? 'adminpass';
const HERMES_URL = process.env.HERMES_URL ?? 'http://dsai-hermes-agent-f31skt:5000';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB';

const AUTH = `${ARI_USER}:${ARI_PASS}`;
const ARI_HEADERS = {
  Authorization: `Basic ${Buffer.from(AUTH).toString('base64')}`,
  'Content-Type': 'application/json',
};

const AUDIO_DIR = '/tmp/audio';
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function log(msg: string) {
  console.log(`[hermes-voice] ${msg}`);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/audio', express.static(AUDIO_DIR));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hermes-voice' });
});

const httpServer = app.listen(PORT, () => {
  log(`Audio HTTP server listening on :${PORT}`);
});

async function ariPost(path: string, body?: any) {
  const r = await axios.post(`${ARI_URL}/ari${path}`, body ?? {}, { headers: ARI_HEADERS });
  return r.data;
}

// Map to store active call sessions and their associated resources
interface CallSession {
  channelId: string;
  phone: string;
  dgWs?: WebSocket;
  udpServer?: dgram.Socket;
  silenceTimeout?: NodeJS.Timeout;
  currentText: string;
  lastAudioTime: number;
}
const activeSessions = new Map<string, CallSession>();

function connectToARI() {
  const wsUrl = `${ARI_URL.replace('http', 'ws')}/ari/events?api_key=${ARI_USER}:${ARI_PASS}&app=hermes-voice`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => log('Conectado a ARI'));
  ws.on('close', () => {
    log('WS closed, reconectando...');
    setTimeout(connectToARI, 5000);
  });
  ws.on('error', (err) => log(`ARI WS Error: ${err.message}`));

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'StasisStart') {
        if (event.args && event.args[0] === 'snoop') {
          // Ignore snoop channel starts to avoid loops
          return;
        }
        await handleCallStart(event.channel.id);
      } else if (event.type === 'StasisEnd') {
        await handleCallEnd(event.channel.id);
      }
    } catch (err: any) {
      log(`Error processing event: ${err.message}`);
    }
  });
}

// Helper to write a 44-byte WAV header for 16kHz 16-bit Mono PCM
function writeWavHeader(numSamples: number, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);
  return buffer;
}

// Convert PCM raw buffer to WAV
function pcmToWav(pcmBuffer: Buffer, sampleRate = 16000): Buffer {
  const header = writeWavHeader(pcmBuffer.length / 2, sampleRate);
  return Buffer.concat([header, pcmBuffer]);
}

async function textToSpeech(text: string): Promise<string | null> {
  if (!ELEVENLABS_API_KEY) {
    log('ElevenLabs no configurado');
    return null;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=pcm_16000`;
    const resp = await axios.post(
      url,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 15000,
      }
    );

    const pcmBuffer = Buffer.from(resp.data);
    const wavBuffer = pcmToWav(pcmBuffer, 16000);
    const audioId = `tts-${Date.now()}`;
    const filename = `${audioId}.wav`;
    const filepath = path.join(AUDIO_DIR, filename);

    fs.writeFileSync(filepath, wavBuffer);
    log(`WAV generado exitosamente en ${filepath}`);
    return audioId;
  } catch (err: any) {
    log(`ElevenLabs TTS error: ${err.message}`);
    return null;
  }
}

async function handleCallStart(channelId: string) {
  const phone = channelId.replace(/\D/g, '').slice(-8) || 'unknown';
  log(`📞 Llamada contestada: ${channelId} (${phone})`);

  const session: CallSession = {
    channelId,
    phone,
    currentText: '',
    lastAudioTime: Date.now(),
  };
  activeSessions.set(channelId, session);

  try {
    await ariPost(`/channels/${channelId}/answer`);

    // 1. Generar saludo inicial en ElevenLabs
    const audioId = await textToSpeech(
      'Hola, bienvenido a DesignSoft. Soy tu consultor de P.O.S. Restaurantes. ¿En qué te puedo ayudar hoy?'
    );
    if (audioId) {
      const url = `sound:http://127.0.0.1:${PORT}/audio/${audioId}.wav`;
      log(`Reproduciendo saludo vía URL: ${url}`);
      await ariPost(`/channels/${channelId}/play`, { media: url });
    }

    // 2. Establecer canal externalMedia y WebSocket de Deepgram
    if (DEEPGRAM_API_KEY) {
      setupSpeechToText(session);
    }
  } catch (err: any) {
    log(`Error starting call handler: ${err.message}`);
  }
}

async function handleCallEnd(channelId: string) {
  log(`Llamada finalizada: ${channelId}`);
  const session = activeSessions.get(channelId);
  if (session) {
    if (session.dgWs) {
      try { session.dgWs.close(); } catch {}
    }
    if (session.udpServer) {
      try { session.udpServer.close(); } catch {}
    }
    if (session.silenceTimeout) {
      clearTimeout(session.silenceTimeout);
    }
    activeSessions.delete(channelId);
  }
}

function setupSpeechToText(session: CallSession) {
  log(`Estableciendo canal de externalMedia y Deepgram para ${session.channelId}`);

  // 1. WebSocket de Deepgram (Nova-2 para baja latencia en español)
  const dgUrl = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&language=es&model=nova-2-general&endpointing=300&interim_results=false`;
  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  session.dgWs = dgWs;

  dgWs.on('open', async () => {
    log('Conexión con Deepgram abierta');

    // 2. Iniciar externalMedia en Asterisk apuntando al puerto UDP asignado al gateway
    // Usamos slin16 (16kHz linear PCM)
    try {
      await ariPost(`/channels/externalMedia`, {
        app: 'hermes-voice',
        external_host: `127.0.0.1:${RTP_PORT}`,
        format: 'slin16',
      });
      log(`Canal de externalMedia conectado al puerto UDP ${RTP_PORT}`);
    } catch (err: any) {
      log(`Error al crear externalMedia: ${err.message}`);
    }
  });

  dgWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data.toString());
      const transcript = response.channel?.alternatives?.[0]?.transcript ?? '';
      
      if (transcript && transcript.trim()) {
        session.currentText += ' ' + transcript;
        session.lastAudioTime = Date.now();
        log(`[Interim/Transcript]: ${transcript}`);

        // Control de silencio / VAD simple:
        // Si hay una pausa de 1.5 segundos después de que el usuario habló, enviamos a Hermes
        if (session.silenceTimeout) clearTimeout(session.silenceTimeout);
        session.silenceTimeout = setTimeout(() => {
          processAgentTurn(session);
        }, 1500);
      }
    } catch (err: any) {
      log(`Error parsing Deepgram message: ${err.message}`);
    }
  });

  // 3. Servidor UDP para capturar los frames de Asterisk y enviarlos a Deepgram
  const udpServer = dgram.createSocket('udp4');
  session.udpServer = udpServer;

  udpServer.on('message', (msg) => {
    // El stream de Asterisk via externalMedia contiene RTP headers (12 bytes) si no se usa raw.
    // Asumimos formato raw slin16 enviado directamente por UDP o extraemos si hay RTP header.
    let audioPayload = msg;
    if (msg.length > 12 && msg[0] === 0x80) {
      audioPayload = msg.subarray(12); // Extraer RTP header
    }

    if (dgWs.readyState === WebSocket.OPEN && audioPayload.length > 0) {
      dgWs.send(audioPayload);
    }
  });

  udpServer.on('error', (err) => {
    log(`UDP Server Error: ${err.message}`);
  });

  udpServer.bind(RTP_PORT, '0.0.0.0', () => {
    log(`Receptor UDP escuchando en el puerto ${RTP_PORT}`);
  });
}

async function processAgentTurn(session: CallSession) {
  const text = session.currentText.trim();
  if (!text) return;
  session.currentText = ''; // Reset

  log(`[Turno Agente] Enviando a Hermes: "${text}"`);

  try {
    const r = await axios.post(
      `${HERMES_URL}/messages`,
      { phone: session.phone, message: text, source: 'voice' },
      { timeout: 20000 }
    );
    const reply = r.data?.reply;
    if (reply) {
      log(`[Turno Agente] Respuesta de Hermes: "${reply}"`);
      const audioId = await textToSpeech(reply);
      if (audioId) {
        const url = `sound:http://127.0.0.1:${PORT}/audio/${audioId}.wav`;
        log(`Reproduciendo respuesta vía URL: ${url}`);
        await ariPost(`/channels/${session.channelId}/play`, { media: url });
      }
    }
  } catch (err: any) {
    log(`Error procesando respuesta del agente: ${err.message}`);
  }
}

log('=== Hermes Voice Gateway (Deepgram + ElevenLabs) ===');
log(`ARI: ${ARI_URL}`);
log(`Hermes: ${HERMES_URL}`);
log(`Deepgram: ${DEEPGRAM_API_KEY ? '✅ configurado' : '❌ sin API key'}`);
log(`ElevenLabs: ${ELEVENLABS_API_KEY ? '✅ configurado' : '❌ sin API key'}`);

connectToARI();
