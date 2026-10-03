// P2 auto-grounding — grounded prompt block + vec KNN adapter degradation (node:test, built modules).
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
const { buildCourseGroundedBlock, createCourseVectorSearch } = await loadModule('chatGrounding.js');
const { estimateTokens } = await loadModule('../llm/modelCapabilities.js');

// Pinned byte-for-byte: must equal GROUNDING_HEADER in chatGrounding.ts.
const HEADER =
  'RELATED COURSE MATERIAL — ground truth for this conversation (prefer these over model memory; cite the Source URLs when answering)';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-grounding-test-'));
let fileSeq = 0;
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Unique real .md per run/lesson (production lessons live at local_md_path files).
function writeLessonMd(text) {
  const p = path.join(tmpRoot, `lesson-${process.pid}-${Date.now()}-${fileSeq++}.md`);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

const sha1hex = (text) => createHash('sha1').update(text, 'utf8').digest('hex');

// Upsert course (status complete), enable it, add lessons pointing at real temp .md files, then index
// chunks + rowid-aligned FTS rows mirroring embeddings.ts's non-vector SQL exactly. Returns lesson urls.
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

function freshStore() {
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL); // also creates course_chunks + course_chunks_fts; no vec table by construction
  return { db, store: new CourseStore(db) };
}

test('G1 empty store grounds nothing', async () => {
  const { db, store } = freshStore();
  assert.equal(
    await buildCourseGroundedBlock({ message: 'anything at all in here', storeLike: store, db, pipeline: null }),
    null,
  );
});

const ZEBRA_MD = [
  '# Zebras',
  '',
  'The zebra stripes make each zebra unique within the herd.',
  '',
  'A lone zebra never wanders far from the rest of the herd at dawn.',
].join('\n');

test('G2 auto mode grounds from enabled course FTS rows', async () => {
  const { db, store } = freshStore();
  const [urlA] = seedCourse(db, 'course-zebra', 'Zebra course', [{ title: 'Zebras', text: ZEBRA_MD }]);
  const block = await buildCourseGroundedBlock({ message: 'zebra', storeLike: store, db });
  assert.equal(typeof block, 'string');
  assert.ok(block.startsWith(HEADER), 'block must start with the exact header line');
  assert.ok(block.includes('Source URL:'), 'sections carry Source URL lines');
  assert.ok(block.includes(urlA), 'cites lesson A url');
  assert.ok(estimateTokens(block) <= 4800 + 50, `over budget: ${String(estimateTokens(block))} tokens`);
});

test('G3 zero-overlap query returns null', async () => {
  const { db, store } = freshStore();
  seedCourse(db, 'course-plain', 'Plain course', [
    { title: 'Intro', text: '# Intro\nGeneral orientation content for new learners.' },
  ]);
  assert.equal(
    await buildCourseGroundedBlock({ message: 'xyzzypqrsuniquezerooverlap', storeLike: store, db }),
    null,
  );
});

const QUOKKA_MD = '# Quokka habitat\n\nThe quokka is a small Australian marsupial found near the coast.';

test('G4 pin bypasses enabled filter for disabled course', async () => {
  const { db } = freshStore();
  const [urlQ] = seedCourse(db, 'course-off', 'Disabled course', [{ title: 'Quokka habitat', text: QUOKKA_MD }]);
  const store = new CourseStore(db);
  store.setCourseEnabled('course-off', false); // auto candidate selection now excludes it...
  assert.equal(store.listCourses().find((c) => c.id === 'course-off').enabled, false);
  const block = await buildCourseGroundedBlock({
    message: 'quokka',
    storeLike: store,
    db,
    pinnedCourseIds: ['course-off'], // ...but pinning still grounds it.
  });
  assert.equal(typeof block, 'string');
  assert.ok(block.startsWith(HEADER));
  assert.ok(block.includes('quokka'), 'block carries quokka content from the disabled course');
  assert.ok(block.includes(urlQ), 'cites the pinned lesson url');
});

test('G5 missing vec table degrades gracefully to FTS-only', async () => {
  const { db } = freshStore();
  seedCourse(db, 'course-cedar', 'Cedar course', [
    { title: 'Cedar', text: '# Cedar\nA cedar grows tall along the ridge.' },
  ]);
  const store = new CourseStore(db);
  const pipeline = { getEmbeddingForQuery: async () => ({ embedding: new Array(8).fill(0.1) }) };
  // vec_course_chunks_8 absent by construction ⇒ vector side yields nothing, FTS finds no overlap ⇒ null.
  assert.equal(await buildCourseGroundedBlock({ message: 'gvwz9qnmzerooverlap', storeLike: store, db, pipeline }), null);

  const vecSearch = createCourseVectorSearch(db);
  assert.deepEqual(await vecSearch.search(['course-cedar'], null), []); // no embedding ⇒ []
  assert.deepEqual(await vecSearch.search(['course-cedar'], new Array(8).fill(0.1)), []); // missing-table guard, no throw
});

// One long line of repeated sentences: the chunker hard-slices it into <=7200-char chunks (8 full + one ~4900),
// every chunk containing "tundra", so any 6 matched rows overflow the 4800-token budget.
const TUNDRA_SENTENCE = 'The tundra biome is a cold treeless plain of the Arctic. ';
const TUNDRA_MD = TUNDRA_SENTENCE.repeat(Math.ceil(62500 / TUNDRA_SENTENCE.length));

test('G6 oversized lesson truncates inside budget with ellipsis', async () => {
  const { db, store } = freshStore();
  const [urlT] = seedCourse(db, 'course-tundra', 'Tundra course', [{ title: 'Tundra', text: TUNDRA_MD }]);
  const block = await buildCourseGroundedBlock({ message: 'tundra', storeLike: store, db });
  assert.equal(typeof block, 'string');
  assert.ok(block.startsWith(HEADER));
  assert.ok(block.includes(urlT), 'truncated block still cites the lesson url');
  assert.ok(block.endsWith('…'), 'overflow section is cut and ends with ellipsis');
  assert.ok(estimateTokens(block) <= 4800 + 150, `over budget: ${String(estimateTokens(block))} tokens`);
});
