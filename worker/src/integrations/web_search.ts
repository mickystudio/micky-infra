/**
 * Micky Assistant Unlimited - Web Search Integration
 * ----------------------------------------------------------------------------
 * تكامل البحث في الويب (P2-T3)
 *
 * Free web search via DuckDuckGo's HTML endpoint — no API key, no rate-limit
 * account, no billing. Falls back to Bing scraping if DDG fails or rate-limits.
 * Used by Text Mode to inject up-to-date information into the LLM prompt when
 * the user asks about current events, prices, or anything time-sensitive.
 *
 * Pipeline:
 *
 *   user message
 *      │
 *      ▼
 *   needsWebSearch(message)  ───no──▶ skip search entirely
 *      │ yes
 *      ▼
 *   webSearch(env, query, 5)
 *      │                          →  check PROMPT_CACHE KV (1h TTL)
 *      │                          →  POST DuckDuckGo HTML
 *      │                          →  parse `result__a` + `result__snippet`
 *      │                          →  unwrap duckduckgo.com/l/?uddg= redirects
 *      │                          →  on DDG failure: scrape Bing as fallback
 *      ▼
 *   formatSearchContext()      →  Markdown block injected into the user turn
 *
 * Created: 2026-11-10
 * Phase: P2-T3
 */

import type { Env } from '../index';
import { logger } from '../utils/logger';

// ============ Types ============

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  /** The original query string. */
  query: string;
  /** Parsed top-N results. */
  results: SearchResult[];
  /** Number of results returned (== results.length, kept for compat). */
  total_found: number;
  /** Epoch ms when this response was cached (or freshly produced). */
  cached_at: number;
}

// ============ Constants ============

/** DuckDuckGo HTML endpoint (no API key required). */
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

/** Bing search endpoint (fallback when DDG fails). */
const BING_SEARCH_URL = 'https://www.bing.com/search';

/**
 * User-Agent used for the DDG/Bing requests.
 * A real-looking browser UA avoids the "empty results" bot heuristic
 * that DDG sometimes applies to generic `fetch` default UAs.
 */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MickyAssistant/1.0';

/** Default cap on the number of results returned by `webSearch`. */
const DEFAULT_MAX_RESULTS = 5;

/** Cache TTL for search responses stored in PROMPT_CACHE KV (1 hour). */
const CACHE_TTL_SECONDS = 3600;

/**
 * Time-sensitive keywords that trigger a web search.
 *
 * Arabic keywords come first (Micky primarily writes Arabic), then English.
 * Each entry is matched case-insensitively as a substring of the message.
 */
const TIME_SENSITIVE_KEYWORDS: readonly string[] = [
  // Arabic: temporal
  'اليوم',
  'الآن',
  'الان',
  'حاليًا',
  'حاليا',
  'حالياً',
  'أحدث',
  'احدث',
  'جديد',
  'الأخيرة',
  'الاخيرة',
  'آخر',
  'اخر',
  'أخبار',
  'اخبار',
  'تحديث',
  'تطور',
  'سعر',
  'أسعار',
  'اسعار',
  'حالة',
  'وضع',
  'الطقس',
  'النتيجة',
  'متأخر',
  'متقدم',
  // English: temporal
  'latest',
  'today',
  'current',
  'recent',
  'now',
  'news',
  'updated',
  'price',
  'prices',
  'cost',
  'stock',
  'weather',
  'score',
  'trending',
  'rate',
  'live',
  // Years (current + future window)
  '2024',
  '2025',
  '2026',
  '2027',
];

// ============ Internal helpers ============

/**
 * Build a stable, KV-safe cache key from a search query.
 *
 * Workers don't expose Node's `Buffer`, so we can't use the
 * `Buffer.from(query).toString('base64')` trick. Instead we hash the
 * lowercased query with the Web Crypto SHA-256 (available in Workers) and
 * take the first 16 hex bytes — collision-resistant enough for a 1-hour
 * cache, and the resulting key is pure ASCII (KV-safe regardless of input).
 */
async function makeCacheKey(query: string): Promise<string> {
  const lower = query.toLowerCase().trim();
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(lower),
    );
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return `websearch:${hex.slice(0, 40)}`;
  } catch {
    // Fallback: KV allows up to 512 bytes — truncated lowercased query works.
    return `websearch:${lower.slice(0, 200)}`;
  }
}

/**
 * Strip HTML tags and decode the most common entities.
 * Used to normalize DuckDuckGo's and Bing's HTML-escaped titles/snippets.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ') // any other numeric entity → space
    .trim();
}

/**
 * Unwrap a DuckDuckGo redirect URL of the form
 * `//duckduckgo.com/l/?uddg=<encoded-real-url>&rut=...`.
 *
 * Returns the original target URL when possible; otherwise the input URL
 * itself (resolved against the duckduckgo.com origin).
 */
function unwrapDdgUrl(rawHref: string): string {
  try {
    // DuckDuckGo relative hrefs often start with `//` (protocol-relative).
    const url = new URL(rawHref, 'https://duckduckgo.com');

    // Redirect-wrap shape: pathname `/l/` + `?uddg=<encoded-url>`
    if (url.pathname === '/l/') {
      const uddg = url.searchParams.get('uddg');
      if (uddg) {
        try {
          return decodeURIComponent(uddg);
        } catch {
          return uddg;
        }
      }
    }

    return url.toString();
  } catch {
    // Not a parseable URL — return as-is.
    return rawHref;
  }
}

/**
 * Parse DuckDuckGo HTML results page.
 *
 * Result blocks have the rough shape:
 *
 *   <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded>">Title</a>
 *   <a class="result__snippet">Snippet text…</a>
 *
 * The two anchors are siblings inside a `<div class="result">` container.
 * We collect all `result__a` matches and pair each with the next
 * `result__snippet` match by document order.
 */
function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match all `result__a` anchors: capture (href, innerHtml).
  const linkRegex =
    /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Match all `result__snippet` anchors: capture (innerHtml).
  const snippetRegex =
    /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  // Collect snippets first in document order so we can pair them by index
  // with link matches (DDG reliably emits one snippet per result).
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1]));
  }

  let snippetIdx = 0;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const rawHref = linkMatch[1];
    const title = stripHtml(linkMatch[2]);
    if (!title) {
      snippetIdx++; // keep snippet pairing aligned even on empty titles
      continue;
    }

    const url = unwrapDdgUrl(rawHref);
    if (!url) {
      snippetIdx++;
      continue;
    }

    const snippet = snippets[snippetIdx] ?? '';
    snippetIdx++;

    results.push({ title, url, snippet });
  }

  return results;
}

/**
 * Parse Bing search results page.
 *
 * Bing's organic results have the rough shape:
 *
 *   <h2><a href="https://...">Title with <em>highlights</em></a></h2>
 *   <p class="b_lineclamp...">Snippet text…</p>
 *
 * Bing's HTML is far noisier than DDG's, so we only extract title + url and
 * leave snippets empty (the LLM still gets enough signal from titles).
 */
function parseBingHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Bing organic result links live inside <h2> tags.
  const linkRegex =
    /<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const url = match[1];
    // Bing sometimes emits relative or javascript: links — skip those.
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
    // Skip Bing's own navigation links.
    if (url.includes('bing.com/') || url.includes('go.microsoft.com/')) continue;

    const title = stripHtml(match[2]);
    if (!title) continue;

    results.push({ title, url, snippet: '' });
  }

  return results;
}

// ============ Search backends ============

/**
 * Query DuckDuckGo's HTML endpoint via POST.
 *
 * POST is preferred over GET because DDG occasionally truncates very long
 * queries in the URL string, and POST bodies are not subject to the same
 * length heuristics. The `kl=us-en` parameter pins region/language to
 * US-English (DDG otherwise localizes by geo-IP, which on Workers resolves
 * to whatever Cloudflare edge the request lands on).
 *
 * Throws on any failure — callers wrap with the Bing fallback.
 */
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const body = new URLSearchParams({
    q: query,
    kl: 'us-en', // region/language pin
  });

  const response = await fetch(DDG_HTML_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseDuckDuckGoHtml(html, maxResults);
}

/**
 * Query Bing as a fallback when DuckDuckGo fails or rate-limits.
 *
 * Bing is more aggressive about bot detection and will occasionally return
 * a captcha page instead of results — in that case `parseBingHtml` returns
 * an empty array and the caller treats it as "no fresh info available".
 */
async function searchBing(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const url = `${BING_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${maxResults}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`Bing returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseBingHtml(html, maxResults);
}

// ============ Public API ============

/**
 * Search the web using DuckDuckGo's free HTML endpoint, with Bing as a
 * fallback. No API key, no quota, no billing.
 *
 * Results are cached in `env.PROMPT_CACHE` KV for 1 hour (keyed by a SHA-256
 * of the lowercased query). On any failure (network, parse, HTTP non-200)
 * we try Bing; if Bing also fails, we return an empty `SearchResponse`
 * instead of throwing — callers (Text Mode) treat this as "no fresh info
 * available" and proceed without search context.
 *
 * @param env         Worker env (used for the PROMPT_CACHE KV namespace).
 * @param query       The natural-language search query.
 * @param numResults  Maximum number of results to return (default 5).
 */
export async function webSearch(
  env: Env,
  query: string,
  numResults: number = DEFAULT_MAX_RESULTS,
): Promise<SearchResponse> {
  if (!query || !query.trim()) {
    return { query, results: [], total_found: 0, cached_at: Date.now() };
  }

  const maxResults = Math.max(1, numResults);

  // 1. Check cache first (1 hour TTL).
  const cacheKey = await makeCacheKey(query);
  try {
    const cached = await env.PROMPT_CACHE.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as SearchResponse;
      logger.info('web_search', 'cache hit', {
        query: query.slice(0, 80),
        results: parsed.total_found,
      });
      return parsed;
    }
  } catch (err) {
    logger.warn('web_search', 'cache read failed; continuing', {
      error: String(err),
    });
  }

  // 2. Search DuckDuckGo; on failure, fall back to Bing.
  logger.info('web_search', 'searching', { query: query.slice(0, 80) });
  let results: SearchResult[] = [];
  try {
    results = await searchDuckDuckGo(query, maxResults);
  } catch (err) {
    logger.warn('web_search', 'DuckDuckGo failed; trying Bing', {
      error: String(err),
    });
    try {
      results = await searchBing(query, maxResults);
      if (results.length > 0) {
        logger.info('web_search', 'Bing fallback succeeded', {
          count: results.length,
        });
      }
    } catch (err2) {
      logger.error('web_search', 'Bing fallback also failed', {
        error: String(err2),
      });
    }
  }

  const response: SearchResponse = {
    query,
    results,
    total_found: results.length,
    cached_at: Date.now(),
  };

  // 3. Cache for 1 hour (best-effort; never block on cache writes).
  try {
    await env.PROMPT_CACHE.put(cacheKey, JSON.stringify(response), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (err) {
    logger.warn('web_search', 'cache write failed; continuing', {
      error: String(err),
    });
  }

  return response;
}

/**
 * Detect whether a user message likely needs fresh web information.
 *
 * Triggers on temporal keywords (Arabic + English) and on year tokens
 * (2024–2027). Returns `true` if any keyword is found, case-insensitively,
 * as a substring of the message.
 *
 * Designed to be intentionally broad: a false positive only costs a single
 * DuckDuckGo fetch (cacheable), while a false negative means stale
 * information.
 *
 * @param message The raw user message (text mode).
 */
export function needsWebSearch(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return TIME_SENSITIVE_KEYWORDS.some((kw) =>
    lower.includes(kw.toLowerCase()),
  );
}

/**
 * Format search results into a Markdown block suitable for injection into
 * the LLM's `user` message, capped at `maxChars` characters to keep the
 * prompt size under control.
 *
 * Output shape (example):
 *
 *   ## معلومات من الويب (بتاريخ 2026-11-10):
 *
 *   1. [Title](url)
 *      snippet text…
 *
 *   2. [Title](url)
 *      snippet text…
 *
 * Returns an empty string when there are no results — callers can safely
 * concatenate without checking for emptiness first.
 *
 * @param search   The `SearchResponse` returned by {@link webSearch}.
 * @param maxChars Soft upper bound on the returned string length.
 */
export function formatSearchContext(
  search: SearchResponse,
  maxChars: number = 2000,
): string {
  if (!search.results || search.results.length === 0) return '';

  const date = new Date(search.cached_at).toISOString().split('T')[0];
  const lines: string[] = [
    `## معلومات من الويب (بتاريخ ${date}):`,
    '',
  ];

  let totalChars = lines.join('\n').length;

  for (let i = 0; i < search.results.length; i++) {
    const r = search.results[i];
    const entry = `${i + 1}. [${r.title}](${r.url})` +
      (r.snippet ? `\n   ${r.snippet}` : '') + '\n';
    if (totalChars + entry.length > maxChars) break;
    lines.push(entry);
    totalChars += entry.length;
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format the list of source URLs as a footnote block to append to the
 * assistant's final reply. Returns an empty string when there are no
 * sources, so callers can concatenate without checking.
 *
 * @param search   The `SearchResponse` returned by {@link webSearch}.
 * @param maxSources  Cap on the number of sources listed.
 */
export function formatSourceFootnotes(
  search: SearchResponse,
  maxSources: number = 5,
): string {
  if (!search.results || search.results.length === 0) return '';

  const lines: string[] = ['\n\n---\n📚 **المصادر:**'];
  const slice = search.results.slice(0, Math.min(maxSources, search.results.length));
  slice.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.title}](${r.url})`);
  });

  return lines.join('\n');
}
