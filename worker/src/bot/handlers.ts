/**
 * Micky Assistant Unlimited - Telegram Command Handlers
 *
 * Handlers for projects / chats / file uploads. Uses the Telegram Bot API
 * directly via fetch. All user-facing text is in Arabic (RTL-friendly).
 *
 * Created: 2026-11-10 (P1-T4)
 */

import type { Env } from '../index';
import {
  mainMenuKeyboard,
  projectsListKeyboard,
  chatListKeyboard,
  modeSelectorKeyboard,
  cancelKeyboard,
  confirmKeyboard,
  modeLabel,
  type TelegramInlineKeyboardMarkup,
  type ProjectListItem,
  type ChatListItem,
} from './keyboards';
import {
  createProject,
  listProjects,
  getProject,
  deleteProject,
  addProjectFile,
  listProjectFiles,
  type Project,
} from './projects';
import {
  createChat,
  listChats,
  archiveChat,
  type Chat,
} from './conversations';

// ============ Telegram Bot API types (subset) ============
interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

interface TelegramGetFileResult {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

// ============ Send Helpers ============

/** Send a text message (Markdown), optionally with an inline keyboard. */
async function sendTelegramMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: TelegramInlineKeyboardMarkup,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };
  if (keyboard) body.reply_markup = keyboard;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('sendTelegramMessage failed:', err);
  }
}

// ============ Handlers ============

/**
 * /projects — shows the list of Micky's projects with a "new project" button.
 * Falls back to a friendly empty state if no projects exist yet.
 */
export async function handleProjectsCommand(env: Env, chatId: number): Promise<void> {
  const userId = await getUserIdByChatId(env, chatId);
  if (!userId) {
    await sendTelegramMessage(env, chatId, '⚠️ المستخدم غير مصرّح. أرسل /start أولاً.');
    return;
  }

  const result = await listProjects(env, userId);
  if (!result.ok || !result.data) {
    await sendTelegramMessage(env, chatId, `❌ تعذّر جلب المشاريع:\n\`${result.error}\``);
    return;
  }

  const projects = result.data;
  if (projects.length === 0) {
    await sendTelegramMessage(
      env,
      chatId,
      [
        '📂 *مشاريعك*',
        '',
        'لا توجد مشاريع بعد.',
        'اضغط الزر أدناه لإنشاء أول مشروع:',
      ].join('\n'),
      projectsListKeyboard([]),
    );
    return;
  }

  const items: ProjectListItem[] = projects.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));

  await sendTelegramMessage(
    env,
    chatId,
    [
      '📂 *مشاريعك*',
      '',
      `العدد: *${projects.length}*`,
      'اضغط 📁 للفتح أو 🗑️ للحذف.',
    ].join('\n'),
    projectsListKeyboard(items),
  );
}

/**
 * /newproject — kicks off the project creation wizard.
 *
 * The wizard collects four fields (name, description, audience, tone).
 * Because the Telegram update handler is stateless per message, we use
 * the LOCKS KV namespace as a tiny session store keyed by chat_id.
 * Each subsequent user message is then routed to the wizard until
 * all fields are gathered.
 */
export async function handleNewProjectCommand(env: Env, chatId: number): Promise<void> {
  await setWizardState(env, chatId, {
    step: 'name',
    data: { name: '', description: '', audience: 'patients', tone: 'educational' },
  });

  await sendTelegramMessage(
    env,
    chatId,
    [
      '➕ *إنشاء مشروع جديد*',
      '',
      'الخطوة 1/4 — أرسل *اسم المشروع*:',
      '',
      '_مثال: عيادة تبييض الأسنان_',
    ].join('\n'),
    cancelKeyboard(),
  );
}

/**
 * Continues the project-creation wizard. Called by the main router when a
 * non-command text message arrives while a wizard state is active.
 */
export async function handleNewProjectWizardStep(
  env: Env,
  chatId: number,
  text: string,
): Promise<void> {
  const state = await getWizardState(env, chatId);
  if (!state) {
    await sendTelegramMessage(env, chatId, '⚠️ لا يوجد إنشاء مشروع نشط. أرسل /newproject للبدء.');
    return;
  }

  const trimmed = text.trim();

  switch (state.step) {
    case 'name': {
      if (!trimmed) {
        await sendTelegramMessage(env, chatId, '⚠️ الاسم لا يمكن أن يكون فارغًا. أرسل اسم المشروع:');
        return;
      }
      state.data.name = trimmed;
      state.step = 'description';
      await setWizardState(env, chatId, state);
      await sendTelegramMessage(
        env,
        chatId,
        [
          `✅ الاسم: *${trimmed}*`,
          '',
          'الخطوة 2/4 — أرسل *وصف المشروع*',
          '(أو أرسل "skip" لتجاوزها):',
        ].join('\n'),
        cancelKeyboard(),
      );
      return;
    }
    case 'description': {
      state.data.description = (trimmed.toLowerCase() === 'skip' || !trimmed) ? '' : trimmed;
      state.step = 'audience';
      await setWizardState(env, chatId, state);
      await sendTelegramMessage(
        env,
        chatId,
        [
          'الخطوة 3/4 — اختر *الجمهور المستهدف*:',
          '',
          '• `patients` — مرضى',
          '• `colleagues` — زملاء',
          '• `public` — عام',
          '',
          'أرسل إحدى الكلمات أعلاه:',
        ].join('\n'),
        cancelKeyboard(),
      );
      return;
    }
    case 'audience': {
      const valid = ['patients', 'colleagues', 'public'];
      if (!valid.includes(trimmed.toLowerCase())) {
        await sendTelegramMessage(env, chatId, '⚠️ قيمة غير صالحة. أرسل: patients / colleagues / public');
        return;
      }
      state.data.audience = trimmed.toLowerCase();
      state.step = 'tone';
      await setWizardState(env, chatId, state);
      await sendTelegramMessage(
        env,
        chatId,
        [
          'الخطوة 4/4 — اختر *النبرة*:',
          '',
          '• `educational` — تعليمية',
          '• `promotional` — تسويقية',
          '• `clinical` — سريرية',
          '',
          'أرسل إحدى الكلمات أعلاه:',
        ].join('\n'),
        cancelKeyboard(),
      );
      return;
    }
    case 'tone': {
      const valid = ['educational', 'promotional', 'clinical'];
      if (!valid.includes(trimmed.toLowerCase())) {
        await sendTelegramMessage(env, chatId, '⚠️ قيمة غير صالحة. أرسل: educational / promotional / clinical');
        return;
      }
      state.data.tone = trimmed.toLowerCase();
      await clearWizardState(env, chatId);
      await quickCreateProject(env, chatId, state.data);
      return;
    }
    default: {
      await clearWizardState(env, chatId);
      await sendTelegramMessage(env, chatId, '⚠️ حالة غير معروفة. أرسل /newproject للبدء من جديد.');
    }
  }
}

/** Cancels any active wizard state. */
export async function handleCancelWizard(env: Env, chatId: number): Promise<void> {
  await clearWizardState(env, chatId);
  await sendTelegramMessage(
    env,
    chatId,
    '✅ تم الإلغاء. أرسل /start للقائمة الرئيسية.',
    mainMenuKeyboard(),
  );
}

/** Actually creates the project once all wizard fields are collected. */
async function quickCreateProject(
  env: Env,
  chatId: number,
  params: { name: string; description: string; audience: string; tone: string },
): Promise<void> {
  const userId = await getUserIdByChatId(env, chatId);
  if (!userId) {
    await sendTelegramMessage(env, chatId, '⚠️ المستخدم غير مصرّح. أرسل /start أولاً.');
    return;
  }

  const result = await createProject(env, userId, params.name, params.description, params.audience, params.tone);
  if (!result.ok || !result.data) {
    await sendTelegramMessage(env, chatId, `❌ فشل إنشاء المشروع:\n\`${result.error}\``);
    return;
  }

  const project = result.data;
  await setCurrentProjectId(env, chatId, project.id);

  await sendTelegramMessage(
    env,
    chatId,
    [
      '✅ *تم إنشاء المشروع بنجاح!*',
      '',
      `🆔 \`${project.id}\``,
      `📁 الاسم: ${project.name}`,
      `📝 الوصف: ${project.description || '—'}`,
      `👥 الجمهور: ${project.audience}`,
      `🎭 النبرة: ${project.tone}`,
      '',
      'الآن يمكنك:',
      '• إنشاء محادثة جديدة عبر /newchat',
      '• رفع ملفات عبر إرسال مستند',
      '• العودة للقائمة عبر /start',
    ].join('\n'),
  );
}

/**
 * Shows project details + chats list (and a file count).
 * Sets the "current project" in session KV so subsequent file uploads go
 * into the right project.
 */
export async function handleProjectSelection(env: Env, chatId: number, projectId: string): Promise<void> {
  const projectResult = await getProject(env, projectId);
  if (!projectResult.ok || !projectResult.data) {
    await sendTelegramMessage(env, chatId, '❌ المشروع غير موجود.');
    return;
  }
  const project: Project = projectResult.data;

  // Persist as current project for subsequent operations (file upload, new chat).
  await setCurrentProjectId(env, chatId, projectId);

  const chatsResult = await listChats(env, projectId);
  if (!chatsResult.ok) {
    await sendTelegramMessage(env, chatId, `❌ تعذّر جلب المحادثات:\n\`${chatsResult.error}\``);
    return;
  }
  const chats: Chat[] = chatsResult.data ?? [];

  const filesResult = await listProjectFiles(env, projectId);
  const fileCount = filesResult.ok ? (filesResult.data?.length ?? 0) : 0;

  const items: ChatListItem[] = chats.map(c => ({
    id: c.id,
    mode: c.mode,
    title: c.title,
    status: c.status,
  }));

  const text = [
    '📁 *تفاصيل المشروع*',
    '',
    `🆔 \`${project.id}\``,
    `الاسم: ${project.name}`,
    `الوصف: ${project.description || '—'}`,
    `👥 الجمهور: ${project.audience || 'patients'}`,
    `🎭 النبرة: ${project.tone || 'educational'}`,
    `💬 المحادثات: ${chats.length}`,
    `📎 الملفات: ${fileCount}`,
    '',
    'اختر محادثة أو أنشئ واحدة جديدة:',
  ].join('\n');

  await sendTelegramMessage(env, chatId, text, chatListKeyboard(items));
}

/**
 * /newchat — creates a new chat in the *currently active* project
 * (or in `projectId` if explicitly provided). Asks the user to pick a mode.
 */
export async function handleNewChatCommand(
  env: Env,
  chatId: number,
  projectId?: string,
): Promise<void> {
  const pid = projectId ?? (await getCurrentProjectId(env, chatId));
  if (!pid) {
    await sendTelegramMessage(
      env,
      chatId,
      [
        '⚠️ *لا يوجد مشروع مفعّل*',
        '',
        'اختر مشروعًا أولًا:',
        '',
        '/projects ← افتح مشروعًا ← "محادثة جديدة"',
      ].join('\n'),
      cancelKeyboard(),
    );
    return;
  }

  const projectResult = await getProject(env, pid);
  if (!projectResult.ok || !projectResult.data) {
    await sendTelegramMessage(env, chatId, '❌ المشروع غير موجود.');
    return;
  }

  await sendTelegramMessage(
    env,
    chatId,
    [
      '💬 *محادثة جديدة*',
      '',
      `المشروع: ${projectResult.data.name}`,
      '',
      'اختر الوضع:',
      '📝 نص  •  💻 كود  •  🎨 صور  •  🎬 مونتاج',
    ].join('\n'),
    modeSelectorKeyboard(),
  );
}

/**
 * Called by the callback router after the user picks a mode in the
 * mode-selector keyboard. Creates the chat and acknowledges.
 */
export async function createChatWithMode(
  env: Env,
  chatId: number,
  mode: string,
  projectId?: string,
): Promise<void> {
  const pid = projectId ?? (await getCurrentProjectId(env, chatId));
  if (!pid) {
    await sendTelegramMessage(env, chatId, '⚠️ لا يوجد مشروع مفعّل. أرسل /projects لاختيار مشروع.');
    return;
  }

  const result = await createChat(env, pid, mode);
  if (!result.ok || !result.data) {
    await sendTelegramMessage(env, chatId, `❌ فشل إنشاء المحادثة:\n\`${result.error}\``);
    return;
  }

  const chat = result.data;
  await sendTelegramMessage(
    env,
    chatId,
    [
      '✅ *تم إنشاء المحادثة!*',
      '',
      `🆔 \`${chat.id}\``,
      `الوضع: ${modeLabel(chat.mode)}`,
      `العنوان: ${chat.title ?? '—'}`,
      `الحالة: ${chat.status}`,
      '',
      'ابدأ الكتابة الآن وسيرد المساعد.',
    ].join('\n'),
  );
}

/**
 * Handles incoming file/document uploads. Files are stored as a Telegram
 * URL reference initially; the queue consumer can later transfer them
 * to R2 (R2 binding is not declared in wrangler.toml yet).
 *
 * The handler requires a currently-active project (set via
 * handleProjectSelection). If none is active, the upload is rejected
 * with guidance.
 */
export async function handleFileUpload(env: Env, chatId: number, document: TelegramDocument): Promise<void> {
  const projectId = await getCurrentProjectId(env, chatId);
  if (!projectId) {
    await sendTelegramMessage(
      env,
      chatId,
      [
        '⚠️ *لا يوجد مشروع مفعّل*',
        '',
        'لاستقبال ملف، يجب أولًا اختيار مشروع:',
        '',
        '/projects ← اختر مشروعًا ← ثم أعد إرسال الملف',
      ].join('\n'),
      cancelKeyboard(),
    );
    return;
  }

  const fileId = document.file_id;
  const filename = document.file_name || `file_${Date.now()}`;
  const sizeBytes = document.file_size ?? 0;
  const mimeType = document.mime_type ?? '';
  const fileType = detectFileType(filename, mimeType);

  // Step 1: resolve the Telegram file_path (valid for ~1h).
  let fileUrl: string;
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    const meta = (await metaRes.json()) as TelegramApiResponse & { result?: TelegramGetFileResult };
    if (!meta.ok || !meta.result?.file_path) {
      await sendTelegramMessage(
        env,
        chatId,
        `❌ تعذّر جلب الملف من تليجرام: ${meta.description || 'unknown error'}`,
      );
      return;
    }
    fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`;
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ خطأ أثناء تنزيل الملف: ${String(err)}`);
    return;
  }

  // Step 2: store a reference in D1 (R2 transfer is a queue-consumer task).
  const addResult = await addProjectFile(
    env,
    projectId,
    fileType,
    filename,
    fileUrl,
    null, // extracted_text — populated later by the file-processing pipeline.
    sizeBytes,
    'telegram',
  );

  if (!addResult.ok || !addResult.data) {
    await sendTelegramMessage(env, chatId, `❌ فشل تخزين الملف:\n\`${addResult.error}\``);
    return;
  }

  await sendTelegramMessage(
    env,
    chatId,
    [
      '✅ *تم رفع الملف بنجاح*',
      '',
      `📎 الاسم: ${filename}`,
      `📦 النوع: ${fileType}`,
      `📏 الحجم: ${formatBytes(sizeBytes)}`,
      `🆔 \`${addResult.data.id}\``,
      '',
      'سيُستخرج النص لاحقًا ويُحقن تلقائيًا في محادثات هذا المشروع.',
    ].join('\n'),
  );
}

/** Pre-delete confirmation prompt. */
export async function handleDeleteProjectConfirm(env: Env, chatId: number, projectId: string): Promise<void> {
  const projectResult = await getProject(env, projectId);
  if (!projectResult.ok || !projectResult.data) {
    await sendTelegramMessage(env, chatId, '❌ المشروع غير موجود.');
    return;
  }
  await sendTelegramMessage(
    env,
    chatId,
    [
      '⚠️ *تأكيد الحذف*',
      '',
      `سيتم حذف المشروع: *${projectResult.data.name}*`,
      'كافة المحادثات والملفات المرتبطة ستُحذف نهائيًا.',
      '',
      'هل أنت متأكد؟',
    ].join('\n'),
    confirmKeyboard(`del_project:${projectId}`),
  );
}

/** Actually performs the project deletion after user confirms. */
export async function handleConfirmDelete(env: Env, chatId: number, projectId: string): Promise<void> {
  const result = await deleteProject(env, projectId);
  if (!result.ok) {
    await sendTelegramMessage(env, chatId, `❌ فشل الحذف:\n\`${result.error}\``);
    return;
  }
  // Clear the session pointer if it pointed to the deleted project.
  const current = await getCurrentProjectId(env, chatId);
  if (current === projectId) {
    await clearCurrentProjectId(env, chatId);
  }
  await sendTelegramMessage(
    env,
    chatId,
    '✅ تم حذف المشروع بنجاح. أرسل /projects لعرض القائمة المحدّثة.',
  );
}

/** Archives a chat (callback from chat list keyboard). */
export async function handleArchiveChat(env: Env, chatId: number, targetChatId: string): Promise<void> {
  const result = await archiveChat(env, targetChatId);
  if (!result.ok) {
    await sendTelegramMessage(env, chatId, `❌ فشل الأرشفة:\n\`${result.error}\``);
    return;
  }
  await sendTelegramMessage(env, chatId, '✅ تمت أرشفة المحادثة.');
}

// ============ Session / Wizard state (KV-backed) ============

interface ProjectWizardState {
  step: 'name' | 'description' | 'audience' | 'tone';
  data: {
    name: string;
    description: string;
    audience: string;
    tone: string;
  };
}

/**
 * We store wizard state in the LOCKS KV namespace with a 1h TTL.
 * (The env has only 4 KV namespaces; LOCKS is the closest fit for
 * short-lived per-chat state. PROMPT_CACHE is reserved for compiled
 * prompt caching; TASK_STATUS for task lifecycle; RATE_LIMITS for
 * counters.)
 */
const WIZARD_TTL_SEC = 60 * 60; // 1 hour
const WIZARD_KEY_PREFIX = 'wizard:newproject:';
const SESSION_PROJECT_KEY_PREFIX = 'session:';

async function setWizardState(env: Env, chatId: number, state: ProjectWizardState): Promise<void> {
  await env.LOCKS.put(WIZARD_KEY_PREFIX + chatId, JSON.stringify(state), {
    expirationTtl: WIZARD_TTL_SEC,
  });
}

async function getWizardState(env: Env, chatId: number): Promise<ProjectWizardState | null> {
  const raw = await env.LOCKS.get(WIZARD_KEY_PREFIX + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectWizardState;
  } catch {
    return null;
  }
}

async function clearWizardState(env: Env, chatId: number): Promise<void> {
  await env.LOCKS.delete(WIZARD_KEY_PREFIX + chatId);
}

/** Returns true if a wizard is currently active for this chat. */
export async function hasActiveWizard(env: Env, chatId: number): Promise<boolean> {
  const state = await getWizardState(env, chatId);
  return state !== null;
}

async function setCurrentProjectId(env: Env, chatId: number, projectId: string): Promise<void> {
  await env.LOCKS.put(
    `${SESSION_PROJECT_KEY_PREFIX}current_project:${chatId}`,
    projectId,
    { expirationTtl: 24 * 60 * 60 },
  );
}

async function getCurrentProjectId(env: Env, chatId: number): Promise<string | null> {
  return await env.LOCKS.get(`${SESSION_PROJECT_KEY_PREFIX}current_project:${chatId}`);
}

async function clearCurrentProjectId(env: Env, chatId: number): Promise<void> {
  await env.LOCKS.delete(`${SESSION_PROJECT_KEY_PREFIX}current_project:${chatId}`);
}

// ============ Internal helpers ============

async function getUserIdByChatId(env: Env, chatId: number): Promise<number | null> {
  try {
    const row = await env.DB.prepare(`SELECT id FROM users WHERE chat_id = ?`)
      .bind(chatId)
      .first<{ id: number }>();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Detects the project_file `type` from extension + MIME. */
function detectFileType(filename: string, mimeType: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) || mimeType.startsWith('image/')) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext) || mimeType.startsWith('video/')) return 'video';
  if (ext === 'md' || filename.endsWith('plan.md')) return 'plan_md';
  return 'text';
}

/** Human-readable byte size (e.g. "1.2 MB"). */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ============ /cancel — Cancel active task or wizard ============

export async function handleCancelCommand(env: Env, chatId: number, taskId?: string): Promise<void> {
  if (taskId) {
    // Cancel specific task by ID
    const task = await env.DB.prepare(
      'SELECT id, status, runner, runner_job_id FROM tasks WHERE id = ? AND chat_id = ?'
    ).bind(taskId, String(chatId)).first() as { id: string; status: string; runner: string | null; runner_job_id: string | null } | null;

    if (!task) {
      await sendTelegramMessage(env, chatId, `❌ لم يتم العثور على مهمة بالمعرّف: \`${taskId}\``);
      return;
    }

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      await sendTelegramMessage(env, chatId, `⚠️ المهمة \`${taskId}\` بالفعل في حالة: ${task.status}`);
      return;
    }

    // Update task to cancelled
    await env.DB.prepare(
      'UPDATE tasks SET status = ?, completed_at = ?, error_log = ? WHERE id = ?'
    ).bind('cancelled', Date.now() / 1000, 'cancelled by user', taskId).run();

    // If it was on Kaggle, try to stop the kernel
    if (task.runner === 'kaggle' && task.runner_job_id) {
      try {
        const { stopKaggleKernel } = await import('../runners/kaggle_runner');
        await stopKaggleKernel(env, task.runner_job_id);
      } catch (e) {
        console.error('Failed to stop Kaggle kernel:', e);
      }
    }

    await sendTelegramMessage(env, chatId, [
      '🛑 *تم إلغاء المهمة*',
      '',
      `🆔 \`${taskId}\``,
      `📍 الحالة السابقة: ${task.status}`,
      '✅ تم تحديثها إلى: cancelled',
      '',
      task.runner === 'kaggle' && task.runner_job_id ? `🔗 تم إيقاف Kaggle kernel: \`${task.runner_job_id}\`` : '',
    ].filter(Boolean).join('\n'));
    return;
  }

  // No task ID specified — cancel active wizard OR show active tasks
  const hasWizard = await hasActiveWizard(env, chatId);
  if (hasWizard) {
    await handleCancelWizard(env, chatId);
    return;
  }

  // List active tasks for this user
  const tasks = await env.DB.prepare(
    'SELECT id, type, status, queued_at FROM tasks WHERE chat_id = ? AND status IN (?) ORDER BY queued_at DESC LIMIT 5'
  ).bind(String(chatId), 'running').all();

  const activeTasks = (tasks.results || []) as Array<{ id: string; type: string; status: string; queued_at: number }>;

  if (activeTasks.length === 0) {
    await sendTelegramMessage(env, chatId, [
      '✅ *لا توجد مهام نشطة للإلغاء*',
      '',
      'جميع مهامك مكتملة أو ملغاة بالفعل.',
    ].join('\n'));
    return;
  }

  const lines = ['🛑 *مهام نشطة — اختر ما تريد إلغاءه*', ''];
  for (const t of activeTasks) {
    const ageMin = Math.floor((Date.now() / 1000 - t.queued_at) / 60);
    lines.push(`• \`${t.id}\` — ${t.type} (${t.status}, ${ageMin}min ago)`);
    lines.push(`  /cancel ${t.id}`);
  }
  await sendTelegramMessage(env, chatId, lines.join('\n'));
}

// ============ /settings — User settings ============

export async function handleSettingsCommand(env: Env, chatId: number): Promise<void> {
  // Fetch user settings from D1
  let settings: Record<string, unknown> | null = null;
  try {
    settings = await env.DB.prepare(
      'SELECT * FROM settings WHERE user_id = (SELECT id FROM users WHERE chat_id = ?)'
    ).bind(chatId).first() as Record<string, unknown> | null;
  } catch (e) {
    console.error('Settings query failed:', e);
  }

  const get = (key: string): unknown => (settings as Record<string, unknown> | null)?.[key];

  const lines = [
    '⚙️ *إعداداتك الحالية*',
    '',
    `🌐 اللغة: ${(get('language') as string) || 'ar'}`,
    `🎨 السمة: ${(get('theme') as string) || 'dark'}`,
    `🔔 الإشعارات: ${get('notifications') === false ? 'معطّلة' : 'مفعّلة'}`,
    `🎭 الجمهور الافتراضي: ${(get('default_audience') as string) || 'patients'}`,
    `🗣️ النبرة الافتراضية: ${(get('default_tone') as string) || 'educational'}`,
    `🤖 النموذج الافتراضي: ${(get('default_model') as string) || 'qwen2.5-coder-32b'}`,
    `🌡️ درجة الحرارة: ${(get('temperature') as number) ?? 0.4}`,
    '',
    '*للتعديل:*',
    '/settings lang ar|en — تغيير اللغة',
    '/settings theme dark|light — تغيير السمة',
    '/settings notify on|off — تفعيل/إلغاء الإشعارات',
    '/settings model qwen2.5-coder-32b|14b|7b — تغيير النموذج',
    '/settings temp 0.0-1.0 — ضبط درجة الحرارة',
    '',
    '🔐 /biometric — إعداد البصمة (WebApp)',
  ];
  await sendTelegramMessage(env, chatId, lines.join('\n'));
}

// ============ /biometric — Biometric enrollment (WebApp integration) ============

export async function handleBiometricCommand(env: Env, chatId: number, action?: string): Promise<void> {
  if (!action || action === 'status') {
    // Show current biometric enrollment status
    let enrolled = false;
    try {
      const user = await env.DB.prepare(
        'SELECT biometric_enrolled FROM users WHERE chat_id = ?'
      ).bind(chatId).first() as { biometric_enrolled?: number } | null;
      enrolled = (user?.biometric_enrolled ?? 0) === 1;
    } catch (e) {
      console.error('Biometric query failed:', e);
    }

    const lines = [
      '🔐 *البصمة الحيوية (Biometric)*',
      '',
      `الحالة الحالية: ${enrolled ? '✅ مُفعّلة' : '❌ غير مُفعّلة'}`,
      '',
      '*ما هي البصمة الحيوية؟*',
      '• تسجيل دخول سريع عبر بصمة الإصبع / الوجه',
      '• حماية إضافية لعمليات حساسة (مثل إنشاء API keys)',
      '• تعمل فقط عبر WebApp (لا يمكن تفعيلها من Telegram مباشرة)',
      '',
      '*للتفعيل:*',
      '1. افتح WebApp: https://micky-canvas.pages.dev',
      '2. سجّل الدخول بكلمة المرور',
      '3. اذهب إلى Settings → Security → Enable Biometric',
      '4. اتبع التعليمات على الشاشة',
      '',
      '*للإلغاء:*',
      '/biometric disable — إزالة البصمة (يلزم إعادة الإعداد لاحقًا)',
    ];
    await sendTelegramMessage(env, chatId, lines.join('\n'));
    return;
  }

  if (action === 'disable') {
    try {
      await env.DB.prepare(
        'UPDATE users SET biometric_enrolled = 0 WHERE chat_id = ?'
      ).bind(chatId).run();
      await sendTelegramMessage(env, chatId, '✅ تم تعطيل البصمة الحيوية بنجاح.');
    } catch (e) {
      await sendTelegramMessage(env, chatId, `❌ فشل التعطيل: ${String(e)}`);
    }
    return;
  }

  await sendTelegramMessage(env, chatId, [
    '❓ أمر غير معروف.',
    '',
    'الأوامر المتاحة:',
    '• /biometric — عرض الحالة',
    '• /biometric disable — تعطيل البصمة',
  ].join('\n'));
}

