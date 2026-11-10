/**
 * Mistral AI adapter for the multi-provider LLM gateway.
 *
 * Mistral's API is ~95% OpenAI-compatible (chat/completions endpoint shape,
 * SSE streaming format, tool-calling). Notable quirks handled here:
 *
 * 1. **Old models reject `role: "system"` as the first message.**
 *    `open-mixtral-8x7b` and `open-mistral-7b` were trained before Mistral
 *    added first-class system-role support. We fold the system message into
 *    the start of the first user message.
 *
 * 2. **`safe_prompt` parameter.** Every request can carry it. We default to
 *    `false` unless the caller explicitly opts in, matching the recommendation
 *    from Mistral's cookbook ("set safe_prompt only when you need moderation").
 *
 * 3. **`warnings` field.** Mistral returns an optional array of warning objects
 *    when params are silently ignored. We capture it on `ChatResponse`.
 *
 * 4. **Monthly quota (not daily).** Mistral's free tier is ~1M tokens / month
 *    recurring. We expose `x-ratelimit-*` headers when present, but Mistral
 *    is more sparing with them than Groq/OpenAI; the gateway's ledger layer
 *    is responsible for monthly-vs-daily accounting.
 *
 * Edge-compatible: only `Headers` / `fetch` from the runtime; no Node APIs.
 */

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatResponseChoice,
  DeltaChunk,
  ProviderAdapter,
  RateLimitInfo,
  ResponseWarning,
} from './types';

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
const MISTRAL_CHAT_PATH = '/chat/completions';

/**
 * Models that pre-date first-class `system` role support and will 400 if a
 * system message is the first message in the array. For these we prepend the
 * system content to the first user message.
 */
const OLD_MODELS_WITHOUT_SYSTEM_ROLE: ReadonlySet<string> = new Set([
  'open-mixtral-8x7b',
  'open-mistral-7b',
]);

/** Models the adapter advertises as supported. */
const SUPPORTED_MODELS: readonly string[] = [
  'mistral-large-latest',
  'mistral-small-latest',
  'open-mixtral-8x7b',
  'open-mixtral-8x22b',
  'open-mistral-7b',
  'codestral-latest',
] as const;

/** Typed view of the wire-shape request we send to Mistral. */
interface MistralChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | null;
  max_tokens?: number | null;
  top_p?: number | null;
  stream?: boolean;
  tools?: ChatRequest['tools'];
  tool_choice?: ChatRequest['tool_choice'];
  stop?: string | string[];
  random_seed?: number | null;
  response_format?: { type: 'json_object' | 'text' };
  safe_prompt: boolean;
}

/**
 * Mistral API adapter. Pure transformation methods (no fetch) so it is
 * trivially unit-testable; the gateway layer calls `fetch` itself.
 */
export class MistralAdapter implements ProviderAdapter {
  readonly provider = 'mistral';

  getBaseUrl(): string {
    return MISTRAL_BASE_URL;
  }

  getChatCompletionsPath(): string {
    return MISTRAL_CHAT_PATH;
  }

  getSupportedModels(): readonly string[] {
    return SUPPORTED_MODELS;
  }

  getHeaders(apiKey: string): HeadersInit {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Normalize a `ChatRequest` into the Mistral wire format.
   *
   * - Pass through OpenAI shape directly (model, messages, temperature, etc.).
   * - For old models (`open-mixtral-8x7b`, `open-mistral-7b`), convert a
   *   leading `system` message into a prefix on the first `user` message.
   * - Default `safe_prompt: false` unless the caller explicitly set it.
   */
  formatRequest(req: ChatRequest): Record<string, unknown> {
    const isOld = OLD_MODELS_WITHOUT_SYSTEM_ROLE.has(req.model);
    const messages = isOld
      ? this.foldSystemForOldModels(req.messages)
      : req.messages;

    const out: MistralChatRequest = {
      model: req.model,
      messages,
      // safe_prompt defaults to false unless the caller explicitly opts in.
      safe_prompt: req.safe_prompt === true,
    };

    // Only forward params that are actually set; Mistral 400s on unknown fields.
    if (req.temperature != null) out.temperature = req.temperature;
    if (req.max_tokens != null) out.max_tokens = req.max_tokens;
    if (req.top_p != null) out.top_p = req.top_p;
    if (req.stream != null) out.stream = req.stream;
    if (req.tools != null) out.tools = req.tools;
    if (req.tool_choice != null) out.tool_choice = req.tool_choice;
    if (req.stop != null) out.stop = req.stop;
    if (req.random_seed != null) out.random_seed = req.random_seed;
    if (req.response_format != null) out.response_format = req.response_format;

    return out as unknown as Record<string, unknown>;
  }

  /**
   * Parse a raw Mistral response object into a normalized `ChatResponse`.
   * Mistral is OpenAI-shape, so we mostly pass through; we additionally
   * capture the optional `warnings` array if the API surfaces it.
   */
  parseResponse(raw: unknown): ChatResponse {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('MistralAdapter.parseResponse: expected object');
    }
    const r = raw as Record<string, unknown>;

    const choicesRaw = Array.isArray(r.choices) ? r.choices : [];
    const choices: ChatResponseChoice[] = choicesRaw.map(
      (c: unknown, i: number): ChatResponseChoice => {
        const co = (c ?? {}) as Record<string, unknown>;
        const msg = (co.message ?? {}) as Record<string, unknown>;
        return {
          index: typeof co.index === 'number' ? co.index : i,
          message: {
            role: (msg.role as ChatResponseChoice['message']['role']) ?? 'assistant',
            content: typeof msg.content === 'string' ? msg.content : null,
            ...(Array.isArray(msg.tool_calls) && { tool_calls: msg.tool_calls as ChatResponseChoice['message']['tool_calls'] }),
          },
          finish_reason:
            typeof co.finish_reason === 'string' ? co.finish_reason : null,
        };
      },
    );

    const warningsRaw = r.warnings;
    const warnings: ResponseWarning[] | undefined = Array.isArray(warningsRaw)
      ? warningsRaw.map((w: unknown) => {
          if (typeof w === 'object' && w !== null) {
            return w as ResponseWarning;
          }
          return { message: String(w) };
        })
      : undefined;

    const response: ChatResponse = {
      id: typeof r.id === 'string' ? r.id : '',
      object: typeof r.object === 'string' ? r.object : 'chat.completion',
      created: typeof r.created === 'number' ? r.created : 0,
      model: typeof r.model === 'string' ? r.model : '',
      choices,
      ...(typeof r.usage === 'object' && r.usage !== null && {
        usage: r.usage as ChatResponse['usage'],
      }),
      ...(warnings !== undefined && { warnings }),
    };

    return response;
  }

  /**
   * Parse a single raw SSE chunk into a `DeltaChunk`, or `null` for keep-alive
   * / partial / unparseable lines. Mirrors the OpenAI/Groq SSE format:
   *   `data: {...json...}\n\n`
   *   `data: [DONE]\n\n`
   *
   * A chunk may contain multiple `data:` lines (batched by the provider or by
   * the network layer). We return the first parseable delta.
   */
  parseStreamChunk(chunk: string): DeltaChunk | null {
    if (!chunk) return null;

    // Split on newlines; tolerate both \n and \r\n.
    const lines = chunk.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (!data) continue;

      if (data === '[DONE]') {
        return {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          done: true,
        };
      }

      try {
        const parsed = JSON.parse(data) as DeltaChunk;
        if (
          parsed &&
          typeof parsed === 'object' &&
          Array.isArray(parsed.choices)
        ) {
          return parsed;
        }
      } catch {
        // Malformed JSON line — skip silently to keep stream resilient.
      }
    }

    return null;
  }

  /**
   * Extract Mistral rate-limit info from response headers.
   *
   * Mistral returns `x-ratelimit-remaining-{requests,tokens}`,
   * `x-ratelimit-limit-{requests,tokens}`, and on 429s a `retry-after`
   * header (seconds). All are best-effort: if absent, fields stay undefined.
   */
  extractRateLimitInfo(headers: Headers): RateLimitInfo {
    const num = (key: string): number | undefined => {
      const v = headers.get(key);
      if (v == null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (key: string): string | undefined => {
      const v = headers.get(key);
      return v ?? undefined;
    };

    const info: RateLimitInfo = {
      requestsRemaining: num('x-ratelimit-remaining-requests'),
      tokensRemaining: num('x-ratelimit-remaining-tokens'),
      requestsLimit: num('x-ratelimit-limit-requests'),
      tokensLimit: num('x-ratelimit-limit-tokens'),
      retryAfter: num('retry-after'),
      resetRequestsIn: str('x-ratelimit-reset-requests'),
      resetTokensIn: str('x-ratelimit-reset-tokens'),
    };

    // Snapshot a few interesting headers for debugging.
    const raw: Record<string, string> = {};
    const tracked = [
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-limit-requests',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-reset-requests',
      'x-ratelimit-reset-tokens',
      'retry-after',
    ];
    for (const k of tracked) {
      const v = headers.get(k);
      if (v != null) raw[k] = v;
    }
    if (Object.keys(raw).length > 0) info.raw = raw;

    return info;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Fold a leading `system` message into the start of the first `user`
   * message, for models that reject the system role at position 0.
   *
   * - If the first message is not `system`, return messages unchanged.
   * - If no `user` message follows the system message, just drop the system
   *   message (the user content was empty / not provided).
   * - The first user message's content is preserved by concatenating the
   *   system text in front with a blank line separator. If the user message
   *   has structured (vision) content, we keep the parts but prepend a
   *   text part with the system prompt.
   */
  private foldSystemForOldModels(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length === 0) return messages;
    if (messages[0].role !== 'system') return messages;

    const sysMsg = messages[0];
    const sysText =
      typeof sysMsg.content === 'string' ? sysMsg.content : '';

    // Find first user message AFTER position 0.
    let userIdx = -1;
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }

    if (userIdx === -1) {
      // No user message — just drop the system message.
      return messages.slice(1);
    }

    const newMessages = messages.slice(1); // drop system
    const adjIdx = userIdx - 1;
    const userMsg = newMessages[adjIdx];

    if (typeof userMsg.content === 'string') {
      const merged = sysText
        ? `${sysText}\n\n${userMsg.content}`
        : userMsg.content;
      newMessages[adjIdx] = { ...userMsg, content: merged };
      return newMessages;
    }

    // Structured content (vision / multi-part). Prepend a text part.
    if (Array.isArray(userMsg.content)) {
      const parts = sysText
        ? ([{ type: 'text' as const, text: sysText }, ...userMsg.content])
        : userMsg.content;
      newMessages[adjIdx] = { ...userMsg, content: parts };
      return newMessages;
    }

    // content is null — just leave the user message alone.
    return newMessages;
  }
}

/** Singleton instance, since the adapter is stateless. */
export const mistralAdapter = new MistralAdapter();
