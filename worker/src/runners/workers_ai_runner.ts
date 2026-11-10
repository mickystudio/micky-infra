/**
 * Workers AI Runner
 * Micky Assistant Unlimited
 *
 * Fast path for LLM inference — runs synchronously in the Worker via the
 * Cloudflare Workers AI binding. No queue needed for simple inference.
 *
 * Default model: env.DEFAULT_MODEL (Qwen2.5-Coder-32B-Instruct).
 */

import type { Env } from '../index';

// ============ Public Types ============

export interface ChatMessage {
  role: string;
  content: string;
}

export interface RunInferenceParams {
  messages: ChatMessage[];
  /** Workers AI model id (e.g. '@cf/qwen/qwen2.5-coder-32b-instruct'). Defaults to env.DEFAULT_MODEL. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RunInferenceResult {
  response: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ============ Types (Workers AI response shape) ============

interface WorkersAiResponse {
  response?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ============ Public Functions ============

/**
 * Run inference directly via Workers AI.
 *
 * This is the synchronous fast path used by:
 *   - The queue consumer (processQueuedTask with runner='workers-ai')
 *   - Any direct caller that wants low-latency inference without queueing
 */
export async function runInference(
  env: Env,
  params: RunInferenceParams
): Promise<RunInferenceResult> {
  const model = params.model || env.DEFAULT_MODEL;
  const maxTokens = params.maxTokens ?? parseMaxTokensDefault(env);
  const temperature = params.temperature ?? parseTemperatureDefault(env);

  let aiResponse: unknown;
  try {
    aiResponse = await env.AI.run(model, {
      messages: params.messages,
      max_tokens: maxTokens,
      temperature,
    });
  } catch (err) {
    throw new Error(
      `Workers AI inference failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const resp = aiResponse as WorkersAiResponse;

  return {
    response: typeof resp.response === 'string' ? resp.response : '',
    usage: {
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ============ Internal Helpers ============

function parseMaxTokensDefault(env: Env): number {
  const raw = parseInt(env.MAX_TOKENS_DEFAULT, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
}

function parseTemperatureDefault(env: Env): number {
  const raw = parseFloat(env.TEMPERATURE_DEFAULT);
  return Number.isFinite(raw) ? raw : 0.4;
}
