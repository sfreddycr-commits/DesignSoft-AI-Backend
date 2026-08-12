# AI Agent

Modulo del AI Call Center responsable de la logica conversacional del agente.

## Que hace

- Recibe texto del STT (voz del caller convertida a texto).
- Procesa la conversacion con un LLM (modelo de lenguaje).
- Ejecuta herramientas (tools) segun sea necesario: consultar el CRM, transferir a un humano, etc.
- Genera la respuesta en texto para que el TTS la sintetice.
- Mantiene la memoria de la conversacion (corto y largo plazo).

## Estado

Estructura inicial. Sin logica implementada todavia.

Lo que falta:

- [ ] Elegir proveedor(es) de LLM (OpenAI, Anthropic, local, etc.).
- [ ] Implementar el cliente del LLM.
- [ ] Definir el prompt del sistema del agente.
- [ ] Implementar el manejo de la conversacion (memoria, contexto).
- [ ] Integrar con el modulo CRM.
- [ ] Implementar herramientas (transferir a humano, agendar cita, etc.).
- [ ] Manejo de errores y timeouts.

## Estructura

```
ai-agent/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── README.md
```

## Como se usa (planeado)

```ts
import { createAgent } from "@ai-callcenter/ai-agent";

const agent = createAgent({
  provider: "openai",
  model: "gpt-4o",
  systemPrompt: "Eres un agente de atencion al cliente de Costa Rica...",
  tools: ["crm.lookup", "human.transfer"],
});

const reply = await agent.chat(
  "Hola, quiero saber el estado de mi cuenta",
  {
    sessionId: "call-1234",
    callerNumber: "+50688881234",
    history: [],
  }
);
```

(Solo ilustrativo. La implementacion real llega en pasos siguientes.)
