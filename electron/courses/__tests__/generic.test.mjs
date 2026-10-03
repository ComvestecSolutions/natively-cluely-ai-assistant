// P5 generic profile — sitemap/crawl planner for non-Microsoft-Learn URLs (node:test, no real network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const loadModule = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const { parseSitemapLocs, filterCandidateLinks, planGeneric } = await loadModule('profiles/generic.js');

const ORIGIN = 'https://docs.example.com';
const ROOT = `${ORIGIN}/course/web-dev/`;
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;

test('parseSitemapLocs: keeps absolute http(s) locs, trims, decodes entities, dedupes, drops relatives/schemes', () => {
  const xml =
    '<?xml version="1.0"?>' +
    '<sitemapindex>' +
    '<sitemap><loc>https://docs.example.com/s.xml</loc></sitemap>' +
    '<sitemap><loc>  https://docs.example.com/c/b?x=1&amp;y=2 </loc></sitemap>' +
    '<sitemap><loc>/relative/path</loc></sitemap>' + // relative → dropped (not absolute)
    '<sitemap><loc>mailto:team@example.com</loc></sitemap>' + // non-http(s) scheme → dropped
    '<sitemap><loc>https://docs.example.com/s.xml</loc></sitemap>' + // duplicate → deduped
    'some <loc junk without a closing tag' +
    '</sitemapindex>';
  assert.deepEqual(parseSitemapLocs(xml), [
    'https://docs.example.com/s.xml',
    'https://docs.example.com/c/b?x=1&y=2', // &amp; decoded, whitespace trimmed
  ]);

  const big = '<urlset>' + Array.from({ length: 600 }, (_, n) => `<url><loc>https://big.example/i/${n}</loc></url>`).join('') + '</urlset>';
  const capped = parseSitemapLocs(big);
  assert.equal(capped.length, 500); // hard cap
  assert.equal(capped[0], 'https://big.example/i/0');
  assert.equal(capped[499], 'https://big.example/i/499');
});

test('filterCandidateLinks: drops cross-origin/fragments/binaries, keeps pdfs, dedupes collapsed paths, caps in order', () => {
  const base = [
    null, // explicit null tolerated
    '', // empty
    '   ', // whitespace-only
    '#top', // fragment-only
    'mailto:it@example.com',
    'javascript:void(0)',
    'https://other.example/page', // cross-origin
    '/img/logo.png', // binary image
    '/course/web-dev/diagram.svg', // binary (in-scope but still excluded)
    `${ORIGIN}/course/web-dev/handbook.pdf`, // pdf kept
    '/course/web-dev/start/', // dedupe group A
    '/course//web-dev//start', // same collapsed path as above → dropped
  ];
  const links = filterCandidateLinks(ROOT, base);
  assert.deepEqual(links, [
    { url: `${ORIGIN}/course/web-dev/handbook.pdf`, title: 'handbook.pdf' }, // raw decoded segment, extension kept
    { url: `${ORIGIN}/course/web-dev/start/`, title: 'start' },
  ]);

  const padded = [...base];
  for (let n = 0; n < 160; n += 1) padded.push(`/course/web-dev/p/${n}`);
  const capped = filterCandidateLinks(ROOT, padded);
  assert.equal(capped.length, 150); // hard cap after the 2 base keeps + 148 generated
  assert.ok(capped[0].url.endsWith('handbook.pdf'));
  assert.ok(capped[149].url === `${ORIGIN}/course/web-dev/p/147`); // order preserved

  // Unparseable/garbage root → empty, never throws.
  assert.deepEqual(filterCandidateLinks('not a url', ['/x']), []);
});

test('planGeneric: sitemap path yields >=3 items with correct kinds and stable ids (no page fetch)', async () => {
  const calls = [];
  const fakeHttp = {
    async get(url) {
      calls.push(String(url));
      if (url === SITEMAP_URL) {
        return {
          status: 200,
          body:
            '<?xml version="1.0"?><urlset>' +
            `<url><loc>${ORIGIN}/course/web-dev/lessons/getting-started</loc></url>` +
            `<url><loc>${ORIGIN}/course/web-dev/lessons/flexbox-layouts</loc></url>` +
            `<url><loc>https://cdn.example.com/assets/logo.png</loc></url>` + // cross-origin → excluded
            `<url><loc>/relative-only/page</loc></url>` + // relative loc → dropped
            `<url><loc>${ORIGIN}/course/web-dev/lessons/grid-in-depth</loc></url>` +
            `<url><loc>${ORIGIN}/course/web-dev/cheatsheet/api-reference.pdf</loc></url>` +
            '</urlset>',
        };
      }
      throw new Error(`fake http: unexpected fetch ${url}`); // proves STEP B is NOT used when the sitemap works
    },
  };

  const plan = await planGeneric(ROOT, fakeHttp);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], SITEMAP_URL);
  assert.ok(plan.items.length >= 3); // exactly 4 usable links survive filtering
  assert.deepEqual(
    plan.items.map((i) => [i.kind, i.id]),
    [
      ['lesson', 'generic:0:lessons-getting-started'],
      ['lesson', 'generic:1:lessons-flexbox-layouts'],
      ['lesson', 'generic:2:lessons-grid-in-depth'],
      ['reference', 'generic:3:cheatsheet-api-reference-pdf'], // .pdf → reference; '.' sanitized out of the slug
    ],
  );
  assert.deepEqual(
    plan.items.map((i) => i.index),
    [0, 1, 2, 3],
  );
  assert.equal(new Set(plan.items.map((i) => i.id)).size, plan.items.length); // unique ids
  assert.deepEqual(plan.warnings, []); // happy path: "warning none"
});

test('planGeneric: unusable sitemap falls back to the root page link list (scope-filtered lessons + pinned warning)', async () => {
  const calls = [];
  const fakeHttp = {
    async get(url) {
      calls.push(String(url));
      if (url === SITEMAP_URL) return { status: 404, body: '' }; // missing sitemap
      if (url === ROOT) {
        return {
          status: 200,
          body:
            '<html><body>' +
            `<a href="/course/web-dev/lessons/unit-one">Unit one</a>` +
            `<a href="${ORIGIN}/course/web-dev/glossary/">Glossary</a>` +
            `<a href="${ORIGIN}/course/other/start">Other course (out of scope)</a>` +
            '<a href="/course/web-dev/diagram.png">diagram</a>' + // binary → dropped
            '<a href="https://evil.example/x">external</a>' + // cross-origin → dropped
            '<a href="#top">top</a>' +
            '</body></html>',
        };
      }
      throw new Error(`fake http: unexpected fetch ${url}`);
    },
  };

  const plan = await planGeneric(ROOT, fakeHttp);

  assert.deepEqual(calls, [SITEMAP_URL, ROOT]);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(
    plan.items.map((i) => [i.kind, i.id, i.title]),
    [
      ['lesson', 'generic:0:lessons-unit-one', 'unit-one'],
      ['lesson', 'generic:1:web-dev-glossary', 'glossary'],
    ],
  );
  assert.deepEqual(plan.warnings, ['no usable sitemap found — imported 2 same-origin pages from linked list']);
});

test('planGeneric: non-http or unparseable roots return empty plans with warnings and no HTTP calls', async () => {
  let called = false;
  const neverClient = { get: async () => { called = true; return { status: 200, body: '' }; } };

  const ftp = await planGeneric('ftp://files.example.com/course.zip', neverClient);
  assert.deepEqual(ftp, { items: [], warnings: ['not an http(s) url'] });

  const garbage = await planGeneric('not a url at all'); // default client path is not exercised for invalid URLs
  assert.equal(garbage.items.length, 0);
  assert.match(garbage.warnings[0], /^invalid course URL:/);
  assert.equal(called, false);
});

test('planGeneric: total network failure never throws — empty plan with one warning per failed step', async () => {
  const failingClient = { get: async () => { throw new Error('ECONNRESET'); } };
  const plan = await planGeneric(ROOT, failingClient); // must resolve, not reject
  assert.equal(plan.items.length, 0);
  assert.deepEqual(plan.warnings, [
    'sitemap fetch failed (Error: ECONNRESET); falling back to the page\'s link list',
    'root page fetch failed (Error: ECONNRESET)',
  ]);
});
