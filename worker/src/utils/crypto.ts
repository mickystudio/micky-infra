/**
 * Micky Assistant Unlimited - Cryptographic Utilities
 *
 * Provides:
 *   - API key generation (micky_<43 url-safe chars>, 50 chars total)
 *   - SHA-256 hashing + constant-time verification for API keys
 *   - Cloudflare Access service token generation
 *   - Prefixed UUIDs for entity IDs
 *   - Password hashing (bcrypt via bcryptjs)
 *
 * Created: 2026-11-10
 * Phase: P3-T1
 */

import bcrypt from 'bcryptjs';

// ============ Constants ============

/** Prefix applied to every Micky API key. */
export const API_KEY_PREFIX = 'micky_';

/** Length of the random URL-safe portion (must be 43 to total 50 chars with prefix). */
const KEY_RANDOM_LENGTH = 43;

/** Total length of a fully-formed API key (prefix + random). */
export const API_KEY_TOTAL_LENGTH = API_KEY_PREFIX.length + KEY_RANDOM_LENGTH; // 50

/** URL-safe alphabet (RFC 4648 base64url without padding). */
const URL_SAFE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Length of a Cloudflare Access client ID (32 hex chars). */
const CF_ACCESS_CLIENT_ID_LENGTH = 32;

/** Length of a Cloudflare Access client secret (64 hex chars). */
const CF_ACCESS_CLIENT_SECRET_LENGTH = 64;

// ============ Internal helpers ============

/**
 * Fill a Uint8Array with cryptographically strong random bytes.
 * Uses WebCrypto's getRandomValues, available in the Workers runtime.
 */
function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * Encode raw bytes into a URL-safe base64 string (no padding).
 */
function bytesToUrlSafeBase64(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return s;
}

/**
 * Generate a random string of the given length from the supplied alphabet
 * using rejection sampling to avoid modulo bias.
 */
function randomStringFromAlphabet(length: number, alphabet: string): string {
  if (length <= 0) return '';
  const alphabetLen = alphabet.length;
  // Smallest bit mask that covers the alphabet length.
  let mask = 1;
  while (mask < alphabetLen) mask = (mask << 1) | 1;
  // Mask is now at least alphabetLen - 1.

  const out: string[] = new Array(length);
  const buf = randomBytes(length * 2); // over-sample to limit retries
  let idx = 0;
  let written = 0;
  while (written < length) {
    if (idx >= buf.length) {
      // Refill buffer if we exhausted it.
      crypto.getRandomValues(buf);
      idx = 0;
    }
    const byte = buf[idx++];
    if (byte > mask) continue; // rejection
    const ch = alphabet[byte % alphabetLen];
    out[written++] = ch;
  }
  return out.join('');
}

// ============ Public API: API Keys ============

/**
 * Generate a new Micky API key.
 *
 * Format: `micky_<43 url-safe chars>` → exactly 50 chars total.
 * The random portion is base64url-encoded bytes from WebCrypto.
 *
 * Example: `micky_a3B7c9D1kE8fG2hI4jK6lM8nO0pQ2rS4tU6vW8xY0zA1bC`
 */
export function generateApiKey(): string {
  // 32 random bytes → ~43 base64url chars (no padding).
  const raw = randomBytes(32);
  const b64 = bytesToUrlSafeBase64(raw);
  // Ensure we have at least 43 chars (32 bytes → 43 chars in base64url without padding).
  const randomPart = (b64 + randomStringFromAlphabet(KEY_RANDOM_LENGTH, URL_SAFE_ALPHABET))
    .slice(0, KEY_RANDOM_LENGTH);
  return `${API_KEY_PREFIX}${randomPart}`;
}

/**
 * Hash an API key using SHA-256 and return a lowercase hex digest.
 *
 * The full key is never persisted; only this hash is stored in D1.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Verify an API key against a stored SHA-256 hex hash.
 *
 * Uses a constant-time comparison to mitigate timing attacks.
 */
export async function verifyApiKey(apiKey: string, hash: string): Promise<boolean> {
  const computed = await hashApiKey(apiKey);
  return constantTimeEqual(computed, hash);
}

/**
 * Mask an API key for display (e.g., in Telegram lists).
 * `micky_a3B7c9...` → `micky_a3B7c9...`
 *
 * Keeps the prefix + first 6 random chars + ellipsis.
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    return '****';
  }
  const visible = apiKey.slice(0, API_KEY_PREFIX.length + 6);
  return `${visible}...`;
}

// ============ Public API: Cloudflare Access Tokens ============

/**
 * Generate a Cloudflare Access service token pair.
 *
 * Client ID  = 32 hex chars (prefixed `cf_access_id_`).
 * Client Secret = 64 hex chars (prefixed `cf_access_secret_`).
 *
 * These are sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`
 * headers and validated by Cloudflare Access in front of the Worker.
 */
export function generateAccessTokens(): { clientId: string; clientSecret: string } {
  const idBytes = randomBytes(CF_ACCESS_CLIENT_ID_LENGTH / 2); // 16 bytes → 32 hex
  const secretBytes = randomBytes(CF_ACCESS_CLIENT_SECRET_LENGTH / 2); // 32 bytes → 64 hex
  return {
    clientId: `cf_access_id_${bytesToHex(idBytes)}`,
    clientSecret: `cf_access_secret_${bytesToHex(secretBytes)}`,
  };
}

// ============ Public API: Prefixed IDs ============

/**
 * Generate a prefixed UUID-style identifier.
 *
 * Example: `generateId('key_')` → `key_a3b7c9d1-...`
 */
export function generateId(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

// ============ Public API: Password Hashing ============

/**
 * Hash a password using bcrypt.
 *
 * Uses cost factor 10 (suitable for interactive login on Workers).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Verify a password against a bcrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

// ============ Internal: helpers exposed for testing ============

/**
 * Convert a Uint8Array to lowercase hex.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Constant-time string comparison.
 * Returns true iff both strings are equal length and contain identical bytes.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
