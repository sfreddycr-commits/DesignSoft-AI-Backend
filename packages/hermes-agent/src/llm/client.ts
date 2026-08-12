// ============================================================
// Hermes Agent — LLM Client (DeepSeek directo)
// ============================================================
import axios from 'axios'

const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'deepseek'
const LLM_MODEL = process.env.LLM_MODEL ?? 'deepseek-chat'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? 'sk-734c03a1dd4f4897b0263c4a2b9224f5'

const baseURLs: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
}
const baseURL = baseURLs[LLM_PROVIDER] ?? baseURLs.deepseek
const apiKey = LLM_PROVIDER === 'openai' ? (process.env.OPENAI_API_KEY ?? '') : DEEPSEEK_API_KEY

export interface LLMTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

export interface LLMResponse {
  content: string | null
  tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finish_reason: string
}

export async function callLLM(systemPrompt: string, messages: LLMMessage[], tools: LLMTool[] = []): Promise<LLMResponse> {
  if (!apiKey) {
    return { content: '[stub] No API key configurada.', tool_calls: [], finish_reason: 'stop' }
  }

  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0.7,
    max_tokens: 1000,
  }
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  try {
    const res = await axios.post(baseURL, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    })

    const choice = res.data?.choices?.[0]
    const msg = choice?.message ?? {}

    let tool_calls: LLMResponse['tool_calls'] = []
    if (Array.isArray(msg.tool_calls)) {
      tool_calls = msg.tool_calls.map((tc: any) => {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function?.arguments ?? '{}') } catch {}
        return { id: tc.id, name: tc.function?.name ?? '', arguments: args }
      })
    }

    return { content: msg.content ?? null, tool_calls, finish_reason: choice?.finish_reason ?? 'stop' }
  } catch (err: any) {
    const errMsg = err?.response?.data ?? err?.message
    console.error('[hermes/llm] error:', JSON.stringify(errMsg).slice(0, 300))
    return { content: null, tool_calls: [], finish_reason: 'error' }
  }
}
