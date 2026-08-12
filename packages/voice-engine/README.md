# Voice Engine

Modulo del AI Call Center responsable de la conversion de voz ↔ texto.

## Que hace

- **STT (Speech-to-Text)** — convierte la voz del caller en texto para que el agente IA la procese.
- **TTS (Text-to-Speech)** — convierte la respuesta del agente IA en audio para enviarla al caller.
- **Puente de audio** — recibe RTP desde Asterisk y devuelve audio generado por el TTS.

## Estado

Estructura inicial. Sin logica implementada todavia.

Lo que falta:

- [ ] Definir proveedor(es) de STT/TTS (decision pendiente).
- [ ] Implementar `transcribe()` y `synthesize()`.
- [ ] Puente de audio entre Asterisk y el motor de voz.
- [ ] Manejo de streaming y baja latencia.
- [ ] Interfaz HTTP/WebSocket para integracion con el agente IA.

## Estructura

```
voice-engine/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── README.md
```

## Como se usa (planeado)

```ts
import { createVoiceEngine } from "@ai-callcenter/voice-engine";

const engine = createVoiceEngine({
  sttProvider: "whisper",
  ttsProvider: "elevenlabs",
  language: "es-CR",
});

const text = await engine.transcribe(audioBuffer);
const reply = await engine.synthesize("Hola, en que puedo ayudarle?");
```

(Solo ilustrativo. La implementacion real llega en pasos siguientes.)
