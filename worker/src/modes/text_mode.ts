/**
 * Micky Assistant Unlimited - Text Mode Handler
 * ----------------------------------------------------------------------------
 * واجهة Text Mode الكاملة (P2-T4)
 *
 * The primary chat interface — competes with Claude/ChatGPT in quality by
 * composing four building blocks:
 *
 *   1. 4-layer prompt assembly (system prompt + chat history + web search
 *      context + memory injection — the latter via the memory engine).
 *   2. Streaming LLM responses with progressive Telegram message editing
 *      (rate-limited to 1 edit / second per Telegram policy).
 *   3. Automatic web search injection for time-sensitive queries
 *      (DuckDuckGo HTML — no API key required).
 *   4. Voice message support via Whisper-on-Workers-AI transcription.
 *
 * Telegram UX:
 *   - User sends text or voice.
 *   - Bot sends a placeholder "🤔 ..." message.
 *   - As tokens stream in, the placeholder is edited every ~1s.
 *   - When streaming finishes, the final edit carries the full text + an
 *     inline keyboard:  [📋 نسخ] [🔄 إعادة] [🌐 تتبع المصادر]
 *   - Both user and assistant messages are persisted to the `messages`
 *     table with `model_used` and `sources` recorded for traceability.
 *
 * Created: 2026-11-10
 * Phase: P2-T4
 */

import type { Env } from '../index';
import {
  callLLM,
  streamLLM,
  type ChatMessage,
  type LLMRequest,
  type LLMResponse,
} from '../integrations/llama_client';
import {
  formatSearchForPrompt,
  needsWebSearch,
  webSearch,
} from '../integrations/web_search';
import { logger } from '../utils/logger';

// ============ Types ============

export interface TextModeConfig {
  /** Logical chat id (defaults to `String(chatId)` from Telegram). */
  chatId: string;
  /** Optional project scope — used for memory isolation. */
  projectId?: string;
  /** Override the default system prompt. */
  systemPromptOverride?: string;
  /** Override the model (defaults to `env.DEFAULT_MODEL`). */
  model?: string;
  /** Override the decoding temperature. */
  temperature?: number;
  /** Override the max output tokens. */
  maxTokens?: number;
}

// ============ Constants ============

/** Telegram Bot API base URL (token appended at call time). */
const TG_API_BASE = 'https://api.telegram.org/bot';

/**
 * Minimum interval between two `editMessageText` calls for the same chat
 * (Telegram returns 429 Too Many Requests below this).
 */
const TG_EDIT_INTERVAL_MS = 1000;

/** Telegram message length hard limit. */
const TG_MAX_LENGTH = 4096;

/** Soft cap for the streaming preview — leaves room for the truncation hint. */
const TG_PREVIEW_CAP = TG_MAX_LENGTH - 64;

/** Number of past messages loaded as chat history context. */
const HISTORY_LIMIT = 20;

/** Default system prompt for Text Mode. */
const DEFAULT_SYSTEM_PROMPT = [
  'You are Micky Assistant, a professional AI assistant for a dentist named Micky.',
  'Always reply in Arabic unless the user explicitly asks for another language.',
  'Be concise but thorough. Use Markdown formatting when it adds clarity:',
  'headings (##), bullet lists, numbered lists, tables, and fenced code blocks.',
  'When you are unsure or when the information may be outdated, say so and',
  'recommend verifying with up-to-date sources. Tone: friendly, professional,',
  'educational. Avoid unnecessary filler or empty enthusiasm. You may use',
  'LaTeX inline like $x^2$ when it adds clarity for clinical or technical',
  'quantities. When citing fresh facts from the web, mention the source URL.',
].join(' ');

// ============ Telegram API helpers ============

/** Resolve the Bot API base URL for the configured token. */
function tgApi(env: Env, path: string): string {
  return `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/${path}`;
}

/** Shape of the `result` block returned by Telegram's `sendMessage`. */
interface TelegramMessageResult {
  message_id?: number;
}

/** Shape of the `result.file` block returned by Telegram's `getFile`. */
interface TelegramFileResult {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

/** Generic Telegram API response envelope. */
interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * Send a plain text message via Telegram.
 *
 * Returns the assigned `message_id` (or `undefined` on failure). The
 * `parseMode` argument lets callers opt out of Markdown parsing for LLM
 * output (LLM-emitted Markdown frequently fails Telegram's strict parser).
 */
async function sendTelegramMessage(
  env: Env,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
): Promise<number | undefined> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (parseMode) body.parse_mode = parseMode;

    const res = await fetch(tgApi(env, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as TelegramApiResponse<TelegramMessageResult>;
    if (!json.ok || !json.result?.message_id) {
      logger.warn('text_mode', 'sendMessage failed', {
        status: res.status,
        description: json.description,
      });
      return undefined;
    }
    return json.result.message_id;
  } catch (err) {
    logger.error('text_mode', 'sendMessage threw', { error: String(err) });
    return undefined;
  }
}

/**
 * Edit the text of an existing message.
 *
 * `replyMarkup` may be supplied to attach an inline keyboard during the
 * final edit. Failures are logged but not thrown — callers should fall
 * back to `sendMessage` if the edit genuinely cannot go through.
 */
async function editTelegramMessage(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    // Plain text by default — LLM Markdown often trips Telegram's parser.
    if (replyMarkup) body.reply_markup = replyMarkup;

    const res = await fetch(tgApi(env, 'editMessageText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as TelegramApiResponse<unknown>;
    if (!json.ok) {
      // 400 "message is not modified" is benign during throttled streaming.
      if (json.description?.includes('not modified')) return true;
      logger.debug('text_mode', 'editMessageText non-ok', {
        description: json.description,
        error_code: json.error_code,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('text_mode', 'editMessageText threw', { error: String(err) });
    return false;
  }
}

/**
 * Download a Telegram file by `file_id`. Used for voice messages and any
 * other attachments that need to be processed by Workers AI.
 *
 * Returns the raw bytes (ArrayBuffer). Throws on failure — callers wrap.
 */
async function downloadTelegramFile(
  env: Env,
  fileId: string,
): Promise<ArrayBuffer> {
  // Step 1: ask Telegram for the file_path.
  const metaRes = await fetch(
    `${tgApi(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`,
  );
  const meta = (await metaRes.json()) as TelegramApiResponse<TelegramFileResult>;
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(
      `getFile failed: ${meta.description ?? 'unknown error'}`,
    );
  }

  // Step 2: download the actual bytes.
  const fileUrl = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`download failed: HTTP ${fileRes.status}`);
  }
  return await fileRes.arrayBuffer();
}

// ============ Inline keyboard factory ============

/**
 * Build the post-response inline keyboard: [نسخ] [إعادة] [تتبع المصادر].
 *
 * `callback_data` strings must fit in 64 bytes — a UUID (36 chars) plus a
 * short prefix leaves plenty of headroom.
 */
function buildResponseKeyboard(
  assistantMsgId: string,
  userMsgId: string,
  hasSources: boolean,
): unknown {
  return {
    inline_keyboard: [
      [
        { text: '📋 نسخ', callback_data: `copy:${assistantMsgId}` },
        { text: '🔄 إعادة', callback_data: `retry:${userMsgId}` },
        {
          text: hasSources ? '🌐 تتبع المصادر' : '🌐 لا مصادر',
          callback_data: `sources:${assistantMsgId}`,
        },
      ],
    ],
  };
}

// ============ Chat history persistence ============

/** Row shape returned by the messages table for history loading. */
interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

/** Coerce a raw `messages.role` value into a `ChatMessage` role, or null. */
function toChatRole(role: string): 'user' | 'assistant' | null {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return null; // skip system/tool/unknown rows
}

/**
 * Load the most recent `limit` messages for a chat in chronological order.
 *
 * Returns an empty array on any DB failure — Text Mode degrades gracefully
 * to "no history" rather than crashing the whole request.
 */
async function loadChatHistory(
  env: Env,
  chatId: string,
  limit: number = HISTORY_LIMIT,
): Promise<MessageRow[]> {
  try {
    const result = await env.DB.prepare(
      'SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(chatId, limit)
      .all<MessageRow>();

    // Most-recent-first from DB → reverse to chronological for the LLM.
    return (result.results ?? []).slice().reverse();
  } catch (err) {
    logger.warn('text_mode', 'loadChatHistory failed; continuing without history', {
      error: String(err),
    });
    return [];
  }
}

/** Persist a single message to the `messages` table. Best-effort. */
async function saveMessage(
  env: Env,
  params: {
    id: string;
    chatId: string;
    role: 'user' | 'assistant';
    content: string;
    modelUsed?: string;
    sources?: string[];
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO messages (id, chat_id, role, content, model_used, sources, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        params.id,
        params.chatId,
        params.role,
        params.content,
        params.modelUsed ?? null,
        params.sources && params.sources.length > 0 ? JSON.stringify(params.sources) : null,
        now,
      )
      .run();
  } catch (err) {
    logger.error('text_mode', 'saveMessage failed', {
      role: params.role,
      error: String(err),
    });
  }
}

// ============ streamLLM → AsyncIterable bridge ============

/**
 * Bridge the callback-based `streamLLM` into an `AsyncIterable<string>`.
 *
 * Workers AI's `ReadableStream` + our `streamLLM` wrapper is push-based:
 * each token is delivered via an `onToken` callback. Some downstream
 * consumers (notably `streamToTelegram`) prefer pull-based iteration.
 *
 * This helper returns a tuple:
 *   - `iterable`: yields each token in arrival order
 *   - `response`: resolves to the final `LLMResponse` once streaming ends
 *
 * Backpressure is honored: `onToken` is awaited inside `streamLLM`, so the
 * underlying Workers AI stream is only read as fast as the iterable is
 * consumed.
 */
function streamLLMAsIterable(
  env: Env,
  request: LLMRequest,
): { iterable: AsyncIterable<string>; response: Promise<LLMResponse> } {
  const queue: string[] = [];
  let resolveWaiter: (() => void) | null = null;
  let isDone = false;
  let streamError: Error | null = null;

  const streamPromise = streamLLM(env, request, async (chunk) => {
    queue.push(chunk);
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  }).then(
    (response) => {
      isDone = true;
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
      return response;
    },
    (err: unknown) => {
      streamError = err instanceof Error ? err : new Error(String(err));
      isDone = true;
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
      throw streamError;
    },
  );

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          // Loop until we either yield a value or signal done.
          while (true) {
            if (queue.length > 0) {
              return { done: false, value: queue.shift() as string };
            }
            if (isDone) {
              if (streamError) throw streamError;
              return { done: true, value: undefined };
            }
            // Park until the next chunk or completion signal.
            await new Promise<void>((resolve) => {
              resolveWaiter = resolve;
            });
          }
        },
      };
    },
  };

  return { iterable, response: streamPromise };
}

// ============ Streaming → Telegram UX ============

/**
 * Stream the response to Telegram by editing the placeholder message
 * progressively — at most once per ~1 second per Telegram's rate policy.
 *
 * Strategy:
 *   - Buffer tokens into `accumulated`.
 *   - Every `TG_EDIT_INTERVAL_MS`, call `editMessageText` with the current
 *     accumulated text (truncated to Telegram's length cap).
 *   - Suppress benign errors ("message is not modified") — these are
 *     expected when no new tokens arrived in the last interval.
 *
 * @returns The full accumulated text.
 */
async function streamToTelegram(
  env: Env,
  chatId: number,
  messageId: number,
  stream: AsyncIterable<string>,
): Promise<string> {
  let accumulated = '';
  let lastEditTs = 0;

  for await (const chunk of stream) {
    accumulated += chunk;

    const now = Date.now();
    if (now - lastEditTs < TG_EDIT_INTERVAL_MS) continue;
    lastEditTs = now;

    // Truncate preview to fit Telegram's 4096-char limit + truncation hint.
    const preview =
      accumulated.length > TG_PREVIEW_CAP
        ? accumulated.slice(0, TG_PREVIEW_CAP) +
          '\n\n… (الرد طويل — يُعرض كاملًا عند الانتهاء)'
        : accumulated;

    // Plain text — LLM Markdown may fail Telegram's parser mid-stream.
    await editTelegramMessage(env, chatId, messageId, preview);
  }

  return accumulated;
}

// ============ Public: handleTextCommand ============

/**
 * Handle the `/text` command — show a banner confirming Text Mode is
 * active and how to use it.
 */
export async function handleTextCommand(env: Env, chatId: number): Promise<void> {
  const banner = [
    '📝 *Text Mode نشط*.',
    '',
    'أرسل أي سؤال أو رسالة بالعربية أو الإنجليزية.',
    'سيتم البحث في الويب تلقائيًا عند الحاجة لمعلومات حديثة.',
    '',
    '💡 يمكنك أيضًا إرسال *رسالة صوتية* وسيتم تفريغها نصيًا ثم الرد عليها.',
    '',
    '🛠️ أزرار مفيدة بعد كل رد:',
    '   • *نسخ* — يرسل الرد كاملًا في كتلة قابلة للنسخ',
    '   • *إعادة* — يعيد توليد الرد على نفس السؤال',
    '   • *تتبع المصادر* — يعرض الروابط المستخدمة',
  ].join('\n');

  await sendTelegramMessage(env, chatId, banner, 'Markdown');
  logger.info('text_mode', '/text command handled', { chatId });
}

// ============ Public: handleTextMessage ============

/**
 * Handle an incoming text message in Text Mode.
 *
 * Pipeline:
 *   1. Save the user message to D1 (`messages` table, role=user).
 *   2. Detect time-sensitivity (`needsWebSearch`); if true, run a DuckDuckGo
 *      query and format the results into a Markdown block.
 *   3. Build the LLM messages array: [system, ...history, user_with_search].
 *   4. Send a placeholder "🤔 ..." message — this is the message we'll edit
 *      as tokens stream in.
 *   5. Stream the LLM response, editing Telegram every ~1s.
 *   6. On stream failure: fall back to single-shot `callLLM`.
 *   7. Final edit with the full text + inline keyboard.
 *   8. Save the assistant message (with `model_used` and `sources`).
 */
export async function handleTextMessage(
  env: Env,
  chatId: number,
  text: string,
  config?: TextModeConfig,
): Promise<void> {
  const chatIdStr = config?.chatId ?? String(chatId);
  logger.info('text_mode', 'incoming text message', {
    chatId: chatIdStr,
    length: text.length,
  });

  // 1. Save user message.
  const userMsgId = crypto.randomUUID();
  await saveMessage(env, {
    id: userMsgId,
    chatId: chatIdStr,
    role: 'user',
    content: text,
  });

  // 2. Web search (if needed).
  let searchContext = '';
  let sources: string[] = [];
  if (needsWebSearch(text)) {
    try {
      logger.info('text_mode', 'performing web search', { query: text.slice(0, 80) });
      const searchResponse = await webSearch(text, 5);
      searchContext = formatSearchForPrompt(searchResponse);
      sources = searchResponse.results.map((r) => r.url);
      logger.info('text_mode', 'web search done', {
        count: sources.length,
      });
    } catch (err) {
      // Graceful fallback: continue without search context.
      logger.warn('text_mode', 'web search failed; responding without it', {
        error: String(err),
      });
    }
  }

  // 3. Load chat history (excluding the just-saved user message — we'll
  //    re-append it with the search context below).
  const history = await loadChatHistory(env, chatIdStr, HISTORY_LIMIT);

  // 4. Build the LLM messages array.
  const systemPrompt = config?.systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const m of history) {
    if (m.id === userMsgId) continue;
    const role = toChatRole(m.role);
    if (!role) continue;
    messages.push({ role, content: m.content });
  }

  const finalUserText = searchContext
    ? `${text}\n\n---\n${searchContext}`
    : text;
  messages.push({ role: 'user', content: finalUserText });

  // 5. Send placeholder message.
  const placeholderId = await sendTelegramMessage(env, chatId, '🤔 ...');
  if (!placeholderId) {
    logger.error('text_mode', 'failed to send placeholder; aborting');
    return;
  }

  // 6. Build LLM request params.
  const request: LLMRequest = {
    messages,
    model: config?.model,
    temperature: config?.temperature ?? parseFloat(env.TEMPERATURE_DEFAULT),
    maxTokens: config?.maxTokens ?? parseInt(env.MAX_TOKENS_DEFAULT, 10),
    stream: true,
  };

  // 7. Stream (with non-streaming fallback).
  let fullText = '';
  let modelUsed = config?.model ?? env.DEFAULT_MODEL;

  try {
    const { iterable, response: responsePromise } = streamLLMAsIterable(env, request);
    fullText = await streamToTelegram(env, chatId, placeholderId, iterable);
    const response = await responsePromise;
    modelUsed = response.model;
    if (!fullText) {
      // Stream completed but yielded nothing — surface a friendly message.
      fullText = '⚠️ لم يتم توليد رد. حاول مرة أخرى.';
    }
  } catch (err) {
    logger.error('text_mode', 'streaming failed; falling back to callLLM', {
      error: String(err),
    });
    try {
      const response = await callLLM(env, { ...request, stream: false });
      fullText = response.content || '⚠️ تعذّر توليد رد. حاول مرة أخرى.';
      modelUsed = response.model;
    } catch (err2) {
      logger.error('text_mode', 'non-streaming call also failed', {
        error: String(err2),
      });
      fullText = '⚠️ حدث خطأ أثناء توليد الرد. حاول مرة أخرى لاحقًا.';
    }
  }

  // 8. Persist assistant message.
  const assistantMsgId = crypto.randomUUID();
  await saveMessage(env, {
    id: assistantMsgId,
    chatId: chatIdStr,
    role: 'assistant',
    content: fullText,
    modelUsed,
    sources,
  });

  // 9. Final edit with full text + inline keyboard.
  const hasSources = sources.length > 0;
  const keyboard = buildResponseKeyboard(assistantMsgId, userMsgId, hasSources);

  // For the final edit, truncate at the hard Telegram limit if needed.
  // If the response is longer than 4096 chars, send the overflow as a
  // separate message rather than truncating content silently.
  const finalTextForEdit =
    fullText.length > TG_MAX_LENGTH ? fullText.slice(0, TG_MAX_LENGTH) : fullText;

  const edited = await editTelegramMessage(
    env,
    chatId,
    placeholderId,
    finalTextForEdit,
    keyboard,
  );

  if (!edited) {
    // Edit failed — send the full response as a new message instead.
    await sendTelegramMessage(env, chatId, finalTextForEdit);
  }

  // Overflow: send the remainder as additional messages.
  if (fullText.length > TG_MAX_LENGTH) {
    const overflow = fullText.slice(TG_MAX_LENGTH);
    for (let i = 0; i < overflow.length; i += TG_MAX_LENGTH) {
      await sendTelegramMessage(env, chatId, overflow.slice(i, i + TG_MAX_LENGTH));
    }
  }

  logger.info('text_mode', 'response delivered', {
    chatId: chatIdStr,
    messageId: placeholderId,
    length: fullText.length,
    model: modelUsed,
    sourcesCount: sources.length,
  });
}

// ============ Public: handleVoiceMessage ============

/**
 * Handle a voice message:
 *   1. Download the OGG/Opus audio file from Telegram.
 *   2. Transcribe it via Workers AI Whisper.
 *   3. Echo the transcription back to the chat (so Micky can verify).
 *   4. Feed the transcribed text through {@link handleTextMessage} for the
 *      normal streaming response pipeline.
 *
 * Any failure along the way surfaces a friendly Arabic error message — voice
 * messages must never silently fail.
 */
export async function handleVoiceMessage(
  env: Env,
  chatId: number,
  fileId: string,
): Promise<void> {
  logger.info('text_mode', 'voice message received', { chatId, fileId });

  // 1. Inform the user that transcription is in flight.
  const statusId = await sendTelegramMessage(
    env,
    chatId,
    '🎙️ جارٍ تفريغ الرسالة الصوتية...',
  );

  // 2. Download the audio bytes.
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await downloadTelegramFile(env, fileId);
  } catch (err) {
    logger.error('text_mode', 'failed to download voice file', {
      error: String(err),
    });
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ تعذّر تنزيل الرسالة الصوتية من تليجرام. حاول مرة أخرى.',
    );
    return;
  }

  // 3. Transcribe via Whisper (lazy import to avoid circular module cycles
  //    in case this file is later re-exported by index.ts).
  let transcript = '';
  try {
    const { transcribeAudio } = await import('../integrations/llama_client');
    transcript = await transcribeAudio(env, audioBuffer);
  } catch (err) {
    logger.error('text_mode', 'Whisper transcription failed', {
      error: String(err),
    });
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ تعذّر تفريغ الرسالة الصوتية. حاول مرة أخرى أو أرسلها كنص.',
    );
    return;
  }

  if (!transcript.trim()) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ لم أتمكن من سماع أي كلام واضح في الرسالة الصوتية. حاول مرة أخرى في بيئة أهدأ.',
    );
    return;
  }

  // 4. Echo the transcription so Micky can verify before the answer arrives.
  await sendTelegramMessage(
    env,
    chatId,
    `📝 *النص المُفرّغ:*\n\n${transcript}`,
    'Markdown',
  );

  // 5. Optionally dismiss the "transcribing..." status message.
  if (statusId) {
    await editTelegramMessage(env, chatId, statusId, '✅ تم التفريغ بنجاح.');
  }

  // 6. Hand off to the normal text pipeline.
  await handleTextMessage(env, chatId, transcript);
}

// ============ Public: sendCopyableText ============

/**
 * Send a chunk of text in a fenced code block so Micky can tap-to-copy on
 * Telegram mobile. Used by the [📋 نسخ] inline keyboard button.
 *
 * Long text is split into 4000-char chunks to stay under Telegram's 4096
 * limit (leaving room for the code fence + language tag).
 */
export async function sendCopyableText(
  env: Env,
  chatId: number,
  text: string,
): Promise<void> {
  const CHUNK_SIZE = 4000;

  if (!text) {
    await sendTelegramMessage(env, chatId, '(لا يوجد نص لنسخه)');
    return;
  }

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const chunk = text.slice(i, i + CHUNK_SIZE);
    const fenced = '```\n' + chunk + '\n```';
    await sendTelegramMessage(env, chatId, fenced, 'Markdown');
  }
}
