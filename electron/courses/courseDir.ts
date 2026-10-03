// ============================================================================
// Courses Studio — Windows-safe course directory names (single source of truth).
//
// Course ids embed raw URLs (e.g. "course-https://learn.microsoft.com/...?x=y").
// ':' and '?' are illegal NTFS name characters, so every on-disk course dir is
// derived from safeCourseDirName(id) — never the raw id. DB rows keep the RAW
// id; only filesystem segments change. Pure string ops + node:fs, no
// process.platform branching: identical behavior on macOS and Windows.
// ============================================================================

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** NTFS max segment is 255 UTF-16 units; keep a wide margin below it. */
const MAX_SAFE_DIR_CHARS = 140;

/**
 * Maps a course id to one filesystem-safe directory segment.
 * Every char outside [A-Za-z0-9._-] becomes '-', runs of '-' collapse, and an
 * over-long result is cut at ~120 chars + '-' + sha1(original).slice(0,8) so
 * distinct long ids stay distinct and the mapping stays deterministic.
 */
export function safeCourseDirName(courseId: string): string {
  let name = String(courseId ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
  // Pure-garbage ids (only illegal chars) must collapse to '', not a bare '-'.
  name = name.replace(/^-+|-+$/g, "");
  if (name.length > MAX_SAFE_DIR_CHARS) {
    const digest = createHash("sha1").update(String(courseId)).digest("hex");
    name = `${name.slice(0, 120)}-${digest.slice(0, 8)}`;
  }
  return name.trim() || "course";
}

/** True when `p` is an existing directory; never throws (missing/bad path → false). */
function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the on-disk data dir for a course id at request time. Normally
 * returns <rootDir>/<safeCourseDirName(id)>. If only the legacy raw-id dir
 * (created pre-fix, where ':' etc. are legal — i.e. POSIX) exists, that dir is
 * kept serving and a one-time rename to the safe name is attempted; on failure
 * (Windows file locks can block renames) the legacy path simply keeps working.
 * Never throws for missing dirs — callers mkdir -p or surface ENOENT as before.
 */
export function resolveCourseDataDir(rootDir: string, courseId: string): string {
  const safe = path.join(rootDir, safeCourseDirName(courseId));
  if (isExistingDir(safe)) return safe;
  const raw = String(courseId ?? "");
  // Legacy fallback only when the raw id would actually differ on disk.
  if (raw !== "" && safeCourseDirName(raw) !== raw) {
    const legacy = path.join(rootDir, raw);
    if (isExistingDir(legacy)) {
      try {
        fs.renameSync(legacy, safe); // one-time migration; failures are ignored
      } catch {
        /* locked/busy: keep serving the legacy dir */
      }
      return isExistingDir(safe) ? safe : legacy;
    }
  }
  return safe;
}
