/**
 * Tipos e interfaces del modulo Voice Engine.
 */

export interface VoiceEngine {
  readonly provider: string;
  readonly sttProvider?: string;
  readonly language?: string;
  transcribe(audio: Buffer): Promise<string>;
  /**
   * Recibe texto y devuelve un media URI que ARI/Asterisk puede
   * reproducir (p.ej. `sound:greeting`, `sound:tt-monkeys`,
   * `http://...`, `file:/path/to/file.wav`).
   */
  synthesize(text: string): Promise<string>;
}

export interface VoiceEngineConfig {
  sttProvider?: 'stub' | 'openai' | 'vosk';
  ttsProvider?: 'stub' | 'elevenlabs' | 'google' | 'azure' | 'piper' | 'coqui';
  /** API key de OpenAI (alternativa a la variable de entorno OPENAI_API_KEY). */
  openaiApiKey?: string;
  language?: string;
  sampleRate?: number;
  /**
   * Media URI que devuelve synthesize() cuando el proveedor es 'stub'.
   * Por defecto: `sound:greeting` (el archivo greeting.wav que monta
   * docker-compose en /var/lib/asterisk/sounds).
   */
  defaultStubUri?: string;
}
