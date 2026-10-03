// Premium contract testable slices — feature OFF must leave zero trace in chat grounding:
// N2 (off or zero enabled courses → early return BEFORE retrieval/embedding),
// N4 (disabled course with real on-disk chunks contributes nothing to the assembled prompt,
//     proven against an enabled positive control that would fail if gating leaked), and
// N3 (re-enabling restores course/lessons/chunks from existing rows without any re-import).
// Handler-level {disabled:true} responses in ipcHandlers.ts are code-review-only; boot
// cleanliness while off is a physical-verification note. node:test, built modules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const loadModule = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const { COURSES_SCHEMA_SQL, CourseStore } = await loadModule('courseStore.js');
const { chunkLessonMarkdown } = await loadModule('chunking.js');
const { buildCourseGroundedBlock } = await loadModule('chatGrounding.js');

// Pinned byte-for-byte: must equal GROUNDING_HEADER in chatGrounding.ts.
const HEADER =
  'RELATED COURSE MATERIAL — ground truth for this conversation (prefer these over model memory; cite the Source URLs when answering)';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-contract-test-'));
let fileSeq = 0;
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Unique real .md per run/lesson (production lessons live at local_md_path files).
function writeLessonMd(text) {
  const p = path.join(tmpRoot, `premium-${process.pid}-${Date.now()}-${fileSeq++}.md`);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

const sha1hex = (text) => createHash('sha1').update(text, 'utf8').digest('hex');

function freshStore() {
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL); // also creates course_chunks + course_chunks_fts; no vec table by construction
  return { db, store: new CourseStore(db) };
}

// Same seeder as chatGrounding.test.mjs: upsert (enabled), lessons whose url points at real temp
// .md files, then rowid-aligned FTS rows mirroring embeddings.ts's non-vector SQL. Returns urls.
function seedCourse(db, courseId, title, lessons) {
  const store = new CourseStore(db);
  store.upsertCourse({
    id: courseId,
    name: title ?? `Course ${courseId}`,
    sourceUrl: `https://courses.test/run-${process.pid}/${courseId}`,
    status: 'complete',
  });
  store.setCourseEnabled(courseId, true);
  const lessonInputs = lessons.map((lesson, i) => ({
    id: `${courseId}-l${i}`,
    title: lesson.title ?? `Lesson ${i + 1}`,
    url: writeLessonMd(lesson.text),
    orderNo: i,
  }));
  store.addLessons(courseId, lessonInputs);

  const insChunk = db.prepare(
    'INSERT INTO course_chunks (course_id, lesson_id, ord, heading_path, text, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const delFts = db.prepare('DELETE FROM course_chunks_fts WHERE rowid = ?');
  const insFts = db.prepare(
    'INSERT INTO course_chunks_fts (rowid, course_id, lesson_id, heading_path, text) VALUES (?, ?, ?, ?, ?)',
  );
  for (let li = 0; li < lessons.length; li++) {
    const chunks = chunkLessonMarkdown(lessons[li].text);
    for (const ch of chunks) {
      const rowId = Number(
        insChunk.run(courseId, lessonInputs[li].id, ch.index, ch.headingPath ?? null, ch.text, sha1hex(ch.text))
          .lastInsertRowid,
      );
      delFts.run(rowId); // idempotent re-seed safety, same form as the indexer
      insFts.run(rowId, courseId, lessonInputs[li].id, ch.headingPath ?? null, ch.text);
    }
  }
  return lessonInputs.map((l) => l.url);
}

// Chunk one lesson's markdown into course_chunks + course_chunks_fts in indexer form.
function indexLessonChunks(db, courseId, lessonId, text) {
  const insChunk = db.prepare(
    'INSERT INTO course_chunks (course_id, lesson_id, ord, heading_path, text, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const delFts = db.prepare('DELETE FROM course_chunks_fts WHERE rowid = ?');
  const insFts = db.prepare(
    'INSERT INTO course_chunks_fts (rowid, course_id, lesson_id, heading_path, text) VALUES (?, ?, ?, ?, ?)',
  );
  for (const ch of chunkLessonMarkdown(text)) {
    const rowId = Number(insChunk.run(courseId, lessonId, ch.index, ch.headingPath ?? null, ch.text, sha1hex(ch.text)).lastInsertRowid);
    delFts.run(rowId);
    insFts.run(rowId, courseId, lessonId, ch.headingPath ?? null, ch.text);
  }
}

// Counts SQL statements prepared through the CourseSqlDb handle passed to the builder, so
// "zero retrieval work before the early return" is observable (store-side listCourses() calls
// use their own connection and are not counted — N2's zero-work claim is about retrieval/embedding).
function countingHandle(db) {
  const counts = { prepareCalls: 0 };
  return {
    counts,
    dbLike: {
      prepare(sql) {
        counts.prepareCalls += 1;
        return db.prepare(sql);
      },
    },
  };
}

// Counts getEmbeddingForQuery invocations so "zero embedding work" is observable.
function spyPipeline() {
  const calls = [];
  return {
    calls,
    pipeline: {
      async getEmbeddingForQuery(text) {
        calls.push(String(text));
        return new Array(8).fill(0.1);
      },
    },
  };
}

// A single unique FTS token plus a multi-word sentinel that must never leak into prompts while off.
const LEAK_TOKEN = 'zqleak97x';
const SENTINEL = 'ZZ_SENTINEL_N4_DO_NOT_LEAK';
const N4_MD = `# Leak guard\n\n${LEAK_TOKEN} ${SENTINEL} payload that must stay out of prompts while the course is disabled.\n`;

test('N2 premium-off, empty store: null block with zero embedding + zero retrieval work', async () => {
  const { db, store } = freshStore(); // no courses at all — feature off / nothing imported
  const spy = spyPipeline();
  const handle = countingHandle(db);
  assert.equal(
    await buildCourseGroundedBlock({
      message: 'anything at all in here',
      storeLike: store,
      db: handle.dbLike,
      pipeline: spy.pipeline,
    }),
    null,
  );
  assert.equal(spy.calls.length, 0, 'no embedding request before the early return');
  assert.equal(handle.counts.prepareCalls, 0, 'no retrieval SQL prepared before the early return');
});

test('N4 premium-off leak guard: disabled course with on-disk chunks grounds nothing', async () => {
  const { db } = freshStore();
  const [lessonUrl] = seedCourse(db, 'course-n4-off', 'Leak guard course', [{ title: 'Guard', text: N4_MD }]);
  assert.ok(fs.readFileSync(lessonUrl, 'utf8').includes(SENTINEL), 'on-disk fixture still carries the sentinel while premium is off');
  const store = new CourseStore(db);
  store.setCourseEnabled('course-n4-off', false);
  assert.equal(store.listCourses().find((c) => c.id === 'course-n4-off').enabled, false);
  assert.ok(
    store.countCourseStats('course-n4-off').chunks > 0,
    'chunk rows exist on disk — the enabled gate is what keeps them out of the prompt',
  );

  const spy = spyPipeline();
  const handle = countingHandle(db);
  const block = await buildCourseGroundedBlock({
    message: LEAK_TOKEN, // a query that WOULD match if retrieval ran against this course
    storeLike: store,
    db: handle.dbLike,
    pipeline: spy.pipeline,
  });
  assert.equal(block, null, 'assembled prompt block is empty while the course is disabled');
  assert.ok(!String(block ?? '').includes(SENTINEL), 'no sentinel chunk in the assembled prompt');
  assert.equal(spy.calls.length, 0);
  assert.equal(handle.counts.prepareCalls, 0);
});

test('N4 positive control: same fixture enabled → sentinel grounds (proves the guard would catch a leak)', async () => {
  const { db } = freshStore();
  const [lessonUrl] = seedCourse(db, 'course-n4-on', 'Leak guard course (on)', [{ title: 'Guard', text: N4_MD }]);
  const store = new CourseStore(db); // seeder leaves it enabled
  assert.equal(store.listCourses().find((c) => c.id === 'course-n4-on').enabled, true);
  const block = await buildCourseGroundedBlock({ message: LEAK_TOKEN, storeLike: store, db });
  assert.equal(typeof block, 'string');
  assert.ok(block.startsWith(HEADER));
  assert.ok(block.includes(SENTINEL), 'enabled fixture grounds its sentinel chunk — the off test is discriminating');
  assert.ok(block.includes(lessonUrl));
});

test('N3 premium back on: re-enabling restores course/lessons/chunks from existing data, no re-import', async () => {
  const { db, store } = freshStore();
  // Real .md files on disk; local_md_path holds absolute paths (production layout).
  const alphaMd = writeLessonMd('# Alphas\n\nAlpha recovery token alpharecovery42x lives in the first lesson.');
  const betaMd = writeLessonMd('# Betas\n\nBeta filler content that never matches this test query at all.');
  store.upsertCourse({
    id: 'c-restore',
    name: 'Restore course',
    sourceUrl: `https://courses.test/run-${process.pid}/restore`,
    status: 'complete',
  });
  store.addLessons('c-restore', [
    { id: 'c-r-l0', title: 'Alphas', url: 'https://courses.test/lesson/a', localMdPath: alphaMd, orderNo: 0 },
    { id: 'c-r-l1', title: 'Betas', url: 'https://courses.test/lesson/b', localMdPath: betaMd, orderNo: 1 },
  ]);
  indexLessonChunks(db, 'c-restore', 'c-r-l0', fs.readFileSync(alphaMd, 'utf8'));
  indexLessonChunks(db, 'c-restore', 'c-r-l1', fs.readFileSync(betaMd, 'utf8'));

  const statsBefore = store.countCourseStats('c-restore');
  assert.equal(statsBefore.lessons, 2);
  assert.ok(statsBefore.chunks >= 2, `expected at least one chunk per lesson, got ${statsBefore.chunks}`);

  // Premium off: observable disabled state, data untouched...
  store.setCourseEnabled('c-restore', false);
  assert.equal(store.getCourse('c-restore').enabled, false);
  assert.ok(!store.listCourses().some((c) => c.enabled), 'no course is enabled while premium is off');

  // ...and back on with ZERO data changes (no upsert / addLessons / reindex in between).
  store.setCourseEnabled('c-restore', true);
  assert.equal(store.getCourse('c-restore').enabled, true);
  assert.deepEqual(
    store.countCourseStats('c-restore'),
    statsBefore,
    'stats identical to pre-disable values without any re-import',
  );
  const lessons = store.listLessons('c-restore');
  assert.equal(lessons.length, 2);
  for (const lesson of lessons) {
    assert.ok(
      typeof lesson.localMdPath === 'string' && fs.existsSync(lesson.localMdPath),
      'on-disk md path still intact',
    );
  }

  // Grounding is fully restored from the existing rows.
  const block = await buildCourseGroundedBlock({ message: 'alpharecovery42x', storeLike: store, db });
  assert.equal(typeof block, 'string');
  assert.ok(block.startsWith(HEADER));
  assert.ok(block.includes('https://courses.test/lesson/a'), 'restored lesson grounds again from disk data');
});

test('N2 premium-off via the real gate: non-empty store with zero enabled courses does the same zero work', async () => {
  const { db } = freshStore();
  seedCourse(db, 'course-gate-a', 'Gate A', [{ title: 'One', text: '# One\n\nFirst lesson body copy for the gate check.' }]);
  seedCourse(db, 'course-gate-b', 'Gate B', [{ title: 'Two', text: '# Two\n\nSecond lesson body copy for the gate check.' }]);
  const store = new CourseStore(db);
  // Premium off manifests in chatGrounding.ts as "rows exist but none enabled" — the same early return.
  for (const course of store.listCourses()) store.setCourseEnabled(course.id, false);
  assert.equal(store.listCourses().length, 2);
  assert.ok(store.listCourses().every((c) => !c.enabled));

  const spy = spyPipeline();
  const handle = countingHandle(db);
  assert.equal(
    await buildCourseGroundedBlock({
      message: 'first lesson body copy for the gate check',
      storeLike: store,
      db: handle.dbLike,
      pipeline: spy.pipeline,
    }),
    null,
  );
  assert.equal(spy.calls.length, 0);
  assert.equal(handle.counts.prepareCalls, 0);
});
