// TEMP DIAGNOSTIC — delete after use. Probes what searchCourses + estimateTokens actually do for G6's fixture.
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
const { estimateTokens } = await loadModule('../llm/modelCapabilities.js');
const { searchCourses } = await loadModule('./retrieval.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-grounding-diag-'));
const db = new Database(':memory:');
db.exec(COURSES_SCHEMA_SQL);
const store = new CourseStore(db);

const TUNDRA_SENTENCE = 'The tundra biome is a cold treeless plain of the Arctic. ';
const md = TUNDRA_SENTENCE.repeat(Math.ceil(62500 / TUNDRA_SENTENCE.length));
console.log('md length:', md.length);

store.upsertCourse({ id: 'course-tundra', name: 'Tundra course', sourceUrl: `https://courses.test/diag/${Date.now()}`, status: 'complete' });
const url = path.join(tmpRoot, 'tundra.md');
fs.writeFileSync(url, md, 'utf8');
store.addLessons('course-tundra', [{ id: 'course-tundra-l0', title: 'Tundra', url, orderNo: 0 }]);

const chunks = chunkLessonMarkdown(md);
console.log('chunker produced', chunks.length, 'chunks; lengths:', JSON.stringify(chunks.map((c) => c.text.length)));

const insChunk = db.prepare(
  'INSERT INTO course_chunks (course_id, lesson_id, ord, heading_path, text, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
);
const delFts = db.prepare('DELETE FROM course_chunks_fts WHERE rowid = ?');
const insFts = db.prepare(
  'INSERT INTO course_chunks_fts (rowid, course_id, lesson_id, heading_path, text) VALUES (?, ?, ?, ?, ?)',
);
for (const ch of chunks) {
  const rowId = Number(
    insChunk.run('course-tundra', 'course-tundra-l0', ch.index, ch.headingPath ?? null, ch.text, createHash('sha1').update(ch.text, 'utf8').digest('hex'))
      .lastInsertRowid,
  );
  delFts.run(rowId);
  insFts.run(rowId, 'course-tundra', 'course-tundra-l0', ch.headingPath ?? null, ch.text);
}

const ftsRows = db.prepare("SELECT rowid, length(text) AS n FROM course_chunks_fts WHERE course_chunks_fts MATCH ?").all('tundra');
console.log('FTS matched rows:', ftsRows.length, 'total chars:', ftsRows.reduce((a, r) => a + r.n, 0));

const evidence = await searchCourses({ db, query: 'tundra', courseIds: ['course-tundra'], limit: 6 });
console.log('searchCourses returned rows:', evidence.length);
for (const row of evidence) {
  console.log(`  text=${row.text.length} heading="${row.headingPath}" title="${row.lessonTitle}" url=${row.url ? 'yes' : 'no'}`);
}

const total = evidence.reduce((a, r) => a + r.text.length, 0);
console.log('evidence total chars:', total);
for (const n of [7200, 41000]) {
  console.log(`estimateTokens('${'x'.repeat(Math.min(n, 30))}...x' x${n}) =`, estimateTokens('tundra '.repeat(Math.ceil(n / 7))));
}
