// P5 assessment capture — embedded JSON extraction, markdown rendering, offline fetch flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const loadModule = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const { extractEmbeddedQuestions, renderAssessmentMarkdown, fetchAssessmentQuestions } =
  await loadModule('assessments.js');

// Five question-shaped objects with varied key spellings, embedded as JSON in a script tag.
function assessmentJsonHtml() {
  const payload = [
    { text: 'What is the capital of France?', options: ['Berlin', 'Paris'], correctAnswer: 1 },
    { questionText: 'Which model type uses layers?', choices: [{ label: 'CNN' }, { label: 'RNN' }], answerIndex: 0 },
    { prompt: 'Does a transformer use attention?', choices: [{ text: 'No', isCorrect: false }, { text: 'Yes', isCorrect: true }] },
    { questionText: 'What does CPU stand for?', options: [{ content: 'Central Processing Unit' }, { content: 'Computer Personal Unit' }], correctAnswer: 0 },
    { prompt: 'Which language runs in the browser?', choices: ['Python', 'JavaScript'] },
  ];
  return [
    '<!doctype html><html><head><title>Practice Assessment</title></head>',
    '<body><h1>Certification practice assessment</h1>',
    `<script type="application/json">${JSON.stringify(payload)}</script>`,
    '</body></html>',
  ].join('');
}

// A realistic plain page: scripts present but none carries question JSON.
function plainHtml() {
  return [
    '<!doctype html><html><head><title>AI Fundamentals certification</title></head>',
    '<body><h1>Certification</h1><p>The practice assessment is currently not available.</p>',
    '<script type="application/ld+json">{"@context":"https://schema.org","name":"AI-900"}</script>',
    "<script>console.log('no questions embedded');</script>",
    '</body></html>',
  ].join('');
}

const CARD_URL = 'https://learn.microsoft.com/en-us/credentials/certs/ms-ai-fundamentals/practice-assessment';
const cardLine = (url) => `> **Official practice assessment (external):** [Take it on Microsoft Learn ↗](${url})`;

// 1 — extraction normalizes a varied question array from embedded JSON.
test('extractEmbeddedQuestions maps text/options/answer key spellings per item', () => {
  const out = extractEmbeddedQuestions(assessmentJsonHtml());
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { q: 'What is the capital of France?', options: ['Berlin', 'Paris'], answer: 1 });
  assert.equal(out[1].q, 'Which model type uses layers?');
  assert.deepEqual(out[1].options, ['CNN', 'RNN']); // .label objects coerced to text
  assert.equal(out[1].answer, 0);
  assert.equal(out[2].q, 'Does a transformer use attention?');
  assert.equal(out[2].answer, 1); // derived from the first isCorrect option
  assert.deepEqual(out[3], { q: 'What does CPU stand for?', options: ['Central Processing Unit', 'Computer Personal Unit'], answer: 0 });
  assert.equal(out[4].q, 'Which language runs in the browser?');
  assert.deepEqual(out[4].options, ['Python', 'JavaScript']);
  assert.ok(!('answer' in out[4]), 'no answer signal — key omitted entirely');
});

// 2 — plain HTML without question JSON yields [].
test('extractEmbeddedQuestions returns [] for pages with no parseable question JSON', () => {
  assert.deepEqual(extractEmbeddedQuestions(plainHtml()), []);
  assert.deepEqual(extractEmbeddedQuestions(''), []);
});

// 3 — markdown rendering: exact terminal card line in both variants.
test('renderAssessmentMarkdown ends with the external link card and lists questions when present', () => {
  const questions = [
    { q: 'What is a transformer?', options: ['A neural architecture', 'A kitchen appliance'], answer: 0 },
    { q: 'Which loss function for classification?' },
  ];
  const md = renderAssessmentMarkdown('AI-900 practice assessment', CARD_URL, questions);

  assert.ok(md.startsWith('\n\n'), 'appendable to an existing markdown file');
  assert.equal(md.split('\n').pop(), cardLine(CARD_URL), 'last line is exactly the external card');
  assert.ok(md.includes('## Practice assessment — extracted questions (2)'));
  assert.match(md, /\*\*1\. What is a transformer\?\*\*/);
  assert.ok(md.includes('- A. A neural architecture'));
  assert.ok(md.includes('- B. A kitchen appliance'));
  assert.equal((md.match(/- Answer:/g) || []).length, 1, 'only the known answer renders an Answer line');

  const empty = renderAssessmentMarkdown('AI-900 practice assessment', CARD_URL, []);
  assert.ok(empty.startsWith('\n\n'));
  assert.ok(empty.includes('## Practice assessment'));
  assert.ok(empty.includes('No machine-readable practice questions were found on this page.'));
  assert.equal(empty.split('\n').pop(), cardLine(CARD_URL), 'empty variant ends with the same card');
});

// 4 — offline fetch success end-to-end.
test('fetchAssessmentQuestions returns extracted questions for a 200 page with JSON', async () => {
  let calls = 0;
  const http = {
    get: async (url) => {
      calls += 1;
      return { status: 200, body: assessmentJsonHtml() };
    },
  };
  const res = await fetchAssessmentQuestions(CARD_URL, http);
  assert.equal(calls, 1, 'exactly one polite GET');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.questions.length, 5);
    assert.deepEqual(res.questions[0], { q: 'What is the capital of France?', options: ['Berlin', 'Paris'], answer: 1 });
  } else {
    assert.fail(`expected ok result, got error: ${res.error}`);
  }
});

// 5 — no machine-readable data → exact fallback error string.
test('fetchAssessmentQuestions reports the link-card fallback with its exact error string', async () => {
  const http = { get: async () => ({ status: 200, body: plainHtml() }) };
  const res = await fetchAssessmentQuestions(CARD_URL, http);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error, 'no machine-readable questions found — link card fallback');
  } else {
    assert.fail('expected a fallback error result');
  }
});

// 6 — non-2xx surfaces as an HTTP status error.
test('fetchAssessmentQuestions surfaces non-2xx statuses with the code', async () => {
  const http = { get: async () => ({ status: 404, body: 'not found' }) };
  const res = await fetchAssessmentQuestions(CARD_URL, http);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /HTTP 404/);
  } else {
    assert.fail('expected an error result');
  }
});
