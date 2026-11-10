/**
 * Micky Assistant Unlimited - Telegram Inline Keyboards
 *
 * Provides reusable inline keyboard markup builders for the bot UI.
 * All user-facing text is in Arabic (RTL-friendly).
 *
 * Created: 2026-11-10 (P1-T4)
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
}

// ============ Keyboard Builders ============

/**
 * Main menu keyboard — 4 mode buttons (Text / Code / Graphics / Montage)
 * plus Projects and Stats navigation rows.
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
 * Projects list keyboard. Each project gets an "open" button and a
 * trash-can "delete" button. The list is appended with a "new project"
 * shortcut and a back-to-main-menu button.
 */
export function projectsListKeyboard(projects: ProjectListItem[]): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = projects.map(p => [
    { text: `📁 ${p.name}`, callback_data: `project:open:${p.id}` },
    { text: '🗑️', callback_data: `project:del:${p.id}` },
  ]);

  rows.push([{ text: '➕ مشروع جديد', callback_data: 'project:new' }]);
  rows.push([{ text: '🔙 القائمة الرئيسية', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

/**
 * Chats list keyboard for a given project. Each non-archived chat gets an
 * "open" button and an "archive" button.
 */
export function chatListKeyboard(chats: ChatListItem[]): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = chats
    .filter(c => c.status !== 'archived')
    .map(c => [
      { text: `💬 ${c.title || modeLabel(c.mode as ChatMode)}`, callback_data: `chat:open:${c.id}` },
      { text: '📥 أرشفة', callback_data: `chat:archive:${c.id}` },
    ]);

  rows.push([{ text: '➕ محادثة جديدة', callback_data: 'chat:new' }]);
  rows.push([{ text: '🔙 رجوع للمشاريع', callback_data: 'menu:projects' }]);
  return { inline_keyboard: rows };
}

/**
 * Mode selector keyboard — used when creating a new chat.
 */
export function modeSelectorKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📝 نص', callback_data: 'newchat:text' },
        { text: '💻 كود', callback_data: 'newchat:code' },
      ],
      [
        { text: '🎨 صور', callback_data: 'newchat:graphics' },
        { text: '🎬 مونتاج', callback_data: 'newchat:montage' },
      ],
      [{ text: '❌ إلغاء', callback_data: 'op:cancel' }],
    ],
  };
}

/**
 * Cancel keyboard — single button. Attached to multi-step wizard states.
 */
export function cancelKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '❌ إلغاء', callback_data: 'op:cancel' }],
    ],
  };
}

/**
 * Confirmation keyboard — Yes / No for a parameterized action.
 * The `action` value is echoed back in the callback_data so the router
 * can route to the right confirmation handler.
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
