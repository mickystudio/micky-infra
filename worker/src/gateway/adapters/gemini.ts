/**
 * Micky Assistant Unlimited - Gemini Provider Adapter (Agent A4).
 *
 * Translates OpenAI-shaped Chat Completions ↔ Google Gemini native format.
 * Key quirks (see README_gemini.md): system prompt → `system_instruction`;
 * roles `user`/`model` only (assistant→model); content is `parts:[{text}]`;
 * tool calling uses `functionDeclarations` / `functionCall` / `functionResponse`;
 * streaming uses SSE `alt=sse`; auth via `x-goog-api-key`; no reliable rate-limit
 * headers on free tier → gateway must count internally; 429 RESOURCE_EXHAUSTED
 * is mapped to `GeminiRateLimitError`.
 * Edge-compatible (no Node-only APIs).
 */

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  DeltaChunk,
  ProviderAdapter,
  RateLimitInfo,
} from './types';

// ============ Gemini-native request body shape ============

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  system_instruction?: { parts: Array<{ text: string }> };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

// ============ Type guards / coercion helpers (no `any`) ============

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function safeParseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Map Gemini finishReason → OpenAI finish_reason. */
function mapFinishReason(raw: string | undefined): string {
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

const genId = (): string => Math.random().toString(36).slice(2, 10);

/** Extract concatenated text from a Gemini candidate's parts. */
function extractText(candidate: Record<string, unknown>): string {
  const content = candidate.content;
  if (!isObject(content)) return '';
  return asArray(content.parts)
    .map((p) => (isObject(p) ? asString(p.text) : undefined))
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

/** Extract functionCall parts from a Gemini candidate (model role). */
function extractFunctionCalls(
  candidate: Record<string, unknown>,
): Array<{ name: string; args: Record<string, unknown> }> {
  const content = candidate.content;
  if (!isObject(content)) return [];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const p of asArray(content.parts)) {
    if (!isObject(p)) continue;
    const fc = p.functionCall;
    if (!isObject(fc)) continue;
    const name = asString(fc.name);
    if (name) out.push({ name, args: isObject(fc.args) ? fc.args : {} });
  }
  return out;
}

// ============ Errors ============

/** Raised on 429 RESOURCE_EXHAUSTED — gateway circuit-breaker keys off this type. */
export class GeminiRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfter: number | null;
  constructor(message: string, retryAfter: number | null) {
    super(message);
    this.name = 'GeminiRateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** Raised on any non-2xx Gemini response that is not a 429. */
export class GeminiApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
  }
}

// ============ Adapter ============

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODELS_PATH = '/models';
const SUPPORTED_MODELS: readonly string[] = [
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
] as const;

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = 'gemini';

  getBaseUrl(): string {
    return GEMINI_BASE_URL;
  }

  getChatCompletionsPath(): string {
    // Gemini uses a per-model path, not a fixed /chat/completions. The gateway
    // SHOULD prefer `buildChatUrl(model)` / `buildStreamUrl(model)` below; this
    // method exists only to satisfy the ProviderAdapter contract for adapters
    // that share a single endpoint.
    return GEMINI_MODELS_PATH;
  }

  getSupportedModels(): readonly string[] {
    return SUPPORTED_MODELS;
  }

  getHeaders(apiKey: string): HeadersInit {
    // x-goog-api-key avoids leaking the key in server logs / referer the way ?key= would.
    return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  }

  /** Non-stream URL: /models/{model}:generateContent */
  buildChatUrl(model: string): string {
    return `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
  }

  /** Stream URL: /models/{model}:streamGenerateContent?alt=sse */
  buildStreamUrl(model: string): string {
    return `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }

  /**
   * Convert an OpenAI-shaped ChatRequest into Gemini's native body.
   *
   * - `system` messages → accumulated into `system_instruction` (NOT in contents).
   * - `assistant` → `model`; `user` → `user`; `tool` → user role with `functionResponse` part.
   * - `tool_calls` on assistant messages → `functionCall` parts.
   * - `tools[]` → `tools: [{ functionDeclarations: [...] }]`.
   * - `max_tokens` → `maxOutputTokens`; `stop` → `stopSequences`.
   */
  formatRequest(req: ChatRequest): Record<string, unknown> {
    const contents: GeminiContent[] = [];
    let systemText = '';

    for (const msg of req.messages) {
      const contentStr = typeof msg.content === 'string' ? msg.content : '';

      if (msg.role === 'system') {
        systemText += (systemText ? '\n\n' : '') + contentStr;
        continue;
      }

      if (msg.role === 'tool') {
        const name = msg.name || msg.tool_call_id || 'tool';
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: safeParseJson(contentStr) } }],
        });
        continue;
      }

      const geminiRole: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];
      if (contentStr.length > 0) parts.push({ text: contentStr });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: { name: tc.function.name, args: safeParseJson(tc.function.arguments) },
          });
        }
      }
      // For the model role, always preserve the turn (even with empty text) so
      // conversation order is maintained for tool-call round-trips. OpenAI
      // clients sometimes send a stub assistant message with empty content +
      // tool_call_id but no tool_calls array between the user request and the
      // tool result; Gemini requires an explicit model turn there.
      if (parts.length > 0 || geminiRole === 'model') {
        contents.push({ role: geminiRole, parts });
      }
    }

    const body: GeminiRequestBody = { contents };
    if (systemText.length > 0) body.system_instruction = { parts: [{ text: systemText }] };

    if (Array.isArray(req.tools) && req.tools.length > 0) {
      body.tools = [{
        functionDeclarations: req.tools.map((t) => {
          const tt = t as { function: { name: string; description?: string; parameters?: Record<string, unknown> } };
          return {
            name: tt.function.name,
            description: tt.function.description,
            parameters: tt.function.parameters,
          };
        }),
      }];
    }

    const genConfig: GeminiRequestBody['generationConfig'] = {};
    if (req.temperature != null) genConfig.temperature = req.temperature;
    if (req.max_tokens != null) genConfig.maxOutputTokens = req.max_tokens;
    if (req.top_p != null) genConfig.topP = req.top_p;
    if (typeof req.stop === 'string') genConfig.stopSequences = [req.stop];
    else if (Array.isArray(req.stop) && req.stop.length > 0) genConfig.stopSequences = req.stop;
    if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

    return body as unknown as Record<string, unknown>;
  }

  /** Parse a Gemini generateContent response into the OpenAI chat.completion shape. */
  parseResponse(raw: unknown): ChatResponse {
    const obj = isObject(raw) ? raw : {};
    const candidates = asArray(obj.candidates);
    const first = candidates.length > 0 && isObject(candidates[0]) ? candidates[0] : null;

    const text = first ? extractText(first) : '';
    const fnCalls = first ? extractFunctionCalls(first) : [];
    const finishReason = first ? mapFinishReason(asString(first.finishReason)) : 'stop';

    const usageMeta = isObject(obj.usageMetadata) ? obj.usageMetadata : {};
    const promptTokens = asNumber(usageMeta.promptTokenCount) ?? 0;
    const completionTokens = asNumber(usageMeta.candidatesTokenCount) ?? 0;
    const totalTokens = asNumber(usageMeta.totalTokenCount) ?? promptTokens + completionTokens;

    const message: ChatResponse['choices'][0]['message'] = { role: 'assistant', content: text };
    if (fnCalls.length > 0) {
      message.tool_calls = fnCalls.map((fc, i) => ({
        id: `call_${genId()}_${i}`,
        type: 'function' as const,
        function: { name: fc.name, arguments: JSON.stringify(fc.args) },
      }));
    }

    return {
      id: `chatcmpl-${genId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: asString(obj.modelVersion) || 'gemini',
      choices: [
        {
          index: 0,
          message,
          finish_reason: fnCalls.length > 0 ? 'tool_calls' : finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  }

  /**
   * Parse a single SSE chunk from `:streamGenerateContent?alt=sse` into a
   * `DeltaChunk`, or `null` for empty / `[DONE]` / non-JSON lines.
   *
   * The transport layer should split the SSE stream on `\n\n` and pass each
   * `data: {json}` line here.
   */
  parseStreamChunk(chunk: string): DeltaChunk | null {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === 'data: [DONE]' || trimmed === '[DONE]') return null;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload.startsWith('{')) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;

    const candidates = asArray(parsed.candidates);
    if (candidates.length === 0) return null; // usageMetadata-only final chunk
    const first = isObject(candidates[0]) ? candidates[0] : null;
    if (!first) return null;

    const text = extractText(first);
    const fnCalls = extractFunctionCalls(first);
    const finishReason = mapFinishReason(asString(first.finishReason));

    const delta: DeltaChunk['choices'][0]['delta'] = {};
    if (text.length > 0) delta.content = text;
    if (fnCalls.length > 0) {
      delta.tool_calls = fnCalls.map((fc, i) => ({
        id: `call_${genId()}_${i}`,
        type: 'function' as const,
        function: { name: fc.name, arguments: JSON.stringify(fc.args) },
      }));
    }
    if (Object.keys(delta).length === 0 && finishReason === 'stop') return null;

    return {
      id: `chatcmpl-${genId()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: asString(parsed.modelVersion) || 'gemini',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  /**
   * Gemini free-tier responses do NOT include reliable `x-ratelimit-*` headers.
   * The gateway MUST maintain its own internal per-key / per-model request
   * counter and treat 429 RESOURCE_EXHAUSTED as the ground-truth rate-limit
   * signal. We opportunistically read `Retry-After` (seconds) if Gemini sets it.
   */
  extractRateLimitInfo(headers: Headers): RateLimitInfo {
    const info: RateLimitInfo = {};
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) info.retryAfter = seconds;
    }
    // Snapshot any rate-limit-ish headers for debugging — usually empty for Gemini.
    const raw: Record<string, string> = {};
    headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower.startsWith('x-ratelimit') || lower === 'retry-after') {
        raw[lower] = value;
      }
    });
    if (Object.keys(raw).length > 0) info.raw = raw;
    return info;
  }

  // ============ High-level I/O methods (required by Agent A4 task) ============
  // These are additive to the ProviderAdapter contract so the adapter can be
  // used standalone (e.g. in tests or direct callers) without the gateway
  // fetch boilerplate. `fetchFn` is injectable for testability.

  async chat(
    req: ChatRequest,
    apiKey: string,
    fetchFn: typeof fetch = fetch,
  ): Promise<ChatResponse> {
    const res = await fetchFn(this.buildChatUrl(req.model), {
      method: 'POST',
      headers: this.getHeaders(apiKey),
      body: JSON.stringify(this.formatRequest(req)),
    });
    if (res.status === 429) {
      const retryAfter = this.extractRateLimitInfo(res.headers).retryAfter ?? null;
      throw new GeminiRateLimitError('Gemini RESOURCE_EXHAUSTED (429)', retryAfter);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GeminiApiError(`Gemini API error ${res.status}: ${body.slice(0, 300)}`, res.status);
    }
    return this.parseResponse(await res.json());
  }

  async *chatStream(
    req: ChatRequest,
    apiKey: string,
    fetchFn: typeof fetch = fetch,
  ): AsyncIterable<DeltaChunk> {
    const res = await fetchFn(this.buildStreamUrl(req.model), {
      method: 'POST',
      headers: this.getHeaders(apiKey),
      body: JSON.stringify(this.formatRequest(req)),
    });
    if (res.status === 429) {
      const retryAfter = this.extractRateLimitInfo(res.headers).retryAfter ?? null;
      throw new GeminiRateLimitError('Gemini RESOURCE_EXHAUSTED (429)', retryAfter);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new GeminiApiError(`Gemini stream error ${res.status}: ${body.slice(0, 300)}`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE framing: events are separated by \n\n. Each event may have multiple
        // `data:` lines; emit per line so the parser sees one JSON object at a time.
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          for (const line of rawEvent.split('\n')) {
            const delta = this.parseStreamChunk(line);
            if (delta) yield delta;
          }
        }
      }
      const tail = buffer.trim();
      if (tail.length > 0) {
        const delta = this.parseStreamChunk(tail);
        if (delta) yield delta;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  async listModels(apiKey: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
    const res = await fetchFn(`${GEMINI_BASE_URL}${GEMINI_MODELS_PATH}`, {
      headers: this.getHeaders(apiKey),
    });
    if (!res.ok) throw new GeminiApiError(`Gemini listModels ${res.status}`, res.status);
    const raw: unknown = await res.json();
    const obj = isObject(raw) ? raw : {};
    return asArray(obj.models)
      .map((m) => (isObject(m) ? asString(m.name) : undefined))
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.replace(/^models\//, ''));
  }

  async healthCheck(apiKey: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
    try {
      const models = await this.listModels(apiKey, fetchFn);
      return models.length > 0;
    } catch {
      return false;
    }
  }
}

/** Singleton — the adapter is stateless. */
export const geminiAdapter = new GeminiAdapter();

// Re-export shared types so callers can `import { ChatRequest, GeminiAdapter } from './gemini'`.
export type { ChatMessage, ChatRequest, ChatResponse, DeltaChunk, ProviderAdapter, RateLimitInfo } from './types';
