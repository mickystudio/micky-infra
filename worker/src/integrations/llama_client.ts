/**
 * Micky Assistant Unlimited - Workers AI Client Wrapper
 * ----------------------------------------------------------------------------
 * عميل Workers AI (P2-T3)
 *
 * Thin, typed wrapper around `env.AI.run()` for the three inference tasks used
 * by Text Mode:
 *
 *   1. `callLLM()`         — single-shot inference (Qwen2.5-Coder-32B/14B)
 *   2. `streamLLM()`       — streaming inference with per-token callback
 *   3. `transcribeAudio()` — Whisper STT for voice messages
 *
 * Why this wrapper exists:
 *   - Normalizes the Workers AI response shape (`{ response, usage }`) into
 *     a stable `LLMResponse` interface that downstream code can rely on.
 *   - Centralizes model + decoding defaults (env.DEFAULT_MODEL,
 *     env.MAX_TOKENS_DEFAULT, env.TEMPERATURE_DEFAULT).
 *   - Provides a streaming API with a callback signature that's easy to
 *     plug into Telegram's "edit message every 1s" UX.
 *
 * Streaming format:
 *   Workers AI text-generation models emit raw UTF-8 text chunks when
 *   `stream: true` is passed (NOT JSON-wrapped). The TextDecoder with
 *   `{ stream: true }` handles multi-byte character boundaries across
 *   chunks. As a defensive measure we also detect SSE/NDJSON wrappers
 *   (e.g. `data: {...}\n\n` lines) and extract the inner `response` field
 *   if the raw bytes happen to look like JSON — keeping us resilient to
 *   future changes in Workers AI's streaming protocol.
 *
 * Created: 2026-11-10
 * Phase: P2-T3
 */

import type { Env } from '../index';

// ============ Types ============

/** A single chat message in OpenAI-compatible format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Parameters for {@link callLLM} and {@link streamLLM}. */
export interface LLMRequest {
  messages: ChatMessage[];
  /** Workers AI model id (e.g. `@cf/qwen/qwen2.5-coder-32b-instruct`). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Reserved — `streamLLM` always streams; this flag is accepted but ignored. */
  stream?: boolean;
}

/** Normalized LLM response — uniform across sync and streaming calls. */
export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

// ============ Internal: streaming chunk parser ============

/**
 * Incremental parser for Workers AI stream chunks.
 *
 * Handles three possible on-the-wire shapes:
 *   1. Raw UTF-8 text (the documented shape for Qwen text-generation)
 *   2. NDJSON lines: `{"response":"..."}\n`
 *   3. SSE lines:    `data: {"response":"..."}\n\n`
 *
 * Each parsed token is forwarded to `onToken`. Partial JSON or multi-byte
 * text is buffered between calls; call `flush()` once the stream ends to
 * drain any remaining buffered text.
 */
class StreamChunkParser {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly onToken: (chunk: string) => Promise<void>;

  constructor(onToken: (chunk: string) => Promise<void>) {
    this.onToken = onToken;
  }

  /** Feed a raw `Uint8Array` chunk from the Workers AI stream. */
  async feed(chunk: Uint8Array): Promise<void> {
    // `{ stream: true }` keeps incomplete multi-byte UTF-8 sequences buffered
    // across calls so we never emit half a character.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    await this.drainLines();
  }

  /** Drain any buffered remainder once the underlying stream is done. */
  async flush(): Promise<void> {
    // Final flush of the decoder (no `stream: true`).
    this.buffer += this.decoder.decode();
    if (this.buffer.length === 0) return;

    // Try to interpret the remaining buffer as JSON; fall back to raw text.
    await this.tryParseBufferLine(this.buffer);
    this.buffer = '';
  }

  /** Split the buffer on newlines and emit each complete line. */
  private async drainLines(): Promise<void> {
    while (true) {
      const nlIdx = this.buffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      await this.tryParseBufferLine(line);
    }
  }

  /**
   * Try to parse a single buffered line as a stream chunk.
   *
   * Three branches:
   *   1. Empty line → skip
   *   2. Looks like JSON (starts with `{` after optional `data: ` prefix)
   *      → parse and forward `response`/`delta` field if present
   *   3. Doesn't look like JSON → forward as raw text
   */
  private async tryParseBufferLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed === 'data: [DONE]') return;

    // Strip SSE `data:` prefix if present.
    const payload = trimmed.startsWith('data:')
      ? trimmed.slice(5).trim()
      : trimmed;

    // Try JSON only if it could plausibly be JSON.
    if (payload.startsWith('{')) {
      try {
        const parsed = JSON.parse(payload) as {
          response?: string;
          delta?: string;
          content?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const token = parsed.response ?? parsed.delta ?? parsed.content ?? '';
        if (token) await this.onToken(token);
        return;
      } catch {
        // Malformed JSON — fall through to raw text emission.
      }
    }

    // Raw text chunk — forward as-is.
    await this.onToken(payload);
  }
}

// ============ Internal: request shaping ============

/** Resolve the model id, defaulting to `env.DEFAULT_MODEL`. */
function resolveModel(env: Env, requested?: string): string {
  return requested || env.DEFAULT_MODEL;
}

/** Parse env string vars to numbers with safe fallbacks. */
function resolveDecodingParams(
  env: Env,
  req: LLMRequest,
): { maxTokens: number; temperature: number; topP: number } {
  return {
    maxTokens: req.maxTokens ?? (parseInt(env.MAX_TOKENS_DEFAULT, 10) || 4096),
    temperature: req.temperature ?? (parseFloat(env.TEMPERATURE_DEFAULT) || 0.4),
    topP: req.topP ?? 0.8,
  };
}

/** Map `ChatMessage[]` to the Workers AI `messages` input shape. */
function toAiMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Coerce a raw Workers AI result object into `LLMResponse`. */
function toLLMResponse(
  raw: unknown,
  model: string,
  fallbackContent = '',
): LLMResponse {
  const shaped = raw as {
    response?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const usage = shaped.usage ?? {};
  return {
    content: shaped.response ?? fallbackContent,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    },
    model,
  };
}

// ============ Public API ============

/**
 * Single-shot LLM inference.
 *
 * Calls `env.AI.run(model, { messages, max_tokens, temperature, top_p })`
 * and returns a normalized `LLMResponse`. Suitable for short prompts where
 * streaming UX adds no value (e.g. memory extraction, prompt compilation).
 *
 * Throws if the underlying `env.AI.run` rejects — callers should wrap with
 * try/catch for graceful degradation.
 */
export async function callLLM(env: Env, request: LLMRequest): Promise<LLMResponse> {
  const model = resolveModel(env, request.model);
  const { maxTokens, temperature, topP } = resolveDecodingParams(env, request);

  const raw = await env.AI.run(model, {
    messages: toAiMessages(request.messages),
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
  });

  return toLLMResponse(raw, model);
}

/**
 * Streaming LLM inference with per-token callback.
 *
 * Calls `env.AI.run(model, { ..., stream: true })` and reads the resulting
 * `ReadableStream`. Each decoded token is forwarded to `onToken` (awaited
 * in order — backpressure is honored). The returned `LLMResponse` contains
 * the fully accumulated content.
 *
 * Usage notes:
 *   - `onToken` is async; the next chunk will not be read until the prior
 *     callback resolves. This is intentional: callers like
 *     `streamToTelegram` need to throttle edits to 1/sec.
 *   - Workers AI does NOT return `usage` in streaming mode — the `usage`
 *     field of the response will contain zeros. Callers that need token
 *     accounting should fall back to `estimateTokens()` from `utils/tokens`.
 *
 * Throws on underlying stream errors. Caller is responsible for try/catch
 * and for falling back to {@link callLLM} if streaming is unavailable.
 */
export async function streamLLM(
  env: Env,
  request: LLMRequest,
  onToken: (chunk: string) => Promise<void>,
): Promise<LLMResponse> {
  const model = resolveModel(env, request.model);
  const { maxTokens, temperature, topP } = resolveDecodingParams(env, request);

  const streamResult = await env.AI.run(model, {
    messages: toAiMessages(request.messages),
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream: true,
  });

  // Workers AI typing for `stream: true` overloads returns `ReadableStream`.
  const readable = streamResult as unknown as ReadableStream<Uint8Array>;
  const reader = readable.getReader();

  // Accumulate the full content so we can return it in the LLMResponse.
  let content = '';
  const accumulatingCallback = async (chunk: string): Promise<void> => {
    content += chunk;
    await onToken(chunk);
  };

  const parser = new StreamChunkParser(accumulatingCallback);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await parser.feed(value);
      }
    }
    await parser.flush();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released; ignore.
    }
  }

  return {
    content,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    model,
  };
}

/**
 * Transcribe an audio clip via the configured Whisper model.
 *
 * @param env        The Cloudflare Worker environment (must contain `AI`).
 * @param audioBlob  Raw audio bytes (e.g. an OGG/Opus voice message downloaded
 *                   from Telegram). Whisper-tiny-en on Workers AI accepts the
 *                   raw bytes; no container stripping is required by us.
 * @returns          The transcribed text (empty string if transcription fails).
 */
export async function transcribeAudio(env: Env, audioBlob: ArrayBuffer): Promise<string> {
  // Workers AI's Whisper input expects `audio: number[]` (8-bit unsigned bytes).
  const audioBytes = Array.from(new Uint8Array(audioBlob));

  const result = await env.AI.run(env.WHISPER_MODEL, { audio: audioBytes });
  const shaped = result as { text?: string; word_count?: number };

  return (shaped.text ?? '').trim();
}
