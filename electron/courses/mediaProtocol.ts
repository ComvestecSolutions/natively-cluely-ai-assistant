// ============================================================================
// Courses Studio — course-media:// protocol (P0 batch 4).
//
// Serves course assets from <userData>/courses/<courseId>/<relPath> under the
// privileged `course-media` scheme, so renderers can embed them directly via
// e.g. course-media://<courseId>/assets/cover.png.
//
// Timing contract (Electron requirements):
//   - registerCourseMediaSchemes() MUST run at module load, BEFORE the app is
//     ready — Electron throws if a privileged scheme is registered later.
//   - handleCourseMediaProtocol(app) binds protocol.handle(...) and must only
//     be called AFTER app.whenReady(). main.ts performs both: top of module
//     (pre-ready) and inside initializeApp() after the ready log, respectively.
// ============================================================================

import { protocol } from "electron"
import path from "path"
import fs from "fs"

import { resolveCourseDataDir } from "./courseDir";

export const COURSE_MEDIA_SCHEME = "course-media";

/**
 * Minimal structural view of Electron.App: everything this handler needs is a
 * userData path. Keeping it structural (instead of importing the Electron
 * type) makes the module testable with a plain stub and avoids coupling to how
 * electron.d.ts exposes its types under this repo's strict tsconfig.
 */
interface CourseMediaHostApp {
  getPath(name: "userData"): string;
}

/**
 * Registers course-media as a privileged scheme (standard + secure).
 * Must be called exactly once at module load, before the app is ready.
 */
export function registerCourseMediaSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: COURSE_MEDIA_SCHEME,
      privileges: { standard: true, secure: true },
    },
  ]);
}

/**
 * Resolves a course-relative media path to an absolute filesystem path.
 *
 * Defensive — any traversal or outside-root input yields null instead of a
 * path, and it never throws. The course dir is resolved through
 * resolveCourseDataDir (courseDir.ts) so pre-fix raw-id directories keep
 * resolving; otherwise only node:path join/resolve/sep, no manual segment math.
 */
export function resolveCourseMediaPath(
  coursesRootDir: string,
  courseId: string,
  relPath: string,
): string | null {
  if (!courseId || !relPath) return null;

  // A course id is a single path segment (it arrives as the URL host). If it
  // contains any separator or traversal marker it can never be a valid id.
  if (
    courseId.includes("/") ||
    courseId.includes("\\") ||
    courseId.includes("\0") ||
    relPath.includes("\0")
  ) {
    return null;
  }

  const root = path.resolve(coursesRootDir);
  const courseDir = resolveCourseDataDir(root, courseId);
  // The course directory itself must sit strictly inside the courses root —
  // this is what rejects courseId values that would resolve elsewhere.
  if (!courseDir.startsWith(root + path.sep)) return null;

  const target = path.resolve(courseDir, relPath);
  // After normalization by resolve(), any surviving ".." walk-out shows up as
  // a prefix mismatch — anything not strictly inside the course dir is rejected.
  if (!target.startsWith(courseDir + path.sep)) return null;

  return target;
}

const MEDIA_CONTENT_TYPES: Record<string, { type: string; charset?: string }> = {
  ".png": { type: "image/png" },
  ".jpg": { type: "image/jpeg" },
  ".jpeg": { type: "image/jpeg" },
  ".gif": { type: "image/gif" },
  ".webp": { type: "image/webp" },
  ".svg": { type: "image/svg+xml" },
  ".pdf": { type: "application/pdf" },
};

/** Content metadata for a file extension; null when the kind is not servable. */
export function contentForExtension(ext: string): { type: string; charset?: string } | null {
  return MEDIA_CONTENT_TYPES[ext.toLowerCase()] ?? null;
}

function tryDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Percent-decode a single URL segment, falling back to the raw value rather
// than failing the request on stray percent characters.
function decodeSegment(value: string): string {
  const decoded = tryDecode(value);
  return decoded === null ? value : decoded;
}

/**
 * Splits a course-media:// request URL into (courseId, relPath).
 * Canonical form is `course-media://<courseId>/<rel...>` (id in the host);
 * the flat `course-media:/<courseId>/<rel...>` form (no authority) is also
 * tolerated — there the id falls out as the first path segment.
 */
function parseCourseMediaRequest(
  rawUrl: string,
): { courseId: string; relPath: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${COURSE_MEDIA_SCHEME}:`) return null;

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);

  if (url.host) {
    const courseId = decodeSegment(url.host);
    const relPath = segments.join("/");
    return courseId && relPath ? { courseId, relPath } : null;
  }

  if (segments.length < 2) return null;
  return { courseId: segments[0], relPath: segments.slice(1).join("/") };
}

function notFoundResponse(): Response {
  return new Response("Not Found", { status: 404 });
}

/**
 * Binds the protocol.handle handler for course-media. Must be called exactly
 * once, after app.whenReady(). Unknown/missing/unreadable resources get a
 * plain 404; anything unexpected gets a logged 500 — never an unhandled throw.
 */
export function handleCourseMediaProtocol(app: CourseMediaHostApp): void {
  protocol.handle(COURSE_MEDIA_SCHEME, async (request: { url: string }) => {
    try {
      const parsed = parseCourseMediaRequest(request.url);
      if (!parsed) return notFoundResponse();

      const coursesRootDir = path.join(app.getPath("userData"), "courses");
      const resolvedPath = resolveCourseMediaPath(
        coursesRootDir,
        parsed.courseId,
        parsed.relPath,
      );
      if (!resolvedPath) return notFoundResponse();

      // Unknown file kinds are indistinguishable from missing ones to the
      // caller — a 404 (rather than an error page) keeps <img> degrading.
      const mediaType = contentForExtension(path.extname(resolvedPath));
      if (!mediaType) return notFoundResponse();

      let body: Buffer;
      try {
        body = await fs.promises.readFile(resolvedPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EISDIR") return notFoundResponse();
        throw err; // permission/disk failures surface as 500 below
      }

      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "content-type": mediaType.type,
          "cache-control": "no-cache",
        },
      });
    } catch (err) {
      console.error(`[CourseMedia] failed to serve resource:`, err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}
