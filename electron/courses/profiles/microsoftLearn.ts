// Microsoft Learn profile — P1 ingestion planner (COURSES_FEATURE_PLAN §6, DISCOVER phase).
// Turns a credential root URL into an ordered plan of consumable items via the public JSON TOC
// endpoints — or, for certification-hub roots whose static HTML is JS-rendered and link-free,
// exclusively from the keyless /api/certification/<slug>/detail endpoint. The module NEVER calls
// global fetch itself: all HTTP goes through an
// injected CourseHttpClient so tests can substitute an in-memory fake. Partial failures
// (404/5xx sub-docs, bad JSON, network errors) become warnings — this function never throws.

import * as cheerio from 'cheerio';

/** Consumable kinds. `assessment` stays an external link card until P5 live endpoints. */
export type MslConsumableKind = 'lesson' | 'reference' | 'assessment';

/** One ordered, deduped consumable entry (dedupe by origin+path; assessments keep query). */
export interface MslItem {
  id: string; // stable slug + FNV-1a hash of the dedupe key
  kind: MslConsumableKind;
  title: string;
  url: string; // absolute URL as linked (assessment deep-link query preserved)
  moduleId?: string; // set when nested under a module node in the TOC tree
  index: number; // 0-based position in the final ordered list
}

export interface MslPlanResult {
  items: MslItem[];
  warnings: string[]; // human-readable notes for skipped sub-docs and caps
}

/** Minimal injected HTTP client. Production uses createFetchHttpClient(); tests use fakes. */
export interface CourseHttpClient {
  get(url: string): Promise<{ status: number; body: string }>;
}

const LEARN_HOST = 'learn.microsoft.com';
const HARD_ITEM_CAP = 2000; // locked P1 cap on total items per plan run
const MAX_TOC_DEPTH = 8; // bounded recursion (§6.1 "bounded depth/leaf count")

interface TocMetadata { [key: string]: unknown }
interface TocNode { metadata?: TocMetadata | null; children?: TocNode[] | null; [key: string]: unknown }

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** FNV-1a 32-bit over `text` → 8 hex chars (stable ids, no dependencies). */
function hashHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function slugify(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Dedupe key. Assessments keep the full href (assessmentId lives in the query); everything
 * else compares origin+path only, so tracking-query variants of a lesson dedupe together. */
function dedupeKey(url: URL, kind: MslConsumableKind): string {
  if (kind === 'assessment') return url.href;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.origin}${path}`;
}

function makeId(url: URL, key: string): string {
  let slug = '';
  try {
    const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    slug = slugify(lastSegment).slice(0, 48);
  } catch {
    slug = '';
  }
  return `${slug || 'item'}-${hashHex(key)}`;
}

function classify(url: URL, meta: TocMetadata | undefined): MslConsumableKind {
  const path = url.pathname.toLowerCase();
  if (path.includes('/practice-assessment') || path.includes('exam-practice')) return 'assessment';
  const contentType = asString(meta?.contentType).toLowerCase();
  if (contentType === 'assessment' || meta?.isAssessment === true) return 'assessment';
  if (url.hostname !== LEARN_HOST || path.startsWith('/reference/') || path.endsWith('.pdf')) return 'reference';
  return 'lesson';
}

function isModuleBoundary(url: URL, meta: TocMetadata | undefined): boolean {
  const path = url.pathname.toLowerCase();
  return path.includes('/modules/') || asString(meta?.contentType).toLowerCase() === 'module';
}

/** Parse a href/URL value into an absolute http(s) URL, or null when unusable. */
function resolveUrl(raw: string, fallbackOrigin: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  try {
    const url = new URL(trimmed, `${fallbackOrigin}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

interface WalkContext {
  items: MslItem[];
  seen: Set<string>;
  warnings: string[];
  origin: string;
  capWarned: boolean;
  depthWarned: boolean;
}

/** Depth-first, pre-order walk of one TOC tree — preserves teaching order. */
function visit(node: TocNode | null | undefined, moduleId: string | undefined, depth: number, ctx: WalkContext): void {
  if (!node || typeof node !== 'object') return;
  if (depth > MAX_TOC_DEPTH) {
    if (!ctx.depthWarned && Array.isArray(node.children) && node.children.length > 0) {
      ctx.depthWarned = true;
      ctx.warnings.push(`TOC nesting truncated at depth ${MAX_TOC_DEPTH}`);
    }
    return;
  }

  const meta: TocMetadata | undefined = node.metadata && typeof node.metadata === 'object' ? (node.metadata as TocMetadata) : undefined;
  const children = Array.isArray(node.children) ? (node.children as TocNode[]) : [];
  const rawHref = asString(meta?.href);
  const url = rawHref ? resolveUrl(rawHref, ctx.origin) : null;

  // Descendants inherit this node's id when it marks a module boundary.
  let childModuleId = moduleId;
  if (url && isModuleBoundary(url, meta)) {
    childModuleId = makeId(url, dedupeKey(url, classify(url, meta)));
  }

  if (url) {
    const kind = classify(url, meta);
    const key = dedupeKey(url, kind);
    if (!ctx.seen.has(key) && ctx.items.length < HARD_ITEM_CAP) {
      ctx.seen.add(key);
      let title = asString(meta?.title);
      if (!title) {
        try {
          title = slugify(decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? ''));
        } catch {
          title = '';
        }
      }
      const item: MslItem = { id: makeId(url, key), kind, title: title || url.href, url: url.href, index: ctx.items.length };
      if (moduleId !== undefined) item.moduleId = moduleId;
      ctx.items.push(item);
    }
  }

  if (!ctx.capWarned && ctx.items.length >= HARD_ITEM_CAP) {
    ctx.capWarned = true;
    ctx.warnings.push(`item limit of ${HARD_ITEM_CAP} reached — remaining TOC entries skipped`);
    return;
  }

  for (const child of children) visit(child, childModuleId, depth + 1, ctx);
}

/** Fetch one sub-TOC and fold it into the plan. Never throws; failures become warnings. */
async function fetchAndWalkToc(http: CourseHttpClient, tocUrl: string, moduleId: string | undefined, ctx: WalkContext): Promise<void> {
  let body = '';
  try {
    const res = await http.get(tocUrl);
    if (res.status < 200 || res.status >= 300) {
      ctx.warnings.push(`${tocUrl} → HTTP ${res.status}; sub-TOC skipped`);
      return;
    }
    body = res.body;
  } catch (err) {
    ctx.warnings.push(`${tocUrl} fetch failed (${String(err)}); sub-TOC skipped`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    ctx.warnings.push(`${tocUrl} is not valid JSON; sub-TOC skipped`);
    return;
  }
  const tocNode = (parsed && typeof parsed === 'object' ? parsed : undefined) as TocNode | undefined;
  if (!tocNode || !Array.isArray(tocNode.children)) {
    ctx.warnings.push(`${tocUrl} has no children array; sub-TOC skipped`);
    return;
  }

  // The TOC root may itself be a content node (e.g. the learning-path landing page).
  if (asString(tocNode.metadata?.href)) {
    visit(tocNode, moduleId, 0, ctx);
  } else {
    for (const child of tocNode.children as TocNode[]) visit(child, moduleId, 1, ctx);
  }
}

/** Extract ordered, deduped learning-path ids from a credential landing page's links. */
function discoverLearningPaths(html: string, rootUrl: URL): string[] {
  const found = new Map<string, undefined>();
  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_index, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      const url = resolveUrl(href, rootUrl.origin);
      if (!url || url.hostname !== LEARN_HOST) return;
      const match = /^\/(?:[a-z]{2}-[a-z]{2}\/)?learn\/learning-paths\/([^/?#]+)/.exec(url.pathname);
      if (match && !found.has(match[1])) {
        let id: string;
        try {
          id = decodeURIComponent(match[1]);
        } catch {
          id = match[1];
        }
        found.set(id, undefined);
      }
    });
  } catch {
    // Malformed HTML is non-fatal; the caller reports "no learning paths" if nothing was found.
  }
  return [...found.keys()];
}

/** Slug of a certification-hub root (/credentials/certifications/<slug>[/...]) — its last non-empty pathname segment. */
function certificationSlug(root: URL): string | null {
  const segments = root.pathname.split('/').filter(Boolean);
  const idx = segments.indexOf('certifications');
  if (idx === -1 || segments[idx - 1] !== 'credentials' || segments.length <= idx + 1) return null;
  return segments[segments.length - 1] ?? null; // filter(Boolean) already removed empty segments
}

/** Resolve a detail-API url (often locale-less, e.g. "/training/paths/x/") against the root origin,
 * adding the /en-us prefix live pages carry when absent. Query strings survive via URL parsing. */
function normalizeDetailUrl(raw: string, origin: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(trimmed, `${origin}/`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/en-us' && !url.pathname.startsWith('/en-us/')) {
    url.pathname = `/en-us${url.pathname}`;
  }
  return url;
}

/** Add one detail-API item with the same dedupe and hard-cap bookkeeping as TOC walks. */
function pushDetailItem(ctx: WalkContext, kind: MslConsumableKind, title: string, url: URL, moduleId?: string, verbatimUrl?: string): void {
  if (ctx.items.length >= HARD_ITEM_CAP) return;
  const key = dedupeKey(url, kind);
  if (!ctx.seen.has(key)) {
    ctx.seen.add(key);
    const item: MslItem = { id: makeId(url, key), kind, title, url: verbatimUrl ?? url.href, index: ctx.items.length };
    if (moduleId !== undefined) item.moduleId = moduleId;
    ctx.items.push(item);
  }
}

function warnIfCapped(ctx: WalkContext): void {
  if (!ctx.capWarned && ctx.items.length >= HARD_ITEM_CAP) {
    ctx.capWarned = true;
    ctx.warnings.push(`item limit of ${HARD_ITEM_CAP} reached — remaining TOC entries skipped`);
  }
}

/**
 * Build a plan EXCLUSIVELY from the keyless certification detail endpoint, for hub roots whose
 * static HTML carries no training links. Returns true on success; every failure path WARNs (with
 * "certification <slug> curriculum not available") and returns false so the caller falls back to
 * legacy static discovery. Never throws.
 */
async function planCertificationDetail(http: CourseHttpClient, root: URL, originalUrl: string, slug: string, ctx: WalkContext): Promise<boolean> {
  const detailUrl = `${root.origin}/api/certification/certification.${slug}/detail`;

  let body = '';
  try {
    const res = await http.get(detailUrl);
    if (res.status < 200 || res.status >= 300) {
      ctx.warnings.push(`${detailUrl} → HTTP ${res.status}; certification ${slug} curriculum not available; falling back to static discovery`);
      return false;
    }
    body = res.body;
  } catch (err) {
    ctx.warnings.push(`${detailUrl} fetch failed (${String(err)}); certification ${slug} curriculum not available; falling back to static discovery`);
    return false;
  }

  if (!body.trim()) {
    ctx.warnings.push(`${detailUrl} returned an empty body; certification ${slug} curriculum not available; falling back to static discovery`);
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    ctx.warnings.push(`${detailUrl} is not valid JSON; certification ${slug} curriculum not available; falling back to static discovery`);
    return false;
  }

  const record = (parsed && typeof parsed === 'object' ? parsed : undefined) as Record<string, unknown> | undefined;
  const courseRecord: Record<string, unknown> | undefined = record && record.course !== null && typeof record.course === 'object' ? (record.course as Record<string, unknown>) : undefined;
  const guideRecord: Record<string, unknown> | undefined = record && record.courseStudyGuide !== null && typeof record.courseStudyGuide === 'object' ? (record.courseStudyGuide as Record<string, unknown>) : undefined;

  const rawEntries = guideRecord ? guideRecord.items : undefined;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    ctx.warnings.push(`${detailUrl} has no courseStudyGuide.items; certification ${slug} curriculum not available; falling back to static discovery`);
    return false;
  }

  for (const rawEntry of rawEntries) {
    if (ctx.items.length >= HARD_ITEM_CAP) break;
    const entry = (rawEntry && typeof rawEntry === 'object' ? rawEntry : undefined) as Record<string, unknown> | undefined;
    if (!entry) continue;
    const data: Record<string, unknown> | undefined = entry.data !== null && typeof entry.data === 'object' ? (entry.data as Record<string, unknown>) : undefined;

    if (asString(entry.type) === 'path') {
      const pathTitle = data && asString(data.title) ? asString(data.title) : 'Untitled path';
      let emittedFromPath = 0;
      const rawModules = data ? data.modules : undefined;
      for (const [moduleIndex, rawModule] of (Array.isArray(rawModules) ? rawModules : []).entries()) {
        const mod = (rawModule && typeof rawModule === 'object' ? rawModule : undefined) as Record<string, unknown> | undefined;
        if (!mod) continue;

        // Stable per-module grouping key from the module slug (".../training/modules/<slug>/").
        let moduleId: string;
        const rawModuleUrl = asString(mod.url);
        try {
          moduleId = rawModuleUrl ? decodeURIComponent(new URL(rawModuleUrl, `${root.origin}/`).pathname.split('/').filter(Boolean).pop() ?? '') : '';
        } catch {
          moduleId = '';
        }
        if (!moduleId) moduleId = `module-${moduleIndex}`;

        const rawUnits = Array.isArray(mod.units) ? mod.units : [];
        for (const rawUnit of rawUnits) {
          const unit = (rawUnit && typeof rawUnit === 'object' ? rawUnit : undefined) as Record<string, unknown> | undefined;
          if (!unit) continue;
          const lessonUrl = normalizeDetailUrl(asString(unit.url), root.origin);
          if (!lessonUrl) continue;
          pushDetailItem(ctx, 'lesson', asString(unit.title) || '<untitled>', lessonUrl, moduleId);
          emittedFromPath += 1;
        }
      }
      if (emittedFromPath === 0) {
        ctx.warnings.push(`${pathTitle}: no units listed`);
      }
    } else {
      // Non-path entry carrying a url + title → single lesson at its position.
      const title = data ? asString(data.title) : '';
      const rawEntryUrl = data ? asString(data.url) : '';
      if (!title || !rawEntryUrl) continue;
      const standaloneUrl = normalizeDetailUrl(rawEntryUrl, root.origin);
      if (standaloneUrl) pushDetailItem(ctx, 'lesson', title, standaloneUrl);
    }
  }

  // The hub page itself is the assessment target: one final link-card row pointing at the user's
  // original root string verbatim (?practice-assessment-type=certification already selects it).
  const courseTitle = (courseRecord && asString(courseRecord.title)) || slug;
  pushDetailItem(ctx, 'assessment', `Practice assessment — ${courseTitle}`, root, undefined, originalUrl);
  warnIfCapped(ctx);
  return true;
}

/**
 * Plan all consumable items under a Microsoft Learn credential root URL, in teaching order.
 * `http` defaults to a real fetch-backed client (see createFetchHttpClient) — tests inject fakes.
 */
export async function planMicrosoftLearn(rootUrlRaw: string, http: CourseHttpClient = createFetchHttpClient()): Promise<MslPlanResult> {
  const warnings: string[] = [];
  let root: URL;
  try {
    root = new URL(rootUrlRaw);
  } catch {
    return { items: [], warnings: [`invalid course URL: ${rootUrlRaw}`] };
  }
  if (root.hostname !== LEARN_HOST) {
    return { items: [], warnings: [`unsupported host for Microsoft Learn profile (expected ${LEARN_HOST}, got ${root.hostname})`] };
  }

  const ctx: WalkContext = { items: [], seen: new Set(), warnings, origin: root.origin, capWarned: false, depthWarned: false };

  // Certification-hub roots (/credentials/certifications/*) render their curriculum client-side —
  // the static credential page carries no training links. Try the keyless detail endpoint first:
  // on success the plan comes exclusively from that payload; every failure WARNs and falls through
  // to the legacy static discovery below.
  const hubSlug = certificationSlug(root);
  if (hubSlug !== null && (await planCertificationDetail(http, root, rootUrlRaw, hubSlug, ctx))) {
    return { items: ctx.items, warnings };
  }

  let pageBody: string;
  try {
    const res = await http.get(root.href);
    if (res.status < 200 || res.status >= 300) {
      return { items: [], warnings: [...warnings, `credential page HTTP ${res.status} (${root.href}) — nothing to plan`] };
    }
    pageBody = res.body;
  } catch (err) {
    return { items: [], warnings: [...warnings, `failed to fetch credential page ${root.href}: ${String(err)}`] };
  }

  const learningPathIds = discoverLearningPaths(pageBody, root);
  if (learningPathIds.length === 0) {
    // §6.2 fallback: try a toc.json next to the credential path itself.
    warnings.push('no /learn/learning-paths/* links on credential page; trying <path>/toc.json fallback');
    const basePath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
    await fetchAndWalkToc(http, `${root.origin}${basePath}toc.json`, undefined, ctx);
    return { items: ctx.items, warnings };
  }

  for (const lpId of learningPathIds) {
    const tocUrl = `${root.origin}/api/tocs/${encodeURIComponent(lpId)}.toc.json`;
    await fetchAndWalkToc(http, tocUrl, undefined, ctx);
    if (ctx.items.length >= HARD_ITEM_CAP) break;
  }

  return { items: ctx.items, warnings };
}

/** Fetch-based HTTP client for production. This is the only place in the module that touches
 * global fetch — planMicrosoftLearn() itself stays transport-agnostic. */
export function createFetchHttpClient(): CourseHttpClient {
  return {
    async get(url) {
      const response = await globalThis.fetch(url, {
        headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      });
      let body = '';
      try {
        body = await response.text();
      } catch {
        // Unreadable/aborted body is treated as empty; the status still drives control flow.
      }
      return { status: response.status, body };
    },
  };
}

export default planMicrosoftLearn;
