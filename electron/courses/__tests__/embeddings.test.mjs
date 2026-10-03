// Course embedding indexer — P2 (retrieval): idempotent chunking/FTS/vector indexing of course lessons (node:test, built module).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { COURSES_SCHEMA_SQL } = await import(
  pathToFileURL(path.join(distRoot, 'courseStore.js')).href
);
const { indexCourseForRetrieval } = await import(
  pathToFileURL(path.join(distRoot, 'embeddings.js')).href
);
const { chunkLessonMarkdown } = await import(
  pathToFileURL(path.join(distRoot, 'chunking.js')).href
);

// --- Fixtures (markdown on disk, like production local_md_path files) ------
const mdA = [
  '# Getting started',
  '',
  'This lesson introduces the course and sets expectations for learners.',
  '',
  '## First steps',
  '',
  'Open the workspace, review the overview, and follow along with each demo.',
].join('\n');

const mdb = [
  '# Deployment basics',
  '',
  'Cover how builds are packaged and shipped to macOS and Windows machines.',
].join('\n');

// Same structure as mdA; one word is changed so exactly the chunk containing it differs.
const mdA2 = mdA.replace('sets expectations', 'sets clear expectations');

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'course-embeddings-test-'));
const fileA = path.join(tmpRoot, 'lesson-a.md');
const fileB = path.join(tmpRoot, 'lesson-b.md');
await fs.writeFile(fileA, mdA, 'utf8');
await fs.writeFile(fileB, mdb, 'utf8');

// Expected chunk counts are derived from the real chunker — never hardcoded.
const chunksBeforeA = chunkLessonMarkdown(mdA);
const chunksB = chunkLessonMarkdown(mdb);
const totalChunks = chunksBeforeA.length + chunksB.length;
assert.ok(totalChunks >= 2, 'fixtures should produce at least two chunks');

// --- In-memory DB seeded with the real schema (raw SQL) --------------------
const db = new Database(':memory:');
db.exec(COURSES_SCHEMA_SQL);

// Stand-in for the vec0 virtual table: sqlite-vec cannot be loaded outside Electron,
// so a plain table of the same name makes the module's CREATE VIRTUAL TABLE IF NOT EXISTS a no-op.
db.exec('CREATE TABLE IF NOT EXISTS vec_course_chunks_8(chunk_id INTEGER PRIMARY KEY, embedding BLOB)');

const nowIso = new Date().toISOString();
// Parent course row; best-effort only — the indexer itself never reads courses.
try {
  db.prepare('INSERT INTO courses (id, name, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    'Course One',
    'https://example.test/course',
    nowIso,
    nowIso,
  );
} catch {}
const insLesson = db.prepare(
  'INSERT INTO course_lessons (id, course_id, title, url, order_no, local_md_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
insLesson.run('c1:l1', 'c1', 'Lesson One', 'https://example.test/one', 1, fileA, nowIso);
insLesson.run('c1:l2', 'c1', 'Lesson Two', 'https://example.test/two', 2, fileB, nowIso);

// Fake embedder: deterministic dim-8 vector derived from the input text; counts calls.
let embedCalls = 0;
const fakeEmbedder = {
  async getEmbeddingWithFallback(text) {
    embedCalls++;
    return {
      embedding: Array.from({ length: 8 }, (_, i) => ((text.length + i * 3) % 17) / 4 - 1),
      space: 'fake-space',
    };
  },
};

const countRows = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
const vecTableExists = () =>
  Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('vec_course_chunks_8'),
  );

test('A: first run indexes every chunk into course_chunks, FTS and vec_course_chunks_8', async () => {
  const res = await indexCourseForRetrieval({ db, courseId: 'c1', embedder: fakeEmbedder });
  assert.equal(res.error, undefined);
  assert.equal(res.indexed, totalChunks);
  assert.equal(res.skipped, 0);
  assert.equal(embedCalls, totalChunks);
  assert.equal(countRows('course_chunks'), totalChunks);
  assert.equal(countRows('course_chunks_fts'), totalChunks);
  assert.ok(vecTableExists(), 'vec_course_chunks_8 table should exist');
  assert.equal(countRows('vec_course_chunks_8'), totalChunks);
});

test('B: no content change → all chunks skipped, embedder not called', async () => {
  const before = embedCalls;
  const res = await indexCourseForRetrieval({ db, courseId: 'c1', embedder: fakeEmbedder });
  assert.equal(res.error, undefined);
  assert.equal(res.indexed, 0);
  assert.equal(res.skipped, totalChunks);
  assert.equal(embedCalls, before, 'unchanged chunks must not be re-embedded');
});

test('C: modified lesson re-indexes only the changed chunk(s)', async () => {
  try {
    const chunksAfterA = chunkLessonMarkdown(mdA2);
    assert.equal(chunksAfterA.length, chunksBeforeA.length, 'fixture edit must preserve chunk structure');
    let changed = 0;
    for (let i = 0; i < chunksAfterA.length; i++) {
      if ((chunksBeforeA[i]?.text ?? null) !== (chunksAfterA[i]?.text ?? null)) changed++;
    }
    assert.ok(changed >= 1, 'fixture edit should change at least one chunk');

    await fs.writeFile(fileA, mdA2, 'utf8');

    const before = embedCalls;
    const res = await indexCourseForRetrieval({ db, courseId: 'c1', embedder: fakeEmbedder });
    assert.equal(res.error, undefined);
    assert.equal(res.indexed, changed, 'only the modified chunk should be re-indexed');
    assert.equal(res.skipped, totalChunks - changed);
    assert.equal(embedCalls, before + changed, 'only modified chunks are re-embedded');
    // Rows are updated in place (same ids): full coverage is preserved.
    assert.equal(countRows('course_chunks'), totalChunks);
    assert.equal(countRows('course_chunks_fts'), totalChunks);
    assert.equal(countRows('vec_course_chunks_8'), totalChunks);
  } finally {
    db.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
