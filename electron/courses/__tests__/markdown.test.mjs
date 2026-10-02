/**
 * Markdown converter — P1 lesson-page HTML → clean markdown (node:test, built module).
 * Run via `npm test` (builds electron → dist-electron first) or standalone after building:
 *   node --test electron/courses/__tests__/markdown.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { htmlToCourseMarkdown, stripCourseFrontmatter } = await import(
  pathToFileURL(path.join(distRoot, 'markdown.js')).href
);

const BASE_URL = 'https://learn.microsoft.com/en-us/training/units/sample-unit/';
const IMG_SRC = '/content/media/pic.png';
// Root-relative srcs resolve against the origin (WHATWG URL), not the base path.
const EXPECTED_IMG = `https://learn.microsoft.com${IMG_SRC}`;

// One compact lesson page: chrome that must vanish, a heading + paragraph with entities,
// a nested list, a 2x3 table (header + separator), a fenced code block, one relative image
// (resolved via baseUrl).
const FIXTURE_HTML = [
  '<html><body>',
  '  <nav class="chrome">SKIPME_NAV_JUNK</nav>',
  '  <header>SKIPME_HEADER_JUNK</header>',
  '  <h2>Sample lesson &amp; title</h2>',
  '  <p>Lead text with <strong>bold</strong> and an ampersand &amp; co.</p>',
  '  <ul><li>first item<ul><li>nested child</li></ul></li><li>second item</li></ul>',
  '  <table><tr><th>Name</th><th>Role</th><th>Note</th></tr>',
  '    <tr><td>a</td><td>b</td><td>c &amp; d</td></tr>',
  '    <tr><td>e</td><td>f</td><td>g</td></tr>',
  '  </table>',
  '  <pre class="language-typescript"><code>const x = 1;</code></pre>',
  `  <img src="${IMG_SRC}" alt="diagram">`,
  '  <form hidden><input type="hidden" name="t"></form>',
  '</body></html>',
].join('\n');

test('strips chrome, decodes entities, and contains no raw HTML', () => {
  const res = htmlToCourseMarkdown(FIXTURE_HTML, BASE_URL);
  assert.equal(res.markdown.includes('<'), false, 'markdown must never contain "<"');
  assert.ok(!res.markdown.includes('SKIPME_NAV_JUNK'), 'nav content must be stripped');
  assert.ok(!res.markdown.includes('SKIPME_HEADER_JUNK'), 'header content must be stripped');
  assert.equal(res.markdown.includes('&amp;'), false, '&amp; must be decoded to &');
  assert.ok(res.markdown.includes('&'), 'decoded ampersand kept as literal &');
});

test('keeps headings, paragraphs and nested lists as markdown', () => {
  const { markdown } = htmlToCourseMarkdown(FIXTURE_HTML, BASE_URL);
  assert.ok(markdown.includes('## Sample lesson & title'));
  assert.ok(markdown.includes('Lead text with **bold**'), 'strong kept inline');
  assert.ok(markdown.includes('- first item'));
  assert.ok(markdown.includes('  - nested child'), 'nested list keeps indentation');
  assert.ok(markdown.includes('- second item'));
});

test('renders tables as pipe tables with header separator', () => {
  const { markdown } = htmlToCourseMarkdown(FIXTURE_HTML, BASE_URL);
  assert.ok(markdown.includes('| Name | Role | Note |'), 'header row');
  assert.ok(markdown.includes('| --- | --- | --- |'), 'separator row');
  assert.ok(markdown.includes('| a | b | c & d |'), 'cells HTML-stripped, entity decoded');
  assert.ok(markdown.includes('| e | f | g |'));
});

test('fences code blocks with the class language hint', () => {
  const { markdown } = htmlToCourseMarkdown(FIXTURE_HTML, BASE_URL);
  assert.ok(markdown.includes('```typescript\nconst x = 1;\n```'));
});

test('collects images in document order, resolved against baseUrl', () => {
  const res = htmlToCourseMarkdown(FIXTURE_HTML, BASE_URL);
  const hits = res.images.filter((url) => url === EXPECTED_IMG).length;
  assert.equal(hits, 1, `relative src resolved to ${EXPECTED_IMG} exactly once`);
  assert.ok(res.markdown.includes(`![diagram](${EXPECTED_IMG})`), 'image kept inline in markdown');
});

test('without baseUrl the relative img src is preserved for ingest', () => {
  const res = htmlToCourseMarkdown(FIXTURE_HTML);
  assert.ok(res.images.includes(IMG_SRC));
  assert.ok(res.markdown.includes(`![diagram](${IMG_SRC})`));
});

// stripCourseFrontmatter (plan §7 on-disk lesson header): strips for LF/CRLF, echoes otherwise.

test('stripCourseFrontmatter removes an LF front-matter header plus one leading blank line', () => {
  const raw = [
    '---',
    'title: "Unit 1"',
    'url: https://example.test/lesson',
    'contentHash: sha1:abc',
    '---',
    '',
    '# Body title',
    'para',
  ].join('\n');
  assert.equal(stripCourseFrontmatter(raw), '# Body title\npara');
});

test('stripCourseFrontmatter removes a CRLF front-matter header (with and without blank line after)', () => {
  const withBlank = ['---', 'title: "Unit 1"', 'order: 1', '---', '', '# Body'].join('\r\n');
  assert.equal(stripCourseFrontmatter(withBlank), '# Body');
  const tight = ['---', 'order: 1', '---', '# Body'].join('\r\n');
  assert.equal(stripCourseFrontmatter(tight), '# Body');
});

test('stripCourseFrontmatter echoes text without a complete header', () => {
  assert.equal(stripCourseFrontmatter('# Just markdown'), '# Just markdown');
  const notClosed = '---\nnot closed yet\nmore keys';
  assert.equal(stripCourseFrontmatter(notClosed), notClosed);
});

test('stripCourseFrontmatter leaves a header whose closer lands past line 30 untouched', () => {
  const lines = ['---'];
  for (let i = 1; i <= 29; i += 1) lines.push(`key${i}: v${i}`); // the --- below is line 31
  lines.push('---', 'body');
  const raw = lines.join('\n');
  assert.equal(stripCourseFrontmatter(raw), raw);
});
