// Chunker — P2 (retrieval): deterministic lesson-markdown splitting into CourseChunk units (node:test, built module).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { chunkLessonMarkdown } = await import(
  pathToFileURL(path.join(distRoot, 'chunking.js')).href
);

const MAX = 3600; // default maxCharsPerChunk under test
const HARD = 7200; // default hardMaxChars under test

// --- fixture: two h2 sections, nested list, ~800-char fence straddling a MAX slice boundary,     ---
// --- a table, and an 8.5k single-line paragraph that forces the hard split. ----------------------
function fill(targetChars, unit) {
  const out = [];
  let n = 1;
  while (out.join('\n').length < targetChars) out.push(`${unit} ${String(n++).padStart(2, '0')}.`);
  return out.join('\n');
}

const SENTINEL = 'The sentinel ALPHA-42 marks this retrieval fixture.';
const INTRO =
  fill(360, 'The retrieval layer turns lesson pages into addressable re-rankable evidence for the assistant to cite.') +
  '\n' +
  SENTINEL;
const GS_UNIT = 'Chunking keeps every code fence and table intact so an answer can quote the exact lesson snippet it used.';
const P1 = fill(765, GS_UNIT);
const P2 = fill(765, GS_UNIT);
const P3 = fill(765, GS_UNIT);
const TABLE = [
  '| Stage | Purpose |',
  '| ----- | ------- |',
  '| Chunking | Split the lesson into retrieval units |',
  '| Embedding | Project chunk text to vectors |',
].join('\n');
const FENCE = [
  '```python',
  ...Array.from({ length: 16 }, (_, i) => `// retrieve top-k passages for query slot ${String(i + 1).padStart(2, '0')}`),
  '```',
].join('\n');
const CLOSE = fill(620, 'Recall merges per-chunk cosine scores with a length penalty before the cross-encoder re-ranks it.');

const LIST = [
  '- pipeline stages run in a fixed order',
  '    - chunking preserves fences and tables verbatim',
  '        * nested leaf alpha stays attached to its section',
  '- re-ranking runs only on recalled chunks',
].join('\n');
let hugeLine = 'HUGE-START ';
while (hugeLine.length < 8500)
  hugeLine += 'The embedding index rebuilds lazily so a long lesson never blocks the first assistant question. ';
hugeLine += '| HUGE-END';

const FIXTURE = [
  '# Retrieval Foundations',
  INTRO,
  '## Getting Started',
  P1,
  P2,
  P3,
  TABLE,
  FENCE,
  CLOSE,
  '## Deep Dive',
  '### How it works',
  LIST,
  hugeLine,
].join('\n\n');

const chunks = chunkLessonMarkdown(FIXTURE);
const again = chunkLessonMarkdown(FIXTURE); // determinism: same input → identical output
const ws = (s) => s.replace(/\s+/g, '');
const ALL_WS = ws(chunks.map((c) => c.text).join(''));

test('chunks are bounded, sequentially indexed and stable across runs', () => {
  // This fixture packs deterministically into exactly four chunks.
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  for (const c of chunks) {
    assert.ok(c.text.length > 0 && c.text.length <= HARD, `chunk ${c.index} size out of bounds: ${c.text.length}`);
  }
  assert.deepEqual(again, chunks);
});

test('the fence straddles a MAX slice boundary but stays intact in one chunk', () => {
  const fenceStart = FIXTURE.indexOf('```');
  const closeIdx = FIXTURE.indexOf('```', fenceStart + 3);
  assert.ok(closeIdx > fenceStart, 'closing fence not found');
  const fenceEnd = closeIdx + 3;
  assert.ok(
    Math.floor(fenceEnd / MAX) > Math.floor(fenceStart / MAX),
    `fixture should straddle a ${MAX}-char slice (fence at [${fenceStart}, ${fenceEnd}))`,
  );
  const fenceChunks = chunks.filter((c) => c.text.includes('retrieve top-k passages for query slot'));
  assert.equal(fenceChunks.length, 1, 'the whole fenced block lives in exactly one chunk');
  assert.ok(ALL_WS.includes(ws(FENCE)), 'every line of the fenced block survives verbatim in chunk text');
  for (const c of chunks) {
    const fenceLines = c.text.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
    assert.equal(fenceLines % 2, 0, `chunk ${c.index} splits a fenced block (${fenceLines} fence lines)`);
  }
});

test('headingPath follows the active heading stack per chunk', () => {
  const H1 = 'Retrieval Foundations';
  const allowed = [H1, `${H1} > Getting Started`, `${H1} > Deep Dive`, `${H1} > Deep Dive > How it works`];
  for (const c of chunks) {
    assert.ok(allowed.includes(c.headingPath), `unexpected headingPath ${JSON.stringify(c.headingPath)} in chunk ${c.index}`);
  }
  const by = (needle) => chunks.filter((c) => ws(c.text).includes(ws(needle)));
  // Probes sit in chunks that provably START inside their section, so the first-block path rule applies.
  assert.equal(by(SENTINEL).length, 1); // chunk opens at the h1 block
  for (const c of by(SENTINEL)) assert.equal(c.headingPath, H1);
  const fenceByChunk = chunks.filter((c) => c.text.includes('retrieve top-k passages for query slot'));
  assert.ok(fenceByChunk.length >= 1, 'fenced block must survive chunking');
  for (const c of fenceByChunk) assert.equal(c.headingPath, `${H1} > Getting Started`); // chunk opens under the h2
  // The huge line's pieces open fresh chunks under the full stack — this also proves the h2/h3 pop-push sequence.
  const hugeChunks = [...by('HUGE-START'), ...by('HUGE-END')];
  assert.ok(hugeChunks.length >= 1, 'huge-line markers must survive');
  for (const c of hugeChunks) assert.equal(c.headingPath, `${H1} > Deep Dive > How it works`);
});

test('lesson content is preserved modulo whitespace; sentinel lands in exactly one chunk', () => {
  assert.equal(ALL_WS, ws(FIXTURE), 'whitespace-stripped fixture must equal the stripped chunk texts');
  const hits = chunks.filter((c) => ws(c.text).includes(ws(SENTINEL))).length;
  assert.equal(hits, 1, 'sentinel sentence must appear in exactly one chunk');
});

test('an indivisible block past hardMax is split into consecutive capped chunks', () => {
  const startChunk = chunks.find((c) => c.text.includes('HUGE-START'));
  const endChunk = chunks.find((c) => c.text.includes('HUGE-END'));
  assert.ok(startChunk && endChunk, 'huge-line markers must survive the hard split');
  assert.equal(endChunk.index, startChunk.index + 1, 'hard-split pieces are consecutive chunks');
});
