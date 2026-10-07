import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../../dist-electron/electron/courses');
const { getLessonDuration } = await import(pathToFileURL(path.join(dist, 'lessonDuration.js')).href);
const { resolveCourseDataDir } = await import(pathToFileURL(path.join(dist, 'courseDir.js')).href);
const source = fs.readFileSync(path.resolve(here, '../../ipcHandlers.ts'), 'utf8');
const start = source.indexOf("  safeHandle('courses:list'");
const end = source.indexOf("  safeHandle('courses:lesson-content'", start);
assert.ok(start > 0 && end > start, 'course IPC handlers and shared path resolver exist');
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'course duration ipc '));
  const courseId = 'legacy-course';
  const lessonsDir = path.join(userData, 'courses', courseId, 'lessons');
  fs.mkdirSync(lessonsDir, { recursive: true });
  const lessons = [
    { id: `${courseId}:old`, kind: 'lesson', localMdPath: null },
    { id: 'explicit', kind: 'lesson', localMdPath: 'lessons/explicit.md' },
    { id: 'missing', kind: 'lesson', localMdPath: 'lessons/missing.md' },
    { id: 'invalid', kind: 'lesson', localMdPath: '../escape.md' },
    { id: 'resource', kind: 'resource', localMdPath: 'lessons/resource.md' },
  ].map((lesson) => ({ ...lesson, updatedAt: '2026-01-01T00:00:00Z' }));
  fs.writeFileSync(path.join(lessonsDir, 'old.md'), `---\nkind: lesson\nurl: https://example.com/old\n---\n${Array(401).fill('word').join(' ')}`);
  fs.writeFileSync(path.join(lessonsDir, 'explicit.md'), '---\nkind: lesson\nlessonDurationMinutes: 7\n---\nShort lesson');
  fs.writeFileSync(path.join(lessonsDir, 'resource.md'), '---\nlessonDurationMinutes: 42\n---\nResource');
  fs.writeFileSync(path.join(userData, 'courses', 'escape.md'), '---\nlessonDurationMinutes: 50\n---\nEscape');
  const course = { id: courseId, name: 'Imported course', status: 'partial', updatedAt: '2026-01-01T00:00:00Z' };
  const store = {
    listCourses: () => [course],
    getCourse: (id) => id === courseId ? course : undefined,
    listLessons: (id) => id === courseId ? lessons : [],
    countCourseStats: () => ({ lessons: 4, chunks: 2 }),
  };
  const handlers = new Map();
  let reads = 0;
  let activeStats = 0;
  let peakStats = 0;
  const countedFs = {
    ...fs,
    promises: {
      ...fs.promises,
      readFile: async (...args) => { reads++; return fs.promises.readFile(...args); },
      stat: async (...args) => {
        peakStats = Math.max(peakStats, ++activeStats);
        try { return await fs.promises.stat(...args); }
        finally { activeStats--; }
      },
    },
  };
  vm.runInNewContext(code, {
    safeHandle: (channel, handler) => handlers.set(channel, handler),
    isProOrTrialActive: () => true,
    getCourseStore: () => store,
    app: { getPath: () => userData },
    fs: countedFs, path, resolveCourseDataDir, getLessonDuration,
    stripCourseFrontmatter: (md) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''),
    console: { warn() {} },
  });
  return { courseId, lessons, lessonsDir, handlers, get reads() { return reads; }, get peakStats() { return peakStats; }, cleanup: () => fs.rmSync(userData, { recursive: true, force: true }) };
}

test('course IPC reads legacy and explicit durations, skips absent and non-lesson files', async () => {
  const f = fixture();
  try {
    const invoke = (channel, id) => f.handlers.get(channel)(null, id);
    const [summary] = await invoke('courses:list');
    assert.equal(summary.lessonCount, 4);
    assert.equal(summary.timedLessonCount, 2, 'only readable lesson files have durations');
    assert.equal(summary.chunkCount, 2);
    assert.equal(summary.readingMinutes, 10);
    assert.equal(summary.providedMinutes, 7);
    const result = await invoke('courses:get', f.courseId);
    assert.equal(result.course.status, 'partial');
    assert.deepEqual(Array.from(result.lessons, (lesson) => [lesson.durationMinutes, lesson.durationSource]), [
      [3, 'estimated'], [7, 'provided'], [null, null], [null, null], [null, null],
    ]);
    assert.equal(f.reads, 2, 'both endpoints reuse parsed durations');
    fs.writeFileSync(path.join(f.lessonsDir, 'missing.md'), '---\nlessonDurationMinutes: 4\n---\nNow imported');
    const [updated] = await invoke('courses:list');
    assert.equal(updated.timedLessonCount, 3, 'newly available lesson is now timed');
    assert.equal(updated.readingMinutes, 14, 'partial import appears without reimport');
    assert.equal(updated.providedMinutes, 11);
    fs.rmSync(path.join(f.lessonsDir, 'explicit.md'));
    const afterRemoval = await invoke('courses:get', f.courseId);
    assert.equal(afterRemoval.lessons[1].durationMinutes, null, 'removed file invalidates cached duration');
    assert.equal(afterRemoval.lessons[2].durationMinutes, 4);
    const [revised] = await invoke('courses:list');
    assert.equal(revised.timedLessonCount, 2, 'removed lesson is no longer timed');
    assert.equal(revised.readingMinutes, 7);
    assert.equal(revised.providedMinutes, 4);
  } finally {
    f.cleanup();
  }
});

test('empty cached lessons do not invent a one-minute reading estimate', async () => {
  const f = fixture();
  try {
    f.lessons.push({ id: 'empty', kind: 'lesson', localMdPath: 'lessons/empty.md', updatedAt: '2026-01-01' });
    fs.writeFileSync(path.join(f.lessonsDir, 'empty.md'), '---\nkind: lesson\n---\n');
    const [summary] = await f.handlers.get('courses:list')(null);
    assert.equal(summary.timedLessonCount, 2);
    assert.equal(summary.readingMinutes, 10);
    const result = await f.handlers.get('courses:get')(null, f.courseId);
    assert.equal(result.lessons.at(-1).durationMinutes, null);
  } finally {
    f.cleanup();
  }
});

test('duration file reads stay bounded even when listing many lessons', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5000; i++) f.lessons.push({ id: `missing-${i}`, kind: 'lesson', localMdPath: `lessons/missing-${i}.md`, updatedAt: '2026-01-01' });
    const [summary] = await f.handlers.get('courses:list')(null);
    assert.equal(summary.readingMinutes, 10);
    assert.equal(summary.timedLessonCount, 2);
    assert.equal(f.reads, 2);
    assert.ok(f.peakStats <= 16, `at most 16 files statted concurrently; got ${f.peakStats}`);
  } finally {
    f.cleanup();
  }
});
