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
  multicamSyncKeyboard,
  multicamSwitchModeKeyboard,
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
import type { QueueMessage } from '../core/queue_manager';
// Task B13: brand profile + asset management.
import {
  createBrandProfileManager,
  MAX_LOGO_SIZE_BYTES,
  BrandProfileNotFoundError,
  BrandAssetTooLargeError,
  VALID_WATERMARK_POSITIONS,
  VALID_PLATFORMS,
  VALID_STYLES,
  type BrandProfile,
} from '../core/brand_profile';
import {
  startBrandSetup,
  hasActiveBrandWizard,
  getWizardState as getBrandWizardState,
} from './brand_setup';

/**
 * Validate / normalize a single `<field> <value>` for `/brand set`.
 * Returns `[true, normalizedValue]` or `[false, errorMessage]`.
 * Mirrors the columns accepted by BrandProfileManager.updateProfile.
 */
function tryNormalizeBrandField(
  field: string,
  value: string,
): [true, unknown] | [false, string] {
  const isHex = (v: string): boolean => /^#?[0-9A-Fa-f]{6}$/.test(v);
  const normHex = (v: string): string => {
    const h = v.startsWith('#') ? v : '#' + v;
    return h.toUpperCase();
  };
  switch (field) {
    case 'color_primary':
    case 'color_secondary':
    case 'color_accent':
      return isHex(value) ? [true, normHex(value)] : [false, `invalid hex (expected #RRGGBB): ${value}`];
    case 'watermark_position': {
      const v = value.toLowerCase();
      return (VALID_WATERMARK_POSITIONS as readonly string[]).includes(v)
        ? [true, v]
        : [false, `invalid position (valid: ${VALID_WATERMARK_POSITIONS.join(', ')})`];
    }
    case 'watermark_opacity': {
      const n = Number(value);
      return (isFinite(n) && n >= 0 && n <= 1)
        ? [true, n]
        : [false, 'opacity must be a number in [0.0, 1.0]'];
    }
    case 'default_platform': {
      const v = value.toLowerCase();
      return (VALID_PLATFORMS as readonly string[]).includes(v)
        ? [true, v]
        : [false, `invalid platform (valid: ${VALID_PLATFORMS.join(', ')})`];
    }
    case 'default_style': {
      const v = value.toLowerCase();
      return (VALID_STYLES as readonly string[]).includes(v)
        ? [true, v]
        : [false, `invalid style (valid: ${VALID_STYLES.join(', ')})`];
    }
    case 'font_primary':
    case 'font_secondary':
    case 'logo_url':
    case 'intro_video_url':
    case 'outro_video_url':
      return [true, value];
    default:
      return [false, `unknown field '${field}'`];
  }
}

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

// ============ B15: Multi-cam sync detection & prompt ============

/**
 * Called by the media router (`index.ts handleMediaMessage`) when a video
 * is received. Tracks per-chat pending video uploads within a 60s window.
 * When 2+ videos are detected, asks the user how to align them.
 *
 * Returns true if multi-cam mode was triggered (the caller should NOT
 * start a separate montage task in that case — the user must first pick
 * a sync + switch mode, after which `startMulticamMontage()` is called).
 */
export async function handleMulticamVideoUpload(
  env: Env,
  chatId: number,
  videoUrl: string,
  filename: string,
  sizeBytes: number,
  durationSec: number,
  messageId: number,
): Promise<boolean> {
  const now = Date.now();
  // Window: 60 seconds between first and last video in the group.
  const GROUP_WINDOW_MS = 60 * 1000;
  let state = await getMulticamPending(env, chatId);
  if (!state || (now - state.started_at) > GROUP_WINDOW_MS) {
    // Start a fresh pending group.
    state = {
      video_urls: [videoUrl],
      videos: [{
        url: videoUrl, filename, size_bytes: sizeBytes,
        duration_sec: durationSec, message_id: messageId,
      }],
      started_at: now,
    };
    await setMulticamPending(env, chatId, state);
    // Single video — don't prompt yet; wait for a potential second one.
    // (The caller will start a normal single-cam montage task if no
    // second video arrives within the window.)
    return false;
  }
  // Append to existing group.
  if (!state.video_urls.includes(videoUrl)) {
    state.video_urls.push(videoUrl);
    state.videos.push({
      url: videoUrl, filename, size_bytes: sizeBytes,
      duration_sec: durationSec, message_id: messageId,
    });
  }
  await setMulticamPending(env, chatId, state);

  if (state.video_urls.length >= 2) {
    await promptMulticamSync(env, chatId, state);
    return true;
  }
  return false;
}

/**
 * Sends the "Multi-cam detected!" prompt with the sync-method keyboard.
 * The callback_data is `multicam:sync:<method>` where method ∈
 * {auto, clap_detection, manual, skip}.
 */
async function promptMulticamSync(
  env: Env,
  chatId: number,
  state: MulticamPendingState,
): Promise<void> {
  const lines: string[] = [
    '🎬 *تم اكتشاف وضع Multi-Cam!*',
    '',
    `📹 عدد الكاميرات: *${state.video_urls.length}*`,
    '',
    '*الفيديوهات المُكتشفة:*',
  ];
  state.videos.forEach((v, i) => {
    const sizeMb = (v.size_bytes / 1024 / 1024).toFixed(1);
    const dur = v.duration_sec ? `${v.duration_sec}s` : '—';
    lines.push(`  ${i + 1}. \`${v.filename}\` (${sizeMb}MB, ${dur})`);
  });
  lines.push('');
  lines.push('*كيف تريد مزامنة الكاميرات؟*');
  lines.push('');
  lines.push('• 🎯 *توافق صوتي* — تحليل FFT cross-correlation (حتى 60s إزاحة)');
  lines.push('• 👏 *اكتشاف التصفيق* — دقّة عالية عند وجود clap/slate');
  lines.push('• ✏️ *إزاحة يدوية* — تُدخل الفارق الزمني لكل كاميرا');
  lines.push('• ⏭️ *تخطّي* — كل فيديو يُعالَج كمونتاج منفصل');

  await sendTelegramMessage(env, chatId, lines.join('\n'), multicamSyncKeyboard());
}

/**
 * Handles the user's sync-method choice (callback `multicam:sync:<method>`).
 *
 * For `auto` / `clap_detection`: immediately asks the user to pick a
 * switching mode (smart | round_robin | beat_sync | speaker) via
 * `multicamSwitchModeKeyboard()`.
 *
 * For `manual`: prompts the user to enter per-camera offsets as
 * "cam1:+2.5 cam2:-1.0" before continuing.
 *
 * For `skip`: clears the pending state and starts a separate montage
 * job for each video (single-cam path).
 */
export async function handleMulticamSyncChoice(
  env: Env,
  chatId: number,
  method: string,
): Promise<void> {
  const state = await getMulticamPending(env, chatId);
  if (!state || state.video_urls.length < 2) {
    await sendTelegramMessage(
      env, chatId,
      '⚠️ لا توجد فيديوهات multi-cam مُعلّقة. أعد إرسال الفيديوهات.',
      cancelKeyboard(),
    );
    return;
  }

  if (method === 'skip') {
    await clearMulticamPending(env, chatId);
    await sendTelegramMessage(
      env, chatId,
      [
        '⏭️ *تخطّي Multi-Cam*',
        '',
        `سيُعالَج كل فيديو (${state.video_urls.length}) كمونتاج مستقل.`,
        'سيبدأ المونتاج لكل فيديو على حدة.',
      ].join('\n'),
    );
    // The caller (queue) will process each video URL as its own montage task.
    return;
  }

  if (method === 'manual') {
    // Ask the user for per-camera offsets.
    await sendTelegramMessage(
      env, chatId,
      [
        '✏️ *إزاحة يدوية*',
        '',
        'أرسل الإزاحات بالصيغة التالية (ثوانٍ لكل كاميرا):',
        '`cam1:+2.5 cam2:-1.0 cam3:0.0`',
        '',
        'مثال: الكاميرا 2 تبدأ بعد 2.5 ثانية من الأولى.',
        'الكاميرا 3 تبدأ قبلها بثانية واحدة.',
        '',
        'أرسل الإزاحات الآن (أو `skip` لتخطّي الإزاحة اليدوية):',
      ].join('\n'),
      cancelKeyboard(),
    );
    // Stash the chosen sync method so the follow-up text handler knows
    // to expect offsets.
    await env.LOCKS.put(
      MULTICAM_KEY_PREFIX + 'method:' + chatId,
      JSON.stringify({ method: 'manual', video_count: state.video_urls.length }),
      { expirationTtl: MULTICAM_TTL_SEC },
    );
    return;
  }

  if (method !== 'auto' && method !== 'clap_detection' && method !== 'cross_correlation') {
    await sendTelegramMessage(env, chatId, `⚠️ طريقة مزامنة غير معروفة: \`${method}\``);
    return;
  }

  // Map UI label → pipeline alignment_method.
  const alignmentMethod = method === 'auto' ? 'auto' : method;
  // Stash the chosen sync method so the switch-mode handler can pick it up.
  await env.LOCKS.put(
    MULTICAM_KEY_PREFIX + 'method:' + chatId,
    JSON.stringify({ method: alignmentMethod, video_count: state.video_urls.length }),
    { expirationTtl: MULTICAM_TTL_SEC },
  );

  // Ask for switching mode.
  await sendTelegramMessage(
    env, chatId,
    [
      '✅ *طريقة المزامنة:* ' + (
        method === 'auto' ? 'توافق صوتي تلقائي' :
        method === 'clap_detection' ? 'اكتشاف التصفيق' : 'توافق صوتي'
      ),
      '',
      'الآن اختر *وضع التبديل بين الكاميرات*:',
      '',
      '• 🧠 *ذكي* — يختار أفضل كاميرا (وجوه + حركة + صوت)',
      '• 🔁 *تناوب* — تبديل كل N ثوانٍ',
      '• 🎵 *مع الإيقاع* — تبديل على نبضات الموسيقى',
      '• 🗣️ *المتحدّث النشط* — الكاميرا بصوت أعلى',
    ].join('\n'),
    multicamSwitchModeKeyboard(),
  );
}

/**
 * Handles the user's switching-mode choice (callback `multicam:mode:<x>`).
 *
 * Reads the previously-stored sync method from KV, then enqueues a single
 * montage task with `multicam_mode=<mode>` and `multicam_videos=<list>`.
 * The Kaggle runner picks up the task and runs the multi-cam pipeline.
 */
export async function handleMulticamSwitchModeChoice(
  env: Env,
  chatId: number,
  switchMode: string,
): Promise<void> {
  const valid = ['smart', 'round_robin', 'beat_sync', 'speaker'];
  if (!valid.includes(switchMode)) {
    await sendTelegramMessage(env, chatId, `⚠️ وضع غير معروف: \`${switchMode}\``);
    return;
  }

  const state = await getMulticamPending(env, chatId);
  if (!state || state.video_urls.length < 2) {
    await sendTelegramMessage(
      env, chatId,
      '⚠️ انتهت صلاحية جلسة multi-cam. أعد إرسال الفيديوهات.',
      cancelKeyboard(),
    );
    return;
  }

  // Pull the previously-chosen sync method.
  const methodRaw = await env.LOCKS.get(MULTICAM_KEY_PREFIX + 'method:' + chatId);
  let alignmentMethod = 'auto';
  if (methodRaw) {
    try {
      alignmentMethod = (JSON.parse(methodRaw) as { method: string }).method || 'auto';
    } catch { /* ignore */ }
  }

  // Enqueue a single montage task that includes the multi-cam options.
  // The first video is the "reference" (input_video_path); the rest are
  // passed as `multicam_videos`. The Kaggle runner downloads each URL
  // to a local path before invoking run_pipeline_from_spec.
  const taskId = crypto.randomUUID();
  const referenceUrl = state.video_urls[0];
  const otherUrls = state.video_urls.slice(1);
  const inputSpec = {
    file_url: referenceUrl,
    output_dir: `/tmp/micky_tasks/${taskId}`,
    multicam_mode: switchMode,
    multicam_videos: otherUrls,
    multicam_alignment_method: alignmentMethod,
    multicam_sync_preview: true,
    multicam_crossfade_sec: 0.3,
    platforms: ['instagram', 'tiktok', 'youtube', 'facebook', 'whatsapp'],
    language: 'ar',
    audience: 'patients',
  };
  try {
    await env.DB.prepare(
      'INSERT INTO tasks (id, chat_id, type, status, priority, input_spec, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      taskId, String(chatId), 'montage', 'queued', 5,
      JSON.stringify(inputSpec), Date.now() / 1000,
    ).run();
  } catch (e) {
    console.error('Failed to enqueue multicam task:', e);
  }
  try {
    await env.TASKS_QUEUE.send({
      type: 'montage',
      taskId,
      chatId,
      payload: inputSpec,
    } as QueueMessage);
  } catch (e) {
    console.error('Queue send failed (non-fatal):', e);
  }

  // Clear the pending state — we've handed off to the runner.
  await clearMulticamPending(env, chatId);
  await env.LOCKS.delete(MULTICAM_KEY_PREFIX + 'method:' + chatId);

  const modeLabels: Record<string, string> = {
    smart: '🧠 ذكي',
    round_robin: '🔁 تناوب',
    beat_sync: '🎵 مع الإيقاع',
    speaker: '🗣️ المتحدّث النشط',
  };
  await sendTelegramMessage(
    env, chatId,
    [
      '🎬 *بدأ Multi-Cam Montage!*',
      '',
      `📹 الكاميرات: ${state.video_urls.length}`,
      `🎯 المزامنة: ${alignmentMethod === 'auto' ? 'توافق صوتي تلقائي' : alignmentMethod}`,
      `🔁 التبديل: ${modeLabels[switchMode] || switchMode}`,
      '',
      `🆔 \`${taskId}\``,
      '',
      '⌛ المعالجة تستغرق عادةً 30-60 دقيقة.',
      'أرسل /cancel للإلغاء.',
    ].join('\n'),
  );
}

/**
 * Handles the user's manual-offset text input (after `multicam:sync:manual`).
 *
 * Parses strings like "cam1:+2.5 cam2:-1.0" into a list of offsets (one
 * per camera, in order). If parsing fails, asks again.
 *
 * NOTE: in this initial implementation, manual offsets are passed through
 * as `multicam_manual_offsets` in the input_spec; the Python pipeline
 * (B15) currently only supports audio-based alignment — manual offsets
 * are reserved for a future enhancement. For now, we fall back to
 * 'auto' alignment with the user's offsets as a hint.
 */
export async function handleMulticamManualOffsetText(
  env: Env,
  chatId: number,
  text: string,
): Promise<boolean> {
  const methodRaw = await env.LOCKS.get(MULTICAM_KEY_PREFIX + 'method:' + chatId);
  if (!methodRaw) return false;
  let methodInfo: { method: string; video_count: number };
  try {
    methodInfo = JSON.parse(methodRaw);
  } catch {
    return false;
  }
  if (methodInfo.method !== 'manual') return false;

  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'skip' || !trimmed) {
    // Fall back to auto alignment.
    await env.LOCKS.put(
      MULTICAM_KEY_PREFIX + 'method:' + chatId,
      JSON.stringify({ method: 'auto', video_count: methodInfo.video_count }),
      { expirationTtl: MULTICAM_TTL_SEC },
    );
    await sendTelegramMessage(
      env, chatId,
      [
        '⏭️ تخطّي الإزاحة اليدوية. سيُستخدم التوافق الصوتي التلقائي.',
        '',
        'اختر الآن *وضع التبديل*:',
      ].join('\n'),
      multicamSwitchModeKeyboard(),
    );
    return true;
  }

  // Parse "cam1:+2.5 cam2:-1.0 cam3:0.0"
  const offsets: number[] = [];
  const re = /cam(\d+):\s*([+-]?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const idx = parseInt(m[1], 10);
    const val = parseFloat(m[2]);
    while (offsets.length < idx) offsets.push(0);
    offsets[idx - 1] = val;
  }
  if (offsets.length === 0) {
    await sendTelegramMessage(
      env, chatId,
      '⚠️ تعذّر تحليل الإزاحات. مثال صحيح: `cam1:+2.5 cam2:-1.0`',
      cancelKeyboard(),
    );
    return true;
  }

  // Store the parsed offsets and proceed to switch-mode prompt.
  await env.LOCKS.put(
    MULTICAM_KEY_PREFIX + 'method:' + chatId,
    JSON.stringify({
      method: 'auto',  // pipeline currently only supports audio alignment;
                         // manual offsets are logged but not consumed yet.
      video_count: methodInfo.video_count,
      manual_offsets: offsets,
    }),
    { expirationTtl: MULTICAM_TTL_SEC },
  );
  await sendTelegramMessage(
    env, chatId,
    [
      `✅ تم تفسير الإزاحات: \`${JSON.stringify(offsets)}\``,
      '',
      '(_ملاحظة: الإزاحة اليدوية لا تزال تجريبية؛ سيُستخدم التوافق الصوتي_).',
      '',
      'اختر *وضع التبديل*:',
    ].join('\n'),
    multicamSwitchModeKeyboard(),
  );
  return true;
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

/**
 * B15: multi-cam pending uploads state. Stored in LOCKS KV with a 10-min TTL.
 * Keyed by chat_id, holds the list of video file URLs received in the same
 * message group (or within a 60s window). When the user picks a sync
 * method, the stored URLs are passed to the montage pipeline as
 * `multicam_videos`.
 */
const MULTICAM_TTL_SEC = 10 * 60; // 10 minutes
const MULTICAM_KEY_PREFIX = 'multicam:pending:';

interface MulticamPendingState {
  // Telegram file URLs (already resolved via getFile) collected so far.
  video_urls: string[];
  // Per-file metadata for display (filename, size, duration).
  videos: Array<{
    url: string;
    filename: string;
    size_bytes: number;
    duration_sec: number;
    message_id: number;
  }>;
  // Wall-clock timestamp (ms) of the first video in the group.
  started_at: number;
}

async function setMulticamPending(
  env: Env,
  chatId: number,
  state: MulticamPendingState,
): Promise<void> {
  await env.LOCKS.put(MULTICAM_KEY_PREFIX + chatId, JSON.stringify(state), {
    expirationTtl: MULTICAM_TTL_SEC,
  });
}

async function getMulticamPending(
  env: Env,
  chatId: number,
): Promise<MulticamPendingState | null> {
  const raw = await env.LOCKS.get(MULTICAM_KEY_PREFIX + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MulticamPendingState;
  } catch {
    return null;
  }
}

async function clearMulticamPending(env: Env, chatId: number): Promise<void> {
  await env.LOCKS.delete(MULTICAM_KEY_PREFIX + chatId);
}

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

// ============ /brand — Brand profile management (Task B13) ============
//
// Syntax:
//   /brand                              Show the active profile (or kick
//                                       off setup wizard if none).
//   /brand set <field> <value>          Update one field of the active profile.
//                                       Fields: color_primary, color_secondary,
//                                       color_accent, font_primary,
//                                       font_secondary, watermark_position,
//                                       watermark_opacity, default_platform,
//                                       default_style.
//   /brand logo                         Reply with a photo to upload a new
//                                       logo (replaces existing, ≤5 MB).
//   /brand font <name>                  Shortcut for `/brand set font_primary`.
//   /brand color <hex>                  Shortcut for `/brand set color_primary`.
//   /brand profile <name>               Switch active profile (creates a new
//                                       empty profile if the name doesn't
//                                       exist yet).
//   /brand list                         List all profiles for the current user.
//   /brand new [name]                   Kick off the interactive 4-step setup
//                                       wizard (defaults to name "default").
//   /brand delete <name>                Delete a profile (refuses to delete
//                                       the last remaining one).
//
// NOTE: the brand_profiles schema uses Telegram chat_id (as text) for the
// `user_id` column — see migration 0004_brand_assets.sql.  This matches
// the BrandProfileManager's setActiveProfile / fetchUserRow helpers which
// query `users WHERE chat_id = ?` directly (no JOIN to users.id).

/** KV key for "waiting for a photo to set as logo" wizard state. */
const BRAND_LOGO_KEY_PREFIX = 'wizard:brandlogo:';
const BRAND_LOGO_TTL_SEC = 5 * 60; // 5 minutes

interface BrandLogoPendingState {
  userId: string;
  profileName: string; // "default" if active is null
}

async function setBrandLogoPending(env: Env, chatId: number, s: BrandLogoPendingState): Promise<void> {
  await env.LOCKS.put(BRAND_LOGO_KEY_PREFIX + chatId, JSON.stringify(s), {
    expirationTtl: BRAND_LOGO_TTL_SEC,
  });
}

export async function getBrandLogoPending(env: Env, chatId: number): Promise<BrandLogoPendingState | null> {
  const raw = await env.LOCKS.get(BRAND_LOGO_KEY_PREFIX + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BrandLogoPendingState;
  } catch {
    return null;
  }
}

async function clearBrandLogoPending(env: Env, chatId: number): Promise<void> {
  await env.LOCKS.delete(BRAND_LOGO_KEY_PREFIX + chatId);
}

/**
 * Main `/brand` router.  `args` is the trimmed text after the command
 * (may be empty for plain `/brand`).
 */
export async function handleBrandCommand(
  env: Env,
  chatId: number,
  args: string,
): Promise<void> {
  // Brand profiles are keyed by the Telegram chat_id (as text).  We still
  // use getUserIdByChatId as the authorization guard (returns null if the
  // user isn't in the users table — i.e. hasn't gone through /start).
  const userInternalId = await getUserIdByChatId(env, chatId);
  if (!userInternalId) {
    await sendTelegramMessage(env, chatId, '⚠️ المستخدم غير مصرّح. أرسل /start أولاً.');
    return;
  }
  const userIdStr = String(chatId);
  const mgr = createBrandProfileManager(env);

  // No args → show active profile (or kick off setup wizard if none).
  if (!args || args.trim() === '') {
    const profile = await mgr.getActiveProfile(userIdStr);
    if (!profile) {
      // No active profile → launch the setup wizard.
      await startBrandSetup(env, undefined, chatId);
      return;
    }
    await sendTelegramMessage(env, chatId, formatBrandProfile(profile));
    return;
  }

  // Subcommand routing.
  const parts = args.trim().split(/\s+/);
  const sub = parts[0].toLowerCase();
  const rest = parts.slice(1);

  switch (sub) {
    case 'set':
      return handleBrandSet(env, chatId, userIdStr, rest);
    case 'logo':
      return handleBrandLogo(env, chatId, userIdStr, rest);
    case 'font':
      return handleBrandFont(env, chatId, userIdStr, rest);
    case 'color':
      return handleBrandColor(env, chatId, userIdStr, rest);
    case 'profile':
      return handleBrandProfileSwitch(env, chatId, userIdStr, rest);
    case 'list':
      return handleBrandList(env, chatId, userIdStr);
    case 'new':
      return handleBrandNew(env, chatId, rest);
    case 'delete':
      return handleBrandDelete(env, chatId, userIdStr, rest);
    case 'help':
    default:
      await sendTelegramMessage(env, chatId, [
        '🎨 *أوامر الهوية البصرية*',
        '',
        '• `/brand` — عرض الملف النشط',
        '• `/brand new [name]` — تشغيل معالج الإعداد',
        '• `/brand set <field> <value>` — تحديث حقل',
        '• `/brand logo` — رفع شعار جديد (صورة كرد)',
        '• `/brand font <name>` — تغيير الخط الأساسي',
        '• `/brand color <#hex>` — تغيير اللون الأساسي',
        '• `/brand profile <name>` — تبديل الملف النشط',
        '• `/brand list` — عرض كل الملفات',
        '• `/brand delete <name>` — حذف ملف',
        '',
        '*الحقول المتاحة في /brand set:*',
        '`color_primary`, `color_secondary`, `color_accent`,',
        '`font_primary`, `font_secondary`, `watermark_position`,',
        '`watermark_opacity`, `default_platform`, `default_style`',
      ].join('\n'));
      return;
  }
}

/** Format a BrandProfile for display. */
function formatBrandProfile(profile: BrandProfile): string {
  return [
    '🎨 *الهوية البصرية النشطة*',
    '',
    `🏷️ الاسم: \`${profile.name}\``,
    `🎨 اللون الأساسي: ${profile.color_primary ?? '—'}`,
    `🎨 اللون الثانوي: ${profile.color_secondary ?? '—'}`,
    `✨ اللون المميز: ${profile.color_accent ?? '—'}`,
    `🔤 الخط الأساسي: ${profile.font_primary ?? '—'}`,
    `🔤 الخط الثانوي: ${profile.font_secondary ?? '—'}`,
    `🖼️ الشعار: ${profile.logo_url ? '✅ مرفوع' : '—'}`,
    `🎬 Intro: ${profile.intro_video_url ? '✅' : '—'}`,
    `🎬 Outro: ${profile.outro_video_url ? '✅' : '—'}`,
    `💧 العلامة المائية: ${profile.watermark_position} (${(profile.watermark_opacity * 100).toFixed(0)}%)`,
    `📱 المنصة الافتراضية: ${profile.default_platform}`,
    `🎭 ستايل الترجمة: ${profile.default_style}`,
    '',
    'عدّل بـ: `/brand set <field> <value>`',
  ].join('\n');
}

/** `/brand set <field> <value>` handler. */
async function handleBrandSet(
  env: Env,
  chatId: number,
  userIdStr: string,
  rest: string[],
): Promise<void> {
  if (rest.length < 2) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ الاستخدام: `/brand set <field> <value>`\nمثال: `/brand set color_primary #FF5733`',
    );
    return;
  }
  const field = rest[0];
  const value = rest.slice(1).join(' '); // support values with spaces (e.g. font names)

  const [ok, result] = tryNormalizeBrandField(field, value);
  if (!ok) {
    await sendTelegramMessage(env, chatId, `❌ قيمة غير صالحة: ${result}`);
    return;
  }

  const mgr = createBrandProfileManager(env);
  const active = await mgr.getActiveProfile(userIdStr);
  if (!active) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ لا يوجد ملف هوية نشط. أرسل `/brand new` لإنشاء واحد أولاً.',
    );
    return;
  }

  try {
    const updated = await mgr.updateProfile(userIdStr, active.name, { [field]: result });
    await sendTelegramMessage(
      env,
      chatId,
      `✅ تم تحديث \`${field}\` في الملف \`${active.name}\`.`,
    );
    await sendTelegramMessage(env, chatId, formatBrandProfile(updated));
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ فشل التحديث: ${String(err)}`);
  }
}

/** `/brand logo` — set "waiting for photo" state; the photo reply is
 * consumed by `handleBrandLogoPhoto` in the main router. */
async function handleBrandLogo(
  env: Env,
  chatId: number,
  userIdStr: string,
  _rest: string[],
): Promise<void> {
  const mgr = createBrandProfileManager(env);
  const active = await mgr.getActiveProfile(userIdStr);
  const profileName = active?.name ?? 'default';

  await setBrandLogoPending(env, chatId, { userId: userIdStr, profileName });
  await sendTelegramMessage(
    env,
    chatId,
    [
      '🖼️ *رفع شعار جديد*',
      '',
      'أرسل الآن صورة الشعار (PNG موصى به، حد أقصى 5 ميجابايت).',
      'الصورة ستحلّ محل الشعار الحالي في الملف ' + `\`${profileName}\`.`,
      '',
      'للإلغاء، أرسل أي نص أو انتظر 5 دقائق.',
    ].join('\n'),
  );
}

/**
 * Consumes the next photo sent by the chat if there's a pending logo-upload
 * wizard state.  Returns true if consumed (so the caller skips the
 * default photo handler).
 */
export async function handleBrandLogoPhoto(
  env: Env,
  chatId: number,
  photos: Array<{ file_id: string; file_unique_id?: string; file_size?: number }>,
): Promise<boolean> {
  const pending = await getBrandLogoPending(env, chatId);
  if (!pending) return false;

  const mgr = createBrandProfileManager(env);
  const largest = photos[photos.length - 1];
  if (!largest) {
    await sendTelegramMessage(env, chatId, '⚠️ لم أستلم أي صورة. حاول مرة أخرى.');
    return true;
  }

  // Enforce 5 MB cap early.
  if (largest.file_size && largest.file_size > MAX_LOGO_SIZE_BYTES) {
    await clearBrandLogoPending(env, chatId);
    await sendTelegramMessage(
      env,
      chatId,
      `❌ حجم الصورة ${(largest.file_size / 1024 / 1024).toFixed(1)}MB يتجاوز الحد (5MB).`,
    );
    return true;
  }

  // 1) Resolve Telegram file_path.
  let fileUrl: string;
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(largest.file_id)}`,
    );
    const meta = (await metaRes.json()) as TelegramApiResponse & { result?: TelegramGetFileResult };
    if (!meta.ok || !meta.result?.file_path) {
      await sendTelegramMessage(
        env,
        chatId,
        `❌ تعذّر جلب الصورة: ${meta.description || 'unknown error'}`,
      );
      return true;
    }
    fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`;
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ خطأ أثناء تنزيل الصورة: ${String(err)}`);
    return true;
  }

  // 2) Fetch bytes.
  let logoFile: File;
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      await sendTelegramMessage(env, chatId, `❌ فشل التنزيل (HTTP ${resp.status})`);
      return true;
    }
    const buf = await resp.arrayBuffer();
    logoFile = new File([buf], `logo_${Date.now()}.png`, { type: 'image/png' });
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ خطأ أثناء القراءة: ${String(err)}`);
    return true;
  }

  // 3) Upload to KV.
  let kvKey: string;
  try {
    kvKey = await mgr.uploadAsset(pending.userId, logoFile, 'logo');
  } catch (err) {
    if (err instanceof BrandAssetTooLargeError) {
      await sendTelegramMessage(env, chatId, `❌ ${err.message}`);
    } else {
      await sendTelegramMessage(env, chatId, `❌ فشل رفع الشعار: ${String(err)}`);
    }
    await clearBrandLogoPending(env, chatId);
    return true;
  }

  // 4) Persist asset row (best-effort).
  try {
    await mgr.addAsset(pending.userId, {
      asset_type: 'logo',
      asset_name: logoFile.name,
      asset_url: kvKey,
      asset_meta: { mime_type: logoFile.type, size: logoFile.size },
    });
  } catch (err) {
    console.warn('[brand] addAsset logo row failed (continuing):', err);
  }

  // 5) Update the active profile (or create default if missing).
  try {
    let profile = await mgr.getProfile(pending.userId, pending.profileName);
    if (!profile) {
      // Create a minimal profile so the logo has somewhere to live.
      profile = await mgr.createProfile(pending.userId, {
        name: pending.profileName,
        logo_url: kvKey,
      });
    } else {
      profile = await mgr.updateProfile(pending.userId, pending.profileName, {
        logo_url: kvKey,
      });
    }
    await sendTelegramMessage(
      env,
      chatId,
      [
        '✅ *تم رفع الشعار بنجاح!*',
        '',
        `🏷️ الملف: \`${profile.name}\``,
        `🔑 KV key: \`${kvKey}\``,
        `📦 الحجم: ${formatBytes(logoFile.size)}`,
      ].join('\n'),
    );
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ فشل ربط الشعار بالملف: ${String(err)}`);
  } finally {
    await clearBrandLogoPending(env, chatId);
  }
  return true;
}

/** `/brand font <name>` — shortcut for `set font_primary`. */
async function handleBrandFont(
  env: Env,
  chatId: number,
  userIdStr: string,
  rest: string[],
): Promise<void> {
  if (rest.length < 1) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ الاستخدام: `/brand font <name>`\nمثال: `/brand font Cairo`',
    );
    return;
  }
  const fontName = rest.join(' ').trim();

  const mgr = createBrandProfileManager(env);
  const active = await mgr.getActiveProfile(userIdStr);
  if (!active) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ لا يوجد ملف هوية نشط. أرسل `/brand new` أولاً.',
    );
    return;
  }
  try {
    const updated = await mgr.updateProfile(userIdStr, active.name, { font_primary: fontName });
    await sendTelegramMessage(env, chatId, `✅ الخط الأساسي = \`${fontName}\``);
    await sendTelegramMessage(env, chatId, formatBrandProfile(updated));
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ فشل التحديث: ${String(err)}`);
  }
}

/** `/brand color <#hex>` — shortcut for `set color_primary`. */
async function handleBrandColor(
  env: Env,
  chatId: number,
  userIdStr: string,
  rest: string[],
): Promise<void> {
  if (rest.length < 1) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ الاستخدام: `/brand color <#RRGGBB>`\nمثال: `/brand color #FF5733`',
    );
    return;
  }
  // Reuse handleBrandSet's validation.
  return handleBrandSet(env, chatId, userIdStr, ['color_primary', ...rest]);
}

/** `/brand profile <name>` — switch active profile (or create new empty one). */
async function handleBrandProfileSwitch(
  env: Env,
  chatId: number,
  userIdStr: string,
  rest: string[],
): Promise<void> {
  if (rest.length < 1) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ الاستخدام: `/brand profile <name>`\nمثال: `/brand profile business`',
    );
    return;
  }
  const name = rest[0].trim();
  const mgr = createBrandProfileManager(env);

  // If the profile doesn't exist, create an empty one with sensible defaults.
  let profile = await mgr.getProfile(userIdStr, name);
  if (!profile) {
    try {
      profile = await mgr.createProfile(userIdStr, { name });
    } catch (err) {
      await sendTelegramMessage(env, chatId, `❌ فشل إنشاء الملف: ${String(err)}`);
      return;
    }
  }
  await mgr.setActiveProfile(userIdStr, name);
  await sendTelegramMessage(
    env,
    chatId,
    [
      '✅ *تم تبديل الملف النشط*',
      '',
      `🏷️ الاسم: \`${name}\``,
      `🎨 اللون: ${profile.color_primary ?? '—'}`,
      `🔤 الخط: ${profile.font_primary ?? '—'}`,
      `🖼️ الشعار: ${profile.logo_url ? '✅' : '—'}`,
    ].join('\n'),
  );
}

/** `/brand list` — list all profiles for the user. */
async function handleBrandList(env: Env, chatId: number, userIdStr: string): Promise<void> {
  const mgr = createBrandProfileManager(env);
  const [profiles, active] = await Promise.all([
    mgr.listProfiles(userIdStr),
    mgr.getActiveProfile(userIdStr),
  ]);
  if (profiles.length === 0) {
    await sendTelegramMessage(
      env,
      chatId,
      '📂 لا توجد ملفات هوية بعد. أرسل `/brand new` لإنشاء الأول.',
    );
    return;
  }
  const lines = ['🎨 *ملفات الهوية البصرية*', ''];
  for (const p of profiles) {
    const isActive = active?.name === p.name;
    const marker = isActive ? '▶️' : '⚪';
    lines.push(
      `${marker} \`${p.name}\` — ${p.color_primary ?? '—'} • ${p.font_primary ?? '—'} • ${p.logo_url ? '🖼️' : ''}`,
    );
  }
  lines.push('', 'للتبديل: `/brand profile <name>`');
  await sendTelegramMessage(env, chatId, lines.join('\n'));
}

/** `/brand new [name]` — kick off the interactive setup wizard. */
async function handleBrandNew(env: Env, chatId: number, rest: string[]): Promise<void> {
  const name = rest[0]?.trim() || 'default';
  await startBrandSetup(env, undefined, chatId, name);
}

/** `/brand delete <name>` — delete a profile (refuses to delete the last one). */
async function handleBrandDelete(
  env: Env,
  chatId: number,
  userIdStr: string,
  rest: string[],
): Promise<void> {
  if (rest.length < 1) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ الاستخدام: `/brand delete <name>`\nمثال: `/brand delete business`',
    );
    return;
  }
  const name = rest[0].trim();
  const mgr = createBrandProfileManager(env);

  const profiles = await mgr.listProfiles(userIdStr);
  if (profiles.length <= 1) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ لا يمكن حذف آخر ملف هوية. أنشئ ملفًا آخر أولاً بـ `/brand new`.',
    );
    return;
  }
  try {
    await mgr.deleteProfile(userIdStr, name);
    await sendTelegramMessage(env, chatId, `✅ تم حذف الملف \`${name}\`.`);
  } catch (err) {
    if (err instanceof BrandProfileNotFoundError) {
      await sendTelegramMessage(env, chatId, `❌ الملف \`${name}\` غير موجود.`);
    } else {
      await sendTelegramMessage(env, chatId, `❌ فشل الحذف: ${String(err)}`);
    }
  }
}

// Re-export the wizard helpers so the main router can dispatch to them.
export { hasActiveBrandWizard, getBrandWizardState };

// ============ /storyboard — Storyboard approval (Task B11) ============
//
// The storyboard command lets the user manually trigger a storyboard
// review for an existing montage task that's paused awaiting approval.
// If no paused task exists, it shows a help message.
//
// Syntax:
//   /storyboard                        Show help + look for any pending
//                                      storyboard for this chat.
//   /storyboard <task_id>             Force-show the storyboard for the
//                                      given task (must belong to this chat).
//   /approve                          Approve the most recent pending
//                                      storyboard (alias for clicking ✅).
//   /edit <take#> <description>       Edit a single take — free-text
//                                      description applied to the take.
//
// The actual callback_query routing (✅ / ✏️ / 🔄 buttons) is delegated
// to storyboard_handler.ts. This handler only covers the text-command
// entry points.

import {
  sendStoryboardForApproval as _sendStoryboardForApproval,
  handleStoryboardApproval as _handleStoryboardApproval,
  handleStoryboardEdit as _handleStoryboardEdit,
  isStoryboardCallback as _isStoryboardCallback,
  hasActiveStoryboardEdit as _hasActiveStoryboardEdit,
  getActiveStoryboardEdit as _getActiveStoryboardEdit,
  type TelegramCallbackQuery as _TgCallbackQuery,
} from './storyboard_handler';

/**
 * /storyboard — show help or re-send a pending storyboard image.
 *
 * The actual photo sending happens in storyboard_handler.ts once the
 * Kaggle runner posts the storyboard JSON; this command is mostly a
 * fallback when the user closed the chat and lost the original photo.
 */
export async function handleStoryboardCommand(
  env: Env, chatId: number, taskId?: string,
): Promise<void> {
  if (taskId) {
    // Look up the task to verify ownership + check if it has a pending
    // storyboard. We don't re-render; we just notify the user where to
    // find the existing storyboard image (stored as task.output_meta).
    let task: { id: string; status: string; chat_id: string } | null = null;
    try {
      task = await env.DB.prepare(
        'SELECT id, status, chat_id FROM tasks WHERE id = ? AND chat_id = ?'
      ).bind(taskId, String(chatId)).first() as { id: string; status: string; chat_id: string } | null;
    } catch (e) {
      console.error('storyboard task lookup failed:', e);
    }
    if (!task) {
      await sendTelegramMessage(env, chatId, `❌ لا توجد مهمة بالمعرّف \`${taskId}\` مرتبطة بحسابك.`);
      return;
    }
    await sendTelegramMessage(env, chatId, [
      '🎬 *حالة لوحة القصة*',
      '',
      `🆔 المهمة: \`${task.id}\``,
      `📍 الحالة: ${task.status}`,
      '',
      'إذا كانت المهمة متوقفة بانتظار الموافقة، يجب أن تكون قد استلمت صورة',
      'لوحة القصة عبر رسالة سابقة مع أزرار inline.',
      '',
      'استخدم الأزرار تحت الصورة للموافقة أو التعديل.',
    ].join('\n'));
    return;
  }

  await sendTelegramMessage(env, chatId, [
    '🎬 *لوحة القصة (Storyboard)*',
    '',
    'ما هي؟ صورة شبكية تعرض كل المشاهد المختارة قبل الـ render النهائي،',
    'مع زر ✅ موافقة و ✏️ تعديل و 🔄 إعادة توليد.',
    '',
    '*متى تظهر؟*',
    '• تلقائيًا بعد اختيار المشاهد (Stage 2) في pipeline المونتاج.',
    '• صلاحية لوحة القصة 30 دقيقة فقط.',
    '',
    '*الأوامر:*',
    '• `/storyboard <task_id>` — استعلام عن حالة لوحة قصة لمهمة محددة.',
    '• `/approve` — الموافقة على آخر لوحة قصة نشطة.',
    '• `/edit <رقم> <وصف>` — تعديل مشهد محدد.',
    '',
    '💡 لا تحتاج لهذا الأمر عادةً — تظهر الأزرار تلقائيًا.',
  ].join('\n'));
}

/** /approve — convenience alias for clicking the ✅ button on the most
 *  recent pending storyboard for this chat. */
export async function handleApproveCommand(env: Env, chatId: number): Promise<void> {
  // Find the most recent pending storyboard for this chat by scanning the
  // LOCKS KV namespace. We can't list keys by chat_id directly, so we
  // rely on a side-channel: the `storyboard:pending:<chat_id>` pointer
  // set by the Kaggle runner when it posts the storyboard JSON.
  const token = await env.LOCKS.get(`storyboard:pending:${chatId}`);
  if (!token) {
    await sendTelegramMessage(env, chatId, [
      '⚠️ لا توجد لوحة قصة نشطة حاليًا.',
      '',
      'أرسل /montage لبدء مشروع مونتاج جديد.',
    ].join('\n'));
    return;
  }
  // Re-route through the storyboard handler's approve path.
  await _handleStoryboardApproval(env, { waitUntil: async () => {} } as unknown as ExecutionContext, {
    id: 'manual-' + Date.now(),
    data: `sb:approve:${token}`,
    message: { message_id: 0, chat: { id: chatId, type: 'private' } },
  } as _TgCallbackQuery);
}

/** /edit — convenience alias for clicking an ✏️ button.
 *  Syntax: /edit <take#> <free-text description> */
export async function handleEditCommand(
  env: Env, chatId: number, args: string,
): Promise<void> {
  const trimmed = (args || '').trim();
  if (!trimmed) {
    await sendTelegramMessage(env, chatId, [
      '⚠️ الاستخدام: `/edit <رقم> <وصف>`',
      '',
      'مثال: `/edit 3 اجعل المشهد أقصر`',
    ].join('\n'));
    return;
  }
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    await sendTelegramMessage(env, chatId, '⚠️ يجب تضمين وصف بعد رقم المشهد.');
    return;
  }
  const takeNum = parseInt(trimmed.slice(0, spaceIdx), 10);
  const description = trimmed.slice(spaceIdx + 1).trim();
  if (!Number.isFinite(takeNum) || takeNum < 1) {
    await sendTelegramMessage(env, chatId, '⚠️ رقم المشهد يجب أن يكون عددًا موجبًا.');
    return;
  }
  if (!description) {
    await sendTelegramMessage(env, chatId, '⚠️ الوصف لا يمكن أن يكون فارغًا.');
    return;
  }

  // Find the most recent pending storyboard token for this chat.
  const token = await env.LOCKS.get(`storyboard:pending:${chatId}`);
  if (!token) {
    await sendTelegramMessage(env, chatId, '⚠️ لا توجد لوحة قصة نشطة حاليًا للتعديل.');
    return;
  }

  // Set up the edit_state in KV so handleStoryboardEdit can validate.
  const takeIdx = takeNum - 1;
  try {
    await env.LOCKS.put(
      `storyboard:edit_state:${chatId}`,
      JSON.stringify({ token, take_idx: takeIdx }),
      { expirationTtl: 10 * 60 },
    );
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ فشل إعداد حالة التعديل: ${String(err)}`);
    return;
  }

  const ctx = { waitUntil: async () => {} } as unknown as ExecutionContext;
  await _handleStoryboardEdit(env, ctx, chatId, takeIdx, description);
}

/**
 * Routes a Telegram callback_query to the storyboard handler if its
 * callback_data starts with `sb:`. Returns true if it handled the
 * callback, false if the callback is for some other subsystem.
 *
 * Called by the main router (index.ts) for every incoming
 * `callback_query` update.
 */
export async function routeCallbackQuery(
  env: Env, ctx: ExecutionContext, callbackQuery: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat?: { id: number; type: string }; text?: string };
    inline_message_id?: string;
  },
): Promise<boolean> {
  if (!_isStoryboardCallback(callbackQuery.data)) {
    return false;
  }
  const result = await _handleStoryboardApproval(
    env, ctx, callbackQuery as _TgCallbackQuery,
  );
  // Ack the callback query so Telegram stops showing the loading spinner.
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: result.answerText || undefined,
        show_alert: !result.ok && !!result.error,
      }),
    });
  } catch (err) {
    console.error('answerCallbackQuery failed:', err);
  }
  return true;
}

/** Returns true if this chat has a pending storyboard edit wizard
 *  (i.e. waiting for free-text input). Used by the main router to
 *  intercept the next message and route it to handleStoryboardEdit. */
export async function hasActiveStoryboardEdit(env: Env, chatId: number): Promise<boolean> {
  return _hasActiveStoryboardEdit(env, chatId);
}

/** Returns the active storyboard edit state (token + take_idx) for a
 *  chat, or null if none. */
export async function getActiveStoryboardEdit(
  env: Env, chatId: number,
): Promise<{ token: string; take_idx: number } | null> {
  return _getActiveStoryboardEdit(env, chatId);
}

/** Re-export so index.ts can call sendStoryboardForApproval directly
 *  when the Kaggle runner posts storyboard JSON. */
export const sendStoryboardForApproval = _sendStoryboardForApproval;
export const handleStoryboardEdit = _handleStoryboardEdit;

