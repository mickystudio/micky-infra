/**
 * Micky Assistant Unlimited - LLM Inference Runner
 *
 * Today this wraps Cloudflare Workers AI directly. The interface is shaped
 * so that a future HuggingFace Spaces deployment (e.g. a Qwen2.5-Coder-14B
 * inference endpoint behind HF's Docker Spaces) can be slotted in without
 * changing callers.
 *
 * The HTTP shape of a future HF Space call would be roughly:
 *
 *   POST {HF_SPACE_URL}/v1/chat/completions
 *   Authorization: Bearer {HF_TOKEN}
 *   X-Project-ID: ...
 *
 *   { "model": "...", "messages": [...] }
 *
 * For now, `callLLM` dispatches to `env.AI.run(...)`.
 *
 * Created: 2026-11-10
 * Phase: P3-T3 (forward-compat for BYOK runner)
 */

// ============ Types ============

/** A chat message understood by the LLM runner. */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Parameters for {@link callLLM}. */
export interface LLMCallParams {
  messages: LLMMessage[];
  /** Workers AI model id, e.g. `@cf/qwen/qwen2.5-coder-32b-instruct`. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** If true, returns a `ReadableStream` under `stream` instead of a string. */
  stream?: boolean;
  /** Stop sequences. */
  stop?: string[];
}

/** Usage accounting returned by the LLM runner. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Synchronous response from {@link callLLM}. */
export interface LLMResponse {
  /** The full text response from the model. */
  response: string;
  /** Token usage, if reported by the backend. */
  usage: LLMUsage;
  /** The model id that produced the response. */
  model: string;
  /** Raw backend object (Workers AI shape) for advanced callers. */
  raw?: unknown;
}

/** Streaming chunk shape (OpenAI-compatible `data: {...}` lines). */
export interface LLMStreamChunk {
  choices: Array<{
    delta: { role?: string; content?: string };
    finish_reason: string | null;
    index: number;
  }>;
}

// ============ Default Model Resolution ============

/**
 * Map a friendly model id (the kind Micky pastes into Cline) to a
 * Workers AI fully-qualified model name.
 */
export function resolveModelId(
  env: { DEFAULT_MODEL: string; FAST_MODEL: string },
  requested?: string
): string {
  if (!requested) return env.DEFAULT_MODEL;
  // Allow callers to pass either the friendly id ("qwen2.5-coder-32b")
  // or the full "@cf/..." model id.
  if (requested.startsWith('@cf/')) return requested;

  const mapping: Record<string, string> = {
    'qwen2.5-coder-32b': env.DEFAULT_MODEL,
    'qwen2.5-coder-14b': env.FAST_MODEL,
    'qwen2.5-coder-7b': '@cf/qwen/qwen2.5-coder-7b-instruct',
    'qwen2.5-coder-32b-instruct': env.DEFAULT_MODEL,
    'qwen2.5-coder-14b-instruct': env.FAST_MODEL,
  };
  return mapping[requested] ?? env.DEFAULT_MODEL;
}

// ============ Public API ============

/**
 * Call the LLM inference endpoint. Currently Workers AI; the HTTP path
 * below is reserved for a future HF Space migration.
 *
 * @param env    The Cloudflare Worker environment (must contain `AI`).
 * @param params Messages, model, decoding parameters.
 */
export async function callLLM(
  env: { AI: Ai; DEFAULT_MODEL: string; FAST_MODEL: string },
  params: LLMCallParams
): Promise<LLMResponse> {
  const model = resolveModelId(env, params.model);

  // --- Future HF Space branch (kept as a clearly-marked stub) -----------------
  // If we migrate to a HuggingFace Space later:
  //
  //   const r = await fetch(HF_SPACE_URL + '/v1/chat/completions', { ... })
  //   return mapOpenAIResponse(await r.json())
  //
  // For now we go straight through Workers AI.

  const aiResult = await env.AI.run(model, {
    messages: params.messages,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    top_p: params.topP,
    stream: params.stream,
    stop: params.stop,
  });

  // Workers AI returns `{ response, usage }` for non-stream calls and
  // a ReadableStream for stream=true calls.
  if (params.stream) {
    // Caller can wrap the stream themselves; we surface it via `raw`.
    const stream = aiResult as unknown as ReadableStream;
    return {
      response: '[stream]',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model,
      raw: stream,
    };
  }

  const shaped = aiResult as {
    response?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const usage = shaped.usage ?? {};
  return {
    response: shaped.response ?? '',
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    },
    model,
    raw: aiResult,
  };
}

/**
 * Wrap a ReadableStream into OpenAI-compatible Server-Sent Events.
 *
 * Each Workers AI stream chunk is a string; we re-emit it as:
 *
 *   data: {"choices":[{"delta":{"content":"..."},"finish_reason":null,"index":0}]}\n\n
 *
 * Followed by a terminating `data: [DONE]`.
 *
 * Reserved for HF Space future-shape parity.
 */
export function toOpenAIStream(
  stream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const reader = stream.getReader();
  const queue: Uint8Array[] = [];

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (queue.length > 0) {
        controller.enqueue(queue.shift()!);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        const terminator = `data: [DONE]\n\n`;
        controller.enqueue(encoder.encode(terminator));
        controller.close();
        return;
      }
      const text = decoder.decode(value, { stream: true });
      const chunk = JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: text },
            finish_reason: null,
          },
        ],
      });
      queue.push(encoder.encode(`data: ${chunk}\n\n`));
      controller.enqueue(queue.shift()!);
    },
    cancel() {
      reader.cancel().catch(() => undefined);
    },
  });
}
