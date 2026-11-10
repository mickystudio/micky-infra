/**
 * Micky Assistant - Task Lifecycle Notifications
 * 
 * Telegram helpers for sending formatted messages about task state changes.
 * Used by:
 *   - The Kaggle webhook callback handler (task completion/failure)
 *   - The cron-based status poller (delayed completion detection)
 *   - The queue consumer (dispatch notifications)
 */

import type { Env } from '../index';

// ============ Internal: Send Telegram Message ============

async function sendTG(env: Env, chatId: number, text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('sendTG failed:', err);
  }
}

// ============ Public API ============

export interface TaskResult {
  taskId: string;
  taskType: string;
  status: 'completed' | 'failed';
  outputUrl?: string;
  outputMeta?: Record<string, unknown>;
  error?: string;
  kaggleUrl?: string;
}

/**
 * Notify user that a task was accepted and dispatched to a runner.
 */
export async function notifyTaskDispatched(
  env: Env,
  chatId: number,
  taskId: string,
  taskType: string,
  runner: string,
  runnerJobId?: string
): Promise<void> {
  const kaggleLink = runner === 'kaggle' && runnerJobId
    ? `\n🔗 [Kaggle](${runnerJobId})`
    : '';
  await sendTG(env, chatId, [
    `🚀 *تم استلام المهمة وبدء المعالجة*`,
    '',
    `🆔 \`${taskId}\``,
    `⚙️ النوع: ${taskType}`,
    `🎯 المنفّذ: ${runner}`,
    kaggleLink,
    '',
    '⏳ ستصلك تحديثات تلقائية عند كل مرحلة.',
  ].filter(Boolean).join('\n'));
}

/**
 * Notify user of in-progress task updates (e.g., "step 3/6 done").
 */
export async function notifyTaskProgress(
  env: Env,
  chatId: number,
  taskId: string,
  stage: string,
  percent: number,
  extraInfo?: string
): Promise<void> {
  const bar = buildProgressBar(percent);
  await sendTG(env, chatId, [
    `⏳ *تحديث التقدم* — \`${taskId}\``,
    '',
    `📍 المرحلة: ${stage}`,
    `${bar} ${percent}%`,
    extraInfo ? `\n💡 ${extraInfo}` : '',
  ].filter(Boolean).join('\n'));
}

/**
 * Notify user of task completion with output URL.
 */
export async function notifyTaskComplete(
  env: Env,
  chatId: number,
  result: TaskResult
): Promise<void> {
  const outputUrl = result.outputUrl || '(لا يوجد رابط)';
  const meta = result.outputMeta || {};
  const metaStr = JSON.stringify(meta, null, 2);
  const truncatedMeta = metaStr.length > 1200 ? metaStr.slice(0, 1200) + '\n...(truncated)' : metaStr;
  
  await sendTG(env, chatId, [
    '✅ *اكتملت معالجة المهمة بنجاح!*',
    '',
    `🆔 \`${result.taskId}\``,
    `⚙️ النوع: ${result.taskType}`,
    `📁 الناتج: ${outputUrl}`,
    '',
    '*تفاصيل الإخراج:*',
    '```json',
    truncatedMeta,
    '```',
    '',
    '📥 اضغط على رابط الناتج للتنزيل.',
    result.kaggleUrl ? `\n🔗 [سجل المعالجة على Kaggle](${result.kaggleUrl})` : '',
  ].filter(Boolean).join('\n'));
}

/**
 * Notify user of task failure with error details.
 */
export async function notifyTaskFailed(
  env: Env,
  chatId: number,
  taskId: string,
  error: string,
  traceback?: string
): Promise<void> {
  const tb = traceback ? `\n\`\`\`\n${traceback.slice(0, 800)}\n\`\`\`` : '';
  await sendTG(env, chatId, [
    '❌ *فشلت معالجة المهمة*',
    '',
    `🆔 \`${taskId}\``,
    '⚠️ *الخطأ:*',
    '```',
    String(error).slice(0, 600),
    '```',
    tb,
    '',
    '💡 يمكنك المحاولة مرة أخرى بإرسال الفيديو من جديد.',
    'إن تكرر الخطأ، استعمل /cancel ثم أعد الإرسال.',
  ].filter(Boolean).join('\n'));
}

/**
 * Notify user that a task was cancelled.
 */
export async function notifyTaskCancelled(
  env: Env,
  chatId: number,
  taskId: string,
  reason: string
): Promise<void> {
  await sendTG(env, chatId, [
    '🛑 *تم إلغاء المهمة*',
    '',
    `🆔 \`${taskId}\``,
    `📋 السبب: ${reason}`,
    '',
    'المهمة لم تكتمل. يمكنك بدء مهمة جديدة متى شئت.',
  ].join('\n'));
}

// ============ Helpers ============

function buildProgressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round(clamped / 5); // 20 chars total
  const empty = 20 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}
