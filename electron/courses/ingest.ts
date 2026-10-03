// Courses Studio — P1 course import orchestrator (COURSES_FEATURE_PLAN §6, FETCH+EXTRACT).
//
// runCourseImport(rootUrl, courseId, opts):
//   PLAN    planMicrosoftLearn + clamp to maxPages; upsert the course as 'importing'
//           (name derived from the root URL slug) before any page work.
//   GATE    optional robots.txt fetch for the root origin; disallowed items are skipped
//           without being fetched, any robots fetch error disables gating.
//   FETCH   pooled via runPool: GET page (exactly one retry on non-2xx/network error,
//           Retry-After ≤8s honored) → htmlToCourseMarkdown → download images through
//           httpBuffer (assets/<safeName> under rootDir/<courseId>) and rewrite references
//           to course-media://<courseId>/<rel>. Per-page failure reasons are collected for
//           the run's stats.
//   PERSIST lessons/<slug>.md with §7 front-matter + one CourseStore row per ok item, then
//           finalize the course as 'complete' or 'partial' with run stats (incl. failures[])
//           in stats_json.
// All I/O goes through injected clients and node:fs (no platform-conditional paths), so this
// module is unit-testable with a :memory: store and fake HTTP on macOS and Windows alike.

import path from "node:path";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

import { htmlToCourseMarkdown } from "./markdown";
import { downloadCourseAssets } from "./assets";
import { safeCourseDirName } from "./courseDir";
import { fetchAssessmentQuestions, renderAssessmentMarkdown } from "./assessments";
import { planMicrosoftLearn, type MslItem } from "./profiles/microsoftLearn";
import { planGeneric } from "./profiles/generic";
import type { CourseStore } from "./courseStore";

/** One progress event pushed to the importer UI during a course import run. */
export interface IngestProgress {
  courseId: string;
  phase: "plan" | "page" | "assets" | "done";
  done: number;
  total: number;
  current?: string;
  status?: "ok" | "failed" | "skipped";
}

/** Final counts plus per-page failure reasons; the same object is written into courses.stats_json on finalize. */
export interface IngestStats {
  planned: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** `"<url> — <reason>"` for each permanently-failed page, ≤300 chars, first 25 of the run. */
  failures: string[];
}

interface TextHttpClient {
  get(url: string): Promise<{ status: number; body: string; headers?: Record<string, string>; }>;
}

interface BufferHttpClient {
  get(url: string): Promise<{ status: number; body: Uint8Array }>;
}

export interface RunIngestOptions {
  courseId: string;
  rootDir: string;
  /** Persistence handle for the course/lesson rows this run produces. */
  store: CourseStore;
  maxPages?: number; // default 2000, hard cap 5000 (defaults.ts §6 decision 6)
  concurrency?: number; // default 3, capped at 4 (R-A5 politeness)
  delayMs?: number; // polite gap between fetch starts, default 250
  /** Wait before the one per-page retry, ms. A numeric Retry-After header ≤8s wins over it. */
  retryDelayMs?: number;
  respectRobots?: boolean;
  signal?: AbortSignal;
  http: TextHttpClient;
  /** Binary client for asset downloads. Default: wrap opts.http with a TextEncoder. */
  httpBuffer?: BufferHttpClient;
  onProgress: (p: IngestProgress) => void;
  /** Reserved for later phases (AI-assisted profiling/enrichment). No LLM work in P1. */
  aiAssist?: unknown;
}

const DEFAULT_MAX_PAGES = 2000;
const HARD_CAP_MAX_PAGES = 5000;
const PROFILE_MS_LEARN = "microsoft-learn";

/** Base wait before the single page retry (ms); overridable via opts.retryDelayMs. */
const DEFAULT_RETRY_DELAY_MS = 1500;
/** A Retry-After value above this many seconds is ignored in favor of the base delay. */
const RETRY_AFTER_CAP_S = 8;

/** Persisted failure reasons are bounded so stats_json cannot grow unboundedly. */
const MAX_FAILURE_ENTRIES = 25;
const FAILURE_REASON_MAX_CHARS = 300;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Lowercased kebab slug of a free-text value (empty for non-symbolic input). */
function slugifyText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Filesystem-safe lesson file stem from the last URL path segment ("unit-1/", "ref.pdf" …). */
function slugFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter((s) => s.length > 0);
    let last = segments[segments.length - 1];
    if (!last) return "";
    try {
      last = decodeURIComponent(last);
    } catch {
      // keep the raw segment when percent-decoding fails
    }
    return slugifyText(last.replace(/\.[a-z0-9]{2,5}$/i, ""));
  } catch {
    return "";
  }
}

/** Per-course unique slugs (collision-safe on case-insensitive filesystems). */
function uniqueLessonSlugs(items: ReadonlyArray<{ url: string }>): string[] {
  const taken = new Set<string>();
  return items.map((item, index) => {
    const base = slugFromUrl(item.url) || String(index);
    let candidate = base;
    for (let n = 1; taken.has(candidate.toLowerCase()); n += 1) {
      candidate = `${base}-${n}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Display name from the last non-empty root-URL path segment, falling back to the host. */
function nameFromRootUrl(rootUrl: string): string {
  try {
    const url = new URL(rootUrl);
    const segments = url.pathname.split("/").filter((s) => s.length > 0 && s !== ".");
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      let segment = segments[i];
      try {
        segment = decodeURIComponent(segment);
      } catch {
        // keep the raw segment when percent-decoding fails
      }
      const clean = segment.trim();
      if (clean.length > 0) return clean;
    }
    return url.hostname || "course";
  } catch {
    return "course";
  }
}

/** Default httpBuffer adapter: re-encode the already-text-decoded body as UTF-8 bytes. */
function textAsBuffer(http: TextHttpClient): BufferHttpClient {
  const encoder = new TextEncoder();
  return {
    async get(url) {
      const res = await http.get(url);
      return { status: res.status, body: encoder.encode(res.body ?? "") };
    },
  };
}

/** Expose getBuffer alongside get — assets.ts downloads through client.getBuffer(url). */
function withGetBufferClient(http: BufferHttpClient): {
  get(url: string): Promise<{ status: number; body: Uint8Array }>;
  getBuffer(url: string): Promise<{ status: number; body: Uint8Array }>;
} {
  return {
    async get(url) {
      return http.get(url);
    },
    async getBuffer(url) {
      return http.get(url);
    },
  };
}

/** Naive robots.txt parse: every non-empty Disallow value becomes a normalized path prefix. */
export function parseRobotsDisallows(robotsText: string): string[] {
  const prefixes = new Set<string>();
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const colon = rawLine.indexOf(":");
    if (colon === -1) continue;
    const key = rawLine.slice(0, colon).trim().toLowerCase();
    let value = rawLine.slice(colon + 1);
    const comment = value.indexOf("#");
    if (comment !== -1) value = value.slice(0, comment);
    value = value.trim();
    if (key === "disallow" && value.length > 0) {
      prefixes.add(value.startsWith("/") ? value : `/${value}`);
    }
  }
  return [...prefixes];
}

/**
 * Wait (ms) before a page retry: the response's numeric `Retry-After` header, in seconds,
 * wins when present and ≤ RETRY_AFTER_CAP_S; otherwise the base delay applies.
 * Header lookup is case-insensitive; anything unparseable or out of range falls back.
 */
export function resolveRetryDelayMs(
  headers: Record<string, string> | undefined,
  baseDelayMs: number,
): number {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "retry-after") continue;
      const seconds = Number(value);
      if (value.trim().length > 0 && Number.isFinite(seconds) && seconds >= 0 && seconds <= RETRY_AFTER_CAP_S) {
        return Math.round(seconds * 1000);
      }
      break; // present but unusable → base delay
    }
  }
  return baseDelayMs;
}

/** Plain ms wait for the per-page retry backoff (tests override it to ~0). */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export interface RunPoolOptions {
  /** Max items in flight; clamped to >= 1. Default 3. */
  concurrency?: number;
  /** Polite gap between item starts, ms. Default 0 (runCourseImport applies its own). */
  delayMs?: number;
  /** Aborting stops scheduling of new items; in-flight workers finish naturally. */
  signal?: AbortSignal;
}

/**
 * Fixed-size worker pool over an ordered list: start order always follows item order while
 * up to `concurrency` workers run concurrently. Returns once every scheduled item completed.
 */
export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  options: RunPoolOptions = {},
): Promise<void> {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 3));
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const signal = options.signal;

  if (signal?.aborted || items.length === 0) return;

  let cursor = 0;
  async function runner(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      if (!(await sleepUnlessAborted(delayMs, signal))) return;
      await worker(items[index], index);
    }
  }

  const runners: Array<Promise<void>> = [];
  for (let slot = 0; slot < Math.min(concurrency, items.length); slot += 1) {
    if (signal?.aborted) break;
    runners.push(runner());
  }
  await Promise.all(runners);
}

/** ms delay that resolves false as soon as the signal aborts. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    setTimeout(() => finish(!signal?.aborted), ms);
    const onAbort = (): void => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface LessonFileRef {
  title: string;
  url: string;
  kind: string;
  moduleId?: string | null;
}

/** lessons/<slug>.md with plan §7 front-matter (only known fields are emitted). */
async function persistLesson(
  rootDir: string,
  courseId: string,
  slug: string,
  ref: LessonFileRef,
  orderNo: number,
  markdown: string,
): Promise<void> {
  const lessonsDir = path.join(rootDir, safeCourseDirName(courseId), "lessons");
  await mkdir(lessonsDir, { recursive: true });
  const frontMatter = [
    "---",
    `title: ${JSON.stringify(ref.title)}`,
    `url: ${ref.url}`,
    `kind: ${ref.kind}`,
    ...(ref.moduleId ? [`parent: modules/${slugifyText(String(ref.moduleId))}`] : []),
    `order: ${orderNo}`,
    `updatedAt: ${new Date().toISOString()}`,
    `contentHash: sha1:${crypto.createHash("sha1").update(markdown).digest("hex")}`,
    "---",
  ].join("\n");
  await writeFile(
    path.join(lessonsDir, `${slug}.md`),
    `${frontMatter}\n${markdown.replace(/\s+$/, "")}\n`,
    "utf8",
  );
}

/**
 * Import one course: plan → gate → pooled fetch/extract → local markdown + store rows.
 * Planning errors reject (no course row touched); per-item failures are isolated and counted.
 */
export async function runCourseImport(
  rootUrl: string,
  courseId: string,
  opts: RunIngestOptions,
): Promise<{ stats: IngestStats }> {
  // assets.ts drives its client through getBuffer(); normalize so both an injected
  // httpBuffer (spec-shaped: get only) and the default wrapper expose it.
  const bufferHttp = withGetBufferClient(opts.httpBuffer ?? textAsBuffer(opts.http));
  const concurrency = clampInt(opts.concurrency, 3, 1, 4);
  const delayMs = Math.max(0, opts.delayMs ?? 250);
  const maxPages = clampInt(opts.maxPages, DEFAULT_MAX_PAGES, 1, HARD_CAP_MAX_PAGES);
  const baseRetryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const signal = opts.signal;

  const emit = (p: Omit<IngestProgress, "courseId">): void => {
    try {
      opts.onProgress({ ...p, courseId });
    } catch {
      // A progress observer must never break the import.
    }
  };

  const stats: IngestStats = { planned: 0, succeeded: 0, failed: 0, skipped: 0, failures: [] };

  // PLAN — pick the planner by hostname: MS Learn keeps its dedicated TOC walk; any other host
  // goes through the generic sitemap/crawl planner. A bad root URL still yields an empty plan.
  let rootHost = "";
  try {
    rootHost = new URL(rootUrl).hostname;
  } catch {
    // unparseable — the generic planner reports it in warnings
  }
  const plan = await (rootHost === "learn.microsoft.com"
    ? planMicrosoftLearn(rootUrl, opts.http)
    : planGeneric(rootUrl, opts.http));
  const items = plan.items.slice(0, maxPages);
  stats.planned = items.length;
  const slugs = uniqueLessonSlugs(items);

  // GATE — one robots.txt fetch for the root origin; any failure disables gating.
  let disallow: string[] = [];
  if (opts.respectRobots) {
    try {
      const res = await opts.http.get(`${new URL(rootUrl).origin}/robots.txt`);
      if (res.status >= 200 && res.status < 300) disallow = parseRobotsDisallows(res.body);
    } catch {
      // robots fetch failed ⇒ ignore robots entirely.
    }
  }
  const isDisallowed = (url: string): boolean => {
    if (disallow.length === 0) return false;
    try {
      return disallow.some((prefix) => new URL(url).pathname.startsWith(prefix));
    } catch {
      return false;
    }
  };

  // Persist the course as 'importing' before any page work.
  const courseFields = {
    id: courseId,
    name: nameFromRootUrl(rootUrl),
    sourceUrl: rootUrl,
    // Only Microsoft Learn roots carry the dedicated profile; every other host is generic.
    profile: rootHost === "learn.microsoft.com" ? PROFILE_MS_LEARN : "generic",
  };
  opts.store.upsertCourse({ ...courseFields, status: "importing" });

  emit({ phase: "plan", done: 0, total: items.length });

  /**
   * Page GET with exactly one retry on non-2xx or network throw. Waits a numeric
   * Retry-After header (seconds, ≤8s) when present, else the base delay; the second
   * attempt is final — its failure propagates to the per-item catch as today.
   */
  async function fetchPageWithRetry(url: string): Promise<{ status: number; body: string }> {
    let first: { status: number; body: string; headers?: Record<string, string> } | undefined;
    try {
      first = await opts.http.get(url);
    } catch {
      // Network-level throw: no response ⇒ no Retry-After — wait the base delay.
    }
    if (first && first.status >= 200 && first.status <= 299) return first;
    await sleepMs(resolveRetryDelayMs(first?.headers, baseRetryDelayMs));
    const second = await opts.http.get(url); // A throwing retry propagates to the per-item catch.
    if (!second || second.status < 200 || second.status > 299) {
      throw new Error(`page fetch returned HTTP ${second ? second.status : "unknown"}`);
    }
    return { status: second.status, body: second.body };
  }

  let completed = 0;
  const worker = async (item: MslItem, index: number): Promise<void> => {
    if (signal?.aborted) return; // per-item abort check
    try {
      if (isDisallowed(item.url)) {
        stats.skipped += 1;
        completed += 1;
        emit({ phase: "page", done: completed, total: items.length, current: item.title, status: "skipped" });
        return;
      }

      const res = await fetchPageWithRetry(item.url);

      const md = htmlToCourseMarkdown(res.body, item.url);
      let markdown = md.markdown;
      if (md.images.length > 0) {
        emit({ phase: "assets", done: completed, total: items.length, current: item.title });
        const dl = await downloadCourseAssets(md.images, bufferHttp, { courseId, rootDir: opts.rootDir });
        for (const [origUrl, relPath] of Object.entries(dl.map)) {
          markdown = markdown.split(origUrl).join(`course-media://${courseId}/${relPath}`);
        }
      }

      await persistLesson(opts.rootDir, courseId, slugs[index], item, index, markdown);

      if (item.kind === "assessment") {
        // P5 best-effort assessment capture: append extracted questions when the page embeds
        // them, otherwise just the guaranteed external link card. Never breaks an ok lesson.
        const localMdPath = path.join(path.join(opts.rootDir, safeCourseDirName(courseId), "lessons"), `${slugs[index]}.md`);
        try {
          const fetched = await fetchAssessmentQuestions(item.url, opts.http);
          await appendFile(localMdPath, renderAssessmentMarkdown(item.title, item.url, fetched.ok ? fetched.questions : []));
          if (!fetched.ok) {
            console.warn(`[Courses] practice assessment questions unavailable for ${item.url} — external link card only`);
          }
        } catch {
          // Optional enrichment: a failed capture must not fail the lesson itself.
        }
      }

      opts.store.addLessons(courseId, [
        {
          id: `${courseId}:${slugs[index]}`,
          title: item.title,
          url: item.url,
          kind: item.kind,
          parent: item.moduleId ? `modules/${slugifyText(String(item.moduleId))}` : null,
          orderNo: index,
          localMdPath: path.join(path.join(opts.rootDir, safeCourseDirName(courseId), "lessons"), `${slugs[index]}.md`),
        },
      ]);

      stats.succeeded += 1;
      completed += 1;
      emit({ phase: "page", done: completed, total: items.length, current: item.title, status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Courses] import failed for ${item.url}: ${message}`);
      if (stats.failures.length < MAX_FAILURE_ENTRIES) {
        stats.failures.push(`${item.url} — ${message}`.slice(0, FAILURE_REASON_MAX_CHARS));
      }
      stats.failed += 1;
      completed += 1;
      emit({ phase: "page", done: completed, total: items.length, current: item.title, status: "failed" });
    }
  };

  await runPool(items, worker, { concurrency, delayMs, signal });

  // Finalize — an aborted early run with zero errors still reports 'complete' by design.
  const finalStatus = stats.failed + stats.skipped === 0 ? "complete" : "partial";
  opts.store.upsertCourse({ ...courseFields, status: finalStatus, stats: { ...stats } });
  emit({ phase: "done", done: completed, total: items.length });

  return { stats };
}
