/**
 * Micky Assistant — Storyboard Approval Flow (Agent B11).
 *
 * Pro-video rough-cut review UX. The bot sends a storyboard image grid
 * with inline keyboard buttons; the user can approve / edit a take /
 * regenerate before the pipeline resumes from the saved pause-state.
 *
 * Storage: the approval payload lives in LOCKS KV under
 * `storyboard:approval:<token>` with a 30-min TTL (matches the spec's
 * hard requirement). D1 is not used because the token expires quickly
 * and the payload is fairly large.
 *
 * Callback-data convention:
 *   `sb:approve:<token>`       — approve → resume pipeline
 *   `sb:edit:<token>:<idx>`     — edit a single take (prompts for text)
 *   `sb:regen:<token>`         — regenerate the storyboard with new seed
 *   `sb:cancel:<token>`         — discard the storyboard + state file
 *
 * On approve, the handler enqueues a `montage_resume` queue message
 * whose payload references the saved pipeline state path. The Kaggle
 * runner picks it up, calls `pipeline.resume_pipeline(state_path)`, and
 * the pipeline continues from Stage 3 without re-doing Whisper.
 */

import type { Env } from '../index';
import type { TelegramInlineKeyboardMarkup } from './keyboards';

// ============ Types ============

/** Per-take metadata stored alongside the approval token. */
export interface StoryboardTakeData {
  idx: number; scene_idx: number;
  start: number; end: number; duration: number;
  source_path: string; thumbnail_path: string; preview_clip_path: string;
  hook_text: string; score: number; thumbnail_b64?: string;
}

/** Full approval payload persisted in LOCKS KV. */
export interface StoryboardApprovalData {
  schema: 'micky.storyboard.approval.v1';
  approval_token: string;
  chat_id: number;
  task_id: string;
  pipeline_state_path: string;
  storyboard_image_url: string | null;
  storyboard_image_file_id: string | null;
  takes: StoryboardTakeData[];
  narrative_arc: Record<string, unknown> | null;
  take_count: number;
  created_at: number;
  expires_at: number;
}

/** Shape of the storyboard data dict produced by storyboard.py. */
export interface StoryboardDataFromPython {
  schema: string;
  storyboard_image_path: string;
  storyboard_image_url: string | null;
  approval_token: string;
  expires_at: number;
  expires_in_sec: number;
  takes: StoryboardTakeData[];
  narrative_arc: Record<string, unknown> | null;
  take_count: number;
  created_at: number;
}

// ============ Constants ============
const APPROVAL_KV_PREFIX = 'storyboard:approval:';
const APPROVAL_TTL_SEC = 30 * 60;
const STORYBOARD_TOKEN_RE = /^[A-Fa-f0-9-]{36}$/;

// ============ Public API ============

/** Sends the storyboard image as a Telegram photo with caption + inline
 * keyboard. Stores the approval payload in LOCKS KV with a 30-min TTL. */
export async function sendStoryboardForApproval(
  env: Env, ctx: ExecutionContext, chatId: number,
  taskId: string, pipelineStatePath: string,
  storyboardData: StoryboardDataFromPython,
  imageBuffer?: ArrayBuffer,
): Promise<{ ok: boolean; approvalToken?: string; error?: string }> {
  if (!storyboardData?.approval_token) {
    return { ok: false, error: 'storyboard_data missing approval_token' };
  }
  if (!storyboardData?.takes?.length) {
    return { ok: false, error: 'storyboard_data has no takes' };
  }
  const token = storyboardData.approval_token;
  const caption = buildCaption(storyboardData.take_count, storyboardData.takes);
  const keyboard = storyboardKeyboard(token, storyboardData.take_count);
  const photoResult = await sendPhotoWithKeyboard(
    env, chatId, imageBuffer, storyboardData.storyboard_image_path, caption, keyboard,
  );
  if (!photoResult.ok) return { ok: false, error: photoResult.error || 'sendPhoto failed' };
  const payload: StoryboardApprovalData = {
    schema: 'micky.storyboard.approval.v1',
    approval_token: token, chat_id: chatId, task_id: taskId,
    pipeline_state_path: pipelineStatePath,
    storyboard_image_url: null,
    storyboard_image_file_id: photoResult.file_id || null,
    takes: storyboardData.takes,
    narrative_arc: storyboardData.narrative_arc,
    take_count: storyboardData.take_count,
    created_at: storyboardData.created_at || Math.floor(Date.now() / 1000),
    expires_at: storyboardData.expires_at || (Math.floor(Date.now() / 1000) + APPROVAL_TTL_SEC),
  };
  try {
    await env.LOCKS.put(
      APPROVAL_KV_PREFIX + token,
      JSON.stringify(payload),
      { expirationTtl: APPROVAL_TTL_SEC },
    );
  } catch (err) {
    return { ok: false, error: `KV put failed: ${String(err)}` };
  }
  ctx.waitUntil(scheduleExpiryNotice(env, chatId, token, payload.expires_at));
  return { ok: true, approvalToken: token };
}

/** Routes a callback_query from the storyboard keyboard. Dispatches the
 * requested action and returns the `answerCallbackQuery` text. */
export async function handleStoryboardApproval(
  env: Env,
  ctx: ExecutionContext,
  callbackQuery: TelegramCallbackQuery,
): Promise<{ ok: boolean; answerText?: string; error?: string }> {
  const data = callbackQuery.data || '';
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) {
    return { ok: false, error: 'callback_query missing chat.id' };
  }

  // Parse callback_data: sb:<action>:<token>[:<idx>]
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== 'sb') {
    return { ok: false, error: `bad callback_data: ${data}` };
  }
  const action = parts[1];
  const token = parts[2];
  if (!STORYBOARD_TOKEN_RE.test(token)) {
    return { ok: false, error: 'invalid token format' };
  }

  const payload = await loadApprovalPayload(env, token);
  if (!payload) {
    await sendTelegramMessage(env, chatId, '⏳ انتهت صلاحية لوحة القصة (أكثر من 30 دقيقة). أرسل /storyboard لإعادة الإنشاء.');
    return { ok: false, answerText: '⏳ انتهت الصلاحية' };
  }
  if (payload.chat_id !== chatId) {
    return { ok: false, error: 'chat_id mismatch (token belongs to another user)' };
  }

  switch (action) {
    case 'approve':
      return await handleApprove(env, ctx, chatId, payload);
    case 'edit': {
      const idx = parseIntSafe(parts[3]);
      if (idx === null) {
        return { ok: false, error: 'edit callback missing idx' };
      }
      return await handleEditPrompt(env, chatId, payload, idx);
    }
    case 'regen':
      return await handleRegenerate(env, ctx, chatId, payload);
    case 'cancel':
      return await handleCancel(env, chatId, payload);
    default:
      return { ok: false, error: `unknown storyboard action: ${action}` };
  }
}

/**
 * Follow-up handler for the user's free-text edit description for a take.
 * Called by the main router when a non-command message arrives while a
 * `storyboard:edit:<token>:<idx>` wizard state is active for the chat.
 */
export async function handleStoryboardEdit(
  env: Env,
  ctx: ExecutionContext,
  chatId: number,
  takeIdx: number,
  editDescription: string,
): Promise<{ ok: boolean; error?: string }> {
  // Look up the active edit-wizard state for this chat.
  const stateKey = `storyboard:edit_state:${chatId}`;
  const raw = await env.LOCKS.get(stateKey);
  if (!raw) {
    return { ok: false, error: 'no active storyboard edit state for chat' };
  }
  let state: { token: string; take_idx: number };
  try {
    state = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'corrupt edit_state in KV' };
  }
  if (state.take_idx !== takeIdx) {
    return { ok: false, error: `take_idx mismatch (state=${state.take_idx}, expected=${takeIdx})` };
  }

  const payload = await loadApprovalPayload(env, state.token);
  if (!payload) {
    await env.LOCKS.delete(stateKey);
    return { ok: false, error: 'approval payload expired or missing' };
  }

  // Apply the edit by enqueuing a montage_resume task with a single-take
  // edit directive. The Kaggle runner will re-generate only that take and
  // then re-render the storyboard.
  const trimmed = editDescription.trim().slice(0, 500);
  if (!trimmed) {
    await sendTelegramMessage(env, chatId, '⚠️ الوصف فارغ. أرسل وصفًا للتغيير المطلوب:');
    return { ok: false };
  }

  try {
    await env.TASKS_QUEUE.send({
      type: 'montage',
      chatId: chatId,
      taskId: payload.task_id,
      payload: {
        kind: 'montage_take_edit',
        pipeline_state_path: payload.pipeline_state_path,
        approval_token: state.token,
        take_idx: takeIdx,
        edit_description: trimmed,
      },
    });
  } catch (err) {
    return { ok: false, error: `queue send failed: ${String(err)}` };
  }

  await env.LOCKS.delete(stateKey);
  await sendTelegramMessage(env, chatId, [
    `✏️ تم استلام التعديل على المشهد #${takeIdx + 1}.`,
    '',
    `💬 "${trimmed}"`,
    '',
    '🔄 سيعاد إنشاء هذا المشهد فقط ثم تُحدَّث لوحة القصة.',
  ].join('\n'));
  return { ok: true };
}

// ============ Internal action handlers ============

async function handleApprove(
  env: Env, ctx: ExecutionContext, chatId: number, payload: StoryboardApprovalData,
): Promise<{ ok: boolean; answerText?: string; error?: string }> {
  try {
    await env.TASKS_QUEUE.send({
      type: 'montage',
      chatId: chatId,
      taskId: payload.task_id,
      payload: {
        kind: 'montage_resume',
        pipeline_state_path: payload.pipeline_state_path,
        approval_token: payload.approval_token,
      },
    });
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ فشل إعادة التشغيل: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
  await env.LOCKS.delete(APPROVAL_KV_PREFIX + payload.approval_token);
  await sendTelegramMessage(env, chatId, [
    '✅ *تمت الموافقة على لوحة القصة!*',
    '',
    '🎬 استئناف المونتاج من الحالة المحفوظة…',
    `🆔 المهمة: \`${payload.task_id}\``,
    '',
    '⏳ سيستغرق الـ render ~20-40 دقيقة.',
  ].join('\n'));
  return { ok: true, answerText: '✅ تمت الموافقة' };
}

async function handleEditPrompt(
  env: Env, chatId: number, payload: StoryboardApprovalData, takeIdx: number,
): Promise<{ ok: boolean; answerText?: string; error?: string }> {
  if (takeIdx < 0 || takeIdx >= payload.takes.length) {
    return { ok: false, error: `take_idx ${takeIdx} out of range (0..${payload.takes.length - 1})` };
  }
  // Save a wizard-state in KV so the next free-text message from this
  // chat is routed to handleStoryboardEdit().
  const stateKey = `storyboard:edit_state:${chatId}`;
  try {
    await env.LOCKS.put(
      stateKey,
      JSON.stringify({ token: payload.approval_token, take_idx: takeIdx }),
      { expirationTtl: 10 * 60 },   // 10 min to type the edit description
    );
  } catch (err) {
    return { ok: false, error: `KV put failed: ${String(err)}` };
  }
  const take = payload.takes[takeIdx];
  await sendTelegramMessage(env, chatId, [
    `✏️ *تعديل المشهد #${takeIdx + 1}*`,
    '',
    `⏱️ البداية: ${take.start.toFixed(1)}s · المدة: ${take.duration.toFixed(1)}s`,
    `⭐ النقاط: ${take.score.toFixed(2)}`,
    `💬 ${take.hook_text}`,
    '',
    'أرسل وصفًا للتغيير المطلوب (مثال):',
    '• "اجعله أقصر"',
    '• "تغيير الزاوية"',
    '• "ابدأ من الثانية 5"',
  ].join('\n'));
  return { ok: true, answerText: `✏️ تعديل #${takeIdx + 1}` };
}

async function handleRegenerate(
  env: Env, ctx: ExecutionContext, chatId: number, payload: StoryboardApprovalData,
): Promise<{ ok: boolean; answerText?: string; error?: string }> {
  // Re-run take_selector with a different seed — same pipeline state, new
  // selection. The Kaggle runner re-runs Stage 2 only (skipping Stage 1
  // Whisper since the transcript is cached in the state file).
  try {
    await env.TASKS_QUEUE.send({
      type: 'montage',
      chatId: chatId,
      taskId: payload.task_id,
      payload: {
        kind: 'montage_regenerate_storyboard',
        pipeline_state_path: payload.pipeline_state_path,
        approval_token: payload.approval_token,
        new_seed: Math.floor(Math.random() * 1_000_000),
      },
    });
  } catch (err) {
    return { ok: false, error: `queue send failed: ${String(err)}` };
  }
  await sendTelegramMessage(env, chatId, '🔄 إعادة توليد لوحة القصة ببذرة جديدة… ستصلك الصورة خلال دقائق.');
  return { ok: true, answerText: '🔄 إعادة توليد' };
}

async function handleCancel(
  env: Env, chatId: number, payload: StoryboardApprovalData,
): Promise<{ ok: boolean; answerText?: string }> {
  await env.LOCKS.delete(APPROVAL_KV_PREFIX + payload.approval_token);
  await env.LOCKS.delete(`storyboard:edit_state:${chatId}`);
  // Note: the /tmp/micky_pipeline_state_<hash>.json file on the Kaggle
  // side is cleaned up by its own cron (TTL 24h on /tmp).
  await sendTelegramMessage(env, chatId, '🗑️ تم إلغاء لوحة القصة. أرسل /montage لبدء مشروع جديد.');
  return { ok: true, answerText: '🗑️ تم الإلغاء' };
}

// ============ Internal helpers ============

async function loadApprovalPayload(
  env: Env, token: string,
): Promise<StoryboardApprovalData | null> {
  const raw = await env.LOCKS.get(APPROVAL_KV_PREFIX + token);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoryboardApprovalData;
  } catch {
    return null;
  }
}

function buildCaption(takeCount: number, takes: StoryboardTakeData[]): string {
  const totalDur = takes.reduce((s, t) => s + (t.duration || 0), 0);
  return [
    '🎬 *لوحة القصة جاهزة للمراجعة!*',
    '',
    `📊 ${takeCount} مشهد · المجموع ${totalDur.toFixed(1)}s`,
    '',
    '✅ /approve — موافقة وبدء الـ render',
    '✏️ /edit <رقم> <وصف> — تعديل مشهد',
    '🔄 زر "إعادة التوليد" لتغيير البذرة',
    '',
    '_⏳ تنتهي الصلاحية خلال 30 دقيقة_',
  ].join('\n');
}

/** Inline keyboard: Approve + first 6 take-edit buttons + Regenerate + Cancel. */
export function storyboardKeyboard(
  token: string, takeCount: number,
): TelegramInlineKeyboardMarkup {
  const kb: { text: string; callback_data: string }[][] = [
    [{ text: '✅ موافقة', callback_data: `sb:approve:${token}` }],
  ];
  const maxButtons = Math.min(takeCount, 6);
  const row: { text: string; callback_data: string }[] = [];
  for (let i = 0; i < maxButtons; i++) {
    row.push({ text: `✏️ #${i + 1}`, callback_data: `sb:edit:${token}:${i}` });
    if (row.length === 3) kb.push(row.splice(0, 3));
  }
  if (row.length > 0) kb.push(row);
  kb.push([
    { text: '🔄 إعادة توليد', callback_data: `sb:regen:${token}` },
    { text: '🗑️ إلغاء', callback_data: `sb:cancel:${token}` },
  ]);
  return { inline_keyboard: kb };
}

async function sendPhotoWithKeyboard(
  env: Env,
  chatId: number,
  imageBuffer: ArrayBuffer | undefined,
  imagePath: string,
  caption: string,
  keyboard: TelegramInlineKeyboardMarkup,
): Promise<{ ok: boolean; file_id?: string; error?: string }> {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('caption', caption);
  formData.append('parse_mode', 'Markdown');
  formData.append('reply_markup', JSON.stringify(keyboard));

  if (imageBuffer) {
    formData.append('photo', new Blob([imageBuffer], { type: 'image/jpeg' }), 'storyboard.jpg');
  } else if (imagePath) {
    return { ok: false, error: `imageBuffer required for path-based photo upload (path=${imagePath})` };
  } else {
    return { ok: false, error: 'no image provided (need imageBuffer or imagePath)' };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: 'POST', body: formData },
    );
    const json = await res.json() as {
      ok: boolean; description?: string;
      result?: { photo?: { file_id: string }[] };
    };
    if (!json.ok) return { ok: false, error: json.description || 'sendPhoto returned ok=false' };
    const photoArr = json.result?.photo;
    const fileId = photoArr && photoArr.length > 0 ? photoArr[photoArr.length - 1].file_id : undefined;
    return { ok: true, file_id: fileId };
  } catch (err) {
    return { ok: false, error: `fetch failed: ${String(err)}` };
  }
}

async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('sendTelegramMessage failed:', err);
  }
}

/** Best-effort: store a "pending expiry" entry that the cron handler can
 * pick up (cron.ts polls every 5 min for stale Kaggle kernels). */
async function scheduleExpiryNotice(
  env: Env, chatId: number, token: string, expiresAt: number,
): Promise<void> {
  try {
    await env.LOCKS.put(
      `storyboard:expiry:${expiresAt}:${token}`,
      JSON.stringify({ chat_id: chatId, token, expires_at: expiresAt }),
      { expirationTtl: APPROVAL_TTL_SEC + 300 },
    );
  } catch {
    // Non-fatal — the KV entry itself will expire on its own.
  }
}

function parseIntSafe(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

// ============ Telegram types (subset) ============

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number; first_name?: string; username?: string };
  message?: { message_id: number; chat?: { id: number; type: string }; text?: string };
  inline_message_id?: string;
}

/** Returns true if `data` is a storyboard callback (prefix `sb:`). */
export function isStoryboardCallback(data: string | undefined): boolean {
  return !!data && data.startsWith('sb:');
}

/** Returns true if a chat currently has an active storyboard edit wizard. */
export async function hasActiveStoryboardEdit(env: Env, chatId: number): Promise<boolean> {
  const raw = await env.LOCKS.get(`storyboard:edit_state:${chatId}`);
  return !!raw;
}

/** Reads the active edit state for a chat (token + take_idx). */
export async function getActiveStoryboardEdit(
  env: Env, chatId: number,
): Promise<{ token: string; take_idx: number } | null> {
  const raw = await env.LOCKS.get(`storyboard:edit_state:${chatId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
