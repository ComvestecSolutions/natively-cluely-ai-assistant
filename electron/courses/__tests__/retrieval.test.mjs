/**
 * Courses Studio — P2 retrieval tests (node:test; real :memory: better-sqlite3 rows, no mocks).
 * Run after `npm run build:electron`:  node --test electron/courses/__tests__/retrieval.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const [retrievalMod, storeMod] = await Promise.all([
  import(pathToFileURL(path.join(distRoot, 'retrieval.js')).href),
  import(pathToFileURL(path.join(distRoot, 'courseStore.js')).href),
]);
const { searchCourses, sanitizeFtsQuery, makeChunkKey } = retrievalMod;
const { COURSES_SCHEMA_SQL } = storeMod;

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
