import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import type { TelegramWebApp } from './biometric';

// Apply Telegram WebApp theme if available (set before React mounts so the
// initial paint uses the correct CSS variables).
const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
if (tg) {
  try {
    tg.ready();
    tg.expand();
    if (tg.colorScheme === 'dark') {
      document.documentElement.classList.add('dark');
    }
    if (tg.themeParams?.bg_color) {
      document.body.style.background = tg.themeParams.bg_color;
    }
    if (tg.themeParams?.text_color) {
      document.body.style.color = tg.themeParams.text_color;
    }
  } catch {
    /* Telegram WebApp may be unavailable in dev — ignore */
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
