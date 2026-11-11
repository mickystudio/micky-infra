/**
 * Tests for the token counter.
 *
 * Run with: `bun run test` (vitest).
 *
 * Coverage:
 *   - estimateTokens: empty / English / Arabic / mixed / Gemini model / +3 overhead
 *   - countMessageTokens: empty / multi-message / multimodal parts / system prompt
 *   - estimateOutputTokens: non-positive / min cap / 0.5x scaling
 *   - getProviderContextLimit: known model / unknown model / unknown provider / case-insensitive
 *   - willFitInProviderContext: fits / exceeds / strict boundary
 *   - MODEL_CONTEXT_LIMITS: covers all 11 providers
 *
 * Agent: A7  ·  Created: 2026-11-10
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  countMessageTokens,
  estimateOutputTokens,
  willFitInProviderContext,
  getProviderContextLimit,
  MODEL_CONTEXT_LIMITS,
} from '../token_counter';
import type { ChatMessage, ProviderId } from '../types';

// ============ estimateTokens ============

describe('estimateTokens', () => {
  it('returns 0 for empty / null input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('', 'gpt-4o')).toBe(0);
  });

  it('estimates English at ~4 chars/token (raw) + 3 overhead', () => {
    // 40 chars → 40/4 = 10 raw + 3 = 13 tokens
    const text = 'Hello world how are you doing today my friend'; // 47 chars
    const tokens = estimateTokens(text);
    // raw = ceil(47/4) = 12, +3 = 15. Allow ±20%.
    expect(tokens).toBeGreaterThanOrEqual(12);
    expect(tokens).toBeLessThanOrEqual(18);
  });

  it('estimates Arabic at ~2 chars/token (denser than English)', () => {
    // 36 Arabic chars → 36/2 = 18 raw + 3 = 21 tokens
    const arabic = 'مرحبا بك في العالم كيف حالك اليوم يا صديقي'; // ~37 chars
    const tokens = estimateTokens(arabic);
    // raw ≈ 19, +3 = 22. Allow ±20%.
    expect(tokens).toBeGreaterThanOrEqual(17);
    expect(tokens).toBeLessThanOrEqual(27);
  });

  it('Arabic produces more tokens-per-char than English', () => {
    const english = 'Hello world this is a test of the token counter today'; // 51 chars
    const arabic = 'مرحبا بك في العالم كيف حالك اليوم يا صديقي'; // ~37 chars
    const enTokens = estimateTokens(english);
    const arTokens = estimateTokens(arabic);

    // Per-char token density should be ~2x higher for Arabic.
    const enDensity = enTokens / english.length;
    const arDensity = arTokens / arabic.length;
    expect(arDensity).toBeGreaterThan(enDensity * 1.3);
  });

  it('estimates Chinese at ~1.5 chars/token', () => {
    // 20 Han chars → 20/1.5 ≈ 14 raw + 3 = 17 tokens
    const chinese = '你好世界，这是一个用于测试分词器的中文句子。'; // ~21 chars
    const tokens = estimateTokens(chinese);
    expect(tokens).toBeGreaterThanOrEqual(13);
    expect(tokens).toBeLessThanOrEqual(22);
  });

  it('uses 3.5 chars/token for Gemini models', () => {
    // 35 chars on Gemini: 35/3.5 = 10 + 3 = 13
    // 35 chars on OpenAI: 35/4 = 9 + 3 = 12
    const text = 'a'.repeat(35);
    const openai = estimateTokens(text, 'gpt-4o');
    const gemini = estimateTokens(text, 'gemini-2.0-flash');
    expect(gemini).toBeGreaterThanOrEqual(openai);
    expect(gemini).toBe(13); // 10 + 3
  });

  it('applies the +3 per-message overhead', () => {
    // "hello" = 5 chars → ceil(5/4) = 2 raw + 3 overhead = 5 tokens
    expect(estimateTokens('hello')).toBe(5);
    // "hi" = 2 chars → ceil(2/4) = 1 raw + 3 overhead = 4 tokens
    expect(estimateTokens('hi')).toBe(4);
  });

  it('handles WorkersAI Qwen the same as Groq Qwen (BPE family)', () => {
    const text = 'def hello():\n    return "world"';
    const groq = estimateTokens(text, 'qwen3-32b');
    const workers = estimateTokens(text, '@cf/qwen/qwen2.5-coder-32b-instruct');
    // Both use the OpenAI-family heuristic → identical counts.
    expect(groq).toBe(workers);
  });

  it('mixed Arabic-English uses weighted average (not all-or-nothing)', () => {
    const halfArabic = 'hello world'.repeat(5) + 'مرحبا بك في'.repeat(5);
    const pureEnglish = 'hello world'.repeat(10); // same total length-ish
    const mixedTokens = estimateTokens(halfArabic);
    const pureTokens = estimateTokens(pureEnglish);
    // Mixed content with Arabic should need more tokens than pure English.
    expect(mixedTokens).toBeGreaterThan(pureTokens);
  });
});

// ============ countMessageTokens ============

describe('countMessageTokens', () => {
  it('returns 0 for an empty array', () => {
    expect(countMessageTokens([], 'gpt-4o')).toBe(0);
    expect(countMessageTokens([], 'gemini-2.0-flash')).toBe(0);
  });

  it('sums tokens across messages with per-message overhead', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' }, // 26 chars → 7 raw
      { role: 'user', content: 'Hello there!' }, // 12 chars → 3 raw
    ];
    const total = countMessageTokens(messages, 'gpt-4o');
    // raw: 7 + 3 = 10; overhead: 4 * 2 = 8; array priming: 3 → total 21
    expect(total).toBeGreaterThanOrEqual(15);
    expect(total).toBeLessThanOrEqual(28);
  });

  it('includes the system prompt in the count', () => {
    const withSystem: ChatMessage[] = [
      { role: 'system', content: 'A'.repeat(400) }, // 400 chars → 100 tokens
      { role: 'user', content: 'Hi' }, // 2 chars → 1 raw + 4 = 5
    ];
    const withoutSystem: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const withS = countMessageTokens(withSystem, 'gpt-4o');
    const withoutS = countMessageTokens(withoutSystem, 'gpt-4o');
    // System prompt adds at least 100 tokens of text.
    expect(withS).toBeGreaterThan(withoutS + 80);
  });

  it('handles multimodal message content (text parts only)', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' }, // 21 chars → 6 raw
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      },
    ];
    const total = countMessageTokens(messages, 'gpt-4o');
    // raw 6 + 4 overhead + 3 priming = 13
    expect(total).toBeGreaterThanOrEqual(9);
    expect(total).toBeLessThanOrEqual(18);
  });

  it('handles messages with empty content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'Hi' },
    ];
    const total = countMessageTokens(messages, 'gpt-4o');
    // 0 raw + 4 (msg 1) + 1 raw + 4 (msg 2) + 3 priming = 12
    expect(total).toBeGreaterThanOrEqual(8);
    expect(total).toBeLessThanOrEqual(16);
  });

  it('uses Gemini heuristic when model is a Gemini variant', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'A'.repeat(35) }, // 35 chars
    ];
    const openai = countMessageTokens(messages, 'gpt-4o');
    const gemini = countMessageTokens(messages, 'gemini-1.5-flash');
    // OpenAI: 9 raw + 4 + 3 = 16; Gemini: 10 raw + 4 + 3 = 17
    expect(gemini).toBeGreaterThanOrEqual(openai);
  });
});

// ============ estimateOutputTokens ============

describe('estimateOutputTokens', () => {
  it('returns 0 for non-positive inputs', () => {
    expect(estimateOutputTokens(0, 1000)).toBe(0);
    expect(estimateOutputTokens(100, 0)).toBe(0);
    expect(estimateOutputTokens(-5, 1000)).toBe(0);
    expect(estimateOutputTokens(100, -10)).toBe(0);
  });

  it('returns promptTokens * 0.5 when under maxTokens', () => {
    expect(estimateOutputTokens(1000, 1000)).toBe(500);
    expect(estimateOutputTokens(100, 1000)).toBe(50);
    expect(estimateOutputTokens(2000, 5000)).toBe(1000);
  });

  it('caps at maxTokens when 0.5 * prompt exceeds it', () => {
    expect(estimateOutputTokens(1000, 200)).toBe(200);
    expect(estimateOutputTokens(10000, 256)).toBe(256);
  });
});

// ============ getProviderContextLimit ============

describe('getProviderContextLimit', () => {
  it('returns the static value for known models', () => {
    expect(getProviderContextLimit('groq1', 'llama-3.1-8b-instant')).toBe(131072);
    expect(getProviderContextLimit('groq2', 'llama-3.1-8b-instant')).toBe(131072);
    expect(getProviderContextLimit('groq1', 'qwen3-32b')).toBe(32768);
    expect(getProviderContextLimit('gemini', 'gemini-flash')).toBe(1048576);
    expect(getProviderContextLimit('gemini', 'gemini-1.5-flash')).toBe(1048576);
    expect(getProviderContextLimit('workersai', '@cf/qwen/qwen2.5-coder-32b-instruct')).toBe(6000);
    expect(getProviderContextLimit('cohere', 'command-r-plus')).toBe(128000);
    expect(getProviderContextLimit('sambanova', 'Llama-3.3-70B-Instruct')).toBe(8192);
  });

  it('falls back to provider default when model is unknown', () => {
    expect(getProviderContextLimit('groq1', 'unknown-model')).toBe(32768);
    expect(getProviderContextLimit('sambanova', 'unknown-model')).toBe(8192);
    expect(getProviderContextLimit('gemini', 'unknown-model')).toBe(1048576);
    expect(getProviderContextLimit('workersai', 'unknown-model')).toBe(6000);
  });

  it('falls back to 8192 for unknown provider', () => {
    expect(
      getProviderContextLimit('unknown' as unknown as ProviderId, 'some-model'),
    ).toBe(8192);
  });

  it('case-insensitive model lookup', () => {
    expect(getProviderContextLimit('cohere', 'Command-R-Plus')).toBe(128000);
    expect(getProviderContextLimit('cohere', 'AYA-23-35B')).toBe(8192);
    expect(getProviderContextLimit('groq1', 'LLAMA-3.1-8B-INSTANT')).toBe(131072);
  });
});

// ============ willFitInProviderContext ============

describe('willFitInProviderContext', () => {
  it('returns true when prompt fits with room to spare', () => {
    expect(willFitInProviderContext(1000, 'groq1', 'llama-3.1-8b-instant')).toBe(true);
    expect(willFitInProviderContext(500000, 'gemini', 'gemini-flash')).toBe(true);
    expect(willFitInProviderContext(100, 'workersai', '@cf/qwen/qwen2.5-coder-32b-instruct')).toBe(true);
  });

  it('returns false when prompt exceeds context window', () => {
    expect(willFitInProviderContext(200000, 'groq1', 'llama-3.1-8b-instant')).toBe(false);
    expect(willFitInProviderContext(10000, 'workersai', '@cf/qwen/qwen2.5-coder-32b-instruct')).toBe(false);
    expect(willFitInProviderContext(2000000, 'gemini', 'gemini-flash')).toBe(false);
  });

  it('uses strict less-than at the boundary (no output reserve)', () => {
    const limit = getProviderContextLimit('groq1', 'qwen3-32b'); // 32768
    expect(willFitInProviderContext(limit, 'groq1', 'qwen3-32b')).toBe(false);
    expect(willFitInProviderContext(limit - 1, 'groq1', 'qwen3-32b')).toBe(true);
  });

  it('unknown model uses provider default for the check', () => {
    // groq1 default is 32768
    expect(willFitInProviderContext(30000, 'groq1', 'unknown-model')).toBe(true);
    expect(willFitInProviderContext(40000, 'groq1', 'unknown-model')).toBe(false);
  });
});

// ============ MODEL_CONTEXT_LIMITS table coverage ============

describe('MODEL_CONTEXT_LIMITS', () => {
  it('covers all 11 providers with at least one known model', () => {
    // Spot check that each provider has at least one model entry.
    const knownModels = [
      'llama-3.1-8b-instant',                              // groq1, groq2
      'mistral-small-latest',                             // mistral
      'meta-llama-3.1-8b-instruct',                       // sambanova
      'qwen/qwen2.5-72b-instruct',                         // siliconflow
      '@cf/qwen/qwen2.5-coder-32b-instruct',              // workersai
      'llama3.1-8b',                                       // cerebras
      'command-r-plus',                                     // cohere
      'gemini-2.0-flash',                                  // gemini
      'deepseek/deepseek-v3.1',                            // novita
      'openrouter/auto',                                   // openrouter
    ];
    for (const m of knownModels) {
      expect(MODEL_CONTEXT_LIMITS).toHaveProperty(m);
    }
  });

  it('includes the three reference values from the spec', () => {
    // The task spec calls these out by name — make sure they exist.
    expect(MODEL_CONTEXT_LIMITS['qwen3-32b']).toBe(32768);
    expect(MODEL_CONTEXT_LIMITS['llama-3.1-8b-instant']).toBe(131072);
    expect(MODEL_CONTEXT_LIMITS['gemini-flash']).toBe(1048576);
  });

  it('every entry is a positive integer', () => {
    for (const [model, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      expect(model.length).toBeGreaterThan(0);
    }
  });
});
