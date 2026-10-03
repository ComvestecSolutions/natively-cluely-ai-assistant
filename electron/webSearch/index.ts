// Web search for Courses Studio (P5) — free / keyless by design.
//
// Provider cascade per invocation:
//   explicit provider (if usable) → searxng (if a URL is set) → DuckDuckGo HTML
//   (zero-config default, always last). A Tavily leg exists in the plan but is
//   INTENTIONALLY SKIPPED in this build: premium/electron/knowledge/
//   TavilySearchProvider.ts ships as a stub here (`search()` returns []), so an
//   attempted tavily call could only ever yield empty results — explicit
//   'tavily' selections therefore degrade to the fallbacks instead. When the
//   real premium module is present, restore that leg inside `cascadeOrder`.
//
// An explicit `enabled: false` in settings turns the whole feature off before
// anything else runs (the user's off-switch).
//
// This module must stay loadable under ELECTRON_RUN_AS_NODE tests: it imports
// no 'electron' and touches no app/credential singletons — all configuration
// arrives through the caller-resolved `settings` argument (the IPC handler
// passes live SettingsManager values in), and HTTP goes through globalThis.

import * as cheerio from 'cheerio';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Raw (persisted or UI-provided) web-search settings, mirroring AppSettings.webSearch. */
export interface WebSearchSettings {
  provider?: 'duckduckgo' | 'tavily' | 'searxng';
  searxngUrl?: string;
  timeoutMs?: number;
  /** Absent ⇒ enabled (feature on); explicit false ⇒ the whole feature is off. */
  enabled?: boolean;
}

/** Fully-resolved settings — no absent keys, every field has a concrete value. */
export interface ResolvedWebSearchSettings {
  provider: 'duckduckgo' | 'tavily' | 'searxng';
  searxngUrl?: string; // undefined when unset (no default instance)
  timeoutMs: number;
  enabled: boolean;
}

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;

export const DEFAULT_WEB_SEARCH: ResolvedWebSearchSettings = {
  provider: 'duckduckgo',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  enabled: true,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge a partial (persisted or UI-provided) settings object over the defaults. */
export function resolveWebSearchSettings(
  partial?: WebSearchSettings | undefined,
): ResolvedWebSearchSettings {
  const p = partial ?? {};
  return {
    provider:
      p.provider === 'tavily' || p.provider === 'searxng' ? p.provider : DEFAULT_WEB_SEARCH.provider,
    searxngUrl:
      typeof p.searxngUrl === 'string' && p.searxngUrl.trim() !== ''
        ? p.searxngUrl.trim().replace(/\/+$/, '')
        : undefined,
    timeoutMs: clampInt(p.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    enabled: p.enabled ?? DEFAULT_WEB_SEARCH.enabled,
  };
}

// ── DuckDuckGo (zero-config default) ───────────────────────────────────────

const DDG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_HITS = 10;

export function buildDuckDuckGoUrl(q: string): string {
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
}

/** Coerce a possibly-missing JSON field to text (numbers stringify; anything else → null). */
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Trim and collapse all whitespace runs to single spaces. */
function collapseWs(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

/** Strip ALL tags and decode entities (cheerio's text() does the decoding), then normalize spacing. */
function cleanText(raw: string | null | undefined): string {
  const s = collapseWs(String(raw ?? ''));
  if (s === '') return '';
  // Re-parse as a fragment so inline markup inside snippets is dropped and any
  // entity still encoded at the string level (&lt; etc.) is decoded.
  const $ = cheerio.load(s);
  return $.root().text().replace(/\s+/g, ' ').trim();
}

/**
 * Turn a result anchor href into a real http(s) URL, or null when it is not one.
 * DDG wraps links in its redirector: `/l/?uddg=<encoded>` (sometimes with extra
 * tracking params) — the real target lives in `uddg`.
 */
function resolveDuckDuckGoUrl(href: string | null): string | null {
  const trimmed = collapseWs(href);
  if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('javascript:')) return null;
  let u: URL;
  try {
    u = new URL(trimmed, 'https://html.duckduckgo.com/');
  } catch {
    return null;
  }
  const isDdgRedirector =
    (u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com')) &&
    u.pathname === '/l/';
  if (isDdgRedirector) {
    const targetEnc = u.searchParams.get('uddg'); // already percent-decoded once by the URL API
    if (!targetEnc) return null;
    try {
      const t = new URL(targetEnc, 'https://html.duckduckgo.com/');
      if (t.protocol === 'http:' || t.protocol === 'https:') return t.toString();
    } catch {
      // fall through to rejection below
    }
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // mailto:, data:, …
  return u.toString();
}

/** Pure parser for html.duckduckgo.com result pages. Never throws on bad HTML. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const $ = cheerio.load(String(html ?? ''));
  const hits: SearchHit[] = [];
  for (const anchorEl of $('a.result__a').toArray()) {
    if (hits.length >= MAX_HITS) break;
    const $a = $(anchorEl);
    const title = collapseWs($a.text());
    const rawHref: unknown = $a.attr('href');
    const url = resolveDuckDuckGoUrl(rawHref == null ? null : String(rawHref));
    if (!title || !url) continue; // drop nav junk and anything without a real target

    // Snippet: prefer the enclosing `.result` container; if the markup drifted
    // and no such wrapper exists, climb parents until one holds the snippet.
    let $scope = $a.closest('.result');
    if ($scope.length === 0) {
      let cur = $a.parent();
      while ($scope.length === 0 && cur.length > 0 && !cur.is('body')) {
        if (cur.find('.result__snippet').length > 0) $scope = cur;
        cur = cur.parent();
      }
    }
    const snippet = collapseWs(($scope.length ? $scope : $a).find('.result__snippet').first().text());
    hits.push({ title, url, snippet });
  }
  return hits;
}

async function fetchDuckDuckGoHits(q: string, signal: AbortSignal): Promise<SearchHit[]> {
  const res = await globalThis.fetch(buildDuckDuckGoUrl(q), {
    headers: { 'User-Agent': DDG_UA, Accept: 'text/html' },
    signal,
  });
  if (!res.ok) throw new Error(`duckduckgo HTTP ${res.status}`);
  return parseDuckDuckGoHtml(await res.text());
}

// ── SearXNG (user-hosted instance, JSON API) ───────────────────────────────

async function fetchSearxngHits(base: string, q: string, signal: AbortSignal): Promise<SearchHit[]> {
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base}/search${sep}q=${encodeURIComponent(q)}&format=json`;
  let res: Awaited<ReturnType<typeof globalThis.fetch>>;
  try {
    res = await globalThis.fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (e) {
    // Network/timeout errors must keep the cascade moving to the next provider.
    const detail = e instanceof Error ? (e.message || 'fetch failed') : String(e);
    throw e instanceof Error && e.name === 'AbortError' ? e : new Error(`searxng fetch failed: ${detail}`);
  }
  if (!res.ok) return []; // instance up but JSON API disabled/blocked → no hits, not an error
  let data: unknown;
  try {
    data = JSON.parse(await res.text());
  } catch {
    return []; // HTML or garbage where JSON was expected (format=json not enabled)
  }
  const raw = Array.isArray((data as { results?: unknown })?.results) ? (data as { results: unknown[] }).results : [];
  const hits: SearchHit[] = [];
  for (const item of raw) {
    if (hits.length >= MAX_HITS) break;
    const r = (item ?? {}) as Record<string, unknown>;
    const url0 = resolveDuckDuckGoUrl(asText(r.url));
    const title = cleanText(asText(r.title));
    if (!title || !url0) continue;
    hits.push({ title, url: url0, snippet: cleanText(asText(r.content)) });
  }
  return hits;
}

// ── Cascade + cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  at: number;
  provider: string;
  hits: SearchHit[];
}

const resultCache = new Map<string, CacheEntry>();

function cacheGet(key: string, now: number): CacheEntry | undefined {
  const entry = resultCache.get(key);
  if (!entry) return undefined;
  if (now - entry.at >= CACHE_TTL_MS) {
    resultCache.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (!resultCache.has(key)) {
    // Evict the OLDEST entry once we exceed the cap (Map keeps insertion order).
    if (resultCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = resultCache.keys().next();
      if (!oldest.done) resultCache.delete(oldest.value);
    }
  }
  resultCache.set(key, entry);
}

/** Explicit usable provider first, then the fixed fallback order (deduped). */
function cascadeOrder(s: ResolvedWebSearchSettings): string[] {
  const order: string[] = [];
  const pushUnique = (name: string): void => {
    if (!order.includes(name)) order.push(name);
  };
  // Explicit provider first when usable. An explicit 'tavily' is skipped in this
  // build — the premium module is a stub, so it would only ever return []
  // (see header) — and degrades to the fallbacks below.
  if (s.provider === 'duckduckgo' || (s.provider === 'searxng' && s.searxngUrl)) {
    pushUnique(s.provider);
  }
  // Fixed fallback order: tavily (if key resolvable — skipped in this build)
  // → searxng (if URL set) → duckduckgo (zero-config default, always last).
  if (s.searxngUrl) pushUnique('searxng');
  pushUnique('duckduckgo');
  return order;
}

function describeFailure(name: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(msg))) {
    return `${name} timed out`;
  }
  return `${name}: ${msg}`;
}

async function attemptProvider(
  name: string,
  s: ResolvedWebSearchSettings,
  q: string,
): Promise<SearchHit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), s.timeoutMs);
  try {
    switch (name) {
      case 'duckduckgo':
        return await fetchDuckDuckGoHits(q, controller.signal);
      case 'searxng':
        if (!s.searxngUrl) throw new Error('no searxng URL configured');
        return await fetchSearxngHits(s.searxngUrl, q, controller.signal);
      default:
        // 'tavily' and anything unknown — the premium seam is stubbed in this build.
        throw new Error(`${name} provider not configured in this build`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export type WebSearchResult =
  | { ok: true; provider: string; hits: SearchHit[] }
  | { ok: false; error: string };

/**
 * Run a web search through the provider cascade. Never throws for operational
 * failures — returns `{ ok:false, error }` instead so IPC callers can relay it.
 */
export async function webSearch(opts: {
  q: string;
  settings?: WebSearchSettings;
  now?: number;
}): Promise<WebSearchResult> {
  const q = typeof opts?.q === 'string' ? opts.q.trim() : '';
  if (!q) return { ok: false, error: 'empty search query' };

  const s = resolveWebSearchSettings(opts.settings);
  // The off-switch is checked before anything else — no cache read, no network.
  if (s.enabled === false) return { ok: false, error: 'web search is disabled' };

  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();

  const cacheKey = q.toLowerCase();
  const cached = cacheGet(cacheKey, now);
  if (cached) return { ok: true, provider: cached.provider, hits: cached.hits };

  let firstReason: string | undefined;
  for (const name of cascadeOrder(s)) {
    try {
      const hits = await attemptProvider(name, s, q);
      cacheSet(cacheKey, { at: now, provider: name, hits });
      return { ok: true, provider: name, hits };
    } catch (e) {
      if (!firstReason) firstReason = describeFailure(name, e);
    }
  }
  return { ok: false, error: `all providers failed: ${firstReason ?? 'no usable provider'}` };
}
