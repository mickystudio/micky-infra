/**
 * Theme constants for Micky Assistant Montage Mode.
 * Dental brand identity: blue (primary), white (clean), yellow (highlights).
 */

export const MICKY_THEME = {
  // Brand palette
  brandBlue: '#0066FF',
  brandBlueDark: '#003D99',
  brandBlueLight: '#3D8BFF',
  white: '#FFFFFF',
  offWhite: '#F4F8FF',
  black: '#0A0A0A',
  // Caption colors (Hormozi-style)
  captionYellow: '#FFD700',
  captionYellowDark: '#FFB000',
  captionOutline: '#000000',
  // Status colors
  successGreen: '#00C853',
  warningAmber: '#FFB300',
  dangerRed: '#FF3B30',
  // Chapter colors
  chapterColors: ['#0066FF', '#00C853', '#FFB300', '#FF3B30', '#9C27B0'],
} as const;

/** Dental keyword → emoji triggers for caption highlighting. */
export const DENTAL_KEYWORD_EMOJIS: Record<string, string> = {
  // Arabic
  'تبييض': '✨',
  'زراعة': '🦷',
  'زرع': '🦷',
  'تقويم': '😁',
  'تنظيف': '🪥',
  'عصب': '🔴',
  'حشو': '🧷',
  'ابتسامة': '😁',
  'لثة': '👄',
  'ألم': '⚡',
  'تخدير': '💉',
  'زراعة الأسنان': '🦷',
  'ابتسامة هوليود': '✨',
  // English
  'whitening': '✨',
  'implant': '🦷',
  'braces': '😁',
  'cleaning': '🪥',
  'root canal': '🔴',
  'filling': '🧷',
  'smile': '😁',
  'gum': '👄',
  'pain': '⚡',
  'anesthesia': '💉',
};

/** Font stacks. */
export const FONTS = {
  /** Arabic display font (loaded from /assets/fonts/Cairo-Bold.ttf). */
  cairoBold: 'Cairo-Bold, Cairo, "Segoe UI", sans-serif',
  /** Arabic body font. */
  tajawal: 'Tajawal, Cairo, "Segoe UI", sans-serif',
  /** English display. */
  montserrat: 'Montserrat, "Segoe UI", sans-serif',
};

/** Default progress bar height in px. */
export const PROGRESS_BAR_HEIGHT = 6;
