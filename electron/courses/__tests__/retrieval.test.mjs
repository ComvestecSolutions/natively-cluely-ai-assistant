/**
 * Courses Studio — P2 retrieval tests (node:test; real :memory: better-sqlite3 rows, no mocks).
 * Run after `npm run build:electron`:  node --test electron/courses/__tests__/retrieval.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const [retrievalMod, storeMod] = await Promise.all([
  import(pathToFileURL(path.join(distRoot, 'retrieval.js')).href),
  import(pathToFileURL(path.join(distRoot, 'courseStore.js')).href),
]);
const { searchCourses, sanitizeFtsQuery, makeChunkKey } = retrievalMod;
const { COURSES_SCHEMA_SQL, CourseStore } = storeMod;

const URL_LA = 'https://docs.example.com/ann/algorithms';
const URL_LB = 'https://docs.example.com/wal/mode';

let db;

// Seed 2 courses / 2 lessons, one chunk each, via raw inserts; chunks mirror into
// course_chunks_fts with rowid = course_chunks.id (retrieval's join convention).
function seed() {
  const now = '2026-01-01T00:00:00.000Z';
  db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL);
  const course = db.prepare(
    `INSERT INTO courses (id, name, source_url, status, enabled, stats_json, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', 1, '{}', ?, ?)`
  );
  const lesson = db.prepare(
    `INSERT INTO course_lessons (id, course_id, title, url, updated_at) VALUES (?, ?, ?, ?, ?)`
  );
  course.run('course-a', 'ANN Course', 'https://example.com/ann-course', now, now);
  course.run('course-b', 'WAL Course', 'https://example.com/wal-course', now, now);
  lesson.run('la', 'course-a', 'ANN Algorithms', URL_LA, now);
  lesson.run('lb', 'course-b', 'WAL Mode', URL_LB, now);

  const chunk = db.prepare(
    `INSERT INTO course_chunks (course_id, lesson_id, ord, heading_path, kind, text)
     VALUES (?, ?, ?, ?, 'chunk', ?)`
  );
  const fts = db.prepare(
    `INSERT INTO course_chunks_fts(rowid, course_id, lesson_id, heading_path, text)
     VALUES (?, ?, ?, ?, ?)`
  );
  const addChunk = (courseId, lessonId, ord, headingPath, text, indexed = true) => {
    const info = chunk.run(courseId, lessonId, ord, headingPath, text);
    if (indexed) fts.run(info.lastInsertRowid, courseId, lessonId, headingPath, text);
  };

  addChunk('course-a', 'la', 0, 'HNSW',
    'HNSW builds a hierarchical navigable small world graph for approximate nearest neighbor search.');
  addChunk('course-a', 'la', 1, 'Quantization',
    'Product quantization splits vectors into sub-vectors and precomputes codes for approximate nearest neighbor search using inverted file lists.');
  addChunk('course-b', 'lb', 0, 'Concurrency',
    'In WAL mode readers never block writers because the write-ahead log buffers changes until a checkpoint.');
  addChunk('course-b', 'lb', 1, 'Checkpoints',
    'A passive checkpoint truncates the write-ahead log once it reaches its configured size limit.', false);
}

describe('retrieval.ts (P2)', () => {
  beforeEach(seed);
  afterEach(() => db.close());

  describe('sanitizeFtsQuery', () => {
    it('strips FTS metacharacters and quotes the surviving terms', () => {
      assert.equal(
        sanitizeFtsQuery('product quantization* :codes ("sub-vectors"'),
        '"product" "quantization" "codes" "sub-vectors"',
      );
      assert.equal(sanitizeFtsQuery('*** ||| '), '');
    });
  });

  describe('FTS path', () => {
    it('ranks the exact-match chunk first with full join metadata (a)', async () => {
      const res = await searchCourses({ db, query: 'approximate nearest neighbor search' });
      assert.equal(res.length, 2);
      assert.match(res[0].text, /HNSW/); // shorter doc holding every term wins bm25
      assert.ok(res[1].text.includes('quantization'));
      assert.ok(res[0].score > res[1].score);
      assert.equal(res[0].score, 1); // FTS-only scores are min-max normalized into (0,1]
      assert.ok(res[1].score > 0 && res[1].score < 1);
      assert.equal(res[0].courseId, 'course-a');
      assert.equal(res[0].lessonTitle, 'ANN Algorithms');
      assert.equal(res[0].url, URL_LA);
      assert.equal(res[0].headingPath, 'HNSW');
      assert.equal(res[0].chunkId, makeChunkKey(URL_LA, 0));
    });

    it('honors the courseIds filter (b)', async () => {
      const scopedOut = await searchCourses({
        db, query: 'approximate nearest neighbor search', courseIds: ['course-b'],
      });
      assert.deepEqual(scopedOut.map((r) => r.courseId), []); // matches live in course-a only

      const kept = await searchCourses({ db, query: 'checkpoint write-ahead', courseIds: ['course-b'] });
      assert.equal(kept.length, 1);
      assert.equal(kept[0].courseId, 'course-b');
      assert.equal(kept[0].chunkId, makeChunkKey(URL_LB, 0));
    });
  });

  describe('vector fusion', () => {
    it('lifts an out-of-FTS-sight chunk into the results (c)', async () => {
      const calls = [];
      const fakeAdapter = {
        search: async (ids, emb, k) => {
          calls.push({ ids, embLen: emb.length, k });
          return [
            { chunkKey: makeChunkKey(URL_LB, 1), score: 0.9 }, // no FTS row for this chunk
            { chunkKey: makeChunkKey(URL_LA, 1), score: 0.75 },
          ];
        },
      };
      const res = await searchCourses({
        db, query: 'write-ahead', vectorSearch: fakeAdapter, queryEmbedding: [0.1, -0.2, 0.3],
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].ids, []); // no course filter -> empty id list passthrough
      assert.equal(calls[0].embLen, 3);
      assert.equal(calls[0].k, Math.min(64, Math.max(8 * 3, 16)));

      // FTS sees only lb#0; fusion must still surface the unindexed lb#1 (ranked #2)
      // and the vector-only la#1, with RRF scores: 1/61, 1/61 (tie -> chunkId order), 1/62.
      assert.equal(res.length, 3);
      assert.deepEqual(
        res.map((r) => r.chunkId),
        [makeChunkKey(URL_LB, 0), makeChunkKey(URL_LB, 1), makeChunkKey(URL_LA, 1)],
      );
      assert.ok(Math.abs(res[0].score - 1 / 61) < 1e-12);
      assert.equal(res[0].score, res[1].score); // deterministic tie resolved by chunkId order
      assert.ok(res[1].score > res[2].score);
      assert.match(res[1].text, /passive checkpoint/);
    });

    it('returns FTS results when the vector adapter rejects', async () => {
      const failing = { search: async () => { throw new Error('embedding service down'); } };
      const res = await searchCourses({ db, query: 'write-ahead', vectorSearch: failing, queryEmbedding: [0.1] });
      assert.equal(res.length, 1);
      assert.equal(res[0].chunkId, makeChunkKey(URL_LB, 0));

      // Adapter without a caller embedding is ignored entirely (module never embeds).
      const noEmb = await searchCourses({ db, query: 'write-ahead', vectorSearch: failing });
      assert.deepEqual(noEmb.map((r) => r.chunkId), [makeChunkKey(URL_LB, 0)]);
    });
  });

  describe('malformed queries', () => {
    it('survives FTS metacharacter soup and returns sane hits (d)', async () => {
      const raw = 'product quantization* :codes ("sub-vectors"';
      // Without sanitizing, this exact query is a genuine FTS5 syntax error.
      assert.throws(() =>
        db.prepare('SELECT * FROM course_chunks_fts WHERE course_chunks_fts MATCH ?').get(raw),
      );

      let res = null;
      let threw = null;
      try {
        res = await searchCourses({ db, query: raw });
      } catch (err) {
        threw = err;
      }
      assert.equal(threw, null); // never throws on partial failure
      assert.equal(res.length, 1);
      assert.match(res[0].text, /Product quantization/); // the only chunk where all terms co-occur
      assert.equal(res[0].chunkId, makeChunkKey(URL_LA, 1));
    });
  });
});

// Exercise the actual handler bodies with real CourseStore, FTS and persisted
// markdown/cache, without registering the unrelated Electron IPC handlers.
it('course IPC search and study aids validate full scope and hydrate only persisted results', async () => {
  seed();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'course-ipc-'));
  try {
    const store = new CourseStore(db);
    const courseDir = path.join(userData, 'courses', 'course-a');
    fs.mkdirSync(path.join(courseDir, 'lessons'), { recursive: true });
    const ids = ['la', 'la2', 'la3', 'la4', 'la5'];
    const names = ['First Title', 'Nebulous Title', 'Third Title', 'Fourth Title', 'Fifth Title'];
    const addLesson = db.prepare(`INSERT INTO course_lessons
      (id, course_id, title, url, parent, local_md_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    db.prepare('UPDATE course_lessons SET title = ?, local_md_path = ? WHERE id = ?')
      .run(names[0], 'lessons/la.md', 'la');
    for (let i = 1; i < ids.length; i++) {
      addLesson.run(ids[i], 'course-a', names[i], `https://example.com/${ids[i]}`,
        i === 4 ? 'la' : null, `lessons/${ids[i]}.md`, '2026-01-01');
    }
    for (let i = 0; i < ids.length; i++) {
      fs.writeFileSync(path.join(courseDir, 'lessons', `${ids[i]}.md`), `# ${names[i]}\n\nLesson ${i + 1} material`);
    }
    const addChunk = db.prepare(`INSERT INTO course_chunks (course_id, lesson_id, ord, text)
      VALUES ('course-a', 'la5', ?, ?)`);
    const addFts = db.prepare(`INSERT INTO course_chunks_fts (rowid, course_id, lesson_id, text)
      VALUES (?, 'course-a', 'la5', ?)`);
    for (let i = 0; i < 2; i++) {
      const text = `nebulous body content ${i}`;
      const row = addChunk.run(i, text);
      addFts.run(row.lastInsertRowid, text);
    }

    const source = fs.readFileSync(path.resolve(__dirname, '../../ipcHandlers.ts'), 'utf8');
    const readStart = source.indexOf('  const readCourseLessonMd =');
    const readEnd = source.indexOf("  safeHandle('courses:lesson-content'", readStart);
    const handlersStart = source.indexOf('  const resolveStudyAidSources =');
    const handlersEnd = source.indexOf('  // Courses Studio P4 portability:', handlersStart);
    assert.ok(readStart > 0 && readEnd > readStart && handlersStart > 0 && handlersEnd > handlersStart);
    const code = ts.transpileModule(source.slice(readStart, readEnd) + source.slice(handlersStart, handlersEnd), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const handlers = new Map();
    let active = true;
    const prompts = [];
    vm.runInNewContext(code, {
      safeHandle: (key, fn) => handlers.set(key, fn),
      getCourseStore: () => store,
      isProOrTrialActive: () => active,
      DatabaseManager: { getInstance: () => ({ getDb: () => db }) },
      app: { getPath: () => userData },
      path, fs, searchCourses,
      resolveCourseDataDir: (root, id) => path.join(root, id),
      stripCourseFrontmatter: (md) => md,
      lookupStudyAid: (await import(pathToFileURL(path.join(distRoot, 'studyAids.js')).href)).lookupStudyAid,
      generateStudyAid: (await import(pathToFileURL(path.join(distRoot, 'studyAids.js')).href)).generateStudyAid,
      appState: { processingHelper: { getLLMHelper: () => ({
        fitContextForCurrentModel: (prompt) => prompt,
        streamChatLongForm: (prompt) => {
          prompts.push(prompt);
          return { stream: (async function* () { yield '## Key points\n- First Title, Nebulous Title, Third Title, Fourth Title and Fifth Title each provide lesson material for this module.'; })(), outcome: { truncated: false } };
        },
      }) } },
      console: { warn() {} },
    });
    const invoke = (channel, payload) => handlers.get(channel)(null, payload);
    const title = await invoke('courses:search', { courseId: 'course-a', query: 'Fifth Title' });
    assert.equal(title.ok, true);
    assert.equal(title.results[0].lessonId, 'la5');
    assert.equal(title.results[0].parent, 'la');
    const body = await invoke('courses:search', { courseId: 'course-a', query: 'nebulous' });
    assert.deepEqual(Array.from(body.results, (r) => r.lessonId), ['la2', 'la5'],
      'title matches precede body hits and multiple chunks map to one lesson');
    assert.match(body.results[1].snippet, /nebulous/);
    const scoped = await invoke('courses:search', { courseId: 'course-b', query: 'nebulous' });
    assert.equal(scoped.results.length, 0);
    assert.equal((await invoke('courses:search', { courseId: 'missing', query: 'nebulous' })).ok, false);
    assert.equal((await invoke('courses:search', { courseId: 'course-a', query: '   ' })).ok, false);

    for (let i = 0; i < 24; i++) {
      addLesson.run(`title-${i}`, 'course-a', `Nebulous headline ${i}`,
        `https://example.com/title-${i}`, null, 'lessons/la.md', '2026-01-01');
    }
    const crowded = await invoke('courses:search', { courseId: 'course-a', query: 'nebulous' });
    assert.equal(crowded.results.length, 20);
    assert.equal(crowded.results[0].lessonId, 'la2', 'title matches still lead');
    assert.ok(crowded.results.some((result) => result.lessonId === 'la5' && /nebulous/.test(result.snippet)),
      'full-text-only lessons remain visible even when titles exceed the result cap');

    const scope = { courseId: 'course-a', type: 'summary', lessonIds: ids };
    const miss = await invoke('courses:lookup-study-aid', scope);
    assert.equal(miss.ok, true);
    assert.equal(miss.cached, false);
    assert.equal(prompts.length, 0, 'lookup cannot generate');
    const generated = await invoke('courses:generate-study-aid', scope);
    assert.equal(generated.ok, true, JSON.stringify(generated));
    assert.ok(prompts.some((prompt) => prompt.includes('Fifth Title') && prompt.includes('Lesson 5 material')));
    const beforeLookup = prompts.length;
    const cached = await invoke('courses:lookup-study-aid', scope);
    assert.equal(cached.cached, true);
    assert.equal(cached.data, generated.data);
    assert.equal(prompts.length, beforeLookup);

    fs.rmSync(path.join(courseDir, 'lessons', 'la5.md'));
    const unavailable = await invoke('courses:generate-study-aid', scope);
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error, /lesson markdown unavailable/);
    assert.equal(prompts.length, beforeLookup);
    assert.equal((await invoke('courses:lookup-study-aid', scope)).ok, false);
    assert.equal((await invoke('courses:generate-study-aid', { ...scope, lessonIds: ['la', 'unknown'] })).ok, false);
    assert.equal((await invoke('courses:generate-study-aid', { ...scope, lessonIds: ['la', 'la'] })).ok, false);
    active = false;
    assert.equal((await invoke('courses:search', { courseId: 'course-a', query: 'nebulous' })).disabled, true);
    assert.equal((await invoke('courses:lookup-study-aid', scope)).disabled, true);
  } finally {
    db.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
