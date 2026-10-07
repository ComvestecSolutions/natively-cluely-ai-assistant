/**
 * Courses Studio — P1 course import orchestrator tests (node:test, no real network).
 *
 * E2E: runCourseImport against a :memory: CourseStore with fake text/buffer HTTP.
 * Unit: runPool scheduling/order/cancel and parseRobotsDisallows.
 * Run via `npm test` or standalone after building:
 *   node --test electron/courses/__tests__/ingest.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const [ingest, storeMod, durationMod] = await Promise.all([
  import(pathToFileURL(path.join(distRoot, 'ingest.js')).href),
  import(pathToFileURL(path.join(distRoot, 'courseStore.js')).href),
  import(pathToFileURL(path.join(distRoot, 'lessonDuration.js')).href),
]);
const { runCourseImport, runPool, parseRobotsDisallows, resolveRetryDelayMs } = ingest;
const { COURSES_SCHEMA_SQL, CourseStore } = storeMod;
const { getLessonDuration } = durationMod;

// Fixtures mirror the planner shapes proven in microsoftLearn.test.mjs.
const ORIGIN = 'https://learn.microsoft.com';
const CRED_URL = `${ORIGIN}/en-us/credentials/certifications/ms-ai-fundamentals/?practice-assessment-type=certification`;
const LP_SLUG = 'microsoft-ai-fundamentals';
const TOC_URL = `${ORIGIN}/api/tocs/${LP_SLUG}.toc.json`;
const ROBOTS_URL = `${ORIGIN}/robots.txt`;
const COURSE_ID = 'ms-fundamentals';
const unitUrl = (n) => `${ORIGIN}/en-us/learn/${LP_SLUG}/unit-${n}/`;
const T1 = 'Unit 1: What is generative AI?';
const T2 = 'Unit 2: Model types';
const T3 = 'Unit 3: Prompting patterns';
const IMG_URL = 'https://cdn.learn.microsoft.com/media/ms-ai/generative-ai-overview.png';

function credentialHtml() {
  return `<!doctype html><html><head><title>MS AI Fundamentals</title></head><body>` +
    `<a href="/en-us/learn/learning-paths/${LP_SLUG}/">Microsoft AI Fundamentals learning path</a>` +
    `<a href="https://docs.microsoft.com/en-us/decoy/architecture.pdf">Not a learning path</a>` +
    `</body></html>`;
}

function tocJson() {
  return JSON.stringify({
    children: [
      { metadata: { title: T1, href: `/en-us/learn/${LP_SLUG}/unit-1/` } },
      { metadata: { title: T2, href: `/en-us/learn/${LP_SLUG}/unit-2/` } },
      { metadata: { title: T3, href: `/en-us/learn/${LP_SLUG}/unit-3/` } },
    ],
  });
}

function lessonHtml(title, extra = '') {
  return `<!doctype html><html><head><title>${title}</title></head>` +
    `<body><h1>${title}</h1><p>Body copy for this unit.</p>${extra}</body></html>`;
}

/** In-memory fake client (text or bytes) keyed by URL, recording every request. */
function makeHttp(routes) {
  const calls = [];
  return {
    calls,
    get(url) {
      calls.push(String(url));
      const hit = routes.get(String(url));
      if (!hit) throw new Error(`fake http: unexpected fetch ${url}`);
      return Promise.resolve({ status: hit.status ?? 200, body: hit.body });
    },
  };
}

/** Fake client serving queued responses per URL (last response repeats when exhausted). */
function makeQueuedHttp(routes) {
  const calls = [];
  const index = new Map();
  return {
    calls,
    get(url) {
      url = String(url);
      calls.push(url);
      const queue = routes.get(url);
      if (!queue || queue.length === 0) throw new Error(`fake http: unexpected fetch ${url}`);
      // Serve the current response first; only then advance for the next call.
      const n = index.get(url) ?? 0;
      if (n < queue.length - 1) index.set(url, n + 1);
      const step = queue[n];
      return Promise.resolve({ status: step.status ?? 200, body: step.body, headers: step.headers });
    },
  };
}

/** Single-item TOC so a test course plans exactly one page. */
function tocOne(title) {
  return JSON.stringify({ children: [{ metadata: { title, href: `/en-us/learn/${LP_SLUG}/unit-1/` } }] });
}

test('runCourseImport imports a learning path end-to-end (e2e)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-ingest-'));
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL);
  const store = new CourseStore(db);

  try {
    const http = makeHttp(new Map([
      [CRED_URL, { body: credentialHtml() }],
      [TOC_URL, { body: tocJson() }],
      [ROBOTS_URL, { body: 'User-agent: *\nDisallow: /private/\n' }],
      [unitUrl(1), { body: lessonHtml(T1, `<img src="${IMG_URL}" alt="overview">`).replace('</head>', '<meta name="lesson-duration" content="PT7M"></head>') }],
      [unitUrl(2), { status: 500, body: '<html><body>boom</body></html>' }],
      [unitUrl(3), { body: lessonHtml(T3, `<p>${'word '.repeat(401)}</p>`) }],
    ]));
    const httpBuffer = makeHttp(new Map([[IMG_URL, { body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }]]));
    const progress = [];

    const result = await runCourseImport(CRED_URL, COURSE_ID, {
      courseId: COURSE_ID,
      rootDir,
      store,
      delayMs: 0,
      retryDelayMs: 0,
      concurrency: 3,
      respectRobots: true,
      http,
      httpBuffer,
      onProgress: (p) => progress.push(p),
    });

    assert.deepEqual(result.stats, {
      planned: 3, succeeded: 2, failed: 1, skipped: 0,
      failures: [`${unitUrl(2)} — page fetch returned HTTP 500`],
    });

    // Only successful lessons are persisted, in teaching order.
    const lessons = store.listLessons(COURSE_ID);
    assert.equal(lessons.length, 2);
    assert.deepEqual(lessons.map((l) => l.url), [unitUrl(1), unitUrl(3)]);
    assert.deepEqual(lessons.map((l) => l.title), [T1, T3]);
    assert.ok(lessons.every((l) => l.kind === 'lesson'));

    // Course finalized as partial; stats live in the JSON column (failures included).
    const course = store.getCourse(COURSE_ID);
    assert.equal(course.status, 'partial');
    // Name derives from the root (credential) URL slug, not the learning-path slug.
    assert.equal(course.name, 'ms-ai-fundamentals');
    assert.equal(course.profile, 'microsoft-learn');
    assert.deepEqual(course.stats, {
      planned: 3, succeeded: 2, failed: 1, skipped: 0,
      failures: [`${unitUrl(2)} — page fetch returned HTTP 500`],
    });

    // L1 persisted with front matter and rewritten media refs; CDN host gone.
    const lessonPath = path.join(rootDir, COURSE_ID, 'lessons', 'unit-1.md');
    const md = fs.readFileSync(lessonPath, 'utf8');
    assert.ok(md.startsWith('---'), 'lesson markdown starts with front matter');
    assert.ok(md.includes(`course-media://${COURSE_ID}/assets/`), 'image rewritten to course-media protocol');
    assert.ok(!md.includes('cdn.learn.microsoft.com'), 'original image host removed from markdown');
    assert.match(md, /^lessonDuration: 7$/m, 'explicit HTML duration survives in front matter');
    assert.deepEqual(getLessonDuration(md), { minutes: 7, source: 'provided' });
    const unmarked = fs.readFileSync(path.join(rootDir, COURSE_ID, 'lessons', 'unit-3.md'), 'utf8');
    assert.doesNotMatch(unmarked, /^lessonDuration:/m, 'unmarked lesson is not stamped with an estimate');
    assert.match(unmarked, /Body copy for this unit/, 'unmarked body remains available for estimation');
    assert.deepEqual(getLessonDuration(unmarked), { minutes: 3, source: 'estimated' });
    assert.equal(fs.existsSync(path.join(rootDir, COURSE_ID, 'lessons', 'unit-2.md')), false);

    const assets = fs.readdirSync(path.join(rootDir, COURSE_ID, 'assets'));
    assert.ok(assets.length >= 1, 'at least one asset downloaded under rootDir/<courseId>/assets');

    // Progress: plan → per-item terminals keyed by title → done.
    assert.equal(progress[0].phase, 'plan');
    assert.equal(progress[0].total, 3);
    const terminal = progress.filter((p) => p.phase === 'page' && p.status);
    assert.equal(terminal.length, 3);
    const byTitle = {};
    for (const p of terminal) byTitle[p.current] = p.status;
    assert.deepEqual(byTitle, { [T1]: 'ok', [T2]: 'failed', [T3]: 'ok' });
    assert.ok(progress.some((p) => p.phase === 'assets' && p.current === T1), 'assets phase for the image lesson');
    assert.deepEqual(progress[progress.length - 1], { courseId: COURSE_ID, phase: 'done', done: 3, total: 3 });

    // Every planned item was attempted (guards pool index coverage) and robots consulted.
    for (const n of [1, 2, 3]) assert.ok(http.calls.includes(unitUrl(n)), `fetched unit-${n}`);
    assert.ok(http.calls.includes(ROBOTS_URL), 'fetched robots.txt when respectRobots set');

    // The failing page was retried exactly once.
    assert.equal(http.calls.filter((u) => u === unitUrl(2)).length, 2, 'failed page fetched twice (one retry)');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});

test('runCourseImport persists scoped body and time durations, not module totals or non-lesson durations', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-ingest-'));
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL);
  const store = new CourseStore(db);
  const assessmentUrl = `${ORIGIN}/en-us/learn/practice-assessment/`;
  const referenceUrl = `${ORIGIN}/reference/handbook.pdf`;
  const pages = [
    [unitUrl(1), lessonHtml(T1, '<p><strong>Unit duration:</strong> 4 minutes</p>')],
    [unitUrl(2), lessonHtml(T2, '<time class="lesson-duration" datetime="PT3M">3 min</time>')],
    [unitUrl(3), lessonHtml(T3, '<p>Read this lesson without a duration marker.</p>').replace('</head>', '<meta name="module-duration" content="40 min"><meta name="duration" content="50 min"><meta name="lesson-duration" content="999 min"></head>')],
    [assessmentUrl, lessonHtml('Practice', '<p><strong>Lesson duration:</strong> 8 min</p>')],
    [referenceUrl, lessonHtml('Reference', '<p><strong>Lesson duration:</strong> 6 min</p>')],
  ];
  try {
    const toc = JSON.stringify({ children: pages.map(([url], index) => ({ metadata: {
      title: `Item ${index + 1}`, href: url,
    } })) });
    const http = makeHttp(new Map([
      [CRED_URL, { body: credentialHtml() }],
      [TOC_URL, { body: toc }],
      ...pages.map(([url, body]) => [url, { body }]),
    ]));
    const { stats } = await runCourseImport(CRED_URL, COURSE_ID, {
      courseId: COURSE_ID, rootDir, store, http, concurrency: 1, delayMs: 0,
      retryDelayMs: 0, onProgress: () => {},
    });
    assert.equal(stats.succeeded, pages.length);
    const lessons = store.listLessons(COURSE_ID);
    assert.deepEqual(lessons.map((lesson) => lesson.kind),
      ['lesson', 'lesson', 'lesson', 'assessment', 'reference']);
    for (const [url, expected] of [[unitUrl(1), 4], [unitUrl(2), 3]]) {
      const markdown = fs.readFileSync(lessons.find((lesson) => lesson.url === url).localMdPath, 'utf8');
      assert.match(markdown, new RegExp(`^lessonDuration: ${expected}$`, 'm'));
      assert.deepEqual(getLessonDuration(markdown), { minutes: expected, source: 'provided' });
    }
    for (const url of [unitUrl(3), assessmentUrl, referenceUrl]) {
      const markdown = fs.readFileSync(lessons.find((lesson) => lesson.url === url).localMdPath, 'utf8');
      assert.doesNotMatch(markdown, /^lessonDuration:/m, `${url} must not receive a lesson duration`);
    }
    const unmarked = fs.readFileSync(lessons.find((lesson) => lesson.url === unitUrl(3)).localMdPath, 'utf8');
    assert.deepEqual(getLessonDuration(unmarked), { minutes: 1, source: 'estimated' });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});

test('runCourseImport preserves scoped duration on a generic course lesson, not a reference', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-ingest-'));
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL);
  const store = new CourseStore(db);
  const root = 'https://docs.example.com/course/';
  const lessonUrl = `${root}unit-one/`;
  const otherUrl = `${root}unit-two/`;
  const referenceUrl = `${root}handbook.pdf`;
  try {
    const http = makeHttp(new Map([
      ['https://docs.example.com/sitemap.xml', { body: `<urlset>${[lessonUrl, otherUrl, referenceUrl].map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>` }],
      [lessonUrl, { body: lessonHtml('Unit one').replace('</head>', '<meta name="unit-duration" content="5 minutes"></head>') }],
      [otherUrl, { body: lessonHtml('Unit two').replace('</head>', '<meta name="module-duration" content="25 minutes"></head>') }],
      [referenceUrl, { body: lessonHtml('Handbook').replace('</head>', '<meta name="lesson-duration" content="8 minutes"></head>') }],
    ]));
    const { stats } = await runCourseImport(root, 'generic-course', {
      courseId: 'generic-course', rootDir, store, http, concurrency: 1,
      delayMs: 0, retryDelayMs: 0, onProgress: () => {},
    });
    assert.equal(stats.succeeded, 3);
    const lessons = store.listLessons('generic-course');
    const saved = (url) => fs.readFileSync(lessons.find((lesson) => lesson.url === url).localMdPath, 'utf8');
    assert.match(saved(lessonUrl), /^lessonDuration: 5$/m);
    assert.deepEqual(getLessonDuration(saved(lessonUrl)), { minutes: 5, source: 'provided' });
    assert.doesNotMatch(saved(otherUrl), /^lessonDuration:/m);
    assert.deepEqual(getLessonDuration(saved(otherUrl)), { minutes: 1, source: 'estimated' });
    assert.equal(lessons.find((lesson) => lesson.url === referenceUrl).kind, 'reference');
    assert.doesNotMatch(saved(referenceUrl), /^lessonDuration:/m);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});

test('runPool keeps item order and bounds in-flight work', async () => {
  const calls = [];
  let inflight = 0;
  let peak = 0;
  await runPool([1, 2, 3, 4, 5], (item, index) => new Promise((resolve) => {
    calls.push(`${item}:${index}`);
    inflight += 1;
    peak = Math.max(peak, inflight);
    setImmediate(() => { inflight -= 1; resolve(); });
  }), { concurrency: 2, delayMs: 0 });
  assert.deepEqual(calls, ['1:0', '2:1', '3:2', '4:3', '5:4']);
  assert.equal(peak, 2);
});

test('runPool does not start items for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  await runPool([1, 2], () => { called += 1; return Promise.resolve(); }, { concurrency: 2, delayMs: 0, signal: controller.signal });
  assert.equal(called, 0);

  let emptyCalled = false;
  await runPool([], (x) => { emptyCalled = true; return Promise.resolve(); });
  assert.equal(emptyCalled, false);
});

test('parseRobotsDisallows extracts normalized Disallow prefixes', () => {
  const text = [
    '# comment line without a colon',
    'User-agent: *',
    'Disallow:',
    'Disallow:     ',
    'Allow: /open/',
    'Crawl-delay: 10',
    'disallow: /private/',
    'DISALLOW:no-leading-slash',
    'Disallow:/inline/ # trailing comment',
    'disallow:/private/',
  ].join('\r\n');
  assert.deepEqual(parseRobotsDisallows(text), ['/private/', '/no-leading-slash', '/inline/']);
});

test('runCourseImport retries a transiently failing page once and succeeds (e2e)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-ingest-'));
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL);
  const store = new CourseStore(db);

  try {
    const page = unitUrl(1);
    const http = makeQueuedHttp(new Map([
      [CRED_URL, [{ body: credentialHtml() }]],
      [TOC_URL, [{ body: tocOne(T1) }]],
      // First attempt is a transient 503; the single retry gets the real page.
      [page, [
        { status: 503, body: '<html><body>service unavailable</body></html>' },
        { body: lessonHtml(T1) },
      ]],
    ]));

    const result = await runCourseImport(CRED_URL, COURSE_ID, {
      courseId: COURSE_ID,
      rootDir,
      store,
      delayMs: 0,
      retryDelayMs: 0,
      respectRobots: false,
      http,
      onProgress: () => {},
    });

    // Succeeded exactly once after the retry; a clean run persists an empty failures list.
    assert.deepEqual(result.stats, { planned: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    assert.equal(http.calls.filter((u) => u === page).length, 2, 'page fetched twice (exactly one retry)');

    const course = store.getCourse(COURSE_ID);
    assert.equal(course.status, 'complete');
    assert.deepEqual(course.stats, { planned: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    assert.deepEqual(store.listLessons(COURSE_ID).map((l) => l.url), [page]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});

test('runCourseImport persists durable failure reasons after an exhausted retry (e2e)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-ingest-'));
  const db = new Database(':memory:');
  db.exec(COURSES_SCHEMA_SQL);
  const store = new CourseStore(db);

  try {
    const page = unitUrl(1);
    // Single queued response repeats, so the retry sees the same 404.
    const http = makeQueuedHttp(new Map([
      [CRED_URL, [{ body: credentialHtml() }]],
      [TOC_URL, [{ body: tocOne(T1) }]],
      [page, [{ status: 404, body: '<html><body>not found</body></html>' }]],
    ]));

    const result = await runCourseImport(CRED_URL, COURSE_ID, {
      courseId: COURSE_ID,
      rootDir,
      store,
      delayMs: 0,
      retryDelayMs: 0,
      respectRobots: false,
      http,
      onProgress: () => {},
    });

    assert.deepEqual(result.stats, {
      planned: 1, succeeded: 0, failed: 1, skipped: 0,
      failures: [`${page} — page fetch returned HTTP 404`],
    });
    const reason = result.stats.failures[0];
    assert.ok(reason.includes(page), 'failure reason names the URL');
    assert.ok(reason.includes('HTTP 404'), 'failure reason carries the status');
    assert.equal(http.calls.filter((u) => u === page).length, 2, 'page retried once before being counted failed');

    // Same reasons land in stats_json through the single finalize upsert.
    const course = store.getCourse(COURSE_ID);
    assert.equal(course.status, 'partial');
    assert.deepEqual(course.stats, result.stats);
    assert.deepEqual(store.listLessons(COURSE_ID), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});

test('resolveRetryDelayMs honors a bounded numeric Retry-After over the base delay', () => {
  assert.equal(resolveRetryDelayMs(undefined, 1500), 1500, 'no headers → base delay');
  assert.equal(resolveRetryDelayMs({}, 1500), 1500, 'empty headers → base delay');
  assert.equal(resolveRetryDelayMs({ 'retry-after': '2' }, 1500), 2000, 'seconds under the cap are used as-is');
  assert.equal(resolveRetryDelayMs({ 'RETRY-AFTER': '8' }, 1500), 8000, 'match is case-insensitive; exactly 8s honored');
  assert.equal(resolveRetryDelayMs({ 'retry-after': '9' }, 750), 750, '>8s falls back to the base delay');
  assert.equal(resolveRetryDelayMs({ 'retry-after': '-1' }, 300), 300, 'negative values fall back to the base delay');
  assert.equal(resolveRetryDelayMs({ 'retry-after': 'soon' }, 400), 400, 'non-numeric (HTTP-date) falls back to the base delay');
});
