// P3 study aids — content prep, JSON extraction, normalizers, cached generation (node:test, built modules).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
