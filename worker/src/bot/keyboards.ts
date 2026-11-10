/**
 * Micky Assistant Unlimited - Telegram Inline Keyboards
 *
 * Provides reusable inline keyboard markup builders for the bot UI.
 * All user-facing text is in Arabic (RTL-friendly).
 *
 * Callback-data routing convention (consumed by the worker's callback
 * router in `src/bot/handlers.ts` / `src/index.ts`):
 *
 *   `mode:<text|code|graphics|montage>`   — switch / pick a chat mode
 *   `menu:<main|projects|stats>`          — top-level navigation
 *   `project:<open|del|new>:<id>`         — project actions
 *   `chat:<open|archive|new|switch>:<id>` — chat actions
 *   `code:<new|list|parse|revoke>`        — code-mode (BYOK) actions
 *   `montage:<upload|settings|cancel>`    — montage-mode actions
 *   `task:<cancel|status|rerun>:<id>`     — async-task actions
 *   `confirm:<yes|no>:<action>`           — confirmation prompts
 *   `cancel:`                              — generic cancel
 *   `page:<projects|chats>:<n>`           — pagination navigation
 *
 * Created: 2026-11-10 (P1-T4)
 * Updated: 2026-11-12 (P1-T5: pagination + status indicators + mode keyboards)
 */

// ============ Telegram Bot API Types (subset) ============
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

// ============ Domain Types ============
export type ChatMode = 'text' | 'code' | 'graphics' | 'montage';

/** All valid chat modes — used to validate incoming callback_data. */
export const CHAT_MODES: readonly ChatMode[] = ['text', 'code', 'graphics', 'montage'] as const;

export interface ProjectListItem {
  id: string;
  name: string;
  description?: string | null;
}

export interface ChatListItem {
  id: string;
  mode: string;
  title?: string | null;
  status: string;
  /** Optional last-activity timestamp (seconds) for "X ago" labels. */
  last_activity?: number | null;
}

// ============ Pagination constants ============
/** Telegram inline keyboards allow up to 8 rows × 3 columns comfortably. */
export const PROJECTS_PER_PAGE = 8;
export const CHATS_PER_PAGE = 8;

// ============ Keyboard Builders ============

/**
 * Main menu keyboard — 4 mode buttons (Text / Code / Graphics / Montage)
 * plus Projects and Stats navigation rows.
 *
 * The mode buttons use `mode:<x>` callback_data so the same handler can
 * serve both the main menu and the mode-selector (the worker just opens
 * a chat in that mode).
 */
export function mainMenuKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📝 نص', callback_data: 'mode:text' },
        { text: '💻 كود', callback_data: 'mode:code' },
      ],
      [
        { text: '🎨 صور', callback_data: 'mode:graphics' },
        { text: '🎬 مونتاج', callback_data: 'mode:montage' },
      ],
      [
        { text: '📂 المشاريع', callback_data: 'menu:projects' },
        { text: '📊 الإحصائيات', callback_data: 'menu:stats' },
      ],
    ],
  };
}

/**
 * Mode selector keyboard — used when creating a new chat. Returns the
 * 4 mode buttons in a 2×2 grid plus a cancel button. Uses the canonical
 * `mode:<x>` callback_data so the worker routes it the same way as the
 * main-menu mode buttons.
 */
export function modeSelectorKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📝 نص', callback_data: 'mode:text' },
        { text: '💻 كود', callback_data: 'mode:code' },
      ],
      [
        { text: '🎨 صور', callback_data: 'mode:graphics' },
        { text: '🎬 مونتاج', callback_data: 'mode:montage' },
      ],
      [{ text: '❌ إلغاء', callback_data: 'cancel:' }],
    ],
  };
}

/**
 * Projects list keyboard — paginated, max 8 projects per page.
 *
 * Each project gets an "open" button and a "delete" button on the same
 * row. After the page rows the keyboard appends:
 *   • a "new project" shortcut,
 *   • a pagination row (prev / page indicator / next) — only when
 *     there is more than one page,
 *   • a "back to main menu" button.
 *
 * @param projects full list of projects for the user (pagination is
 *                 computed internally from `page`).
 * @param page     zero-indexed page number (default 0).
 */
export function projectsListKeyboard(
  projects: ProjectListItem[],
  page: number = 0,
): TelegramInlineKeyboardMarkup {
  const total = projects.length;
  const totalPages = Math.max(1, Math.ceil(total / PROJECTS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PROJECTS_PER_PAGE;
  const slice = projects.slice(start, start + PROJECTS_PER_PAGE);

  const rows: TelegramInlineKeyboardButton[][] = slice.map(p => [
    { text: `📁 ${truncate(p.name, 28)}`, callback_data: `project:open:${p.id}` },
    { text: '🗑️', callback_data: `project:del:${p.id}` },
  ]);

  rows.push([{ text: '➕ مشروع جديد', callback_data: 'project:new' }]);

  // Pagination row — only show when there is more than one page.
  if (totalPages > 1) {
    const pageBtns: TelegramInlineKeyboardButton[] = [];
    pageBtns.push({
      text: safePage === 0 ? '•' : '◀️ السابق',
      callback_data: safePage === 0 ? 'noop:' : `page:projects:${safePage - 1}`,
    });
    pageBtns.push({
      text: `${safePage + 1} / ${totalPages}`,
      callback_data: 'noop:',
    });
    pageBtns.push({
      text: safePage === totalPages - 1 ? '•' : 'التالي ▶️',
      callback_data: safePage === totalPages - 1 ? 'noop:' : `page:projects:${safePage + 1}`,
    });
    rows.push(pageBtns);
  }

  rows.push([{ text: '🔙 القائمة الرئيسية', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

/**
 * Chats list keyboard for a given project. Each non-archived chat gets
 * an "open" button (with mode + status indicators) and an "archive"
 * button. Archived chats are hidden from this list.
 *
 * Status indicator glyphs (Arabic RTL friendly):
 *   🟢 active      — chat is live and ready
 *   🟡 queued      — chat is waiting on the queue
 *   🔵 processing  — chat is currently producing a reply
 *   ⚫ archived    — (hidden by default)
 *
 * Mode indicator glyphs:
 *   📝 text  •  💻 code  •  🎨 graphics  •  🎬 montage
 *
 * @param chats full list of chats for the project (pagination is
 *              computed internally from `page`).
 * @param page  zero-indexed page number (default 0).
 */
export function chatListKeyboard(
  chats: ChatListItem[],
  page: number = 0,
): TelegramInlineKeyboardMarkup {
  const visible = chats.filter(c => c.status !== 'archived');
  const total = visible.length;
  const totalPages = Math.max(1, Math.ceil(total / CHATS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * CHATS_PER_PAGE;
  const slice = visible.slice(start, start + CHATS_PER_PAGE);

  const rows: TelegramInlineKeyboardButton[][] = slice.map(c => [
    {
      text: `${statusGlyph(c.status)} ${modeGlyph(c.mode)} ${c.title || modeLabel(c.mode as ChatMode)}`,
      callback_data: `chat:open:${c.id}`,
    },
    { text: '📥 أرشفة', callback_data: `chat:archive:${c.id}` },
  ]);

  rows.push([{ text: '➕ محادثة جديدة', callback_data: 'chat:new' }]);

  // Pagination row — only when there is more than one page.
  if (totalPages > 1) {
    rows.push([
      {
        text: safePage === 0 ? '•' : '◀️ السابق',
        callback_data: safePage === 0 ? 'noop:' : `page:chats:${safePage - 1}`,
      },
      { text: `${safePage + 1} / ${totalPages}`, callback_data: 'noop:' },
      {
        text: safePage === totalPages - 1 ? '•' : 'التالي ▶️',
        callback_data: safePage === totalPages - 1 ? 'noop:' : `page:chats:${safePage + 1}`,
      },
    ]);
  }

  rows.push([{ text: '🔙 رجوع للمشاريع', callback_data: 'menu:projects' }]);
  return { inline_keyboard: rows };
}

/**
 * Cancel keyboard — single button. Attached to multi-step wizard states
 * (e.g. project-creation wizard). The callback_data is the canonical
 * `cancel:` token (no payload).
 */
export function cancelKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '❌ إلغاء', callback_data: 'cancel:' }],
    ],
  };
}

/**
 * Confirmation keyboard — Yes / No for a parameterized action.
 *
 * The `action` value is echoed back in the callback_data as a suffix so
 * the router can dispatch to the correct confirmation handler. The
 * prefix (`confirm:yes` / `confirm:no`) is the canonical token; the
 * suffix carries the action context.
 *
 * Example: `confirmKeyboard('del_project:proj_abc')` produces buttons
 * with `confirm:yes:del_project:proj_abc` and `confirm:no:del_project:proj_abc`.
 */
export function confirmKeyboard(action: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ نعم', callback_data: `confirm:yes:${action}` },
        { text: '❌ لا', callback_data: `confirm:no:${action}` },
      ],
    ],
  };
}

// ============ Mode-specific keyboards ============

/**
 * Code-mode keyboard — shown when the user is inside a chat whose mode
 * is `code`. Provides quick access to BYOK key management and the
 * plan.md splitter.
 *
 *   🔑 New Key        → `code:new`
 *   📋 List Keys      → `code:list`
 *   🧩 Parse plan.md  → `code:parse`
 *   🗑️ Revoke         → `code:revoke`  (a follow-up prompt asks for the key id)
 *   🔙 Back to chat   → `menu:main`
 */
export function codeModeKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '🔑 مفتاح جديد', callback_data: 'code:new' },
        { text: '📋 قائمة المفاتيح', callback_data: 'code:list' },
      ],
      [
        { text: '🧩 تحليل plan.md', callback_data: 'code:parse' },
        { text: '🗑️ إلغاء مفتاح', callback_data: 'code:revoke' },
      ],
      [{ text: '🔙 القائمة الرئيسية', callback_data: 'menu:main' }],
    ],
  };
}

/**
 * Montage-mode keyboard — shown when the user is inside a chat whose
 * mode is `montage`.
 *
 *   🎬 Upload Video   → `montage:upload`   (prompts the user to send a video)
 *   ⚙️ Settings        → `montage:settings` (opens the montage settings wizard)
 *   ⛔ Cancel Current  → `montage:cancel`   (cancels the currently-running task)
 *   🔙 Back to chat    → `menu:main`
 */
export function montageModeKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🎬 رفع فيديو', callback_data: 'montage:upload' }],
      [
        { text: '⚙️ الإعدادات', callback_data: 'montage:settings' },
        { text: '⛔ إلغاء الحالي', callback_data: 'montage:cancel' },
      ],
      [{ text: '🔙 القائمة الرئيسية', callback_data: 'menu:main' }],
    ],
  };
}

/**
 * Per-task actions keyboard — attached to the message announcing a
 * queued / running async task (e.g. a montage job).
 *
 *   ❌ Cancel  → `task:cancel:<taskId>`
 *   📊 Status  → `task:status:<taskId>`
 *   🔄 Re-run  → `task:rerun:<taskId>`
 */
export function taskActionsKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '❌ إلغاء', callback_data: `task:cancel:${taskId}` },
        { text: '📊 الحالة', callback_data: `task:status:${taskId}` },
        { text: '🔄 إعادة التشغيل', callback_data: `task:rerun:${taskId}` },
      ],
    ],
  };
}

// ============ Helpers ============

/** Human-readable Arabic label for a chat mode. */
export function modeLabel(mode: ChatMode | string): string {
  switch (mode) {
    case 'text':     return 'محادثة نصية';
    case 'code':     return 'محادثة كود';
    case 'graphics': return 'محادثة صور';
    case 'montage':  return 'محادثة مونتاج';
    default:          return 'محادثة';
  }
}

/** Compact emoji glyph for a chat mode (used as a status prefix). */
export function modeGlyph(mode: ChatMode | string): string {
  switch (mode) {
    case 'text':     return '📝';
    case 'code':     return '💻';
    case 'graphics': return '🎨';
    case 'montage':  return '🎬';
    default:          return '💬';
  }
}

/** Status indicator glyph (colored circle) for a chat. */
export function statusGlyph(status: string): string {
  switch (status) {
    case 'active':      return '🟢';
    case 'queued':      return '🟡';
    case 'processing':  return '🔵';
    case 'archived':    return '⚫';
    case 'error':       return '🔴';
    case 'paused':      return '⏸️';
    default:            return '⚪';
  }
}

/** Truncates a string to `max` chars, appending an ellipsis if cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
