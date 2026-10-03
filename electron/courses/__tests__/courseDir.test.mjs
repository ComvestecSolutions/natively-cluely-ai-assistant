/**
 * courseDir — Windows-safe course dir name helper + legacy-tolerant resolver.
 * Run via `node scripts/run-electron-tests.mjs electron/courses` after building:
 *   npm run build:electron
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { safeCourseDirName, resolveCourseDataDir } = await import(
  pathToFileURL(path.join(distRoot, 'courseDir.js')).href,
);

// The real-world id shape that broke Windows imports (raw URL embedded in the id).
const CERT_HUB_ID =
  'course-https://learn.microsoft.com/en-us/credentials/certifications/ai-agent-builder-associate/?practice-assessment-type=certification';

test('a) real cert-hub id sanitizes to a single NTFS-legal segment', () => {
  const name = safeCourseDirName(CERT_HUB_ID);
  assert.doesNotMatch(name, /[:?\\/]/, 'no : ? \\ or / survives');
  assert.match(name, /^[A-Za-z0-9._-]+$/, 'single legal path segment');
  assert.ok(name.length <= 140);
  assert.notEqual(name, CERT_HUB_ID);
});

test('b) already-safe input is unchanged (idempotence)', () => {
  const id = 'my-course_2.x';
  assert.equal(safeCourseDirName(id), id);
  const once = safeCourseDirName(CERT_HUB_ID);
  assert.equal(safeCourseDirName(once), once, 'double application is a no-op');
});

test('c) empty/garbage input falls back to "course"', () => {
  assert.equal(safeCourseDirName(''), 'course');
  assert.equal(safeCourseDirName(''), 'course', 'null-like/empty input → course (helper coerces via String(?? ""))');
  assert.equal(safeCourseDirName('//::??'), 'course', 'all-illegal chars collapse away');
});

test('d) >140-char id truncation is deterministic and bounded', () => {
  const longId = `course-https://learn.microsoft.com/${'a'.repeat(150)}?practice-assessment-type=certification`;
  const once = safeCourseDirName(longId);
  assert.ok(longId.length > 140, 'fixture really exceeds the limit');
  assert.equal(safeCourseDirName(longId), once, 'same input → same name across calls');
  assert.equal(once.length, 129, '120 prefix + "-" + 8 hex chars');
});

test('e1) resolver migrates a legacy-only raw-id dir to the safe name and resolves there', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-coursedir-'));
  try {
    const id = 'legacy course'; // space is legal on POSIX → a legacy dir could exist there
    const legacyDir = path.join(ws, id);
    const safeDir = path.join(ws, safeCourseDirName(id));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'sentinel.txt'), 'keep-me');

    assert.doesNotThrow(() => resolveCourseDataDir(ws, id));
    assert.equal(resolveCourseDataDir(ws, id), safeDir, 'one-time migration lands on the safe name…');
    assert.ok(!fs.existsSync(legacyDir), '…and the legacy dir is gone after the rename');
    assert.equal(fs.readFileSync(path.join(safeDir, 'sentinel.txt'), 'utf8'), 'keep-me', 'data follows the migration…');
    assert.equal(resolveCourseDataDir(ws, id), safeDir, '…and repeated calls stay put');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('e2) resolver tolerates a failed one-time rename and keeps serving a resolvable dir', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-coursedir-'));
  try {
    const id = 'locked course';
    const legacyDir = path.join(ws, id);
    const safeDir = path.join(ws, safeCourseDirName(id));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'sentinel.txt'), 'keep-me');
    // Read-only parent makes the rename fail (POSIX EACCES; NTFS read-only dirs
    // likewise refuse moves) — but a permissive platform that migrates anyway is fine too.
    fs.chmodSync(ws, 0o555);

    let r;
    assert.doesNotThrow(() => {
      r = resolveCourseDataDir(ws, id); // never throws for locked/missing dirs
    });
    assert.ok([legacyDir, safeDir].includes(r), 'points at whichever dir is live');
    assert.equal(fs.readFileSync(path.join(r, 'sentinel.txt'), 'utf8'), 'keep-me', 'still resolves after the attempted rename');
  } finally {
    fs.chmodSync(ws, 0o755); // restore writability so cleanup can recurse
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
