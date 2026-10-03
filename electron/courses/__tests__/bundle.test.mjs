// P4 course portability — unit tests for the zip bundle engine (electron/courses/bundle.ts).
// Imports COMPILED dist output; run with ELECTRON_RUN_AS_NODE via scripts/run-with-env.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const loadModule = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const { BUNDLE_SCHEMA_VERSION, exportCourseBundle, importCourseBundle, rekeyLessons, slugOfLesson } = await loadModule('bundle.js');

// Everything lives under one mkdtemp root so the hook can sweep it in a single call.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-bundle-engine-'));
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: the on-disk layout ingest produces for course 'demo-course'.
//   <src>/demo-course/lessons/{first,second}.md
//   <src>/demo-course/assets/sub/b.png
// ---------------------------------------------------------------------------
const courseId = 'demo-course';
const srcRoot = path.join(base, 'src');
fs.mkdirSync(path.join(srcRoot, courseId, 'lessons'), { recursive: true });
fs.mkdirSync(path.join(srcRoot, courseId, 'assets', 'sub'), { recursive: true });

const FIRST_MD = '# First\nalpha body';
const SECOND_MD = '# Second\nbeta body';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

fs.writeFileSync(path.join(srcRoot, courseId, 'lessons', 'first.md'), FIRST_MD, 'utf8');
fs.writeFileSync(path.join(srcRoot, courseId, 'lessons', 'second.md'), SECOND_MD, 'utf8');
fs.writeFileSync(path.join(srcRoot, courseId, 'assets', 'sub', 'b.png'), PNG_BYTES);

const COMPLETED_AT = '2026-01-15T10:30:00.000Z';

function baseMeta() {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    courseId,
    name: 'Demo Course',
    profile: null,
    sourceUrl: 'https://example.com/courses/demo',
    status: 'complete',
    enabled: true,
    lessons: [
      { id: `${courseId}:first`, title: 'First Lesson', url: 'https://example.test/first', kind: null, parent: null, orderNo: 1, tocPath: null, completedAt: null },
      { id: `${courseId}:second`, title: 'Second Lesson', url: 'https://example.test/second', kind: 'video', parent: 'modules/getting-started', orderNo: 2, tocPath: 'getting-started/deep-dive', completedAt: COMPLETED_AT },
    ],
    exportedAt: '2026-01-16T08:00:00.000Z',
  };
}

const zipFileNames = (zip) => Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
const zipString = async (zip, name) => zip.file(name).async('string');
const zipBuffer = async (zip, name) => Buffer.from(await zip.file(name).async('nodebuffer'));

async function exportFixtureBytes() {
  const res = await exportCourseBundle(srcRoot, courseId, baseMeta());
  assert.strictEqual(res.ok, true);
  return res.zip;
}

// 1 — export packs exactly the expected entries with byte-identical content.
test('exportCourseBundle packs lessons, nested assets and meta.json', async () => {
  const res = await exportCourseBundle(srcRoot, courseId, baseMeta());
  assert.strictEqual(res.ok, true);
  // Deviation pinned here: success carries the artifact bytes alongside their size.
  assert.strictEqual(res.zip instanceof Buffer, true);
  assert.strictEqual(res.size, res.zip.length);
  assert.ok(res.size > 0);

  const zip = await JSZip.loadAsync(res.zip);
  assert.deepStrictEqual(
    zipFileNames(zip),
    ['assets/sub/b.png', 'lessons/first.md', 'lessons/second.md', 'meta.json'],
  );
  assert.strictEqual(await zipString(zip, 'lessons/first.md'), FIRST_MD);
  assert.strictEqual(await zipString(zip, 'lessons/second.md'), SECOND_MD);
  assert.ok((await zipBuffer(zip, 'assets/sub/b.png')).equals(PNG_BYTES));
  assert.deepStrictEqual(JSON.parse(await zipString(zip, 'meta.json')), baseMeta());
});

// 2 — import under the bundle's own courseId; files land byte-identical.
test('importCourseBundle restores a course under its original id', async () => {
  const dst = path.join(base, 'dst-default');
  const res = await importCourseBundle(await exportFixtureBytes(), null, dst);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.courseId, courseId);
  assert.strictEqual(res.meta.courseId, courseId);
  assert.deepStrictEqual(
    res.meta.lessons.map((l) => l.id),
    [`${courseId}:first`, `${courseId}:second`],
  );

  const courseDir = path.join(dst, courseId);
  assert.strictEqual(fs.readFileSync(path.join(courseDir, 'lessons', 'first.md'), 'utf8'), FIRST_MD);
  assert.strictEqual(fs.readFileSync(path.join(courseDir, 'lessons', 'second.md'), 'utf8'), SECOND_MD);
  assert.ok(fs.readFileSync(path.join(courseDir, 'assets', 'sub', 'b.png')).equals(PNG_BYTES));
});

// 3 — targetCourseId rename + rekeyLessons id rewrite.
test('importCourseBundle honours targetCourseId and rekeyLessons rewrites ids', async () => {
  const dst = path.join(base, 'dst-renamed');
  const res = await importCourseBundle(await exportFixtureBytes(), 'renamed-course', dst);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.courseId, 'renamed-course');

  const courseDir = path.join(dst, 'renamed-course');
  assert.strictEqual(fs.readFileSync(path.join(courseDir, 'lessons', 'first.md'), 'utf8'), FIRST_MD);
  assert.ok(fs.readFileSync(path.join(courseDir, 'assets', 'sub', 'b.png')).equals(PNG_BYTES));

  const rekeyed = rekeyLessons(res.meta, 'renamed-course');
  assert.deepStrictEqual(rekeyed.map((l) => l.id), ['renamed-course:first', 'renamed-course:second']);
});

// 4 — rekey field-copy / localMdPath drop / colon-free id; slugOfLesson units.
test('rekeyLessons copies fields, drops localMdPath and handles colon-free ids', () => {
  const input = {
    lessons: [
      { id: 'standalone-lesson-no-colon', title: 'T', url: 'https://example.test/a', kind: null, parent: null, orderNo: 0, tocPath: null, completedAt: null },
    ],
  };
  const rows = rekeyLessons(input, 'new-c');
  assert.deepStrictEqual(rows, [
    { id: 'new-c:standalone-lesson-no-colon', title: 'T', url: 'https://example.test/a', kind: null, parent: null, orderNo: 0, tocPath: null, completedAt: null },
  ]);
  assert.strictEqual(Object.hasOwn(rows[0], 'localMdPath'), false);

  // A full canonical row keeps every field while its id is rekeyed.
  const second = rekeyLessons(baseMeta(), 'new-c')[1];
  assert.deepStrictEqual(second, {
    id: 'new-c:second',
    title: 'Second Lesson',
    url: 'https://example.test/second',
    kind: 'video',
    parent: 'modules/getting-started',
    orderNo: 2,
    tocPath: 'getting-started/deep-dive',
    completedAt: COMPLETED_AT,
  });

  assert.strictEqual(slugOfLesson('a:b:c'), 'c');
  assert.strictEqual(slugOfLesson('no-colon-here'), 'no-colon-here');
});

// 5 — zip-slip pin: entries whose raw names escape the course dir reject atomically.
test('importCourseBundle rejects bundles whose entries escape the course dir', async () => {
  const evil = new JSZip();
  evil.file('meta.json', JSON.stringify(baseMeta()));
  evil.file('../evil.txt', 'boom');
  evil.file('lessons/../../leak.md', 'nope');
  const bytes = await evil.generateAsync({ type: 'nodebuffer' });

  const dst = path.join(base, 'dst-evil'); // fresh path — must never be created.
  const res = await importCourseBundle(bytes, null, dst);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /escapes course directory/i);
  assert.strictEqual(fs.existsSync(dst), false);
});

// 6 — missing meta.json is a distinct failure.
test('importCourseBundle rejects bundles without meta.json', async () => {
  const zip = new JSZip();
  zip.file('lessons/orphan.md', 'hi');
  const res = await importCourseBundle(await zip.generateAsync({ type: 'nodebuffer' }), null, path.join(base, 'dst-no-meta'));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /meta\.json/);
});

// 7 — unknown schemaVersion is a distinct failure.
test('importCourseBundle rejects an unsupported schemaVersion', async () => {
  const meta = baseMeta();
  meta.schemaVersion = 2;
  const zip = new JSZip();
  zip.file('meta.json', JSON.stringify(meta));
  zip.file(`lessons/first.md`, FIRST_MD);
  const res = await importCourseBundle(await zip.generateAsync({ type: 'nodebuffer' }), null, path.join(base, 'dst-schema'));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /schemaVersion/i);
});

// 8 — empty lessons is a distinct failure and writes nothing (atomic).
test('importCourseBundle rejects an empty lesson list without writing anything', async () => {
  const meta = baseMeta();
  meta.lessons = [];
  const zip = new JSZip();
  zip.file('meta.json', JSON.stringify(meta));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });

  const dst = path.join(base, 'dst-empty'); // fresh — must stay absent after a failed import.
  const res = await importCourseBundle(bytes, null, dst);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /no lessons/i);
  assert.strictEqual(fs.existsSync(dst), false);
});

// 9 — unknown top-level entries are skipped; known ones still extract.
test('importCourseBundle skips unknown top-level entries', async () => {
  const zip = await JSZip.loadAsync(await exportFixtureBytes());
  zip.file('notes.txt', 'stray file at the bundle root');
  zip.file('other/deep/x.bin', Buffer.from([9]));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });

  const dst = path.join(base, 'dst-stray');
  const res = await importCourseBundle(bytes, null, dst);
  assert.strictEqual(res.ok, true);
  // Only the known top-level trees extract; notes.txt and other/** stay out.
  assert.deepStrictEqual([...fs.readdirSync(path.join(dst, courseId))].sort(), ['assets', 'lessons']);
});

// 10 — non-zip input is a distinct failure.
test('importCourseBundle rejects non-zip input', async () => {
  const res = await importCourseBundle(Buffer.from('definitely not a zip'), null, path.join(base, 'dst-garbage'));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /zip/i);
});
