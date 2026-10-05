// electron/context-intelligence/policies/answer-policy-store.ts
//
// Persistence for the ONE user-facing grounding control (§6).
//
// A choice that is stored but never read is the unwired-architecture disease
// this mission documents (F1/F9/F10), so this store exists only because the
// consumers do: `decide()` honours `userAnswerPolicy`, and the wired surfaces
// read the store per turn. Keep it that way — do not add fields here ahead of a
// consumer.
//
// Storage is a single small JSON file in userData rather than a DB column: the
// modes table is versioned by migration (v25 at time of writing) and a
// per-mode UI preference does not justify a schema bump. Each read validates
// the latest disk contents; writes serialize read/modify/replace and
// rename a private staging file so readers only see complete committed JSON.
//
// Keys are the mode's UNIQUE id when one exists (two custom modes share a
// templateType but never an id), falling back to templateType for the built-in
// singletons.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AnswerPolicy } from './answer-policy';

const FILE_NAME = 'context-intelligence-answer-policy.json';

// The cache lives on globalThis, NOT at module scope, for the same reason the
// ModesManager active-mode snapshot does: esbuild inlines this module into
// every main-process entry bundle that imports it (12 dist files), and each
// inlined copy is its own module scope. The running app loads only main.js, so
// this is latent there — but any harness/eval/test process that co-loads two
// dist-electron bundles gets a writer copy (the settings IPC) and reader copies
// (engine-bridge for WTA/assist/manual-answer) whose module-level `cached`
// never see each other's writes. Both call-site comments promise "read per
// turn so a Settings change applies to the very next answer"; a process-wide
// slot is what makes that promise true in every runtime.
const CACHE_KEY = '__nativelyAnswerPolicyStoreCacheV1__';
interface PolicyCache { cached: Record<string, AnswerPolicy> | null; cachedDir: string | null; raw?: string | null }
function cacheSlot(): PolicyCache {
  const g = globalThis as unknown as Record<string, unknown>;
  let slot = g[CACHE_KEY] as PolicyCache | undefined;
  if (!slot) { slot = { cached: null, cachedDir: null }; g[CACHE_KEY] = slot; }
  return slot;
}

function resolveDir(explicitDir?: string): string {
  if (explicitDir) return explicitDir;
  // Test isolation first — the same variable every harness in this repo uses —
  // then Electron userData, then a scratch fallback for bare-node contexts.
  if (process.env.NATIVELY_TEST_USERDATA) return process.env.NATIVELY_TEST_USERDATA;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app?.getPath) return app.getPath('userData');
  } catch { /* not in electron */ }
  return process.cwd();
}

function filePath(dir?: string): string {
  return path.join(resolveDir(dir), FILE_NAME);
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const SHARING_RETRY_MS = 250;
const WRITER_WAIT_MS = 2000;

// Windows can transiently refuse replacement while a reader/scanner holds a
// handle. Never unlink the destination or acknowledge before rename succeeds.
function retrySharing<T>(operation: () => T): T {
  const deadline = Date.now() + SHARING_RETRY_MS;
  for (;;) {
    try { return operation(); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

const OWNER_PATTERN = /^owner-(\d+)-[0-9a-f-]{36}$/;

function ownerIsDead(owner: string): boolean {
  const match = OWNER_PATTERN.exec(owner);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function removeOwnedDirectory(directory: string, owner?: string): void {
  if (owner) {
    try { retrySharing(() => fs.unlinkSync(path.join(directory, owner))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Never recursively remove the shared path. A delayed reclaimer/releaser
  // cannot unlink a successor's different marker, and rmdir cannot remove its
  // nonempty directory. A crash after marker deletion leaves a reclaimable
  // empty directory, not another lock that itself needs recovery ownership.
  try { retrySharing(() => fs.rmdirSync(directory)); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

function reclaimDeadWriter(lock: string): void {
  let entries: string[];
  try { entries = retrySharing(() => fs.readdirSync(lock)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.length === 0) removeOwnedDirectory(lock);
  else if (entries.length === 1 && ownerIsDead(entries[0])) removeOwnedDirectory(lock, entries[0]);
}

function cleanDeadClaims(lock: string): void {
  const prefix = `${path.basename(lock)}.`;
  for (const entry of fs.readdirSync(path.dirname(lock))) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.claim')) continue;
    const owner = entry.slice(prefix.length, -'.claim'.length);
    if (ownerIsDead(owner)) removeOwnedDirectory(path.join(path.dirname(lock), entry), owner);
  }
}

function acquireWriterLock(target: string): () => void {
  const lock = `${target}.lock`;
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const claim = `${lock}.${owner}.claim`;
  cleanDeadClaims(lock);
  fs.mkdirSync(claim, { mode: 0o700 });
  try {
    // The owner is the marker's NAME, not subsequently written metadata.
    // Initialize privately, then publish the complete nonempty directory in
    // one rename. Neither Windows nor macOS replaces a nonempty directory.
    fs.writeFileSync(path.join(claim, owner), '', { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + WRITER_WAIT_MS;
    for (;;) {
      const acquired = retrySharing(() => {
        try { fs.renameSync(claim, lock); return true; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '') && fs.existsSync(lock)) return false;
          throw error;
        }
      });
      if (acquired) return () => removeOwnedDirectory(lock, owner);
      reclaimDeadWriter(lock);
      if (Date.now() >= deadline) throw Object.assign(new Error(`Timed out waiting to persist answer policy: ${lock}`), { code: 'EBUSY' });
      Atomics.wait(pause, 0, 0, 10);
    }
  } finally {
    removeOwnedDirectory(claim, owner);
  }
}

function load(dir?: string, insideWriterLock = false): Record<string, AnswerPolicy> {
  const slot = cacheSlot();
  const d = resolveDir(dir);
  // An ordinary open Node read handle blocks replacement on Windows. Pause
  // cooperating readers while a writer commits; retry covers the small race
  // between this check and opening the old file. macOS readers need no pause.
  if (process.platform === 'win32' && !insideWriterLock) {
    const lock = `${filePath(d)}.lock`;
    const deadline = Date.now() + WRITER_WAIT_MS;
    while (fs.existsSync(lock)) {
      reclaimDeadWriter(lock);
      if (Date.now() >= deadline) throw Object.assign(new Error(`Timed out reading answer policy during persistence: ${lock}`), { code: 'EBUSY' });
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  let text: string | null;
  try { text = retrySharing(() => fs.readFileSync(filePath(d), 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = null;
  }
  if (slot.cached && slot.cachedDir === d && slot.raw === text) return slot.cached;
  // Validate values, but never turn unreadable/corrupt persisted choices into
  // an empty map that a subsequent write could silently overwrite.
  const raw = text === null ? {} : JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid answer-policy store: ${filePath(d)}`);
  const next: Record<string, AnswerPolicy> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === 'use_references_when_relevant' || v === 'only_answer_from_references') next[k] = v;
  }
  slot.cached = next; slot.cachedDir = d; slot.raw = text;
  return next;
}

/** The user's stored choice for a mode, or null when they never made one. */
export function getStoredAnswerPolicy(modeKey: string, dir?: string): AnswerPolicy | null {
  if (!modeKey) return null;
  return load(dir)[modeKey] ?? null;
}

/** Persist a choice; null clears it back to the mode default. */
export function setStoredAnswerPolicy(modeKey: string, policy: AnswerPolicy | null, dir?: string): void {
  if (!modeKey) return;
  const target = filePath(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const release = acquireWriterLock(target);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Read INSIDE the lock: a cache or pre-lock snapshot loses other writers.
    const map = { ...load(dir, true) };
    if (policy === null) delete map[modeKey];
    else map[modeKey] = policy;
    const text = JSON.stringify(map, null, 2);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    retrySharing(() => fs.renameSync(tmp, target));
    const slot = cacheSlot();
    slot.cached = map; slot.cachedDir = resolveDir(dir); slot.raw = text;
  } finally {
    try { retrySharing(() => fs.rmSync(tmp, { force: true })); } finally { release(); }
  }
}

/** Test seam: drop the cache so a fresh dir is re-read. */
export function _resetAnswerPolicyStoreForTest(): void {
  const slot = cacheSlot();
  slot.cached = null; slot.cachedDir = null; slot.raw = undefined;
}
