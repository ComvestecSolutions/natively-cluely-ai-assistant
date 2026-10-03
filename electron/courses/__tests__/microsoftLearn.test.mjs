/**
 * Microsoft Learn profile — P1 ingestion planner (node:test, no real network).
 *
 * All HTTP goes through an in-memory fake keyed by URL. Run via `npm test`
 * (builds electron → dist-electron first) or standalone after building:
 *   node --test electron/courses/__tests__/microsoftLearn.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { planMicrosoftLearn } = await import(
  pathToFileURL(path.join(distRoot, 'profiles/microsoftLearn.js')).href
);

const ORIGIN = 'https://learn.microsoft.com';
const CREDENTIAL_URL = `${ORIGIN}/en-us/credentials/certifications/ai-agent-builder-associate/?practice-assessment-type=certification`;
const TOC_A_URL = `${ORIGIN}/api/tocs/microsoft-ai-fundamentals.toc.json`;
const TOC_B_URL = `${ORIGIN}/api/tocs/missing-path.toc.json`;
// Keyless certification detail endpoint for the hub-shaped CREDENTIAL_URL (slug = last path segment).
const DETAIL_URL = `${ORIGIN}/api/certification/certification.ai-agent-builder-associate/detail`;
// Legacy toc.json fallback location when a hub page has zero learning-path links.
const TOC_FALLBACK_URL = `${ORIGIN}/en-us/credentials/certifications/ai-agent-builder-associate/toc.json`;
// A NON-hub credential root: legacy static discovery must behave exactly as before the hub change.
const NONHUB_ROOT = `${ORIGIN}/en-us/credentials/skill-assessments/js-data-modeling/`;

// (a) Credential landing page with two learning-path links to path A (relative + absolute/query
// variants, exercising link dedupe) and one link whose TOC will 404.
function credentialHtml() {
  return `<!doctype html><html><head><title>AI Agent Builder Associate</title></head><body>
    <h1>Certification details</h1>
    <a href="/en-us/learn/learning-paths/microsoft-ai-fundamentals/">Microsoft AI Fundamentals (relative)</a>
    <a href="https://learn.microsoft.com/en-us/learn/learning-paths/microsoft-ai-fundamentals/?tabs=azure-cli">Same path, absolute + query</a>
    <a href="/en-us/learn/learning-paths/missing-path/">Missing Path (TOC 404)</a>
    <a href="https://docs.microsoft.com/en-us/azure/architecture/reference-docs/modeling.pdf">Not a learning path</a>
    <a href="#top">Fragment only</a>
  </body></html>`;
}

// (b) Small TOC: welcome lesson, one module with 3 lesson entries (incl. a duplicate unit-1 link),
//     one practice-assessment entry, and one cross-host reference PDF.
function tocA() {
  return JSON.stringify({
    children: [
      { metadata: { title: 'Welcome to AI Fundamentals', href: '/en-us/learn/microsoft-ai-fundamentals/welcome/' } },
      {
        metadata: { title: 'Module 1 — Models', href: '/en-us/training/paths/microsoft-ai-fundamentals/modules/models-intro/', contentType: 'Page' },
        children: [
          { metadata: { title: 'Unit 1: What is generative AI?', href: '/en-us/learn/microsoft-ai-fundamentals/unit-1/' } },
          { metadata: { title: 'Unit 2: Model types', href: '/en-us/learn/microsoft-ai-fundamentals/unit-2/?tabs=vscode' } },
          { metadata: { title: 'Unit 1 (duplicate link)', href: 'https://learn.microsoft.com/en-us/learn/microsoft-ai-fundamentals/unit-1/' } },
        ],
      },
      { metadata: { title: 'Certification practice test', href: '/en-us/practice-assessment/general/sk-9002/?assessmentId=e3f7b4a1&practice-assessment-type=certification' } },
      { metadata: { title: 'Azure reference PDF', href: 'https://docs.microsoft.com/en-us/azure/architecture/reference-docs/modeling.pdf' } },
    ],
  });
}

// Credential page whose curriculum is JS-rendered — zero learning-path links in the static HTML.
function jsRenderedCredentialHtml() {
  return `<!doctype html><html><head><title>AI Agent Builder Associate</title></head><body>
    <h1>Certification details (rendered client-side)</h1>
    <a href="https://docs.microsoft.com/en-us/azure/architecture/reference-docs/modeling.pdf">Not a learning path</a>
  </body></html>`;
}

// Abridged live shape of the keyless certification detail endpoint: two curriculum paths, the first
// with 2 modules x 2 units (relative, query-bearing and already-locale-prefixed unit urls), the
// second with a module that lists no units at all.
function detailPayload() {
  return JSON.stringify({
    careerPaths: [],
    course: { title: 'AI agent solutions', uid: 'course.ab-x00', url: '/training/courses/ab-x00/' },
    prerequisites: [],
    courseStudyGuide: {
      type: 'studyguide',
      moduleCount: 3,
      items: [
        {
          id: 'learn.path-one',
          type: 'path',
          data: {
            title: 'Foundations of AI agents',
            url: '/training/paths/path-one/',
            modules: [
              { url: '/training/modules/mod-a/', units: [
                { url: '/training/modules/mod-a/intro/', title: 'A1 Intro' },
                { url: '/training/modules/mod-a/build/?tabs=vscode', title: 'A2 Build' },
              ] },
              { url: 'https://learn.microsoft.com/training/modules/mod-b/', units: [
                { url: '/training/modules/mod-b/deploy/', title: 'B1 Deploy' },
                { url: 'https://learn.microsoft.com/en-us/training/modules/mod-b/test/?pivots=frame', title: 'B2 Test' },
              ] },
            ],
          },
        },
        {
          id: 'learn.path-two',
          type: 'path',
          data: {
            title: 'Agent patterns',
            url: '/training/paths/path-two/',
            modules: [{ url: '/training/modules/mod-c/' }], // deliberately no units key
          },
        },
      ],
    },
  });
}

/** In-memory fake CourseHttpClient; records every requested URL for assertion. */
function makeHttp(routes) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(String(url));
      const hit = routes.get(String(url));
      assert.ok(hit, `unexpected fetch in fake http client: ${url}`);
      return { status: hit.status, body: hit.body };
    },
  };
}

test('planMicrosoftLearn builds an ordered, deduped plan with mapped kinds', async () => {
  const http = makeHttp(new Map([
    // CREDENTIAL_URL is hub-shaped → detail endpoint is consulted first; empty here, so the
    // legacy TOC discovery below runs exactly as before.
    [DETAIL_URL, { status: 200, body: '' }],
    [CREDENTIAL_URL, { status: 200, body: credentialHtml() }],
    [TOC_A_URL, { status: 200, body: tocA() }],
    [TOC_B_URL, { status: 404, body: 'not found' }],
  ]));

  const result = await planMicrosoftLearn(CREDENTIAL_URL, http);
  const items = result.items;

  // Shape: 7 TOC entries minus one deduped lesson link.
  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['lesson', 'lesson', 'lesson', 'lesson', 'assessment', 'reference'],
  );

  // Ordering preserved (teaching order) and indexes are dense from 0.
  const titles = items.map((i) => i.title);
  assert.deepEqual(titles, [
    'Welcome to AI Fundamentals',
    'Module 1 — Models',
    'Unit 1: What is generative AI?',
    'Unit 2: Model types',
    'Certification practice test',
    'Azure reference PDF',
  ]);
  assert.deepEqual(items.map((i) => i.index), [0, 1, 2, 3, 4, 5]);

  // Dedupe by url: unit-1 (relative vs absolute variants) appears exactly once.
  const unit1 = items.filter((i) => new URL(i.url).pathname.replace(/\/+$/, '') === '/en-us/learn/microsoft-ai-fundamentals/unit-1');
  assert.equal(unit1.length, 1);
  assert.deepEqual(new Set(items.map((i) => i.id)).size, items.length, 'ids are unique');

  // Assessment kept as external link card with its deep-link query intact.
  const assessment = items[4];
  assert.ok(assessment.url.includes('/practice-assessment/'));
  assert.ok(assessment.url.includes('assessmentId=e3f7b4a1'));

  // Module nesting: units carry the module id; top-level entries do not.
  assert.equal(typeof items[2].moduleId, 'string');
  assert.equal(items[2].moduleId, items[3].moduleId);
  assert.equal(items[0].moduleId, undefined);
  assert.equal(items[1].moduleId, undefined);

  // Hub-shaped root: detail endpoint consulted first (empty body → curriculum warning), then the
  // legacy scan runs. Duplicate learning-path links fetched one TOC; the 404 sub-TOC is a warning,
  // not a throw.
  assert.equal(http.calls[0], DETAIL_URL);
  assert.ok(http.calls.includes(CREDENTIAL_URL));
  assert.equal(http.calls.filter((c) => c === TOC_A_URL).length, 1);
  assert.deepEqual(result.warnings, [
    `${DETAIL_URL} returned an empty body; certification ai-agent-builder-associate curriculum not available; falling back to static discovery`,
    `${TOC_B_URL} → HTTP 404; sub-TOC skipped`,
  ]);
});

test('root page HTTP failure yields an empty plan with a warning, never throws', async () => {
  const http = makeHttp(new Map([
    [DETAIL_URL, { status: 404, body: 'not found' }],
    [CREDENTIAL_URL, { status: 404, body: 'nope' }],
  ]));
  const result = await planMicrosoftLearn(CREDENTIAL_URL, http);
  assert.deepEqual(result.items, []);
  assert.equal(http.calls.length, 2); // hub detail attempt first, then the (failed) credential page fetch
  assert.ok(result.warnings.some((w) => w.includes('HTTP 404')));
});

test('invalid course URL is rejected with a warning, never throws', async () => {
  const http = makeHttp(new Map());
  const result = await planMicrosoftLearn('not-a-url', http);
  assert.deepEqual(result.items, []);
  assert.equal(http.calls.length, 0);
  assert.ok(result.warnings.some((w) => w.includes('invalid course URL')));
});

// (a) Hub root + a valid synthetic detail payload: the plan is built EXCLUSIVELY from that payload.
test('hub root: plan built exclusively from the detail payload, assessment appended last', async () => {
  const http = makeHttp(new Map([[DETAIL_URL, { status: 200, body: detailPayload() }]]));
  const result = await planMicrosoftLearn(CREDENTIAL_URL, http);
  const items = result.items;

  // The static scan is skipped once the detail endpoint succeeds — exactly one request.
  assert.deepEqual(http.calls, [DETAIL_URL]);

  // path1 = 2 modules x 2 units → 4 lessons in payload (array) order; path2 contributes none.
  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['lesson', 'lesson', 'lesson', 'lesson', 'assessment'],
  );
  assert.deepEqual(
    items.map((i) => i.title),
    ['A1 Intro', 'A2 Build', 'B1 Deploy', 'B2 Test', 'Practice assessment — AI agent solutions'],
  );
  assert.deepEqual(items.map((i) => i.index), [0, 1, 2, 3, 4]);

  // Every lesson url is origin-normalized with the /en-us prefix and under /training/.
  const lessons = items.filter((i) => i.kind === 'lesson');
  for (const lesson of lessons) {
    assert.ok(lesson.url.startsWith(`${ORIGIN}/en-us/`), `expected ${ORIGIN}/en-us/...: ${lesson.url}`);
    assert.ok(lesson.url.includes('training/'), `expected a /training/ url: ${lesson.url}`);
  }
  // Locale-less data urls gained the prefix; query strings and pre-existing /en-us/ are preserved.
  assert.equal(lessons[0].url, `${ORIGIN}/en-us/training/modules/mod-a/intro/`);
  assert.ok(lessons[1].url.endsWith('/build/?tabs=vscode'));
  assert.equal(lessons[3].url, `${ORIGIN}/en-us/training/modules/mod-b/test/?pivots=frame`);

  // moduleId groups units by module slug — present on every lesson.
  for (const lesson of lessons) assert.equal(typeof lesson.moduleId, 'string');
  assert.deepEqual(lessons.map((i) => i.moduleId), ['mod-a', 'mod-a', 'mod-b', 'mod-b']);

  // The degraded path is reported; nothing else was warned about.
  assert.deepEqual(result.warnings, ['Agent patterns: no units listed']);

  // Exactly one assessment item, LAST, pointing at the user's original root string verbatim
  // (its ?practice-assessment-type=certification query selects the hub page itself).
  const assessments = items.filter((i) => i.kind === 'assessment');
  assert.equal(assessments.length, 1);
  assert.equal(items[items.length - 1].kind, 'assessment');
  assert.equal(assessments[0].url, CREDENTIAL_URL);
});

// (b) Hub root + HTTP 200 with EMPTY BODY: legacy discovery still runs; warning mentions the slug.
test('hub root with empty detail body falls back to legacy discovery without throwing', async () => {
  const http = makeHttp(new Map([
    [DETAIL_URL, { status: 200, body: '' }], // unknown slug ⇒ HTTP 200 + EMPTY BODY
    [CREDENTIAL_URL, { status: 200, body: jsRenderedCredentialHtml() }],
    [TOC_FALLBACK_URL, { status: 404, body: 'not found' }],
  ]));

  const result = await planMicrosoftLearn(CREDENTIAL_URL, http);

  // Legacy discovery ran to the toc.json fallback and planned nothing from it.
  assert.deepEqual(result.items, []);
  assert.equal(http.calls[0], DETAIL_URL);
  assert.ok(http.calls.includes(TOC_FALLBACK_URL));
  const slugWarning = result.warnings.find(
    (w) => w.includes('certification ai-agent-builder-associate') && w.toLowerCase().includes('curriculum not available'),
  );
  assert.ok(slugWarning, `expected a curriculum warning, got: ${JSON.stringify(result.warnings)}`);
});

// (c) Hub root + detail fetch rejects (network error): same fall-through guarantee.
test('hub root with detail-fetch network error falls back to legacy discovery without throwing', async () => {
  const routes = new Map([
    [CREDENTIAL_URL, { status: 200, body: jsRenderedCredentialHtml() }],
    [TOC_FALLBACK_URL, { status: 404, body: 'not found' }],
  ]);
  const calls = [];
  // The detail endpoint rejects (simulating a network failure); the rest behaves like (b).
  const http = {
    calls,
    async get(url) {
      const u = String(url);
      calls.push(u);
      if (u === DETAIL_URL) throw new Error('socket hang up');
      const hit = routes.get(u);
      assert.ok(hit, `unexpected fetch in fake http client: ${url}`);
      return { status: hit.status, body: hit.body };
    },
  };

  const result = await planMicrosoftLearn(CREDENTIAL_URL, http);

  assert.deepEqual(result.items, []);
  assert.equal(calls[0], DETAIL_URL); // hub endpoint attempted first ...
  assert.ok(calls.includes(TOC_FALLBACK_URL)); // ... then legacy discovery ran to the toc.json fallback
  const slugWarning = result.warnings.find(
    (w) => w.includes(`${DETAIL_URL} fetch failed`) && w.includes('certification ai-agent-builder-associate curriculum not available'),
  );
  assert.ok(slugWarning, `expected a network-error curriculum warning, got: ${JSON.stringify(result.warnings)}`);
});

// (d) Regression: a NON-hub credential root keeps the legacy static discovery path untouched —
//     the certification detail endpoint is never consulted.
test('non-hub credential root keeps legacy static discovery unchanged', async () => {
  const http = makeHttp(new Map([
    [NONHUB_ROOT, { status: 200, body: credentialHtml() }],
    [TOC_A_URL, { status: 200, body: tocA() }],
    [TOC_B_URL, { status: 404, body: 'not found' }],
  ]));

  const result = await planMicrosoftLearn(NONHUB_ROOT, http);

  // The certification detail endpoint is never requested for non-hub roots.
  assert.ok(!http.calls.some((c) => c.includes('/api/certification/')));
  assert.equal(http.calls[0], NONHUB_ROOT);

  // Same plan as before the hub change: TOC walk with dedupe, mapped kinds and module nesting.
  assert.equal(result.items.length, 6);
  assert.deepEqual(
    result.items.map((i) => i.kind),
    ['lesson', 'lesson', 'lesson', 'lesson', 'assessment', 'reference'],
  );
  assert.deepEqual(
    result.items.slice(0, 4).map((i) => i.title),
    ['Welcome to AI Fundamentals', 'Module 1 — Models', 'Unit 1: What is generative AI?', 'Unit 2: Model types'],
  );
  assert.equal(result.items[0].moduleId, undefined);
  assert.equal(typeof result.items[2].moduleId, 'string');
  assert.deepEqual(result.warnings, [`${TOC_B_URL} → HTTP 404; sub-TOC skipped`]);
});
