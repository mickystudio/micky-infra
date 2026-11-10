/**
 * Micky Assistant - Scheduled Task Poller
 *
 * Triggered by Cloudflare Cron. Routes the cron trigger to the right handler:
 *   every 5 min   → Kaggle stale-task safety-net poll (this file).
 *   every 30 min  → gateway health-check cron (gateway/cron_handler.ts).
 *   daily midnight → gateway daily-quota reset (gateway/cron_handler.ts).
 *
 * The 5-min poll finds tasks stuck in "running" state for >5 min and asks
 * Kaggle for their real status. If the kernel has finished (complete /
 * error / cancelled) we update D1 + notify the user via Telegram. If the
 * kernel is still running or queued, we leave the task alone.
 *
 * This is a SAFETY NET — the primary update path is the kernel's webhook call.
 * See wrangler.toml `[triggers]` section and the `scheduled()` export in
 * src/index.ts which delegates to `handleScheduled(env, ctx, cron)` here.
 */

import type { Env } from './index';
import { checkKaggleStatus, getKaggleOutput, type KaggleStatus } from './runners/kaggle_runner';
import { invalidateTaskCache } from './core/state_machine';
import { dispatchGatewayCron } from './gateway/cron_handler';

// ============ Constants ============

/** Only poll tasks that have been "running" longer than this (seconds). */
const STALE_RUNNING_THRESHOLD_SECONDS = 5 * 60; // 5 minutes

// ============ Public Functions ============

/**
 * Cloudflare Cron entry point.
 *
 * Dispatches to the gateway cron handler first (health check + daily reset).
 * If the gateway handled it, returns immediately. Otherwise falls through
 * to the existing Kaggle stale-task poll (the 5-min safety net).
 *
 * NOTE on state machine: `transitionTask()` enforces `running -> {verifying,
 * failed, cancelled}` — it does NOT allow `running -> completed` directly.
 * The webhook handler in src/index.ts likewise bypasses the state machine
 * with a raw D1 UPDATE for the same reason. We follow the same pattern here
 * and call `invalidateTaskCache()` afterwards so the KV cache stays
 * consistent with D1.
 */
export async function handleScheduled(
  env: Env,
  ctx: ExecutionContext,
  cron: string,
): Promise<void> {
  // Gateway cron jobs (health check, daily reset) take precedence.
  const handled = await dispatchGatewayCron(cron, env, ctx);
  if (handled) return;

  // Default: 5-min Kaggle stale-task safety net.
  console.log(`[cron] handleScheduled started (trigger: ${cron})`);

  const staleBefore = Math.floor(Date.now() / 1000) - STALE_RUNNING_THRESHOLD_SECONDS;

  // Find tasks that have been "running" for more than 5 minutes.
  const result = await env.DB.prepare(
    'SELECT id, chat_id, type, runner, runner_job_id, queued_at FROM tasks WHERE status = ? AND queued_at < ?'
  )
    .bind('running', staleBefore)
    .all();

  const tasks = result.results as Array<{
    id: string;
    chat_id: string;
    type: string;
    runner: string | null;
    runner_job_id: string | null;
    queued_at: number;
  }>;

  console.log(`[cron] Found ${tasks.length} running tasks to check`);

  for (const task of tasks) {
    // Only poll Kaggle-runner tasks (not github-actions runners).
    if (task.runner !== 'kaggle') continue;
    if (!task.runner_job_id) {
      console.log(`[cron] Task ${task.id} has no runner_job_id — skipping`);
      continue;
    }

    // The runner_job_id is the kernel ref returned by dispatchToKaggle(),
    // e.g. "dentistmichaelnabil/micky-montage-abc123". checkKaggleStatus()
    // already knows how to talk to the Kaggle API with this id, so we
    // pass it through unchanged.
    const kernelId = task.runner_job_id;

    let kaggleStatus: KaggleStatus;
    try {
      kaggleStatus = await checkKaggleStatus(env, kernelId);
    } catch (err) {
      // Network/HTTP failure — don't kill the cron, just skip this task.
      console.error(`[cron] Could not get Kaggle status for task ${task.id}:`, err);
      continue;
    }

    console.log(`[cron] Task ${task.id} Kaggle status: ${kaggleStatus}`);

    if (kaggleStatus === 'complete') {
      // Fetch the kernel output (files + logs).
      let outputUrl = '';
      let outputMeta: Record<string, unknown> = {};
      try {
        const output = await getKaggleOutput(env, kernelId);
        outputUrl = output.files[0]?.url || '';
        outputMeta = {
          files: output.files.map((f) => f.filename),
          logs: output.logs.slice(0, 500),
        };
      } catch (e) {
        console.error(`[cron] Failed to get Kaggle output for task ${task.id}:`, e);
      }

      // Persist to D1 (bypassing transitionTask — see file header note).
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'UPDATE tasks SET status = ?, output_url = ?, output_meta = ?, completed_at = ? WHERE id = ?'
      )
        .bind('completed', outputUrl || null, JSON.stringify(outputMeta), now, task.id)
        .run();
      await invalidateTaskCache(env, task.id);

      // Notify the user that the task finished (detected via the safety net).
      const chatId = parseInt(task.chat_id, 10);
      if (!isNaN(chatId)) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: [
              '✅ *اكتملت معالجة الفيديو* (تم الكشف عبر الفحص الدوري)',
              '',
              `🆔 \`${task.id}\``,
              `📁 الناتج: ${outputUrl || '(لا يوجد رابط)'}`,
              '',
              '⚠️ ملاحظة: لم يصلنا webhook من Kaggle، لكن الفحص الدوري اكتشف الاكتمال.',
            ].join('\n'),
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        }).catch(() => {});
      }
    } else if (kaggleStatus === 'error' || kaggleStatus === 'cancelled') {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'UPDATE tasks SET status = ?, error_log = ?, completed_at = ? WHERE id = ?'
      )
        .bind('failed', `Kaggle kernel ${kaggleStatus}`, now, task.id)
        .run();
      await invalidateTaskCache(env, task.id);

      const chatId = parseInt(task.chat_id, 10);
      if (!isNaN(chatId)) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: [
              '❌ *فشلت معالجة الفيديو* (تم الكشف عبر الفحص الدوري)',
              '',
              `🆔 \`${task.id}\``,
              `⚠️ السبب: Kaggle kernel ${kaggleStatus}`,
              '',
              'حاول مرة أخرى بإرسال الفيديو من جديد.',
            ].join('\n'),
            parse_mode: 'Markdown',
          }),
        }).catch(() => {});
      }
    }
    // else: still running or queued — leave alone.
  }

  console.log('[cron] handleScheduled complete');
}
