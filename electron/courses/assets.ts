// ============================================================================
// Courses Studio — course asset downloader (P1).
//
// Fetches http(s) media/document URLs into <rootDir>/<courseId>/assets/<name>
// and returns a URL → relPath map. relPath is relative to the COURSE dir
// ("assets/..."), matching resolveCourseMediaPath(coursesRoot, courseId,
// relPath) in mediaProtocol.ts: ingest builds course-media://<courseId>/<rel>.
// ============================================================================

import path from "node:path";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";

import { safeCourseDirName } from "./courseDir";

/** Injection point for HTTP so tests can fake the network layer. */
export interface AssetHttpClient {
  getBuffer(url: string): Promise<{ status: number; body: Uint8Array }>;
}

export interface AssetOptions {
  courseId: string;
  /** The userData/courses dir (the courses root, NOT a course dir). */
  rootDir: string;
  /** Total download budget in bytes for this run; default 2 GiB. */
  maxBytes?: number;
}

export interface AssetFailure {
  url: string;
  reason: string;
}

const DEFAULT_MAX_BYTES = 2048 * 1024 * 1024;

/** Max chars of the sanitized source segment (the sha1 suffix adds on top). */
const MAX_SAFE_CHARS = 80;

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 6);
}

function sanitizePart(part: string): string {
  // Every character outside the boring set becomes "_"; 1:1 so length is stable.
  return part.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Pure name derivation (no I/O). Takes the last path segment of the URL,
 * replaces unsafe characters with "_", keeps ≤ MAX_SAFE_CHARS of it, and pins
 * a 6-hex sha1(url) suffix so identical stems from different hosts never
 * collide. The hash is inserted BEFORE the final extension on purpose:
 * course-media:// resolves its content-type via path.extname(), so appending
 * hex after ".png" would make the protocol refuse to serve the file.
 */
export function assetSafeName(url: string): string {
  const hash = shortHash(url);

  let lastSegment: string;
  try {
    lastSegment = new URL(url).pathname;
  } catch {
    // Not a parseable URL — treat it as an opaque path-like token.
    lastSegment = url.replace(/\\/g, "/").split(/[?#]/)[0];
  }

  const rawSeg = lastSegment.split("/").filter(Boolean).pop() ?? "";
  let seg = rawSeg;
  try {
    const decoded = decodeURIComponent(rawSeg);
    if (decoded) seg = decoded;
  } catch {
    // Malformed percent-encoding — keep the raw segment.
  }

  if (!seg) return `asset-${hash}`; // directory-like URL: stable generic name

  const dot = seg.lastIndexOf(".");
  const hasExt = dot > 0 && dot < seg.length - 1;
  const ext = hasExt ? sanitizePart(seg.slice(dot)) : "";
  let base = hasExt ? sanitizePart(seg.slice(0, dot)) : sanitizePart(seg);
  if (!base) base = "asset";

  // Keep <base><ext> within MAX_SAFE_CHARS, never chopping the extension.
  const maxBaseLen = Math.max(1, MAX_SAFE_CHARS - ext.length);
  if (base.length > maxBaseLen) base = base.slice(0, maxBaseLen);

  return hasExt ? `${base}-${hash}${ext}` : `${base}-${hash}`;
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Downloads each http(s) URL (deduped, in first-seen order) into
 * <rootDir>/<courseId>/assets/. Non-http(s) URLs are skipped. Existing
 * non-empty files are reused without a network hit (idempotent resume).
 * Once the byte budget is exceeded, the offending URL and every remaining
 * candidate fail with reason "budget".
 */
export async function downloadCourseAssets(
  urls: string[],
  http: AssetHttpClient,
  opts: AssetOptions,
): Promise<{ map: Record<string, string>; failed: AssetFailure[] }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive number");
  }

  // Dedupe while preserving first-seen order.
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url || typeof url !== "string" || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }

  // Same containment rule the course-media:// resolver applies: never write
  // outside <rootDir> even for a hostile courseId.
  const root = path.resolve(opts.rootDir);
  const assetsDir = path.resolve(path.join(root, safeCourseDirName(opts.courseId), "assets"));
  if (!assetsDir.startsWith(root + path.sep)) {
    throw new Error(`unsafe courseId: ${opts.courseId}`);
  }

  const map: Record<string, string> = {};
  const failed: AssetFailure[] = [];
  let bytesWritten = 0;
  let overBudget = false;

  for (const url of unique) {
    if (!isHttpUrl(url)) continue; // spec: only http(s) are download candidates

    const safeName = assetSafeName(url);
    const relPath = `assets/${safeName}`; // relative to the COURSE dir
    const absFile = path.join(assetsDir, safeName);

    try {
      const stat = await fsp.stat(absFile);
      if (stat.isFile() && stat.size > 0) {
        map[url] = relPath; // on disk already — no network, budget untouched
        continue;
      }
    } catch {
      // ENOENT (or unreadable): fall through to download.
    }

    if (overBudget) {
      failed.push({ url, reason: "budget" });
      continue;
    }

    let res: { status: number; body: Uint8Array };
    try {
      res = await http.getBuffer(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ url, reason: `request failed (${message})` });
      continue;
    }

    const status = Number.isInteger(res.status) ? res.status : 0;
    if (status < 200 || status >= 300) {
      failed.push({ url, reason: `HTTP ${status}` });
      continue;
    }

    // Copy so the write never aliases a buffer the client may reuse.
    const source = res.body ?? new Uint8Array(0);
    const body = Buffer.from(source.slice().buffer);
    if (body.length === 0) {
      failed.push({ url, reason: `empty response (HTTP ${status})` });
      continue;
    }

    if (bytesWritten + body.length > maxBytes) {
      overBudget = true;
      failed.push({ url, reason: "budget" });
      continue;
    }

    try {
      await fsp.mkdir(assetsDir, { recursive: true }); // no-op after first success
      await fsp.writeFile(absFile, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ url, reason: `write failed (${message})` });
      continue;
    }

    bytesWritten += body.length;
    map[url] = relPath;
  }

  return { map, failed };
}
