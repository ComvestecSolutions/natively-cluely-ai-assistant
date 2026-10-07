// P3 study aids — content prep, JSON extraction, normalizers, cached generation (node:test, built modules).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const loadModule = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const {
  fnv1aHash,
  prepareSources,
  buildPrompt,
  extractJson,
  normalizeSummary,
  normalizeGlossary,
  normalizeQuiz,
  normalizeFlashcards,
  generateStudyAid,
  lookupStudyAid,
} = await loadModule('studyAids.js');

// 1 — plain JSON object, no fences.
test('extractJson parses a bare JSON object', () => {
  const out = extractJson('{"terms":[{"term":"ATM","definition":"Automated Teller Machine"}]}');
  assert.deepEqual(out, { terms: [{ term: 'ATM', definition: 'Automated Teller Machine' }] });
});

// 2 — fenced JSON with prose around it.
test('extractJson pulls JSON out of a fenced block surrounded by prose', () => {
  const text = [
    'Sure, here you go:',
    '```json',
    '{"questions":[{"q":"Q1","options":["a","b"],"answer":0}]}',
    '```',
    'Let me know if you need more.',
  ].join('\n');
  assert.deepEqual(extractJson(text), { questions: [{ q: 'Q1', options: ['a', 'b'], answer: 0 }] });
});

// 3 — malformed input never throws, returns null.
test('extractJson returns null for malformed or absent JSON', () => {
  assert.equal(extractJson('{"a":'), null); // unterminated object
  assert.equal(extractJson('no json here at all'), null);
  assert.deepEqual(extractJson('{"a":"}","b":[1,{"c":2}]}'), { a: '}', b: [1, { c: 2 }] }); // braces in strings ignored
});

// 4 — FNV-1a is deterministic and emits fixed-width hex.
test('fnv1aHash is deterministic, non-empty hex, and distinguishes inputs', () => {
  assert.equal(fnv1aHash('natively'), fnv1aHash('natively'));
  assert.match(fnv1aHash('natively'), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1aHash('hello'), fnv1aHash('world'));
});

// 6a — per-source trim at 5000 chars.
test('prepareSources trims each source md to 5000 chars', () => {
  const out = prepareSources([{ title: 'T1', md: `intro\n${'A'.repeat(6002)}\n` }]);
  assert.ok(out.startsWith('### T1\n\n'));
  assert.equal(out.length, '### T1\n\n'.length + 5000);
});

// 6b — >4 sources sliced to the first 4 (content small enough that all four fit).
test('prepareSources keeps at most 4 sources', () => {
  const mk = (t) => ({ title: t, md: 'B'.repeat(2000) });
  const out = prepareSources([mk('T1'), mk('T2'), mk('T3'), mk('T4'), mk('T5')]);
  assert.ok(out.includes('### T1'));
  assert.ok(out.includes('### T4'));
  assert.ok(!out.includes('### T5')); // fifth source sliced away
  assert.equal(out.length, 4 * ('### T1\n\n'.length + 2000) + 3 * 2);
});

// 6c — total capped at 14000 with a visible ellipsis cut.
test('prepareSources caps the joined output at 14000 chars', () => {
  const mk = (t) => ({ title: t, md: 'B'.repeat(5200) }); // each trims to 5000 → ~15k total
  const out = prepareSources([mk('T1'), mk('T2'), mk('T3')]);
  assert.equal(out.length, 14000);
  assert.ok(out.endsWith('…'));
});

// Bonus — prompt shape for the IPC agent to sanity-check later.
test('buildPrompt assembles preamble, type body and provided material', () => {
  const quiz = buildPrompt('quiz', 'MAT-TEXT');
  assert.ok(quiz.startsWith('You are a course tutor. Generate study material STRICTLY'));
  assert.ok(quiz.includes('exactly 6 questions'));
  assert.ok(quiz.endsWith('\n\nPROVIDED MATERIAL:\nMAT-TEXT'));
  const glossary = buildPrompt('glossary', 'M');
  assert.ok(glossary.includes('"terms"'));
  assert.ok(!glossary.includes('exactly 6 questions'));
});

// 5a — text answers resolve to their option index (case-insensitive); bad items dropped.
test('normalizeQuiz resolves text answers to indexes and drops invalid items', () => {
  const raw = {
    questions: [
      { q: 'Capital of France?', options: ['Berlin', 'Paris'], answer: 'PARIS' }, // → index 1 by text
      { q: 'No options here?', options: [], answer: 0 },                         // dropped (<2 options)
      { q: 'Bad index?', options: ['A', 'B'], answer: 9 },                       // dropped (out of range)
      { q: '', options: ['C', 'D'], answer: 0 },                                 // dropped (empty question)
    ],
  };
  const r = normalizeQuiz(raw);
  assert.ok(r.ok);
  assert.equal(r.data.questions.length, 1);
  assert.deepEqual(r.data.questions[0], { q: 'Capital of France?', options: ['Berlin', 'Paris'], answer: 1 });
});

// 5b — nothing survives → ok:false.
test('normalizeQuiz returns ok:false when no question is valid', () => {
  const r = normalizeQuiz({ questions: [{ q: 'only one option', options: ['A'], answer: 0 }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no valid quiz questions/);
});

// Bonus — glossary + flashcards normalizers keep only complete pairs.
test('normalizeGlossary and normalizeFlashcards keep only complete entries', () => {
  const g = normalizeGlossary({ terms: [{ term: 'API', definition: 'Application interface' }, { term: '', definition: 'x' }] });
  assert.ok(g.ok);
  assert.equal(g.data.entries.length, 1);
  assert.equal(normalizeGlossary('not json').ok, false);

  const f = normalizeFlashcards({ cards: [{ front: 'Q?', back: 'A!' }, { front: 'no back', back: '' }] });
  assert.ok(f.ok);
  assert.equal(f.data.cards.length, 1);
});

// Bonus — summary normalization strips fence leftovers.
test('normalizeSummary trims and strips leading/trailing fence leftovers', () => {
  const ok = normalizeSummary('\n```\nsome text here\n```\n');
  assert.ok(ok.ok);
  assert.equal(ok.data, 'some text here');
  assert.equal(normalizeSummary('   ').ok, false);
});

// 7 — full generate flow: generation → cache write → cached hit (no llm) → force re-call.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'study-aids-test-'));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('generateStudyAid caches by prepared content and honors force', async () => {
  const rootDir = path.join(tmpRoot, 'courses'); // mirrors <userData>/courses
  const courseId = 'course-1';
  let llmCalls = 0;
  const llm = async (prompt) => {
    llmCalls++;
    assert.ok(prompt.includes('PROVIDED MATERIAL:'));
    return [
      'Here is your quiz:',
      '```json',
      '{"questions":[{"q":"Q one","options":["no","yes"],"answer":1,"explanation":"It says so."},{"q":"Q two","options":["a","b","c"],"answer":0}]}',
      '```',
    ].join('\n');
  };
  const sources = [{ title: 'Lesson One', md: 'The lesson body text about loops and conditionals.' }];

  const first = await generateStudyAid({ rootDir, courseId, type: 'quiz', sources, llm });
  assert.ok(first.ok);
  assert.equal(first.cached, undefined);
  assert.equal(llmCalls, 1);
  assert.equal(first.data.questions.length, 2);

  const cacheFile = path.join(rootDir, courseId, 'study-aids.json');
  const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const key = `quiz:${fnv1aHash(prepareSources(sources))}`;
  assert.ok(onDisk[key]);
  assert.equal(typeof onDisk[key].at, 'string');

  // Identical content re-open: served from cache without a second llm call.
  const second = await generateStudyAid({ rootDir, courseId, type: 'quiz', sources, llm });
  assert.ok(second.ok);
  assert.equal(second.cached, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(llmCalls, 1);

  // force:true regenerates even on a cache hit.
  const third = await generateStudyAid({ rootDir, courseId, type: 'quiz', sources, force: true, llm });
  assert.ok(third.ok);
  assert.notEqual(third.cached, true);
  assert.equal(llmCalls, 2);
});

const moduleLessons = () => Array.from({ length: 6 }, (_, i) => ({
  title: `Lesson ${i + 1}`,
  md: `Unique material ${i + 1}`,
}));
const validSynthesis = '## Key points\n- The first lessons introduce their unique material, and the later lessons extend it with other distinct material.';

test('read-only lookup returns a clean miss without generating or creating a cache', async () => {
  const rootDir = path.join(tmpRoot, 'lookup-missing');
  const input = { rootDir, courseId: 'course', type: 'summary', sources: moduleLessons() };
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
  assert.deepEqual(await lookupStudyAid({ ...input, sources: [] }), { ok: true, cached: false, data: null });
  assert.ok(!fs.existsSync(path.join(rootDir, 'course', 'study-aids.json')));
});

test('lookup rehydrates saved full-module data after a fresh import without calling an LLM', async () => {
  const rootDir = path.join(tmpRoot, 'lookup-reopen');
  const sources = moduleLessons();
  const input = { rootDir, courseId: 'course', type: 'quiz', sources };
  let llmCalls = 0;
  const generated = await generateStudyAid({
    ...input,
    llm: async (prompt) => {
      llmCalls++;
      const source = sources.find((lesson) => prompt.includes(lesson.md));
      return JSON.stringify({ questions: [{ q: source.title, options: ['yes', 'no'], answer: 0 }] });
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(llmCalls, 2);
  const cacheFile = path.join(rootDir, 'course', 'study-aids.json');
  const saved = fs.readFileSync(cacheFile, 'utf8');
  const reopened = await import(`${pathToFileURL(path.join(distRoot, 'studyAids.js')).href}?reopen=${Date.now()}`);
  assert.deepEqual(await reopened.lookupStudyAid(input), { ok: true, cached: true, data: generated.data });
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: generated.data });
  assert.deepEqual(await lookupStudyAid({ ...input, type: 'glossary' }), { ok: true, cached: false, data: null });
  assert.equal(llmCalls, 2);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), saved);
});

test('lookup does not rehydrate an aid after the fifth lesson changes', async () => {
  const rootDir = path.join(tmpRoot, 'lookup-invalidated');
  const sources = moduleLessons();
  const input = { rootDir, courseId: 'course', type: 'summary', sources };
  const generated = await generateStudyAid({ ...input, llm: async (prompt) => prompt.includes('BATCH NOTES:') ? validSynthesis : 'Saved module summary' });
  assert.equal(generated.ok, true);
  const changed = sources.map((source, i) => i === 4 ? { ...source, md: 'Updated fifth lesson' } : source);
  assert.deepEqual(await lookupStudyAid({ ...input, sources: changed }), { ok: true, cached: false, data: null });
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: generated.data });
});

test('lookup reads the legacy short-module key and distinguishes cache read errors', async () => {
  const rootDir = path.join(tmpRoot, 'lookup-legacy');
  const input = {
    rootDir, courseId: 'course', type: 'summary',
    sources: [{ title: 'Lesson', md: 'Material' }],
  };
  const generated = await generateStudyAid({ ...input, llm: async () => '## Key points\n- Material is the stated content of this lesson.' });
  assert.equal(generated.ok, true);
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: generated.data });
  fs.writeFileSync(path.join(rootDir, 'course', 'study-aids.json'), '{invalid json');
  assert.deepEqual(await lookupStudyAid(input), { ok: false, error: 'could not read study aid cache' });
});

test('a blocked legacy-dir migration keeps aid writes beside readable lessons', async () => {
  const rootDir = path.join(tmpRoot, 'legacy-dir');
  const courseId = 'legacy course';
  const legacyDir = path.join(rootDir, courseId);
  const safeDir = path.join(rootDir, 'legacy-course');
  fs.mkdirSync(path.join(legacyDir, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'lessons', 'intro.md'), 'The existing lesson');
  const renameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (from === legacyDir && to === safeDir) {
      attempts++;
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    }
    return renameSync(from, to);
  };
  try {
    const input = { rootDir, courseId, type: 'summary', sources: [{ title: 'Intro', md: 'The existing lesson' }] };
    const savedSummary = '## Key points\n- The existing lesson is the material covered here.';
    const generated = await generateStudyAid({ ...input, llm: async () => savedSummary });
    assert.equal(generated.ok, true);
    assert.ok(attempts > 0, 'migration was attempted and blocked');
    assert.ok(!fs.existsSync(safeDir), 'the safe directory must not mask legacy lessons');
    assert.equal(fs.readFileSync(path.join(legacyDir, 'lessons', 'intro.md'), 'utf8'), 'The existing lesson');
    assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: savedSummary });
    assert.ok(fs.existsSync(path.join(legacyDir, 'study-aids.json')));
  } finally {
    fs.renameSync = renameSync;
  }
});

test('force recovers a corrupt cache with a backup; ordinary reads keep the original', async () => {
  const rootDir = path.join(tmpRoot, 'corrupt-cache');
  const courseDir = path.join(rootDir, 'course');
  const cacheFile = path.join(courseDir, 'study-aids.json');
  const corrupt = '{"summary":';
  fs.mkdirSync(courseDir, { recursive: true });
  fs.writeFileSync(cacheFile, corrupt);
  const input = { rootDir, courseId: 'course', type: 'summary', sources: [{ title: 'Intro', md: 'Material' }] };
  assert.deepEqual(await lookupStudyAid(input), { ok: false, error: 'could not read study aid cache' });
  let calls = 0;
  const ordinary = await generateStudyAid({ ...input, llm: async () => { calls++; return 'Not generated'; } });
  assert.deepEqual(ordinary, { ok: false, error: 'could not read study aid cache' });
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), corrupt);
  assert.deepEqual(fs.readdirSync(courseDir), ['study-aids.json']);

  const recoveredSummary = '## Key points\n- Material is the stated content of this lesson.';
  const recovered = await generateStudyAid({ ...input, force: true, llm: async () => { calls++; return recoveredSummary; } });
  assert.deepEqual(recovered, { ok: true, data: recoveredSummary });
  assert.equal(calls, 1);
  const backups = fs.readdirSync(courseDir).filter((name) => /^study-aids\.json\.corrupt-[\da-f-]+\.bak$/.test(name));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(courseDir, backups[0]), 'utf8'), corrupt);
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: recoveredSummary });
});

test('force reports backup failures without replacing the corrupt original', async () => {
  const rootDir = path.join(tmpRoot, 'failed-backup');
  const courseDir = path.join(rootDir, 'course');
  const cacheFile = path.join(courseDir, 'study-aids.json');
  fs.mkdirSync(courseDir, { recursive: true });
  fs.writeFileSync(cacheFile, '{corrupt');
  const copyFile = fs.promises.copyFile;
  fs.promises.copyFile = async (from, to, flags) => {
    if (from === cacheFile) throw Object.assign(new Error('blocked'), { code: 'EIO' });
    return copyFile(from, to, flags);
  };
  try {
    const result = await generateStudyAid({
      rootDir, courseId: 'course', type: 'summary', force: true,
      sources: [{ title: 'Intro', md: 'Material' }], llm: async () => '## Key points\n- Material is the stated content of this lesson.',
    });
    assert.deepEqual(result, { ok: false, error: 'could not back up corrupt study aid cache' });
    assert.equal(fs.readFileSync(cacheFile, 'utf8'), '{corrupt');
    assert.deepEqual(fs.readdirSync(courseDir), ['study-aids.json']);
  } finally {
    fs.promises.copyFile = copyFile;
  }
});

test('force reports save failures without deleting the backed-up corrupt original', async () => {
  const rootDir = path.join(tmpRoot, 'failed-recovery-save');
  const courseDir = path.join(rootDir, 'course');
  const cacheFile = path.join(courseDir, 'study-aids.json');
  fs.mkdirSync(courseDir, { recursive: true });
  fs.writeFileSync(cacheFile, '{corrupt');
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to === cacheFile) throw Object.assign(new Error('blocked'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    const result = await generateStudyAid({
      rootDir, courseId: 'course', type: 'summary', force: true,
      sources: [{ title: 'Intro', md: 'Material' }], llm: async () => '## Key points\n- Material is the stated content of this lesson.',
    });
    assert.deepEqual(result, { ok: false, error: 'could not save study aid cache' });
    assert.equal(fs.readFileSync(cacheFile, 'utf8'), '{corrupt');
    const backups = fs.readdirSync(courseDir).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(courseDir, backups[0]), 'utf8'), '{corrupt');
  } finally {
    fs.promises.rename = rename;
  }
});

test('concurrent forced recovery makes one backup and preserves both new aids', async () => {
  const rootDir = path.join(tmpRoot, 'concurrent-recovery');
  const courseDir = path.join(rootDir, 'course');
  fs.mkdirSync(courseDir, { recursive: true });
  fs.writeFileSync(path.join(courseDir, 'study-aids.json'), 'broken JSON');
  const sources = [{ title: 'Intro', md: 'Material' }];
  const base = { rootDir, courseId: 'course', sources, force: true };
  const [summary, glossary] = await Promise.all([
    generateStudyAid({ ...base, type: 'summary', llm: async () => '## Key points\n- Material is the stated content of this lesson.' }),
    generateStudyAid({ ...base, type: 'glossary', llm: async () => '{"terms":[{"term":"Intro","definition":"Material"}]}' }),
  ]);
  assert.equal(summary.ok, true);
  assert.equal(glossary.ok, true);
  assert.deepEqual(await lookupStudyAid({ ...base, type: 'summary' }), { ok: true, cached: true, data: summary.data });
  assert.deepEqual(await lookupStudyAid({ ...base, type: 'glossary' }), { ok: true, cached: true, data: glossary.data });
  const backups = fs.readdirSync(courseDir).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(courseDir, backups[0]), 'utf8'), 'broken JSON');
});

test('more than 64 aids across modules keep the earliest persisted result', async () => {
  const rootDir = path.join(tmpRoot, 'many-modules');
  const courseId = 'course';
  const types = ['summary', 'glossary', 'quiz', 'flashcards'];
  let llmCalls = 0;
  let earliest;
  let earliestData;
  for (let moduleIndex = 0; moduleIndex < 17; moduleIndex++) {
    for (const type of types) {
      const input = {
        rootDir, courseId, type,
        sources: [{ title: `Module ${moduleIndex}`, md: `Material ${moduleIndex}` }],
      };
      const generated = await generateStudyAid({
        ...input,
        llm: async () => {
          llmCalls++;
          if (type === 'summary') return `## Key points\n- Material ${moduleIndex} is the stated topic of this module.`;
          if (type === 'glossary') return JSON.stringify({ terms: [{ term: `Term ${moduleIndex}`, definition: 'Definition' }] });
          if (type === 'quiz') return JSON.stringify({ questions: [{ q: `Question ${moduleIndex}`, options: ['yes', 'no'], answer: 0 }] });
          return JSON.stringify({ cards: [{ front: `Front ${moduleIndex}`, back: 'Back' }] });
        },
      });
      assert.equal(generated.ok, true, `${type} for module ${moduleIndex}: ${generated.error ?? ''}`);
      if (moduleIndex === 0 && type === 'summary') {
        earliest = input;
        earliestData = generated.data;
      }
    }
  }
  assert.equal(llmCalls, 68);
  const saved = JSON.parse(fs.readFileSync(path.join(rootDir, courseId, 'study-aids.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 68);
  assert.deepEqual(await lookupStudyAid(earliest), { ok: true, cached: true, data: earliestData });
  const again = await generateStudyAid({ ...earliest, llm: async () => { throw new Error('unexpected regeneration'); } });
  assert.equal(again.ok, true);
  assert.equal(again.cached, true);
  assert.deepEqual(again.data, earliestData);
  assert.equal(llmCalls, 68);
});

test('all four aid types use every lesson and persist the complete result', async () => {
  const sources = moduleLessons();
  for (const type of ['summary', 'glossary', 'quiz', 'flashcards']) {
    const rootDir = path.join(tmpRoot, `full-${type}`);
    const seen = [];
    const llm = async (prompt) => {
      assert.ok(prompt.length < 15000);
      if (type === 'summary' && prompt.includes('BATCH NOTES:')) {
        assert.ok(sources.every((source) => prompt.includes(source.title)));
        return `## Key points\n${sources.map((source) => `- Point from ${source.title}`).join('\n')}`;
      }
      const inBatch = sources.filter((source) => prompt.includes(source.md));
      seen.push(inBatch.map((source) => source.title));
      assert.ok(inBatch.length > 0 && inBatch.length <= 4);
      if (type === 'summary') return inBatch.map((source) => `- Point from ${source.title}`).join('\n');
      if (type === 'glossary') return JSON.stringify({ terms: inBatch.map((source) => ({ term: source.title, definition: source.md })) });
      if (type === 'quiz') return JSON.stringify({ questions: inBatch.map((source) => ({ q: source.title, options: ['yes', 'no'], answer: 0 })) });
      return JSON.stringify({ cards: inBatch.map((source) => ({ front: source.title, back: source.md })) });
    };
    const input = { rootDir, courseId: 'whole-course', type, sources, llm };
    const generated = await generateStudyAid(input);
    assert.equal(generated.ok, true, type);
    assert.equal(generated.cached, undefined);
    assert.deepEqual(seen.flat(), sources.map((source) => source.title));
    const rendered = JSON.stringify(generated.data);
    for (const source of sources) assert.ok(rendered.includes(source.title), `${type} omitted ${source.title}`);

    const cacheFile = path.join(rootDir, 'whole-course', 'study-aids.json');
    const saved = Object.values(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].data, generated.data);
    const restored = await generateStudyAid({ ...input, llm: async () => { throw new Error('cache miss'); } });
    assert.equal(restored.ok, true);
    assert.equal(restored.cached, true);
    assert.deepEqual(restored.data, generated.data);
    const forced = await generateStudyAid({ ...input, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.cached, undefined);
    assert.deepEqual(forced.data, generated.data);
    assert.equal(seen.length, 4);
  }
});

test('seven lessons produce one bounded, deduplicated synthesis grounded in both batches', async () => {
  const sources = Array.from({ length: 7 }, (_, i) => ({ title: `Lesson ${i + 1}`, md: `Evidence ${i + 1}` }));
  const rootDir = path.join(tmpRoot, 'seven-lesson-summary');
  const prompts = [];
  const input = { rootDir, courseId: 'course', type: 'summary', sources };
  const generated = await generateStudyAid({ ...input, llm: async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('BATCH NOTES:')) {
      assert.ok(sources.every((source) => prompt.includes(`Takeaway ${source.title}`)));
      return `## Key points\n${sources.map((source) => `- Takeaway ${source.title}: ${source.md}`).join('\n')}\n- Takeaway Lesson 1: Evidence 1.`;
    }
    const inBatch = sources.filter((source) => prompt.includes(source.md));
    assert.ok(prompt.includes('at most 70 words'));
    assert.ok(inBatch.length > 0 && inBatch.length <= 4);
    return inBatch.map((source) => `- Takeaway ${source.title}: ${source.md}`).join('\n');
  } });
  assert.equal(generated.ok, true);
  assert.equal(prompts.length, 3);
  assert.equal((generated.data.match(/Takeaway Lesson 1/g) ?? []).length, 1);
  assert.ok(sources.every((source) => generated.data.includes(source.md)));
  assert.ok(generated.data.trim().split(/\s+/).length <= 220);
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: generated.data });
});

test('invalid or short synthesis cannot be cached or reported as a successful module summary', async () => {
  const sources = moduleLessons();
  for (const [label, synthesis] of [
    ['empty', ''], ['short', '## Key points\n- Okay'],
    ['malformed', '{"points":[]}'],
    ['overlong', `## Key points\n- ${'word '.repeat(221)}`],
    ['stream error', 'Error: Custom Provider returned HTTP 503 secret'],
  ]) {
    const rootDir = path.join(tmpRoot, `invalid-synthesis-${label}`);
    const input = { rootDir, courseId: 'course', type: 'summary', sources };
    const failed = await generateStudyAid({ ...input, llm: async (prompt) => prompt.includes('BATCH NOTES:') ? synthesis : '- A supported batch takeaway' });
    assert.equal(failed.ok, false, label);
    assert.match(failed.error, /summary synthesis:/);
    assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
  }
});

test('changed single-batch summary guidance and summary cache key bypass old entries', async () => {
  const rootDir = path.join(tmpRoot, 'summary-v3');
  const input = { rootDir, courseId: 'course', type: 'summary', sources: [{ title: 'One', md: 'Grounded material' }] };
  const legacyKey = `summary:${fnv1aHash(prepareSources(input.sources))}`;
  const file = path.join(rootDir, 'course', 'study-aids.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [legacyKey]: { h: 'old', at: 'old', data: 'Old summary' } }));
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
  let calls = 0;
  const generated = await generateStudyAid({ ...input, llm: async (prompt) => {
    calls++;
    assert.match(prompt, /at most 180 words/);
    assert.match(prompt, /do not invent exam traps/);
    return '## Key points\n- Grounded material is the stated content of this lesson.';
  } });
  assert.equal(generated.ok, true);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[legacyKey].data, 'Old summary');
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: generated.data });
});

test('a v2 concatenated multi-batch summary is ignored without deleting the old cache', async () => {
  const sources = moduleLessons();
  const rootDir = path.join(tmpRoot, 'summary-v2');
  const input = { rootDir, courseId: 'course', type: 'summary', sources };
  const key = `summary:v2:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`;
  const file = path.join(rootDir, 'course', 'study-aids.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [key]: { h: 'old', at: 'old', data: 'A concatenated essay' } }));
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
  const regenerated = await generateStudyAid({ ...input, llm: async (prompt) => prompt.includes('BATCH NOTES:') ? validSynthesis : '- A supported takeaway' });
  assert.equal(regenerated.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[key].data, 'A concatenated essay');
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: regenerated.data });
});

test('single-batch malformed or trivial summaries fail without caching, then a grounded Markdown summary succeeds', async () => {
  const rootDir = path.join(tmpRoot, 'invalid-single-summary');
  const input = { rootDir, courseId: 'course', type: 'summary', sources: [{ title: 'Loops', md: 'Loops repeat steps until a condition changes.' }] };
  const file = path.join(rootDir, 'course', 'study-aids.json');
  for (const bad of [
    'This is an unstructured response about loops repeating steps until conditions change.',
    '## Key points\nNo bullet about loops repeating steps.',
    '## Key points\n- Loops',
    '## Key points\n## Watch out for\n- Loops repeat steps until a condition changes.',
    '{"summary":"Loops repeat steps until a condition changes."}',
  ]) {
    const failed = await generateStudyAid({ ...input, llm: async () => bad });
    assert.equal(failed.ok, false, bad);
    assert.match(failed.error, /## Key points.*substantive.*bullet/);
    assert.ok(!fs.existsSync(file), 'invalid output must not be cached');
    assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
  }
  const valid = '## Key points\n- Loops repeat steps until a condition changes.';
  assert.deepEqual(await generateStudyAid({ ...input, llm: async () => valid }), { ok: true, data: valid });
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: valid });
});

test('existing malformed v3 single-batch cache entries are bypassed and regenerated', async () => {
  const rootDir = path.join(tmpRoot, 'invalid-single-cache');
  const input = { rootDir, courseId: 'course', type: 'summary', sources: [{ title: 'Loops', md: 'Loops repeat steps until a condition changes.' }] };
  const key = `summary:v3:${fnv1aHash(prepareSources(input.sources))}`;
  const file = path.join(rootDir, 'course', 'study-aids.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [key]: { h: 'old', at: 'old', data: 'Unstructured summary' } }));
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
  let calls = 0;
  const valid = '## Key points\n- Loops repeat steps until a condition changes.';
  const result = await generateStudyAid({ ...input, llm: async () => { calls++; return valid; } });
  assert.deepEqual(result, { ok: true, data: valid });
  assert.equal(calls, 1);
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: true, data: valid });
});

test('oversized single-batch summaries are rejected instead of cached', async () => {
  const rootDir = path.join(tmpRoot, 'too-long-single');
  const input = { rootDir, courseId: 'course', type: 'summary', sources: [{ title: 'One', md: 'A short lesson' }] };
  const failed = await generateStudyAid({ ...input, llm: async () => `## Key points\n- ${'word '.repeat(221)}` });
  assert.deepEqual(failed, { ok: false, error: 'summary exceeds the word limit' });
  assert.deepEqual(await lookupStudyAid(input), { ok: true, cached: false, data: null });
});

test('a change in the fifth lesson invalidates the full-module cache', async () => {
  const rootDir = path.join(tmpRoot, 'invalidate');
  const sources = moduleLessons();
  let calls = 0;
  const llm = async (prompt) => {
    calls++;
    if (prompt.includes('BATCH NOTES:')) {
      return `## Key points\n- The first lessons have original material. ${prompt.includes('Revised study summary') ? 'Revised study summary' : 'Original study summary'} describes the remaining lessons.`;
    }
    return prompt.includes('REVISED FIFTH') ? 'Revised study summary' : 'Original study summary';
  };
  const input = { rootDir, courseId: 'course', type: 'summary', sources, llm };
  const first = await generateStudyAid(input);
  assert.equal(first.ok, true);
  assert.equal(calls, 3);
  const changed = sources.map((source, i) => i === 4 ? { ...source, md: 'REVISED FIFTH' } : source);
  const revised = await generateStudyAid({ ...input, sources: changed });
  assert.equal(revised.ok, true);
  assert.equal(revised.cached, undefined);
  assert.ok(revised.data.includes('Revised study summary'));
  assert.equal(calls, 6);
  const restored = await generateStudyAid({ ...input, llm: async () => { throw new Error('cache miss'); } });
  assert.equal(restored.cached, true);
  assert.deepEqual(restored.data, first.data);
});

test('long lesson material is split rather than discarded, and its end invalidates cache', async () => {
  const rootDir = path.join(tmpRoot, 'long-lesson');
  const sources = [{ title: 'Long lesson', md: `${'A'.repeat(17000)} END-OF-LESSON` }];
  let prompts = [];
  const input = {
    rootDir, courseId: 'course', type: 'summary', sources,
    llm: async (prompt) => { prompts.push(prompt); return prompt.includes('BATCH NOTES:') ? validSynthesis : 'Study summary'; },
  };
  const first = await generateStudyAid(input);
  assert.equal(first.ok, true);
  assert.ok(prompts.length > 1);
  assert.ok(prompts.some((prompt) => prompt.includes('END-OF-LESSON')));
  assert.ok(prompts.every((prompt) => prompt.length < 15000));
  prompts = [];
  const changed = [{ ...sources[0], md: sources[0].md.replace('END-OF-LESSON', 'CHANGED-ENDING') }];
  const revised = await generateStudyAid({ ...input, sources: changed });
  assert.equal(revised.ok, true);
  assert.ok(prompts.some((prompt) => prompt.includes('CHANGED-ENDING')));
});

test('a failed later batch is not cached as a partial aid', async () => {
  const rootDir = path.join(tmpRoot, 'failed-batch');
  const sources = moduleLessons();
  const input = {
    rootDir, courseId: 'course', type: 'summary', sources,
    llm: async (prompt) => {
      if (prompt.includes(sources[4].md)) throw new Error('provider unavailable');
      return 'First batch summary';
    },
  };
  const failed = await generateStudyAid(input);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /batch 2\/2: model request failed/);
  assert.ok(!fs.existsSync(path.join(rootDir, 'course', 'study-aids.json')));
});

test('concurrent aid writes preserve both entries and leave valid JSON', async () => {
  const rootDir = path.join(tmpRoot, 'parallel');
  const sources = moduleLessons();
  const inputs = ['summary', 'glossary'].map((type) => ({
    rootDir, courseId: 'course', type, sources,
    llm: async (prompt) => type === 'summary'
      ? (prompt.includes('BATCH NOTES:') ? validSynthesis : 'Summary')
      : '{"terms":[{"term":"Term","definition":"Definition"}]}',
  }));
  const results = await Promise.all(inputs.map(generateStudyAid));
  assert.ok(results.every((result) => result.ok));
  const saved = JSON.parse(fs.readFileSync(path.join(rootDir, 'course', 'study-aids.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 2);
  for (const input of inputs) {
    const again = await generateStudyAid({ ...input, llm: async () => { throw new Error('cache miss'); } });
    assert.equal(again.cached, true);
  }
});

test('provider errors do not expose lesson text or credentials', async () => {
  const sources = moduleLessons();
  const secret = 'COURSE-TEXT-AND-SECRET';
  const rootDir = path.join(tmpRoot, 'safe-errors');
  const input = { rootDir, courseId: 'course', type: 'summary', sources };
  const thrown = await generateStudyAid({
    ...input, llm: async () => { throw new Error(`HTTP 401 ${secret}`); },
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /HTTP 401/);
  assert.ok(!thrown.error.includes(secret));
  const streamed = await generateStudyAid({
    ...input, llm: async () => `Error: Custom Provider returned HTTP 403 ${secret}`,
  });
  assert.equal(streamed.ok, false);
  assert.match(streamed.error, /HTTP 403/);
  assert.ok(!streamed.error.includes(secret));
});

test('cache read failures at write time return an error instead of reporting unsaved success', async () => {
  const rootDir = path.join(tmpRoot, 'write-failure');
  const sources = moduleLessons();
  const cacheFile = path.join(rootDir, 'course', 'study-aids.json');
  const result = await generateStudyAid({
    rootDir, courseId: 'course', type: 'summary', sources,
    llm: async (prompt) => {
      fs.mkdirSync(cacheFile, { recursive: true });
      return prompt.includes('BATCH NOTES:') ? validSynthesis : 'Generated but not saved';
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not read study aid cache/);
});
