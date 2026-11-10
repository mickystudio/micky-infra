/**
 * Micky Assistant Unlimited - Web Search Integration
 * ----------------------------------------------------------------------------
 * تكامل البحث في الويب (P2-T3)
 *
 * Free web search via DuckDuckGo's HTML endpoint — no API key, no rate-limit
 * account, no billing. Used by Text Mode to inject up-to-date information
 * into the LLM prompt when the user asks about current events, prices, or
 * anything time-sensitive.
 *
 * Pipeline:
 *
 *   user message
 *      │
 *      ▼
 *   needsWebSearch(message)  ───no──▶ skip search entirely
 *      │ yes
 *      ▼
 *   webSearch(query, 5)        →  fetch DuckDuckGo HTML
 *      │                          →  parse `result__a` + `result__snippet`
 *      │                          →  unwrap duckduckgo.com/l/?uddg= redirects
 *      ▼
 *   formatSearchForPrompt()   →  Markdown block injected into the user turn
 *
 * Created: 2026-11-10
 * Phase: P2-T3
 */

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
  totalResults: number;
}

// ============ Constants ============

/** DuckDuckGo HTML endpoint (no API key required). */
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

/**
 * User-Agent used for the DuckDuckGo request.
 * A real-looking browser UA avoids the "empty results" bot heuristic
 * that DDG sometimes applies to generic `fetch` default UAs.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MickyAssistant/1.0';

/** Default cap on the number of results returned by `webSearch`. */
const DEFAULT_MAX_RESULTS = 5;

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
  'rate',
  'live',
  // Years (current + future window)
  '2025',
  '2026',
  '2027',
];

// ============ Internal helpers ============

/**
 * Strip HTML tags and decode the most common entities.
 * Used to normalize DuckDuckGo's HTML-escaped titles and snippets.
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
function parseDuckDuckGoHtml(html: string): SearchResult[] {
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
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const rawHref = linkMatch[1];
    const title = stripHtml(linkMatch[2]);
    if (!title) continue;

    const url = unwrapDdgUrl(rawHref);
    if (!url) continue;

    const snippet = snippets[snippetIdx] ?? '';
    snippetIdx++;

    results.push({ title, url, snippet });
  }

  return results;
}

// ============ Public API ============

/**
 * Search the web using DuckDuckGo's free HTML endpoint.
 *
 * No API key, no quota, no billing. Returns the top-`maxResults` parsed
 * results. On any failure (network, parse, HTTP non-200) we return an empty
 * `SearchResponse` instead of throwing — callers (Text Mode) treat this as
 * "no fresh info available" and proceed without search context.
 *
 * @param query       The natural-language search query.
 * @param maxResults   Maximum number of results to return (default 5).
 */
export async function webSearch(
  query: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<SearchResponse> {
  if (!query || !query.trim()) {
    return { query, results: [], totalResults: 0 };
  }

  const url = `${DDG_HTML_URL}?q=${encodeURIComponent(query)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      },
    });
  } catch (err) {
    console.warn('[web_search] fetch failed:', String(err));
    return { query, results: [], totalResults: 0 };
  }

  if (!response.ok) {
    console.warn(
      `[web_search] DuckDuckGo returned HTTP ${response.status} for query: ${query}`,
    );
    return { query, results: [], totalResults: 0 };
  }

  const html = await response.text();
  const all = parseDuckDuckGoHtml(html);
  const trimmed = all.slice(0, Math.max(1, maxResults));

  return {
    query,
    results: trimmed,
    totalResults: trimmed.length,
  };
}

/**
 * Detect whether a user message likely needs fresh web information.
 *
 * Triggers on temporal keywords (Arabic + English) and on year tokens
 * (2025–2027). Returns `true` if any keyword is found, case-insensitively,
 * as a substring of the message.
 *
 * Designed to be intentionally broad: a false positive only costs a single
 * DuckDuckGo fetch, while a false negative means stale information.
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
 * the LLM's `user` message.
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
 * @param results The `SearchResponse` returned by {@link webSearch}.
 */
export function formatSearchForPrompt(results: SearchResponse): string {
  if (!results.results || results.results.length === 0) return '';

  const date = new Date().toISOString().split('T')[0];
  const lines: string[] = [
    `## معلومات من الويب (بتاريخ ${date}):`,
    '',
  ];

  results.results.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.title}](${r.url})`);
    if (r.snippet) {
      // Indent the snippet so it visually nests under the heading.
      lines.push(`   ${r.snippet}`);
    }
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
