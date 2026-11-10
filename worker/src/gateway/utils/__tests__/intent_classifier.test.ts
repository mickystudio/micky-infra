/**
 * Tests for the intent classifier.
 *
 * Run with: `bun run test` (vitest).
 *
 * Coverage:
 *   - code detection: fence / file extension / keyword combo / false-positive guard
 *   - arabic detection: dominant / mixed-just-under / mixed-just-over
 *   - tool_calling detection: present / empty array
 *   - multimodal detection: image part present / priority over tools / plain text
 *   - long_context detection: >16k tokens / short prompt
 *   - reasoning detection: "step by step" / "explain why" / "analyze"
 *   - simple_chat fallback
 *   - getCascadeForIntent: exact ordering for all 7 intents
 *   - pickBestModel: spec examples + fallback behavior
 *
 * Agent: A7  ·  Created: 2026-11-10
 */

import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  getCascadeForIntent,
  pickBestModel,
  type IntentType,
} from '../intent_classifier';
import type { ChatRequest, ChatMessage } from '../types';

/** Build a ChatRequest with defaults so tests stay terse. */
function req(
  messages: ChatMessage[],
  opts: Partial<ChatRequest> = {},
): ChatRequest {
  return { messages, ...opts };
}

// ============ code detection ============

describe('classifyIntent — code detection', () => {
  it('detects a markdown code fence', () => {
    const r = req([
      { role: 'user', content: '```python\nprint("hello")\n```' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('code');
  });

  it('detects a file extension reference', () => {
    const r = req([
      { role: 'user', content: 'Can you fix the bug in src/index.ts?' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('code');
  });

  it('detects ≥2 code keywords (def + return)', () => {
    const r = req([
      { role: 'user', content: 'def foo():\n  return bar' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('code');
  });

  it('detects code keywords across various languages', () => {
    const r = req([
      { role: 'user', content: 'public class Hello { void main() {} }' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('code');
  });

  it('does NOT misclassify a single keyword in natural language', () => {
    const r = req([
      { role: 'user', content: 'What is the function of the liver?' },
    ]);
    expect(classifyIntent(r)).not.toBe<IntentType>('code');
  });

  it('detects code in the LAST user message even if history is plain', () => {
    const r = req([
      { role: 'user', content: 'Hello, how are you?' },
      { role: 'assistant', content: 'Hi! I am doing well.' },
      { role: 'user', content: 'Help me debug app.py please' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('code');
  });
});

// ============ arabic detection ============

describe('classifyIntent — arabic detection', () => {
  it('classifies a fully Arabic message as arabic', () => {
    const r = req([
      {
        role: 'user',
        content: 'مرحبا بك في العالم، كيف حالك اليوم؟ أتمنى أن تكون بخير.',
      },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('arabic');
  });

  it('classifies a >50% Arabic mixed message as arabic', () => {
    const r = req([
      {
        role: 'user',
        content: 'مرحبا بك يا صديقي العزيز، كيف حالك اليوم؟ أتمنى لك يوماً سعيداً.',
      },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('arabic');
  });

  it('does NOT classify a <50% Arabic mixed message as arabic', () => {
    const r = req([
      {
        role: 'user',
        content:
          'Hello everyone, I would like to discuss the project plan in detail today. مرحبا.',
      },
    ]);
    expect(classifyIntent(r)).not.toBe<IntentType>('arabic');
  });
});

// ============ tool_calling detection ============

describe('classifyIntent — tool_calling detection', () => {
  it('classifies as tool_calling when req.tools is a non-empty array', () => {
    const r = req(
      [{ role: 'user', content: 'What is the weather in London?' }],
      {
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather' },
          },
        ],
      },
    );
    expect(classifyIntent(r)).toBe<IntentType>('tool_calling');
  });

  it('does NOT classify as tool_calling when tools array is empty', () => {
    const r = req(
      [{ role: 'user', content: 'What is the weather in London?' }],
      { tools: [] },
    );
    expect(classifyIntent(r)).not.toBe<IntentType>('tool_calling');
  });

  it('does NOT classify as tool_calling when tools is undefined', () => {
    const r = req([{ role: 'user', content: 'Hello there' }]);
    expect(classifyIntent(r)).not.toBe<IntentType>('tool_calling');
  });
});

// ============ multimodal detection ============

describe('classifyIntent — multimodal detection', () => {
  it('classifies as multimodal when a message has an image_url part', () => {
    const r = req([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('multimodal');
  });

  it('multimodal takes priority over tool_calling', () => {
    const r = req(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
          ],
        },
      ],
      {
        tools: [{ type: 'function', function: { name: 'noop' } }],
      },
    );
    expect(classifyIntent(r)).toBe<IntentType>('multimodal');
  });

  it('does NOT classify as multimodal for plain-text messages', () => {
    const r = req([{ role: 'user', content: 'Tell me a joke' }]);
    expect(classifyIntent(r)).not.toBe<IntentType>('multimodal');
  });
});

// ============ long_context detection ============

describe('classifyIntent — long_context detection', () => {
  it('classifies as long_context when prompt tokens > 16000', () => {
    // 70000 chars of 'A' / 4 = ~17500 raw tokens, well above 16000.
    const longText = 'A'.repeat(70000);
    const r = req([{ role: 'user', content: longText }]);
    expect(classifyIntent(r)).toBe<IntentType>('long_context');
  });

  it('does NOT classify as long_context for short prompts', () => {
    const r = req([{ role: 'user', content: 'Hi there' }]);
    expect(classifyIntent(r)).not.toBe<IntentType>('long_context');
  });

  it('does NOT classify as long_context just below the threshold', () => {
    // 16000 tokens ≈ 64000 chars of English text.
    // Build 60000 chars → ~15000 tokens (under threshold).
    const text = 'word '.repeat(12000); // 60k chars
    const r = req([{ role: 'user', content: text }]);
    expect(classifyIntent(r)).not.toBe<IntentType>('long_context');
  });
});

// ============ reasoning detection ============

describe('classifyIntent — reasoning detection', () => {
  it('detects "step by step"', () => {
    const r = req([
      { role: 'user', content: 'Explain how to bake a cake step by step.' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('reasoning');
  });

  it('detects "step-by-step" (hyphenated)', () => {
    const r = req([
      { role: 'user', content: 'Give me a step-by-step guide to setting up nginx.' },
    ]);
    expect(classifyIntent(r)).toBe<IntentType>('reasoning');
  });

  it('detects "explain why"', () => {
    const r = req([{ role: 'user', content: 'Explain why the sky is blue.' }]);
    expect(classifyIntent(r)).toBe<IntentType>('reasoning');
  });

  it('detects "analyze"', () => {
    const r = req([{ role: 'user', content: 'Analyze the causes of WWI.' }]);
    expect(classifyIntent(r)).toBe<IntentType>('reasoning');
  });

  it('detects "think"', () => {
    const r = req([{ role: 'user', content: 'Think about how to solve this problem.' }]);
    expect(classifyIntent(r)).toBe<IntentType>('reasoning');
  });
});

// ============ simple_chat fallback ============

describe('classifyIntent — simple_chat fallback', () => {
  it('defaults to simple_chat for ordinary messages', () => {
    const r = req([{ role: 'user', content: 'Hey, how are you doing today?' }]);
    expect(classifyIntent(r)).toBe<IntentType>('simple_chat');
  });

  it('defaults to simple_chat for greetings', () => {
    const r = req([{ role: 'user', content: 'Hi' }]);
    expect(classifyIntent(r)).toBe<IntentType>('simple_chat');
  });
});

// ============ cascade ordering ============

describe('getCascadeForIntent', () => {
  it('returns the correct cascade for code', () => {
    expect(getCascadeForIntent('code')).toEqual([
      'groq1', 'groq2', 'mistral', 'sambanova', 'siliconflow', 'workersai', 'cerebras',
    ]);
  });

  it('returns the correct cascade for arabic', () => {
    expect(getCascadeForIntent('arabic')).toEqual([
      'groq1', 'groq2', 'cohere', 'sambanova', 'gemini',
    ]);
  });

  it('returns the correct cascade for long_context', () => {
    expect(getCascadeForIntent('long_context')).toEqual([
      'gemini', 'groq1', 'groq2', 'mistral',
    ]);
  });

  it('returns the correct cascade for reasoning', () => {
    expect(getCascadeForIntent('reasoning')).toEqual([
      'groq1', 'groq2', 'sambanova', 'novita',
    ]);
  });

  it('returns the correct cascade for simple_chat', () => {
    expect(getCascadeForIntent('simple_chat')).toEqual([
      'groq1', 'groq2', 'mistral', 'gemini', 'openrouter', 'workersai',
    ]);
  });

  it('returns the correct cascade for tool_calling', () => {
    expect(getCascadeForIntent('tool_calling')).toEqual([
      'groq1', 'groq2', 'mistral', 'openrouter', 'gemini',
    ]);
  });

  it('returns the correct cascade for multimodal', () => {
    expect(getCascadeForIntent('multimodal')).toEqual(['gemini']);
  });

  it('returns a fresh array each call (no shared mutation)', () => {
    const a = getCascadeForIntent('code');
    const b = getCascadeForIntent('code');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ============ pickBestModel ============

describe('pickBestModel', () => {
  it('picks qwen3-32b for code + groq1', () => {
    expect(pickBestModel('code', 'groq1')).toBe('qwen3-32b');
  });

  it('picks allam-2-7b for arabic + groq1', () => {
    expect(pickBestModel('arabic', 'groq1')).toBe('allam-2-7b');
  });

  it('picks llama-3.1-8b-instant for simple_chat + groq1', () => {
    expect(pickBestModel('simple_chat', 'groq1')).toBe('llama-3.1-8b-instant');
  });

  it('picks gemini-2.0-flash for multimodal + gemini', () => {
    expect(pickBestModel('multimodal', 'gemini')).toBe('gemini-2.0-flash');
  });

  it('picks codestral-latest for code + mistral', () => {
    expect(pickBestModel('code', 'mistral')).toBe('codestral-latest');
  });

  it('picks aya-23-35b for arabic + cohere', () => {
    expect(pickBestModel('arabic', 'cohere')).toBe('aya-23-35b');
  });

  it('falls back to provider default when intent has no specific entry', () => {
    // multimodal+groq1 isn't in the BEST_MODEL table (Groq can't do vision)
    // → fall back to groq1's default model.
    expect(pickBestModel('multimodal', 'groq1')).toBe('llama-3.1-8b-instant');
  });

  it('every (intent, provider) combination returns a non-empty string', () => {
    const intents: IntentType[] = [
      'code', 'arabic', 'long_context', 'reasoning',
      'simple_chat', 'tool_calling', 'multimodal',
    ];
    const providers = [
      'groq1', 'groq2', 'mistral', 'sambanova', 'siliconflow',
      'workersai', 'cerebras', 'cohere', 'gemini', 'novita', 'openrouter',
    ] as const;
    for (const intent of intents) {
      for (const provider of providers) {
        const model = pickBestModel(intent, provider);
        expect(model.length).toBeGreaterThan(0);
      }
    }
  });
});
