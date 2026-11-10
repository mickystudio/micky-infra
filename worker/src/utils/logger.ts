/**
 * Micky Assistant Unlimited - Structured Logger
 * ----------------------------------------------------------------------------
 * نظام تسجيل مهيكل (P2-T3 supporting infra)
 *
 * Two outputs:
 *   1. `log()`     → Workers console (visible in `wrangler tail`)
 *   2. `logToDb()` → D1 `system_logs` table (queryable, persistent)
 *
 * The convenience `logger` object wraps `log()` for terse call-sites:
 *
 *   logger.info('text_mode', 'streaming started', { chatId: 123 });
 *   await logToDb(env, 'warn', 'web_search', 'rate limited', { query });
 *
 * Design notes:
 *   - Logging is best-effort and never throws to the caller (DB writes are
 *     wrapped in try/catch and console.error is used for fallback).
 *   - Level filtering is applied for DB writes (default threshold: `info`)
 *     to avoid flooding D1 with `debug` rows.
 *   - Console output always goes through — `wrangler tail` already filters
 *     by level via the `LOG_LEVEL` var configured on the Worker.
 *
 * Created: 2026-11-10
 * Phase: P2-T3
 */

import type { Env } from '../index';

// ============ Types ============

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  component: string;
  message: string;
  meta?: Record<string, unknown>;
  timestamp: number;
}

// ============ Constants ============

/** Numeric priority used for level filtering (higher = more severe). */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Default log level assumed when env.LOG_LEVEL is missing or invalid. */
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

// ============ Helpers ============

/** Parse a string log level into a typed LogLevel (with fallback). */
function parseLevel(raw: string | undefined): LogLevel {
  if (!raw) return DEFAULT_LOG_LEVEL;
  const normalized = raw.toLowerCase().trim();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return DEFAULT_LOG_LEVEL;
}

/** True if `level` is at or above the configured threshold. */
function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[threshold];
}

/** Safe JSON.stringify — tolerates circular references and BigInt. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      return val;
    });
  } catch {
    return String(value);
  }
}

/** Format a log entry into a single human-readable line for the console. */
function formatConsoleLine(entry: LogEntry): string {
  const ts = new Date(entry.timestamp).toISOString();
  const prefix = `${ts} [${entry.level.toUpperCase()}] [${entry.component}]`;
  if (!entry.meta || Object.keys(entry.meta).length === 0) {
    return `${prefix} ${entry.message}`;
  }
  return `${prefix} ${entry.message} ${safeStringify(entry.meta)}`;
}

// ============ Public API ============

/**
 * Log to the Workers console (visible via `wrangler tail`).
 *
 * The console is the lowest-friction output: no DB writes, no network calls,
 * and resilient to any serialization issue. Level filtering is intentionally
 * NOT applied here so that all events are available when tailing logs; use
 * the wrangler-side `LOG_LEVEL` filter for tail-time control.
 *
 * @param level     Severity (debug | info | warn | error)
 * @param component Logical component name (e.g. "text_mode", "web_search")
 * @param message   Human-readable message
 * @param meta      Optional structured metadata (JSON-serialized in output)
 */
export function log(
  level: LogLevel,
  component: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const entry: LogEntry = {
    level,
    component,
    message,
    meta,
    timestamp: Date.now(),
  };

  const line = formatConsoleLine(entry);

  switch (level) {
    case 'debug':
      console.debug(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
      console.error(line);
      break;
  }
}

/**
 * Persist a log entry to the D1 `system_logs` table.
 *
 * Level filtering applies here (default threshold: `info`) to avoid
 * flooding D1 with `debug` rows. Set `LOG_LEVEL=debug` to capture everything.
 *
 * Failures (DB unavailable, malformed input) are silently swallowed and
 * surfaced only on the Workers console — logging must never crash callers.
 *
 * @returns `true` if the row was written, `false` on failure.
 */
export async function logToDb(
  env: Env,
  level: LogLevel,
  component: string,
  message: string,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  // Filter early to avoid the D1 round-trip for suppressed levels.
  const threshold = parseLevel(env.LOG_LEVEL);
  if (!shouldLog(level, threshold)) return false;

  try {
    await env.DB.prepare(
      'INSERT INTO system_logs (level, component, message, meta) VALUES (?, ?, ?, ?)',
    )
      .bind(
        level,
        component,
        message,
        meta ? safeStringify(meta) : null,
      )
      .run();
    return true;
  } catch (err) {
    // Logging must never throw to the caller — degrade to console.error.
    console.error(
      `[logger] D1 insert failed: ${String(err)} — original event:`,
      `[${level}] [${component}] ${message}`,
      meta ? safeStringify(meta) : '',
    );
    return false;
  }
}

// ============ Convenience wrapper ============

/**
 * Console-only convenience logger. Each method maps to `log()` with the
 * matching severity — use this for terse call-sites that don't need DB
 * persistence.
 *
 * For DB persistence, call `logToDb(env, ...)` explicitly.
 */
export const logger = {
  debug: (component: string, message: string, meta?: Record<string, unknown>): void =>
    log('debug', component, message, meta),
  info: (component: string, message: string, meta?: Record<string, unknown>): void =>
    log('info', component, message, meta),
  warn: (component: string, message: string, meta?: Record<string, unknown>): void =>
    log('warn', component, message, meta),
  error: (component: string, message: string, meta?: Record<string, unknown>): void =>
    log('error', component, message, meta),
};
