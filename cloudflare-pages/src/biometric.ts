/**
 * biometric.ts — Telegram WebApp integration layer
 * -----------------------------------------------
 * Wraps `window.Telegram.WebApp` (loaded synchronously in index.html) and
 * provides typed helpers for biometric auth, theme params, and init data.
 *
 * Outside Telegram (e.g. local `vite dev`) every call degrades gracefully
 * and returns safe defaults so the editor still works in a normal browser.
 */

// Minimal typed shape of window.Telegram.WebApp (only the fields we use).
// The full type is huge; we declare what we touch.
export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  destructive_text_color?: string;
  header_bg_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  accent_text_color?: string;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      photo_url?: string;
    };
    auth_date?: number;
    hash?: string;
    start_param?: string;
  };
  version: string;
  platform: 'ios' | 'android' | 'web' | 'tdesktop' | 'unknown';
  colorScheme: 'light' | 'dark';
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  // Methods
  ready: () => void;
  expand: () => void;
  close: () => void;
  onEvent: (event: string, cb: () => void) => void;
  offEvent: (event: string, cb: () => void) => void;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
  BiometryManager?: {
    biometricType: 'finger' | 'face' | 'unknown';
    isBiometricTokenSaved: boolean;
    isAccessRequested: boolean;
    isAccessGranted: boolean;
    isBiometricAvailable: () => boolean;
    requestAccess: (params: { reason?: string }, cb: (r: { granted: boolean }) => void) => void;
    authenticate: (params: { reason?: string }, cb: (r: { isAuthenticated: boolean }) => void) => void;
    updateBiometricToken: (token: string, cb: (r: { saved: boolean }) => void) => void;
    openSettings: () => void;
  };
}

/** Get the TelegramWebApp instance (or null when not running inside Telegram). */
export function getTelegramWebApp(): TelegramWebApp | null {
  const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return tg ?? null;
}

/** Returns true when the page is opened inside the Telegram in-app browser. */
export function isTelegramWebApp(): boolean {
  return getTelegramWebApp() !== null;
}

/** Telegram passes the user's `initData` string which can be verified server-side. */
export function getTelegramInitData(): string | null {
  const tg = getTelegramWebApp();
  return tg?.initData ?? null;
}

/** Returns the Telegram user id (if inside Telegram) or null. */
export function getTelegramUser(): { id: number; first_name?: string; username?: string } | null {
  const tg = getTelegramWebApp();
  return tg?.initDataUnsafe?.user ?? null;
}

/** Returns the `start_param` from the deep link — Micky uses `?session=xxx`
 *  which Telegram surfaces as `tgWebAppStartParam=session_xxx`. */
export function getStartParam(): string | null {
  const tg = getTelegramWebApp();
  const fromTg = tg?.initDataUnsafe?.start_param;
  if (fromTg) return fromTg;
  // Fallback: read ?session=xxx from the URL (works outside Telegram too)
  const url = new URL(window.location.href);
  return url.searchParams.get('session');
}

// ---------------------------------------------------------------------------
// Biometric helpers
// ---------------------------------------------------------------------------

/** True when the Telegram WebApp BiometryManager exists AND reports availability. */
export function isBiometricAvailable(): boolean {
  const tg = getTelegramWebApp();
  if (!tg?.BiometryManager) return false;
  try {
    return tg.BiometryManager.isBiometricAvailable();
  } catch {
    return false;
  }
}

/** Request biometric access (prompts the user). Resolves to true if granted. */
export function requestBiometric(reason = 'تأكيد هويتك للوصول إلى محرر الصور'): Promise<boolean> {
  return new Promise((resolve) => {
    const tg = getTelegramWebApp();
    if (!tg?.BiometryManager) {
      resolve(false);
      return;
    }
    if (!isBiometricAvailable()) {
      resolve(false);
      return;
    }
    if (tg.BiometryManager.isAccessGranted) {
      resolve(true);
      return;
    }
    try {
      tg.BiometryManager.requestAccess({ reason }, (r: { granted: boolean }) => {
        resolve(!!r.granted);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Authenticate via biometric (Face ID / Touch ID). Resolves true on success. */
export function authenticateBiometric(reason = 'فتح المحرر'): Promise<boolean> {
  return new Promise((resolve) => {
    const tg = getTelegramWebApp();
    if (!tg?.BiometryManager || !isBiometricAvailable()) {
      resolve(false);
      return;
    }
    if (!tg.BiometryManager.isAccessGranted) {
      resolve(false);
      return;
    }
    try {
      tg.BiometryManager.authenticate({ reason }, (r: { isAuthenticated: boolean }) => {
        resolve(!!r.isAuthenticated);
      });
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Haptic feedback (nice-to-have)
// ---------------------------------------------------------------------------
export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  const tg = getTelegramWebApp();
  tg?.HapticFeedback?.impactOccurred(style);
}

export function hapticNotify(type: 'success' | 'warning' | 'error'): void {
  const tg = getTelegramWebApp();
  tg?.HapticFeedback?.notificationOccurred(type);
}

// ---------------------------------------------------------------------------
// Theme integration
// ---------------------------------------------------------------------------
export function applyTelegramTheme(): void {
  const tg = getTelegramWebApp();
  if (!tg) return;
  const root = document.documentElement;
  if (tg.themeParams?.bg_color) {
    root.style.setProperty('--tg-bg', tg.themeParams.bg_color);
    document.body.style.background = tg.themeParams.bg_color;
  }
  if (tg.themeParams?.text_color) {
    root.style.setProperty('--tg-text', tg.themeParams.text_color);
    document.body.style.color = tg.themeParams.text_color;
  }
  if (tg.themeParams?.button_color) {
    root.style.setProperty('--tg-button', tg.themeParams.button_color);
  }
  if (tg.themeParams?.button_text_color) {
    root.style.setProperty('--tg-button-text', tg.themeParams.button_text_color);
  }
}
