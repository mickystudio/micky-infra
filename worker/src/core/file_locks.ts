/**
 * Micky Assistant Unlimited - File Locks (Concurrency Control)
 * ----------------------------------------------------------------------------
 * أقفال الملفات (P1-T2 / P2-T1)
 *
 * Prevents two concurrent tasks from editing the same file at once.
 * Implementation uses the `LOCKS` KV namespace with TTL-based expiration.
 *
 * KV key format: `lock:{projectId}:{filePath}`
 * KV value: JSON `{ taskId, lockedAt, expiresAt }`
 * TTL: 900 seconds (15 minutes)
 *
 * Atomicity note: Cloudflare KV does NOT expose a true compare-and-swap
 * primitive. To minimise the race window we use a read-check-put-verify
 * pattern — if the verify step shows our `taskId` did not win the lock,
 * we report failure and the caller must retry or back off.
 *
 * Created: 2026-11-10
 */

import type { Env } from '../index';

// ============ Types ============

export interface FileLock {
  id: string;
  projectId: string;
  filePath: string;
  taskId: string;
  lockedAt: number;
  expiresAt: number;
}

/** Internal payload stored in KV. */
interface LockPayload {
  taskId: string;
  lockedAt: number;
  expiresAt: number;
}

// ============ Constants ============

/** Lock TTL in seconds (15 minutes). */
const LOCK_TTL_SECONDS = 900;

/** Same TTL expressed in milliseconds, used for `expiresAt` math. */
const LOCK_TTL_MS = LOCK_TTL_SECONDS * 1000;

/** KV key prefix for all file locks. */
const LOCK_KEY_PREFIX = 'lock:';

// ============ Helpers ============

/** Build the KV key for a (projectId, filePath) lock. */
function buildKey(projectId: string, filePath: string): string {
  return `${LOCK_KEY_PREFIX}${projectId}:${filePath}`;
}

/** Current Unix time in milliseconds (for expiry math). */
function nowMs(): number {
  return Date.now();
}

/** Safely parse a stored KV payload; returns null on any error. */
function parseLockPayload(raw: string | null): LockPayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof obj.taskId !== 'string' ||
      typeof obj.lockedAt !== 'number' ||
      typeof obj.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      taskId: obj.taskId,
      lockedAt: obj.lockedAt,
      expiresAt: obj.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Convert a parsed KV payload + key info into a public FileLock. */
function payloadToLock(
  projectId: string,
  filePath: string,
  payload: LockPayload,
): FileLock {
  return {
    id: buildKey(projectId, filePath),
    projectId,
    filePath,
    taskId: payload.taskId,
    lockedAt: payload.lockedAt,
    expiresAt: payload.expiresAt,
  };
}

// ============ Public API ============

/**
 * Try to acquire a lock on a file.
 *
 * Atomicity strategy (best-effort with KV):
 *   1. Read existing value for the key.
 *   2. If a non-expired lock exists, return false (locked by someone else).
 *   3. If expired or absent, write our lock with TTL.
 *   4. Re-read to verify we won the race (our taskId owns it).
 *   5. If verification fails, release our stray value and return false.
 *
 * يحاول قفل ملف لمدة 15 دقيقة. يُرجع true إذا نجح.
 *
 * @returns `true` if the caller now holds the lock, `false` otherwise.
 */
export async function acquireLock(
  env: Env,
  projectId: string,
  filePath: string,
  taskId: string,
): Promise<boolean> {
  if (!projectId || !filePath || !taskId) {
    return false;
  }

  const key = buildKey(projectId, filePath);

  // Step 1+2: read existing & check whether it's still alive
  try {
    const existing = parseLockPayload(await env.LOCKS.get(key));
    if (existing && existing.expiresAt > nowMs()) {
      // Lock is still held (possibly by the same task — caller should
      // explicitly release first or wait).
      return false;
    }
  } catch (err) {
    // KV read error: fail safe — do NOT acquire
    console.error('[file_locks] acquireLock read failed:', err);
    return false;
  }

  // Step 3: write our lock with TTL
  const lockedAt = nowMs();
  const expiresAt = lockedAt + LOCK_TTL_MS;
  const payload: LockPayload = { taskId, lockedAt, expiresAt };

  try {
    await env.LOCKS.put(key, JSON.stringify(payload), {
      expirationTtl: LOCK_TTL_SECONDS,
    });
  } catch (err) {
    console.error('[file_locks] acquireLock put failed:', err);
    return false;
  }

  // Step 4: verify we won the race
  try {
    const verify = parseLockPayload(await env.LOCKS.get(key));
    if (!verify || verify.taskId !== taskId) {
      // Another task raced ahead and won — clean up our stray write
      // (only if it's still ours; otherwise leave it alone).
      // Best-effort cleanup: skip if not ours.
      if (verify && verify.taskId === taskId) {
        try {
          await env.LOCKS.delete(key);
        } catch {
          /* ignore */
        }
      }
      return false;
    }
  } catch (err) {
    // Read-after-write failed; assume we hold it (KV is eventually consistent
    // — the write above has been acknowledged).
    console.warn('[file_locks] acquireLock verify failed, assuming held:', err);
  }

  return true;
}

/**
 * Release a lock.
 *
 * Safe to call multiple times or when no lock is held.
 *
 * يُحرّر القفل عن الملف
 */
export async function releaseLock(
  env: Env,
  projectId: string,
  filePath: string,
): Promise<void> {
  const key = buildKey(projectId, filePath);
  try {
    await env.LOCKS.delete(key);
  } catch (err) {
    console.error('[file_locks] releaseLock failed:', err);
  }
}

/**
 * Check whether a file is currently locked by any task.
 *
 * @returns `true` if there is a non-expired lock on the file.
 */
export async function isLocked(
  env: Env,
  projectId: string,
  filePath: string,
): Promise<boolean> {
  const key = buildKey(projectId, filePath);
  try {
    const payload = parseLockPayload(await env.LOCKS.get(key));
    if (!payload) return false;
    // KV TTL usually auto-deletes the key, but we double-check expiry for safety
    return payload.expiresAt > nowMs();
  } catch (err) {
    console.error('[file_locks] isLocked failed:', err);
    return false;
  }
}

/**
 * Get full lock info for a file.
 *
 * @returns The FileLock if a non-expired lock exists, `null` otherwise.
 */
export async function getLockInfo(
  env: Env,
  projectId: string,
  filePath: string,
): Promise<FileLock | null> {
  const key = buildKey(projectId, filePath);
  try {
    const payload = parseLockPayload(await env.LOCKS.get(key));
    if (!payload) return null;
    if (payload.expiresAt <= nowMs()) {
      // Stale — best-effort cleanup
      try {
        await env.LOCKS.delete(key);
      } catch {
        /* ignore */
      }
      return null;
    }
    return payloadToLock(projectId, filePath, payload);
  } catch (err) {
    console.error('[file_locks] getLockInfo failed:', err);
    return null;
  }
}

/**
 * Clean expired locks.
 *
 * KV TTL auto-expires keys, but values may linger due to eventual
 * consistency or edge cases. This function iterates all `lock:*` keys,
 * parses each, and deletes any whose `expiresAt` is in the past (or whose
 * value is unparseable).
 *
 * يُنظّف الأقفال المنتهية. يُرجع عدد ما حُذف.
 *
 * @returns Number of stale keys actually deleted.
 */
export async function cleanExpiredLocks(env: Env): Promise<number> {
  let cleaned = 0;
  let cursor: string | undefined;

  try {
    // Paginate through KV (Cloudflare returns up to 1000 keys per call)
    do {
      const listOpts: KVNamespaceListOptions = { prefix: LOCK_KEY_PREFIX };
      if (cursor) listOpts.cursor = cursor;
      const list = await env.LOCKS.list(listOpts);

      for (const k of list.keys ?? []) {
        const keyName = k.name;
        let shouldDelete = false;
        try {
          const raw = await env.LOCKS.get(keyName);
          const payload = parseLockPayload(raw);
          if (!payload) {
            shouldDelete = true; // corrupt entry
          } else if (payload.expiresAt <= nowMs()) {
            shouldDelete = true; // expired entry
          }
        } catch {
          shouldDelete = true; // read failed — assume stale
        }
        if (shouldDelete) {
          try {
            await env.LOCKS.delete(keyName);
            cleaned++;
          } catch (err) {
            console.warn('[file_locks] cleanExpiredLocks delete failed:', err);
          }
        }
      }

      cursor = list.list_complete ? undefined : (list.cursor ?? undefined);
    } while (cursor);
  } catch (err) {
    console.error('[file_locks] cleanExpiredLocks failed:', err);
  }

  return cleaned;
}
