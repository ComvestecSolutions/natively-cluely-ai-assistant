// P5 web search — pure, offline tests (node:test, built module). NO network: every
// fetch goes through a stubbed globalThis.fetch that is always restored.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/webSearch');
const loadModule = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const { parseDuckDuckGoHtml, buildDuckDuckGoUrl, resolveWebSearchSettings, webSearch } = await loadModule(
  'index.js',
);

// Realistic html.duckduckgo.com result page: five `.result` blocks —
//   #1 plain href, snippet with &amp; entity + em dash (decoded from &#8212;)
//   #2 DDG redirector link /l/?uddg=<encoded> (+ tracking params) and a <b>-wrapped snippet
//   #3 plain href, snippet mixing named + numeric entities and inline tags
//   #4 minimal valid result
//   #5 nav anchor with .result__a class but NO href → must be dropped
const FIXTURE_HTML = [
  '<!DOCTYPE html><html><head><title>search results - DuckDuckGo</title></head><body id="web_main">',
  '<div class="results--main">',
  '<div class="result results_links result--data">',
  '  <h2 class="result__title"><a rel="nofollow" href="https://cheerio.js.org/guide/" class="result__a">Cheerio — a fast, forgiving <span>HTML parser</span></a></h2>',
  '  <div class="result__snippet-container"><a rel="nofollow" href="https://cheerio.js.org/guide/" class="result__snippet js_sp_result">A rich, forgiving &amp; familiar DOM API for node.js — inspired by jQuery.</a></div>',
  '</div>',
  '<div class="result results_links result--data">',
  '  <h2 class="result__title"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2FWikipedia%3APage_One&amp;page=4&amp;q=cheerio&rut=abc-123" class="result__a">Wikipedia:Page One — Wikipedia</a></h2>',
  '  <div class="result__snippet-container"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2FWikipedia%3APage_One&amp;page=4" class="result__snippet js_sp_result">Wikipedia has a dedicated page for the <b>first</b> article ever published.</a></div>',
  '</div>',
  '<div class="result results_links result--data">',
  '  <h2 class="result__title"><a rel="nofollow" href="https://nodejs.org/api/http.html" class="result__a">http — Node.js Documentation</a></h2>',
  '  <div class="result__snippet-container"><a rel="nofollow" href="https://nodejs.org/api/http.html" class="result__snippet js_sp_result">Low level HTTP client API for both request &amp; response. The protocol is &quot;case-sensitive&quot; &#8212; see the full spec.</a></div>',
  '</div>',
  '<div class="result results_links result--data">',
  '  <h2 class="result__title"><a rel="nofollow" href="https://www.npmjs.com/package/cheerio" class="result__a">npm</a></h2>',
  '  <div class="result__snippet-container"><a class="result__snippet js_sp_result" href="https://www.npmjs.com/package/cheerio">The lightweight HTML parser for Node.</a></div>',
  '</div>',
  '<div class="result results_links result--data">',
  '  <h2 class="result__title"><a rel="nofollow" class="result__a js-sp_a">Nav without a target</a></h2>',
  '  <div class="result__snippet-container"></div>',
  '</div>',
  '</div></body></html>',
].join('\n');

const REAL_FETCH = globalThis.fetch;
after(() => {
  globalThis.fetch = REAL_FETCH;
});

function stubFetch(counters) {
  globalThis.fetch = async (url) => {
    counters.calls += 1;
    counters.lastUrl = String(url);
    return { ok: true, status: 200, text: async () => FIXTURE_HTML };
  };
}

const ENTITY_LEFTOVER = /&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);/;

test('parseDuckDuckGoHtml extracts clean hits, decodes uddg wrappers and entities', () => {
  const hits = parseDuckDuckGoHtml(FIXTURE_HTML);
  assert.ok(hits.length >= 4, `expected at least 4 valid hits, got ${hits.length}`);
  assert.equal(hits.length, 4, 'the href-less nav anchor must be dropped');

  for (const h of hits) {
    assert.match(h.url, /^https?:\/\//i, `url must be absolute http(s): ${h.url}`);
    assert.ok(!h.title.includes('<'), `title contains a raw tag: ${JSON.stringify(h.title)}`);
    assert.ok(!ENTITY_LEFTOVER.test(h.title), `title has entity leftovers: ${JSON.stringify(h.title)}`);
    assert.ok(!h.snippet.includes('<'), `snippet contains a raw tag: ${JSON.stringify(h.snippet)}`);
    assert.ok(!ENTITY_LEFTOVER.test(h.snippet), `snippet has entity leftovers: ${JSON.stringify(h.snippet)}`);
    assert.match(h.title, /\S/, 'title must be non-empty');
  }

  // The uddg-wrapped href must decode to the real target (tracking params gone).
  const wiki = hits.find((h) => h.url.includes('en.wikipedia.org'));
  assert.ok(wiki, 'expected a wikipedia hit from the /l/?uddg= wrapper');
  assert.equal(wiki.url, 'https://en.wikipedia.org/Wikipedia:Page_One');

  // Named + numeric entities must be decoded to plain text.
  const node = hits.find((h) => h.url.startsWith('https://nodejs.org/'));
  assert.ok(node, 'expected the nodejs.org hit');
  assert.ok(node.snippet.includes('&'), '&amp; should decode to a bare ampersand: ' + JSON.stringify(node.snippet));
  assert.ok(!node.snippet.includes('&amp;'), 'raw &amp; must not survive parsing');
});

test('buildDuckDuckGoUrl escapes the query', () => {
  const q = 'electron web search?q=1&x="quoted"';
  const u = buildDuckDuckGoUrl(q);
  assert.equal(u, 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
});

test('resolveWebSearchSettings applies defaults and clamps', () => {
  const base = resolveWebSearchSettings(undefined);
  assert.equal(base.provider, 'duckduckgo');
  assert.equal(base.timeoutMs, 12000);
  assert.equal(base.enabled, true);
  assert.equal(base.searxngUrl, undefined);

  assert.equal(resolveWebSearchSettings({ timeoutMs: 100 }).timeoutMs, 5000, 'clamps up to the floor');
  assert.equal(resolveWebSearchSettings({ timeoutMs: 999_999 }).timeoutMs, 60000, 'clamps down to the ceiling');
  assert.equal(resolveWebSearchSettings({ timeoutMs: 'abc' }).timeoutMs, 12000, 'garbage falls back to default');

  assert.equal(resolveWebSearchSettings({ provider: 'bing' }).provider, 'duckduckgo', 'unknown provider → default');
  const sx = resolveWebSearchSettings({ provider: 'searxng', searxngUrl: 'http://localhost:8080/' });
  assert.equal(sx.provider, 'searxng');
  assert.equal(sx.searxngUrl, 'http://localhost:8080', 'trailing slash trimmed');

  assert.equal(resolveWebSearchSettings({ enabled: false }).enabled, false);
  assert.equal(resolveWebSearchSettings({ enabled: true }).enabled, true);
});

test('settings {enabled:false} short-circuits with zero fetches', async () => {
  const counters = { calls: 0 };
  stubFetch(counters);
  try {
    const res = await webSearch({ q: 'anything at all', settings: { enabled: false } });
    assert.deepEqual(res, { ok: false, error: 'web search is disabled' });
    assert.equal(counters.calls, 0, 'no fetch may be attempted when the feature is off');
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test('results are cached per lowercased query — second call never refetches', async () => {
  const counters = { calls: 0 };
  stubFetch(counters);
  try {
    const a = await webSearch({ q: 'Cache Probe', settings: {} });
    assert.equal(a.ok, true);
    assert.equal(a.provider, 'duckduckgo');
    assert.ok(String(counters.lastUrl).startsWith('https://html.duckduckgo.com/html/?q='));

    const b = await webSearch({ q: 'cache probe', settings: {} }); // different case → same cache key
    assert.equal(counters.calls, 1, 'the second call must be served from the cache');
    assert.deepEqual(b, a);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test('cache entries expire after the 10 minute TTL (via injected now)', async () => {
  const counters = { calls: 0 };
  stubFetch(counters);
  const T0 = 1_700_000_000_000;
  try {
    assert.equal((await webSearch({ q: 'ttl probe', settings: {}, now: T0 })).ok, true);
    assert.equal(counters.calls, 1);

    const within = await webSearch({ q: 'ttl probe', settings: {}, now: T0 + 9 * 60_000 });
    assert.ok(within.ok);
    assert.equal(counters.calls, 1, '9 minutes in → still fresh');

    const stale = await webSearch({ q: 'ttl probe', settings: {}, now: T0 + 11 * 60_000 });
    assert.ok(stale.ok);
    assert.equal(counters.calls, 2, 'past the TTL the query must be refetched');
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});
