/**
 * Course asset downloader — P1 (node:test, built module).
 * Run via `npm test` (builds electron → dist-electron first) or standalone after building:
 *   node --test electron/courses/__tests__/assets.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { downloadCourseAssets, assetSafeName } = await import(
  pathToFileURL(path.join(distRoot, 'assets.js')).href
);

const sha6 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);

/** Fake AssetHttpClient: exact-url routes, records every call in order. */
function makeHttp(routes) {
  const calls = [];
  return {
    calls,
    async getBuffer(url) {
      calls.push(url);
      assert.ok(url in routes, `fake http: no route for ${url}`);
      return routes[url];
    },
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-assets-'));
after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('assetSafeName sanitizes the last segment and pins it with 6-hex sha1', () => {
  const u = 'https://cdn.example.com/media/my%20cool file.png?w=900';
  assert.equal(assetSafeName(u), `my_cool_file-${sha6(u)}.png`);

  // Same stem, different host → different suffix (cross-host uniqueness).
  const u2 = 'https://other.example/zzz/my cool file.png';
  assert.notEqual(assetSafeName(u), assetSafeName(u2));

  const bare = assetSafeName('https://h.io/files/notes-v2'); // no extension
  assert.match(bare, /^notes\-v2\-[0-9a-f]{6}$/);

  assert.match(assetSafeName('http://h.io'), /^asset-[0-9a-f]{6}$/); // no segment at all

  // 80-char cap on the sanitized part: extension survives, base is chopped.
  const u3 = `https://t.io/${'A'.repeat(120)}.pdf`;
  assert.equal(assetSafeName(u3), `${'A'.repeat(76)}-${sha6(u3)}.pdf`);
});

test('downloads into <courseId>/assets and maps url → assets/<name>', async () => {
  const img = 'https://cdn.example.com/media/pic one.png';
  const pdf = 'http://docs.example.com/a/b/white paper.pdf';
  const dead = 'https://cdn.example.com/gone.jpg';
  const dataUrl = 'data:text/plain,hello';

  const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // binary on purpose
  const http = makeHttp({
    [img]: { status: 200, body: imgBytes },
    [pdf]: { status: 206, body: new Uint8Array(5).fill(9) },
    [dead]: { status: 404, body: new Uint8Array(0) },
  });

  const res = await downloadCourseAssets([img, dataUrl, img, pdf, dead], http, { courseId: 'c-b', rootDir: root });

  assert.deepEqual(http.calls, [img, pdf, dead]); // deduped; non-http skipped
  assert.equal(res.map[img], `assets/${assetSafeName(img)}`);
  assert.equal(res.map[pdf], `assets/${assetSafeName(pdf)}`);
  assert.equal(Object.keys(res.map).length, 2);
  assert.equal(res.map[dataUrl], undefined);

  const imgPath = path.join(root, 'c-b', 'assets', assetSafeName(img));
  assert.deepEqual(Buffer.from(await fsp.readFile(imgPath)), Buffer.from(imgBytes)); // binary round-trip

  assert.deepEqual(res.failed, [{ url: dead, reason: 'HTTP 404' }]);
  assert.ok(!fs.existsSync(path.join(root, 'c-b', 'assets', assetSafeName(dead))));
});

test('second run hits no network; a pre-existing zero-byte file IS re-downloaded', async () => {
  const a = 'https://m.example.com/one.webp';
  const b = 'https://m.example.com/two.gif';
  const opts = { courseId: 'c-c', rootDir: root };

  // Empty stub for B on disk: size > 0 is what counts as "already downloaded".
  await fsp.mkdir(path.join(root, 'c-c', 'assets'), { recursive: true });
  await fsp.writeFile(path.join(root, 'c-c', 'assets', assetSafeName(b)), '');

  const mk = () => makeHttp({
    [a]: { status: 200, body: new Uint8Array(64).fill(1) },
    [b]: { status: 200, body: new Uint8Array(32).fill(7) },
  });

  const h1 = mk();
  const r1 = await downloadCourseAssets([a, b], h1, opts);
  assert.deepEqual(h1.calls, [a, b]); // B was empty → still fetched
  assert.equal(r1.failed.length, 0);

  const fileB = path.join(root, 'c-c', 'assets', assetSafeName(b));
  assert.equal((await fsp.stat(fileB)).size, 32); // stub replaced with real bytes
  const beforeB = (await fsp.readFile(fileB)).toString('hex');

  const h2 = mk();
  const r2 = await downloadCourseAssets([a, b], h2, opts);
  assert.equal(h2.calls.length, 0); // fully idempotent: zero network, zero rewrites
  assert.deepEqual(r2.map, r1.map);
  assert.equal((await fsp.readFile(fileB)).toString('hex'), beforeB);
});

test('stops at the byte budget and marks remaining urls "budget"', async () => {
  const u = (n) => `https://b.example.com/big-${n}.png`;
  const body = () => new Uint8Array(64).fill(0x61);
  const http = makeHttp({ [u(1)]: { status: 200, body: body() }, [u(2)]: { status: 200, body: body() }, [u(3)]: { status: 200, body: body() } });

  const res = await downloadCourseAssets([u(1), u(2), u(3)], http, { courseId: 'c-d', rootDir: root, maxBytes: 100 });

  assert.equal(res.map[u(1)], `assets/${assetSafeName(u(1))}`); // 64 ≤ 100
  assert.deepEqual(res.failed, [
    { url: u(2), reason: 'budget' }, // 64 + 64 > 100 → stop here…
    { url: u(3), reason: 'budget' }, // …and skip the rest without fetching
  ]);
  // big-2 is fetched (size unknown until then) but not written; big-3 never fetched.
  assert.deepEqual(http.calls, [u(1), u(2)]);
  assert.ok(!fs.existsSync(path.join(root, 'c-d', 'assets', assetSafeName(u(2)))));
});
