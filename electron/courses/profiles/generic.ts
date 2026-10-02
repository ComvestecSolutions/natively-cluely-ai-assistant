// Generic profile — P5 fallback planner for arbitrary course/docs URLs (P5 goal: import any URL,
// not just learn.microsoft.com). Two-stage discovery over an injected CourseHttpClient (same
// interface as the MS Learn profile; tests substitute in-memory fakes):
//   STEP A  GET <origin>/sitemap.xml → parseSitemapLocs → filterCandidateLinks. ≥3 usable
//           same-origin links become the plan (.pdf → 'reference', anything else → 'lesson').
//   STEP B  sitemap missing/unusable/<3: fetch the root page, cheerio a[href], keep only
//           same-origin links under the root's directory prefix; every item is kind 'lesson'.
// Partial failures (404/5xx sub-resources, malformed XML/HTML, network errors) become warnings —
// this function never throws.

import * as cheerio from 'cheerio';
import type { CourseHttpClient, MslConsumableKind, MslItem, MslPlanResult } from './microsoftLearn';

const FETCH_TIMEOUT_MS = 15_000; // bounded politeness for slow/unresponsive hosts
const USER_AGENT = 'Natively-Course-Import/1.0'; // MS profile sends no custom UA; the generic one is polite about it
const SITEMAP_PATH = '/sitemap.xml';
const MAX_SITEMAP_LOCS = 500; // parseSitemapLocs output cap
const MAX_CANDIDATE_LINKS = 150; // filterCandidateLinks output cap
const MIN_SITEMAP_CONTENT_LINKS = 3;

/** Extensions that never carry course content (PDF is deliberately kept → 'reference'). */
const EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico',
  // archives / executables
  'zip', 'rar', '7z', 'exe', 'msi', 'dll',
  // media / calendars / static assets
  'mp4', 'webm', 'mov', 'ics', 'css', 'js',
]);

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** Decodes the handful of XML entities sitemaps typically contain (&amp; in query strings, …). */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Extract <loc> values from sitemap/sitemap-index XML. Trims each value, keeps absolute http(s)
 * URLs only (relative paths and mailto:/javascript: entries are dropped), dedupes order-preserving,
 * and caps at MAX_SITEMAP_LOCS. Never throws on malformed input.
 */
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null && out.length < MAX_SITEMAP_LOCS) {
    const raw = decodeXmlEntities(match[1] ?? '').trim();
    if (raw === '') continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue; // relative or garbage — not an absolute http(s) loc
    }
    if (!isHttpUrl(parsed)) continue;
    const key = parsed.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Collapse runs of slashes and strip the trailing one ('/a//b/' → '/a/b'; '/' stays '/'). */
function collapseSlashes(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const stripped = collapsed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** True when the last path segment carries an excluded (binary/asset) extension. */
function hasExcludedExtension(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return EXCLUDED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Last non-empty path segment, percent-decoded; `fallback` when the path is bare. */
function titleFromPath(url: URL, fallback: string): string {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return fallback;
  let last = segments[segments.length - 1];
  try {
    last = decodeURIComponent(last);
  } catch {
    // malformed percent-encoding — keep the raw segment
  }
  return last || fallback;
}

/**
 * Turn a raw href/loc list into clean same-origin candidate links resolved against the root's
 * origin: drops empties, fragment-only (#x), non-http(s) schemes (mailto/js:/…), cross-origin
 * targets and binary/asset extensions; dedupes on collapsed origin+path (+search); caps at
 * MAX_CANDIDATE_LINKS preserving input order. Titles are decoded path segments. Never throws.
 */
export function filterCandidateLinks(
  rootUrlRaw: string,
  rawLinks: Array<string | null>,
): Array<{ url: string; title: string }> {
  let root: URL;
  try {
    root = new URL(rootUrlRaw);
  } catch {
    return [];
  }
  if (!isHttpUrl(root)) return [];

  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const raw of rawLinks) {
    if (out.length >= MAX_CANDIDATE_LINKS) break;
    if (typeof raw !== 'string') continue; // null/undefined entries are explicitly allowed
    const value = raw.trim();
    if (value === '' || value.startsWith('#')) continue; // empty or fragment-only
    let u: URL;
    try {
      u = new URL(value, root.origin); // resolve relative refs against the root origin
    } catch {
      continue;
    }
    if (!isHttpUrl(u)) continue;
    if (u.origin !== root.origin) continue;
    if (hasExcludedExtension(u.pathname)) continue;
    const key = `${root.origin}${collapseSlashes(u.pathname)}${u.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: u.href, title: titleFromPath(u, root.hostname) });
  }
  return out;
}

/** Scope check for the crawl fallback: same-origin links at or under the root's directory prefix. */
function inRootScope(urlRaw: string, root: URL): boolean {
  let u: URL;
  try {
    u = new URL(urlRaw);
  } catch {
    return false;
  }
  const base = collapseSlashes(root.pathname);
  if (base === '/') return true; // root is the origin itself — any same-origin page qualifies
  const p = collapseSlashes(u.pathname);
  return p === base || p.startsWith(`${base}/`);
}

function sanitizeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // malformed percent-encoding — keep the raw segment
  }
  return decoded.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Stable slug from the last two non-empty path segments ('/docs/a/b/' → 'a-b'). */
function slugFromPath(pathname: string): string {
  return pathname
    .split('/')
    .filter(Boolean)
    .slice(-2)
    .map(sanitizeSegment)
    .filter((s) => s !== '')
    .join('-');
}

/** Assign planGeneric ids (`generic:<index>:<slug>`) + sequential indices; ids stay unique. */
function buildItems(links: Array<{ url: string; title: string }>, kindOf: (url: string) => MslConsumableKind): MslItem[] {
  const items: MslItem[] = [];
  const usedIds = new Set<string>();
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link.url);
    } catch {
      continue; // defensive — filterCandidateLinks output is always parseable
    }
    const slug = slugFromPath(u.pathname) || 'index';
    const baseId = `generic:${items.length}:${slug}`;
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix += 1) {
      id = `${baseId}-${suffix}`; // collision guard — uniqueness is guaranteed either way
    }
    usedIds.add(id);
    items.push({
      id,
      kind: kindOf(link.url),
      title: link.title || slug,
      url: u.href,
      index: items.length,
    });
  }
  return items;
}

/** Default client (only used when no http is injected): 15s timeout + polite headers. */
function defaultHttpClient(): CourseHttpClient {
  return {
    async get(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await globalThis.fetch(url, {
          headers: { accept: 'text/html,application/xml;q=0.9,*/*;q=0.8', 'user-agent': USER_AGENT },
          signal: controller.signal,
        });
        let body = '';
        try {
          body = await response.text();
        } catch {
          // Unreadable/aborted body is treated as empty; the status still drives control flow.
        }
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Plan a non-Microsoft-Learn course/docs URL. Prefers the origin's sitemap (STEP A) and falls back
 * to crawling the root page's link list (STEP B). Returns an empty plan + warnings instead of
 * throwing on invalid URLs or network failures.
 */
export async function planGeneric(rootUrlRaw: string, http?: CourseHttpClient): Promise<MslPlanResult> {
  let root: URL;
  try {
    root = new URL(rootUrlRaw);
  } catch {
    return { items: [], warnings: [`invalid course URL: ${rootUrlRaw}`] };
  }
  if (!isHttpUrl(root)) {
    return { items: [], warnings: ['not an http(s) url'] };
  }

  const client = http ?? defaultHttpClient();
  const warnings: string[] = [];

  // STEP A — sitemap at the origin (site-wide; no nested sitemap-index traversal in P5).
  let items: MslItem[] | null = null;
  try {
    const res = await client.get(`${root.origin}${SITEMAP_PATH}`);
    if (res.status >= 200 && res.status < 300) {
      const links = filterCandidateLinks(root.href, parseSitemapLocs(res.body));
      if (links.length >= MIN_SITEMAP_CONTENT_LINKS) {
        items = buildItems(links, (url) => (url.toLowerCase().endsWith('.pdf') ? 'reference' : 'lesson'));
      }
    }
    // Non-2xx or <3 usable links: fall through to the crawl fallback below.
  } catch (err) {
    // Hard network failure on the sitemap (timeout/refused): record it and still try STEP B —
    // planGeneric must never throw, and a dead sitemap should not kill an otherwise importable course.
    warnings.push(`sitemap fetch failed (${String(err)}); falling back to the page's link list`);
  }

  if (items === null) {
    // STEP B — crawl the root page for in-scope same-origin links.
    try {
      const res = await client.get(root.href);
      if (res.status < 200 || res.status >= 300) throw new Error(`root page returned HTTP ${res.status}`);
      const $ = cheerio.load(res.body);
      const hrefs: Array<string | null> = [];
      $('a[href]').each((_index, element) => {
        hrefs.push($(element).attr('href') ?? null);
      });
      const links = filterCandidateLinks(root.href, hrefs).filter((link) => inRootScope(link.url, root));
      items = buildItems(links, () => 'lesson');
      warnings.push(`no usable sitemap found — imported ${items.length} same-origin pages from linked list`);
    } catch (err) {
      return { items: [], warnings: [...warnings, `root page fetch failed (${String(err)})`] };
    }
  }

  return { items, warnings };
}
