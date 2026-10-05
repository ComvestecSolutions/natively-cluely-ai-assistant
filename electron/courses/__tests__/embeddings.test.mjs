// Course embedding indexer — P2 (retrieval): idempotent chunking/FTS/vector indexing of course lessons (node:test, built module).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

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
const { searchCourses } = await import(
  pathToFileURL(path.join(distRoot, 'retrieval.js')).href
);
const { createCourseVectorSearch } = await import(
  pathToFileURL(path.join(distRoot, 'chatGrounding.js')).href
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

// Exercise the real course IPC handlers with fake storage, crawl and embedding provider.
const ipcSource = await fs.readFile(path.resolve(__dirname, '../../ipcHandlers.ts'), 'utf8');
const helperStart = ipcSource.indexOf('  const indexCourseOfflineFirst =');
const ipcStart = helperStart >= 0 ? helperStart : ipcSource.indexOf("  safeHandle('courses:import'");
const ipcEnd = ipcSource.indexOf('  // DIAGRAM GENERATION', ipcStart);
assert.ok(ipcStart >= 0 && ipcEnd > ipcStart, 'course IPC handlers should be present');
const courseIpcJs = ts.transpileModule(ipcSource.slice(ipcStart, ipcEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function courseIpcFixture({ ready, rejectEmbedding }) {
  const handlers = new Map();
  const events = [];
  const db = { chunks: ['first lesson', 'second lesson'], lexical: new Set(), vectors: new Set() };
  let embedCalls = 0;
  let finish;
  const terminal = new Promise((resolve) => { finish = resolve; });
  const pipeline = {
    isReady: () => ready,
    async getEmbeddingWithFallback(text) {
      embedCalls++;
      if (rejectEmbedding) throw new Error('provider offline');
      return { embedding: [text.length] };
    },
  };
  vm.runInNewContext(courseIpcJs, {
    safeHandle: (name, handler) => handlers.set(name, handler),
    isProOrTrialActive: () => true,
    getCourseStore: () => ({ upsertCourse: ({ id }) => ({ id }), getCourse: () => ({}) }),
    createFetchHttpClient: () => ({}),
    planGeneric: async () => ({ items: [{}] }),
    planMicrosoftLearn: async () => ({ items: [{}] }),
    resolveCoursesStudioSettings: () => ({}),
    runCourseImport: async () => {},
    DatabaseManager: { getInstance: () => ({ getDb: () => db }) },
    appState: {
      getMainWindow: () => ({ webContents: { send: (_, event) => {
        events.push(event);
        if (event.stage === 'done' || event.stage === 'failed') finish(event);
      } } }),
      getRAGManager: () => ({ getEmbeddingPipeline: () => pipeline }),
    },
    app: { getPath: () => tmpRoot },
    path,
    URL,
    console: { warn() {}, error() {} },
    indexCourseForRetrieval: async ({ db: store, embedder }) => {
      let indexed = 0;
      for (const text of store.chunks) {
        if (!embedder) {
          store.lexical.add(text);
        } else {
          assert.equal(store.lexical.size, store.chunks.length, 'FTS must be complete before vectorizing');
          await embedder.getEmbeddingWithFallback(text);
          store.vectors.add(text);
        }
        indexed++;
      }
      return { indexed, skipped: 0 };
    },
  });
  return { handlers, events, db, terminal, get embedCalls() { return embedCalls; } };
}

test('course import indexes all lessons offline before reporting vector failure', { timeout: 2000 }, async () => {
  const fixture = courseIpcFixture({ ready: true, rejectEmbedding: true });
  const result = await fixture.handlers.get('courses:import')(null, { sourceUrl: 'https://example.test/course' });
  assert.ok(result.course?.id, 'import must return the course before post-processing');
  const lastEvent = await fixture.terminal;
  assert.equal(fixture.db.lexical.size, 2);
  assert.equal(fixture.db.vectors.size, 0);
  assert.equal(fixture.embedCalls, 1);
  assert.equal(lastEvent.stage, 'failed');
  assert.match(lastEvent.detail, /vector.*provider offline/i);
  assert.equal(fixture.events.filter((event) => ['done', 'failed'].includes(event.stage)).length, 1);
});

test('course IPC skips an unready provider and can enrich vectors once ready', { timeout: 2000 }, async () => {
  const offline = courseIpcFixture({ ready: false, rejectEmbedding: true });
  const imported = await offline.handlers.get('courses:import')(null, { sourceUrl: 'https://example.test/course' });
  assert.equal((await offline.terminal).stage, 'done');
  assert.equal(offline.db.lexical.size, 2);
  assert.equal(offline.embedCalls, 0);
  assert.equal(offline.events.at(-1).detail, imported.course.id);

  const offlineReindex = courseIpcFixture({ ready: false, rejectEmbedding: true });
  const lexical = await offlineReindex.handlers.get('courses:reindex')(null, { id: 'course-1' });
  assert.equal(lexical.error, undefined);
  assert.equal(lexical.indexed, 2);
  assert.equal(offlineReindex.db.lexical.size, 2);
  assert.equal(offlineReindex.embedCalls, 0);

  const reindex = courseIpcFixture({ ready: true, rejectEmbedding: false });
  const result = await reindex.handlers.get('courses:reindex')(null, { id: 'course-1' });
  assert.equal(result.error, undefined);
  assert.equal(reindex.db.lexical.size, 2);
  assert.equal(reindex.db.vectors.size, 2);
  assert.equal(reindex.embedCalls, 2);

  const failure = courseIpcFixture({ ready: true, rejectEmbedding: true });
  const failed = await failure.handlers.get('courses:reindex')(null, { id: 'course-1' });
  assert.equal(failure.db.lexical.size, 2);
  assert.match(failed.error, /vector.*provider offline/i);
});

// Keep the real vec0 cases independent of the plain-table fixture and its cleanup.
async function realVecFixture() {
  const realDb = new Database(':memory:');
  let realTmpRoot;
  try {
    const extPath = sqliteVec.getLoadablePath()
      .replace('app.asar', 'app.asar.unpacked')
      .replace(/\.(dylib|so|dll)$/, '');
    realDb.loadExtension(extPath);
    assert.ok(realDb.prepare('SELECT vec_version() AS version').get().version);
    realDb.exec(COURSES_SCHEMA_SQL);

    realTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'course-real-vec-test-'));
    const lessonA = path.join(realTmpRoot, 'lesson-a.md');
    const lessonB = path.join(realTmpRoot, 'lesson-b.md');
    await Promise.all([fs.writeFile(lessonA, mdA, 'utf8'), fs.writeFile(lessonB, mdb, 'utf8')]);
    const date = new Date().toISOString();
    realDb.prepare('INSERT INTO courses (id, name, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('real-vec-course', 'Real Vec Course', 'https://example.test/real-vec', date, date);
    const insertLesson = realDb.prepare(
      'INSERT INTO course_lessons (id, course_id, title, url, order_no, local_md_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertLesson.run('real-vec:l1', 'real-vec-course', 'Getting started', 'https://example.test/real-vec/one', 1, lessonA, date);
    insertLesson.run('real-vec:l2', 'real-vec-course', 'Deployment basics', 'https://example.test/real-vec/two', 2, lessonB, date);

    let embedCalls = 0;
    const embedder = {
      async getEmbeddingWithFallback(text) {
        embedCalls++;
        return { embedding: text.includes('packaged') ? [0, 1, 0, 0, 0, 0, 0, 0] : [1, 0, 0, 0, 0, 0, 0, 0] };
      },
    };
    return {
      db: realDb,
      tmpRoot: realTmpRoot,
      embedder,
      get embedCalls() { return embedCalls; },
      async close() {
        realDb.close();
        await fs.rm(realTmpRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    realDb.close();
    if (realTmpRoot) await fs.rm(realTmpRoot, { recursive: true, force: true });
    throw error;
  }
}

test('offline course indexing searches all lessons, repairs FTS and fills vectors later', async () => {
  const fixture = await realVecFixture();
  try {
    const { db, embedder } = fixture;
    const courseId = 'real-vec-course';
    // Model an imported course with one pre-existing chunk/FTS row and no vectors.
    const first = chunksBeforeA[0];
    const hash = createHash('sha1').update(first.text, 'utf8').digest('hex');
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO course_chunks (course_id, lesson_id, ord, heading_path, text, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(courseId, 'real-vec:l1', 0, first.headingPath ?? null, first.text, hash);
    db.prepare(
      'INSERT INTO course_chunks_fts (rowid, course_id, lesson_id, heading_path, text) VALUES (?, ?, ?, ?, ?)',
    ).run(lastInsertRowid, courseId, 'real-vec:l1', first.headingPath ?? null, first.text);

    assert.deepEqual(await indexCourseForRetrieval({ db, courseId }),
      { indexed: totalChunks - 1, skipped: 1 });
    assert.equal(fixture.embedCalls, 0);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM course_chunks').get().n), totalChunks);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM course_chunks_fts').get().n), totalChunks);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_course_chunks_8'").get(), undefined);
    for (const [query, lessonTitle] of [['expectations', 'Getting started'], ['packaged', 'Deployment basics']]) {
      const hits = await searchCourses({ db, query, courseIds: [courseId] });
      assert.ok(hits.some((hit) => hit.lessonTitle === lessonTitle), `${query} should find ${lessonTitle}`);
      assert.ok(db.prepare('SELECT rowid FROM course_chunks_fts WHERE course_chunks_fts MATCH ?').get(query));
    }
    assert.deepEqual(await indexCourseForRetrieval({ db, courseId }),
      { indexed: 0, skipped: totalChunks });

    const { id } = db.prepare("SELECT id FROM course_chunks WHERE lesson_id = 'real-vec:l2' ORDER BY ord LIMIT 1").get();
    db.prepare('DELETE FROM course_chunks_fts WHERE rowid = ?').run(BigInt(id));
    assert.deepEqual(await indexCourseForRetrieval({ db, courseId }),
      { indexed: 1, skipped: totalChunks - 1 });
    assert.ok(db.prepare('SELECT rowid FROM course_chunks_fts WHERE rowid = ?').get(BigInt(id)));

    assert.deepEqual(await indexCourseForRetrieval({ db, courseId, embedder }),
      { indexed: totalChunks, skipped: 0 });
    assert.equal(fixture.embedCalls, totalChunks);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks);
    assert.deepEqual(await indexCourseForRetrieval({ db, courseId, embedder }),
      { indexed: 0, skipped: totalChunks });

    await fs.writeFile(path.join(fixture.tmpRoot, 'lesson-b.md'), mdb.replace('packaged', 'assembled'));
    assert.deepEqual(await indexCourseForRetrieval({ db, courseId }),
      { indexed: 1, skipped: totalChunks - 1 });
    assert.equal(db.prepare('SELECT chunk_id FROM vec_course_chunks_8 WHERE chunk_id = ?').get(BigInt(id)), undefined);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks - 1);
    assert.ok(db.prepare("SELECT rowid FROM course_chunks_fts WHERE course_chunks_fts MATCH 'assembled'").get());
    assert.equal(db.prepare("SELECT rowid FROM course_chunks_fts WHERE course_chunks_fts MATCH 'packaged'").get(), undefined);
    assert.deepEqual(await indexCourseForRetrieval({ db, courseId, embedder }),
      { indexed: 1, skipped: totalChunks - 1 });
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks);
  } finally {
    await fixture.close();
  }
});

test('real vec0: indexes two lessons and retrieves the relevant lesson', async () => {
  const fixture = await realVecFixture();
  try {
    const { db, embedder } = fixture;
    const result = await indexCourseForRetrieval({ db, courseId: 'real-vec-course', embedder });
    assert.equal(result.error, undefined);
    assert.equal(result.indexed, totalChunks);
    assert.equal(result.skipped, 0);
    assert.equal(fixture.embedCalls, totalChunks);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM course_chunks').get().n), totalChunks);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM course_chunks_fts').get().n), totalChunks);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_course_chunks_8'").get().sql, /USING vec0\(/i);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks);

    const hits = await searchCourses({
      db,
      query: 'packaged',
      courseIds: ['real-vec-course'],
      vectorSearch: createCourseVectorSearch(db),
      queryEmbedding: [0, 1, 0, 0, 0, 0, 0, 0],
      limit: 1,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].lessonTitle, 'Deployment basics');
    assert.match(hits[0].text, /packaged/);
  } finally {
    await fixture.close();
  }
});

test('real vec0: reindex repairs a legacy FTS chunk missing its vector, then stays idempotent', async () => {
  const fixture = await realVecFixture();
  try {
    const { db, embedder } = fixture;
    const initial = await indexCourseForRetrieval({ db, courseId: 'real-vec-course', embedder });
    assert.equal(initial.error, undefined);
    assert.equal(initial.indexed, totalChunks);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks);

    const unchanged = await indexCourseForRetrieval({ db, courseId: 'real-vec-course', embedder });
    assert.deepEqual(unchanged, { indexed: 0, skipped: totalChunks });
    assert.equal(fixture.embedCalls, totalChunks);

    const { id } = db.prepare("SELECT id FROM course_chunks WHERE lesson_id = 'real-vec:l2' ORDER BY ord LIMIT 1").get();
    assert.ok(db.prepare('SELECT rowid FROM course_chunks_fts WHERE rowid = ?').get(BigInt(id)));
    db.prepare('DELETE FROM vec_course_chunks_8 WHERE chunk_id = ?').run(BigInt(id));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks - 1);

    const repaired = await indexCourseForRetrieval({ db, courseId: 'real-vec-course', embedder });
    assert.deepEqual(repaired, { indexed: 1, skipped: totalChunks - 1 });
    assert.equal(fixture.embedCalls, totalChunks + 1);
    assert.ok(db.prepare('SELECT chunk_id FROM vec_course_chunks_8 WHERE chunk_id = ?').get(BigInt(id)));
    assert.ok(db.prepare('SELECT rowid FROM course_chunks_fts WHERE rowid = ?').get(BigInt(id)));
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM vec_course_chunks_8').get().n), totalChunks);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM course_chunks_fts').get().n), totalChunks);
    assert.deepEqual(await indexCourseForRetrieval({ db, courseId: 'real-vec-course', embedder }),
      { indexed: 0, skipped: totalChunks });
    assert.equal(fixture.embedCalls, totalChunks + 1);
  } finally {
    await fixture.close();
  }
});
