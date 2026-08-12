/**
 * Tipos e interfaces del modulo AI Agent.
 */

export interface Agent {
  readonly name: string;
  readonly model?: string;
  chat(message: string, context: ConversationContext): Promise<string>;
  resetConversation(sessionId: string): Promise<void>;
}

export interface ConversationContext {
  sessionId: string;
  callerNumber?: string;
  history: ConversationTurn[];
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

export interface AgentConfig {
  provider?: 'stub' | 'openai';
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  temperature?: number;
  maxTokens?: number;
  /** API key de OpenAI (alternativa a la variable de entorno OPENAI_API_KEY). */
  openaiApiKey?: string;
  /**
   * Cuando es true, no se hace la primera llamada al provider: el
   * greeting fijo se devuelve igual. Si fuera false, el greeting
   * tambien se generaria con el LLM. Por defecto true.
   */
  staticGreeting?: boolean;
  /**
   * (Solo stub) Si esta definido, el segundo turno del agente devuelve
   * unicamente `[TRANSFER:<target>]`, indicando intencion de transferir.
   * Util para pruebas de integracion con el call-manager.
   */
  forceTransferTo?: string;
}
