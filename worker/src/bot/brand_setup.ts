/**
 * Micky Assistant Unlimited - Brand Setup Wizard (Task B13)
 *
 * Interactive 4-step setup wizard that walks a new user through creating
 * their first brand profile. Wizard state persists in the LOCKS KV namespace
 * (1h TTL) so each incoming Telegram update is handled statelessly.
 *
 * Flow:
 *   Step 1 (logo):     "Send me your logo (or /skip)" — expects photo OR /skip
 *   Step 2 (colour):   inline keyboard, 8 presets — callback `brand:setup:color:#RRGGBB`
 *   Step 3 (font):     inline keyboard, 6 presets — callback `brand:setup:font:<Name>`
 *   Step 4 (platform): inline keyboard, 4 presets — callback `brand:setup:platform:<name>`
 *
 * On completion calls BrandProfileManager.createProfile + setActiveProfile.
 * The main router (src/index.ts) dispatches callbacks whose data starts with
 * `brand:setup:` to `handleBrandSetupCallback`, and photo replies to
 * `handleBrandSetupPhoto`.
 *
 * Created: 2026-11-13 (Task B13)
 */
import type { Env } from '../index';
import { createBrandProfileManager, type BrandProfileInput } from '../core/brand_profile';
import {
  cancelKeyboard,
  type TelegramInlineKeyboardMarkup,
  type TelegramInlineKeyboardButton,
} from './keyboards';

// ============ Constants ============

const WIZARD_TTL_SEC = 60 * 60; // 1 hour
const WIZARD_KEY_PREFIX = 'wizard:brand:';

/** Eight preset colours chosen for high contrast on video thumbnails. */
const COLOR_PRESETS: Array<{ label: string; hex: string }> = [
  { label: '🔴 أحمر', hex: '#FF5733' },
  { label: '🟠 برتقالي', hex: '#FFC300' },
  { label: '🟡 أصفر', hex: '#FFE500' },
  { label: '🟢 أخضر', hex: '#31E981' },
  { label: '🔵 أزرق', hex: '#1CA7EC' },
  { label: '🟣 بنفسجي', hex: '#8E44AD' },
  { label: '⚪ أبيض', hex: '#FFFFFF' },
  { label: '⚫ أسود', hex: '#000000' },
];

/** Font choices — Anton for English / Cairo / Tajawal for Arabic. */
const FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Anton (إنجليزي بولد)', value: 'Anton' },
  { label: 'Impact (إنجليزي ثقيل)', value: 'Impact' },
  { label: 'Cairo (عربي عصري)', value: 'Cairo' },
  { label: 'Tajawal (عربي نظيف)', value: 'Tajawal' },
  { label: 'Almarai (عربي احترافي)', value: 'Almarai' },
  { label: 'Amiri (عربي كلاسيكي)', value: 'Amiri' },
];

/** Default platform options. */
const PLATFORM_PRESETS: Array<{ label: string; value: string }> = [
  { label: '🎵 TikTok', value: 'tiktok' },
  { label: '▶️ YouTube', value: 'youtube' },
  { label: '📸 Instagram', value: 'instagram' },
  { label: '🎬 Reels', value: 'reels' },
];

// ============ Wizard state ============

export type BrandSetupStep = 'logo' | 'color' | 'font' | 'platform' | 'done';

export interface BrandSetupState {
  step: BrandSetupStep;
  userId: string;
  profileName: string;
  data: {
    logo_url: string | null;
    color_primary: string | null;
    font_primary: string | null;
    default_platform: string;
  };
}

// ============ Telegram helpers (local) ============

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

/** Send a markdown message with optional inline keyboard. */
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
    console.error('[brand_setup] sendMessage failed:', err);
  }
}

// ============ Wizard state persistence ============

async function setWizardState(env: Env, chatId: number, state: BrandSetupState): Promise<void> {
  await env.LOCKS.put(WIZARD_KEY_PREFIX + chatId, JSON.stringify(state), {
    expirationTtl: WIZARD_TTL_SEC,
  });
}

export async function getWizardState(env: Env, chatId: number): Promise<BrandSetupState | null> {
  const raw = await env.LOCKS.get(WIZARD_KEY_PREFIX + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BrandSetupState;
  } catch {
    return null;
  }
}

async function clearWizardState(env: Env, chatId: number): Promise<void> {
  await env.LOCKS.delete(WIZARD_KEY_PREFIX + chatId);
}

/** Returns true if a brand wizard is currently active for this chat. */
export async function hasActiveBrandWizard(env: Env, chatId: number): Promise<boolean> {
  const state = await getWizardState(env, chatId);
  return state !== null && state.step !== 'done';
}

// ============ Keyboards ============

/** 8-button colour-picker keyboard (4x2 grid) + skip row. */
function colorPickerKeyboard(): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < COLOR_PRESETS.length; i += 4) {
    const row: TelegramInlineKeyboardButton[] = COLOR_PRESETS.slice(i, i + 4).map(p => ({
      text: p.label,
      callback_data: `brand:setup:color:${p.hex}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '⏭️ تخطّي', callback_data: 'brand:setup:color:skip' }]);
  rows.push([{ text: '❌ إلغاء', callback_data: 'brand:setup:cancel' }]);
  return { inline_keyboard: rows };
}

/** Font picker keyboard. */
function fontPickerKeyboard(): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = FONT_PRESETS.map(f => [
    { text: f.label, callback_data: `brand:setup:font:${f.value}` },
  ]);
  rows.push([{ text: '⏭️ تخطّي', callback_data: 'brand:setup:font:skip' }]);
  rows.push([{ text: '❌ إلغاء', callback_data: 'brand:setup:cancel' }]);
  return { inline_keyboard: rows };
}

/** Platform picker keyboard. */
function platformPickerKeyboard(): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < PLATFORM_PRESETS.length; i += 2) {
    const row: TelegramInlineKeyboardButton[] = PLATFORM_PRESETS.slice(i, i + 2).map(p => ({
      text: p.label,
      callback_data: `brand:setup:platform:${p.value}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '❌ إلغاء', callback_data: 'brand:setup:cancel' }]);
  return { inline_keyboard: rows };
}

// ============ Public API ============

/**
 * Entry point — kicks off the wizard. `ctx` is optional and currently
 * unused inside the wizard; accepted for symmetry with the other handlers.
 */
export async function startBrandSetup(
  env: Env,
  ctx: ExecutionContext | undefined,
  chatId: number,
  profileName: string = 'default',
): Promise<void> {
  // Resolve the Telegram user id (numeric chat_id as text — matches the
  // user_id column convention used by the brand_profiles schema).
  const userId = String(chatId);

  const state: BrandSetupState = {
    step: 'logo',
    userId,
    profileName,
    data: {
      logo_url: null,
      color_primary: null,
      font_primary: null,
      default_platform: 'tiktok',
    },
  };
  await setWizardState(env, chatId, state);

  await sendTelegramMessage(
    env,
    chatId,
    [
      '🎨 *إعداد هوية بصرية جديدة*',
      '',
      'الخطوة 1/4 — أرسل لي شعارك (logo):',
      '',
      '• صورة PNG شفافة (موصى به)',
      '• أو صورة JPG عادية',
      '• الحد الأقصى 5 ميجابايت',
      '',
      'أرسل الصورة الآن، أو /skip للتخطّي.',
    ].join('\n'),
    cancelKeyboard(),
  );
}

/**
 * Handle an incoming photo during the wizard (step 1). Uploads to KV via
 * BrandProfileManager.uploadAsset and stores the KV key as logo_url.
 * Telegram sends multiple photo sizes; we pick the largest.
 */
export async function handleBrandSetupPhoto(
  env: Env,
  ctx: ExecutionContext | undefined,
  chatId: number,
  photos: Array<{ file_id: string; file_unique_id?: string; file_size?: number }>,
): Promise<void> {
  const state = await getWizardState(env, chatId);
  if (!state || state.step !== 'logo') return;  // not in logo step

  if (!photos.length) {
    await sendTelegramMessage(env, chatId, '⚠️ لم أستلم أي صورة. حاول مرة أخرى أو /skip.');
    return;
  }
  const largest = photos[photos.length - 1];  // Telegram orders sizes ascending

  // 1) Resolve Telegram file_path
  let fileUrl: string;
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(largest.file_id)}`,
    );
    const meta = (await metaRes.json()) as TelegramApiResponse & { result?: TelegramGetFileResult };
    if (!meta.ok || !meta.result?.file_path) {
      await sendTelegramMessage(env, chatId, `❌ تعذّر جلب الشعار: ${meta.description || 'unknown error'}`);
      return;
    }
    fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`;
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ خطأ أثناء تنزيل الشعار: ${String(err)}`);
    return;
  }

  // 2) Fetch the bytes
  let logoFile: File;
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      await sendTelegramMessage(env, chatId, `❌ فشل تنزيل الشعار (HTTP ${resp.status})`);
      return;
    }
    logoFile = new File([await resp.arrayBuffer()], `logo_${Date.now()}.png`, { type: 'image/png' });
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ خطأ أثناء قراءة الشعار: ${String(err)}`);
    return;
  }

  // 3) Upload to KV via BrandProfileManager
  const mgr = createBrandProfileManager(env);
  let kvKey: string;
  try {
    kvKey = await mgr.uploadAsset(state.userId, logoFile, 'logo');
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ فشل رفع الشعار: ${String(err)}`);
    return;
  }

  // Also persist an asset row so /brand list shows it (non-fatal).
  try {
    await mgr.addAsset(state.userId, {
      asset_type: 'logo',
      asset_name: logoFile.name,
      asset_url: kvKey,
      asset_meta: { mime_type: logoFile.type, size: logoFile.size },
    });
  } catch (err) {
    console.warn('[brand_setup] addAsset row failed (continuing):', err);
  }

  state.data.logo_url = kvKey;
  state.step = 'color';
  await setWizardState(env, chatId, state);

  await sendTelegramMessage(
    env, chatId,
    ['✅ تم استلام الشعار.', '', 'الخطوة 2/4 — اختر اللون الأساسي:'].join('\n'),
    colorPickerKeyboard(),
  );
}

/** Handle inline-keyboard callbacks from the wizard. Returns true if
 *  consumed (so the caller knows to answer the callback query). */
export async function handleBrandSetupCallback(
  env: Env,
  ctx: ExecutionContext | undefined,
  chatId: number,
  callbackData: string,
): Promise<boolean> {
  if (!callbackData.startsWith('brand:setup:')) return false;
  const state = await getWizardState(env, chatId);
  if (!state) return false;  // stale callback

  // Global cancel
  if (callbackData === 'brand:setup:cancel') {
    await clearWizardState(env, chatId);
    await sendTelegramMessage(env, chatId, '✅ تم إلغاء إعداد الهوية. أرسل /brand للبدء من جديد.');
    return true;
  }

  // Skip-from-logo: jump to colour picker without a logo.
  if (state.step === 'logo' && callbackData === 'brand:setup:color:skip') {
    state.step = 'color';
    await setWizardState(env, chatId, state);
    await sendTelegramMessage(env, chatId,
      ['⏭️ تخطّينا الشعار.', '', 'الخطوة 2/4 — اختر اللون الأساسي:'].join('\n'),
      colorPickerKeyboard());
    return true;
  }

  // Colour picker
  if (state.step === 'color' && callbackData.startsWith('brand:setup:color:')) {
    const value = callbackData.slice('brand:setup:color:'.length);
    if (value === 'skip') {
      state.step = 'font';
      await setWizardState(env, chatId, state);
      await sendTelegramMessage(env, chatId,
        ['⏭️ تخطّينا اللون.', '', 'الخطوة 3/4 — اختر الخط:'].join('\n'),
        fontPickerKeyboard());
      return true;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return true;  // invalid hex (stale preset)
    state.data.color_primary = value.toUpperCase();
    state.step = 'font';
    await setWizardState(env, chatId, state);
    await sendTelegramMessage(env, chatId,
      [`✅ اللون الأساسي: ${value.toUpperCase()}`, '', 'الخطوة 3/4 — اختر الخط:'].join('\n'),
      fontPickerKeyboard());
    return true;
  }

  // Font picker
  if (state.step === 'font' && callbackData.startsWith('brand:setup:font:')) {
    const value = callbackData.slice('brand:setup:font:'.length);
    if (value === 'skip') {
      state.step = 'platform';
      await setWizardState(env, chatId, state);
      await sendTelegramMessage(env, chatId,
        ['⏭️ تخطّينا الخط.', '', 'الخطوة 4/4 — المنصة الافتراضية؟'].join('\n'),
        platformPickerKeyboard());
      return true;
    }
    state.data.font_primary = value;
    state.step = 'platform';
    await setWizardState(env, chatId, state);
    await sendTelegramMessage(env, chatId,
      [`✅ الخط: ${value}`, '', 'الخطوة 4/4 — المنصة الافتراضية؟'].join('\n'),
      platformPickerKeyboard());
    return true;
  }

  // Platform picker → save profile & finish
  if (state.step === 'platform' && callbackData.startsWith('brand:setup:platform:')) {
    state.data.default_platform = callbackData.slice('brand:setup:platform:'.length);
    state.step = 'done';
    await setWizardState(env, chatId, state);
    await finishBrandSetup(env, chatId);
    return true;
  }

  return true;  // Stale / out-of-order callback — ignore.
}

/** Handle `/skip` during the wizard. At the logo step it skips to colour
 *  picker; at other steps it's a no-op (those use inline "تخطّي" buttons). */
export async function handleBrandSetupSkip(env: Env, chatId: number): Promise<boolean> {
  const state = await getWizardState(env, chatId);
  if (!state) return false;
  if (state.step === 'logo') {
    state.step = 'color';
    await setWizardState(env, chatId, state);
    await sendTelegramMessage(env, chatId,
      ['⏭️ تخطّينا الشعار.', '', 'الخطوة 2/4 — اختر اللون الأساسي:'].join('\n'),
      colorPickerKeyboard());
  }
  return true;  // at other steps, accept silently
}

// ============ Final persistence ============

/**
 * Persist the brand profile at the end of the wizard.  Idempotent — if a
 * profile with the same name already exists for this user, it is updated
 * instead of created.
 */
async function finishBrandSetup(env: Env, chatId: number): Promise<void> {
  const state = await getWizardState(env, chatId);
  if (!state) return;

  const input: BrandProfileInput = {
    name: state.profileName,
    logo_url: state.data.logo_url,
    color_primary: state.data.color_primary,
    font_primary: state.data.font_primary,
    default_platform: state.data.default_platform,
    default_style: 'bold_pop',
    watermark_position: 'bottom-right',
    watermark_opacity: 0.3,
  };

  const mgr = createBrandProfileManager(env);
  try {
    // Try create first; on duplicate (UNIQUE constraint) fall back to update.
    let profile;
    try {
      profile = await mgr.createProfile(state.userId, input);
    } catch (createErr) {
      // The RETURNING * returns null on UNIQUE conflict — surface as a
      // graceful update instead.
      console.warn('[brand_setup] createProfile failed, trying update:', createErr);
      profile = await mgr.updateProfile(state.userId, state.profileName, input);
    }
    await mgr.setActiveProfile(state.userId, state.profileName);

    await sendTelegramMessage(
      env,
      chatId,
      [
        '✅ *تم إنشاء هويتك البصرية!*',
        '',
        `🏷️ الاسم: \`${profile.name}\``,
        `🎨 اللون: ${profile.color_primary ?? '—'}`,
        `🔤 الخط: ${profile.font_primary ?? '—'}`,
        `📱 المنصة: ${profile.default_platform}`,
        profile.logo_url ? '🖼️ الشعار: ✅ مرفوع' : '🖼️ الشعار: —',
        '',
        'يمكنك تعديلها لاحقًا بـ:',
        '• `/brand set color_primary #FF5733`',
        '• `/brand font Cairo`',
        '• `/brand profile business` (لإنشاء ملف جديد)',
      ].join('\n'),
    );
  } catch (err) {
    console.error('[brand_setup] finishBrandSetup failed:', err);
    await sendTelegramMessage(
      env,
      chatId,
      `❌ فشل حفظ الهوية: ${String(err)}\nأرسل /brand للمحاولة مرة أخرى.`,
    );
  } finally {
    await clearWizardState(env, chatId);
  }
}
