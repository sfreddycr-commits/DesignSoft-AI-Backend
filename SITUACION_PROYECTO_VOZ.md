# Situación del Proyecto

## Objetivo
Implementar un sistema de atención al cliente por voz con IA para una empresa de software (llamémosle "la Empresa"). El cliente llama por teléfono (SIP/VoIP), la IA entiende su pregunta y responde con voz natural.

## Stack Actual

- **VPS propio** con IP pública fija (no compartida)
- **Docker** como base
- **Dokploy** como panel de gestión de contenedores (similar a Portainer)
- **Asterisk PBX** dentro de un contenedor: maneja extensiones SIP 1001 y 1002 con credenciales PJSIP estándar
- **OpenCode** como IDE/CLI de desarrollo (equivalente a Cursor)
- **GitHub** con dos repos:
  - `DesignSoft-AI-Backend` (microservicios Node.js, deploy vía Dokploy)
  - `Omnichannel-AI-Core` (dashboard React, deploy vía Dokploy)

## Componentes Funcionales (verificados)
- ✅ **Dashboard web** con el módulo "Canales" (QR linking) accesible vía HTTPS
- ✅ **WhatsApp worker** con código QR funcional, agent loop, memoria, herramientas (CRM, send_message)
- ✅ **Hermes Agent** con LLM DeepSeek-chat, base de conocimiento de POS Restaurantes, agent loop, memoria SQLite
- ✅ **Deepgram API** (STT) configurada y verificada
- ✅ **ElevenLabs API** (TTS) configurada y verificada
- ✅ **Asterisk** recibe llamadas en extensión 2000, Stasis(hermes-voice) configurado

## Componente Problemático
**Voice Gateway** (paquete `hermes-voice` en el repo backend): es el que conecta Asterisk con Hermes Agent para llamadas de voz.

## Problema Específico

Cuando un usuario llama a la extensión 2000 desde Zoiper:
1. ✅ Asterisk recibe la llamada correctamente
2. ✅ Redirige a Stasis(hermes-voice)
3. ✅ El Voice Gateway se conecta a ARI correctamente
4. ✅ El Voice Gateway CONTESTA la llamada
5. ❌ El usuario NO escucha el saludo de audio (TTS no se reproduce)
6. ❌ El Voice Gateway genera el TTS pero no se envía a Asterisk correctamente

## Logs del Error

```
[hermes-voice] 📞 Llamada: 1786531875.3
[hermes-voice] Contestado
[hermes-voice] TTS greeting: custom/greeting-1786531876955
[hermes-voice] Sin transcripción
[hermes-voice] Llamada finalizada: 1786531875.3
```

El TTS se genera correctamente pero el archivo MP3 se guarda en un directorio del contenedor del gateway que NO está compartido con Asterisk. Por eso el usuario no escucha nada.

## Lo que Necesito

Una solución para:
1. **Reproducir audio TTS de vuelta al usuario que llamó** (flujo bidireccional de audio)
2. **Capturar el audio del usuario** y enviarlo a un servicio de STT
3. Todo esto en tiempo real con latencia < 1 segundo
4. Funcionando sobre mi stack actual (Docker + Dokploy + Asterisk + Node.js)

## Constraints

- El gateway está en un contenedor Docker en la red del VPS
- Asterisk está en otro contenedor (host network)
- Necesito comunicación audio bidireccional entre ellos
- No quiero cambiar de stack ni re-deploy Asterisk

## Mi Idea

Usar ARI (Asterisk REST Interface) WebSocket para capturar audio vía canales snoop, y servir el audio TTS vía un endpoint HTTP que Asterisk pueda descargar y reproducir.

Pero he encontrado varios bloqueos:
- Permissions del directorio de recordings en Asterisk
- 401 en la reconexión del WebSocket
- MP3 vs WAV: ElevenLabs devuelve MP3 pero Asterisk necesita WAV
- Bind mounts no funcionan entre servicios de swarm

## Pregunta para el Experto

¿Cómo integrarías un voice gateway (STT + TTS) en mi stack actual (Docker + Dokploy + Asterisk) para que las llamadas de Zoiper puedan tener una conversación natural con un agente IA, sin re-deployar Asterisk y usando el menor número de servicios externos posibles?

Toda preferencia o workaround es bienvenida. También acepto opciones pagas si son necesarias.
