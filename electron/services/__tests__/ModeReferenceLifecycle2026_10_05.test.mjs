// Executes the production upload bundle, database facade and hybrid index with
// only the embedding provider / Electron shell mocked. Private premium modules
// deliberately remain unavailable. Run after build:electron:core-smoke using
// ELECTRON_RUN_AS_NODE=1 electron --test (better-sqlite3's Electron ABI).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bundlePath = path.join(root, 'dist-electron/electron/services/ModeReferenceFileIngestion.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');
const previousUserData = process.env.NATIVELY_TEST_USERDATA;
const resources = [];
const previousRerank = process.env.NATIVELY_RAG_LOCAL_RERANK;
process.env.NATIVELY_RAG_LOCAL_RERANK = '0';
after(() => {
  if (previousRerank === undefined) delete process.env.NATIVELY_RAG_LOCAL_RERANK;
  else process.env.NATIVELY_RAG_LOCAL_RERANK = previousRerank;
});
const SPACE = 'test:ordinary-upload:4';
const TEXT = 'enterprise plan pricing includes SSO support and audit logs. The renewal notice period is 47 days.';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pipeline({ ready = true, held, fail = false, space = SPACE } = {}) {
  const calls = { chunks: 0, query: 0 };
  return {
    calls,
    isReady: () => ready,
    getActiveSpaceKey: () => ready ? space : null,
    getActiveProviderName: () => 'test',
    getEmbeddingsWithFallback: async (texts) => {
      calls.chunks++;
      if (held) { held.started.resolve(); await held.release.promise; }
      if (fail) throw Object.assign(new Error('synthetic permanent embedding failure'), { retryable: false });
      return { embeddings: texts.map(() => [1, 0, 0, 0]), space };
    },
    getEmbeddingForQuery: async () => { calls.query++; return [1, 0, 0, 0]; },
  };
}

function loadBundle(entry = 'ModeReferenceFileIngestion') {
  const entryPath = path.join(path.dirname(bundlePath), `${entry}.js`);
  const source = entryPath === bundlePath ? bundle : fs.readFileSync(entryPath, 'utf8');
  const mod = new Module(entryPath);
  mod.filename = entryPath;
  mod.paths = Module._nodeModulePaths(path.dirname(entryPath));
  const originalRequire = mod.require.bind(mod);
  const premiumRequests = [];
  mod.require = (request) => {
    if (request === 'electron') return {
      app: undefined, BrowserWindow: { getAllWindows: () => [] },
      safeStorage: { isEncryptionAvailable: () => false },
    };
    if (/(?:^|[\\/])premium[\\/]/.test(request)) {
      premiumRequests.push(request);
      throw Object.assign(new Error('private premium module unavailable'), { code: 'MODULE_NOT_FOUND' });
    }
    return originalRequire(request);
  };
  // Expose the real inlined classes, not a second independently bundled copy.
  mod._compile(source + '\nmodule.exports.lifecycle = { ModesManager, DatabaseManager, ModeHybridRetriever, ModeContextRetriever };', entryPath);
  return { ...mod.exports, ...mod.exports.lifecycle, premiumRequests };
}


function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary mode upload ü '));
  process.env.NATIVELY_TEST_USERDATA = dir;
  const api = loadBundle();
  const database = api.DatabaseManager.getInstance();
  assert.equal(database.isAvailable(), true, database.getInitError()?.message);
  const manager = api.ModesManager.getInstance();
  const mode = manager.createMode({ name: 'Ordinary references A', templateType: 'general' });
  const other = manager.createMode({ name: 'Ordinary references B', templateType: 'general' });
  assert.ok(mode?.id && other?.id);
  manager.setActiveMode(mode.id);
  const embedder = pipeline(options);
  if (!options.noPipeline) manager.setSharedEmbeddingPipeline(embedder);
  const db = database.getDb();
  resources.push({ database, dir });
  const upload = async (content = TEXT, target = mode.id, observer) => {
    const filePath = path.join(dir, 'reference notes ü.md');
    fs.writeFileSync(filePath, content);
    const done = deferred();
    const file = await api.ingestModeReferenceFile({
      modeId: target, filePath,
      onIndexStatus: (phase, id) => {
        try { observer?.(phase, id); } finally { if (phase === 'done') done.resolve(); }
      },
    });
    return { file, done: done.promise };
  };
  const context = () => manager.buildRetrievedActiveModeContextBlockHybrid('enterprise renewal notice period', undefined, 1500);
  return { ...api, dir, db, database, manager, mode, other, embedder, upload, context };
}

afterEach(() => {
  for (const { database, dir } of resources.splice(0).reverse()) {
    database.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (previousUserData === undefined) delete process.env.NATIVELY_TEST_USERDATA;
  else process.env.NATIVELY_TEST_USERDATA = previousUserData;
  delete globalThis.__nativelyActiveModeInfoCacheV1__;
  delete globalThis.__nativelyModeEmbeddingPipelineV1__;
});

function assertRemoved(s, id) {
  for (const table of ['mode_reference_files', 'mode_reference_chunks', 'mode_reference_index_state']) {
    if (!s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    const column = table === 'mode_reference_files' ? 'id' : 'file_id';
    assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n, 0, `${table} still contains deleted file ${id}`);
  }
}

test('ordinary file is extracted, persisted, vector-indexed, retrieved and deleted without premium', async () => {
  const s = setup();
  const phases = [];
  const { file, done } = await s.upload(TEXT, s.mode.id, (phase) => phases.push(phase));
  await done;
  assert.equal(file.content, TEXT);
  assert.equal(file.fileName, 'reference notes ü.md');
  assert.equal(file.contentSha256, crypto.createHash('sha256').update(TEXT).digest('hex'));
  assert.equal(file.binarySha256, file.contentSha256);
  assert.equal(s.manager.getReferenceFiles(s.mode.id)[0].content, TEXT);
  assert.deepEqual(phases, ['indexing', 'done']);
  const status = s.manager.getReferenceFileIndexStatus(file.id);
  assert.equal(status.status, 'ready');
  assert.ok(status.embeddedChunkCount > 0);
  assert.equal(status.embeddedChunkCount, status.chunkCount);
  const calls = s.embedder.calls.chunks;
  assert.match(await s.context(), /47 days/);
  assert.equal(s.embedder.calls.chunks, calls, 'hot query must reuse persisted vectors');
  assert.equal(s.embedder.calls.query, 1);
  s.manager.deleteReferenceFile(file.id);
  assertRemoved(s, file.id);
  assert.doesNotMatch(await s.context(), /47 days/);
  assert.deepEqual(s.premiumRequests, [], 'ordinary reference methods must not require private knowledge code');
});

test('mode switch isolates references; explicit pinned mode uses only its own file set', async () => {
  const s = setup();
  const a = await s.upload(); await a.done;
  const b = await s.upload(TEXT.replace('47 days', '83 days'), s.other.id); await b.done;
  assert.match(await s.context(), /47 days/);
  s.manager.setActiveMode(s.other.id);
  const switched = await s.context();
  assert.match(switched, /83 days/);
  assert.doesNotMatch(switched, /47 days/);
  const pinned = await s.manager.buildRetrievedActiveModeContextBlockHybrid('enterprise renewal notice period', undefined, 1500, undefined, undefined, s.mode.id);
  assert.match(pinned, /47 days/);
  assert.doesNotMatch(pinned, /83 days/);
  s.manager.setActiveMode(null);
  assert.equal(await s.context(), '');
});

for (const options of [{ ready: false }, { fail: true }, { noPipeline: true }]) {
  test(`index unavailable/failure preserves ordinary lexical retrieval: ${JSON.stringify(options)}`, async () => {
    const s = setup(options);
    const { file, done } = await s.upload(); await done;
    assert.equal(s.manager.getReferenceFiles(s.mode.id)[0].content, TEXT);
    assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, options.noPipeline ? 'pending' : options.fail ? 'failed' : 'lexical_only');
    assert.equal(s.manager.getReferenceFileIndexStatus(file.id).embeddedChunkCount, 0);
    assert.match(await s.context(), /47 days/);
    s.manager.setSharedEmbeddingPipeline(pipeline());
    await s.manager.prewarmModeReferenceIndex(s.mode.id);
    assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
    s.manager.deleteReferenceFile(file.id);
    assertRemoved(s, file.id);
  });
}

test('deletion during an embedding request cannot resurrect text, vectors or index state', async () => {
  const held = { started: deferred(), release: deferred() };
  const s = setup({ held });
  const { file, done } = await s.upload();
  await held.started.promise;
  s.manager.deleteReferenceFile(file.id);
  assertRemoved(s, file.id);
  held.release.resolve();
  await done;
  assertRemoved(s, file.id);
  assert.doesNotMatch(await s.context(), /47 days/);
});

test('deletion through a manager without a pipeline still removes an existing persistent index', async () => {
  const s = setup();
  const { file, done } = await s.upload(); await done;
  delete globalThis.__nativelyModeEmbeddingPipelineV1__;
  const deletionManager = new s.ModesManager();
  deletionManager.deleteReferenceFile(file.id);
  assertRemoved(s, file.id);
});

test('a stale ordinary file snapshot submitted after deletion cannot recreate its index', async () => {
  const s = setup();
  const { file, done } = await s.upload(); await done;
  const snapshot = s.manager.getReferenceFiles(s.mode.id)[0];
  s.manager.deleteReferenceFile(file.id);
  await s.manager.indexReferenceFile(snapshot);
  assertRemoved(s, file.id);
});

test('delete and replacement upload leave only the replacement reference and vectors', async () => {
  const s = setup();
  const old = await s.upload(); await old.done;
  s.manager.deleteReferenceFile(old.file.id);
  const replacement = await s.upload(TEXT.replace('47 days', '83 days')); await replacement.done;
  assertRemoved(s, old.file.id);
  assert.deepEqual(s.manager.getReferenceFiles(s.mode.id).map(f => f.id), [replacement.file.id]);
  const context = await s.context();
  assert.match(context, /83 days/);
  assert.doesNotMatch(context, /47 days/);
});

test('invalid/empty extraction persists no reference row and starts no indexing', async () => {
  const s = setup();
  await assert.rejects(s.upload(''), /empty/);
  assert.equal(s.manager.getReferenceFiles(s.mode.id).length, 0);
  assert.equal(s.embedder.calls.chunks, 0);
});

test('same-length edits beyond 10000 characters invalidate the index and chunk cache', async () => {
  const s = setup();
  const prefix = 'enterprise pricing audit renewal details '.repeat(300);
  const old = s.manager.addReferenceFile({ modeId: s.mode.id, fileName: 'long.md', content: prefix + 'SILVER renewal value' });
  await s.manager.indexReferenceFile(old);
  const changed = { ...old, content: prefix + 'GOLDEN renewal value' };
  assert.equal(old.content.length, changed.content.length);
  assert.equal(s.manager.modeContextRetriever.referenceFileNeedsReindex(changed), true, 'tail-only edit was invisible to indexHash');
  await s.manager.indexReferenceFile(changed);
  const chunks = s.db.prepare('SELECT text FROM mode_reference_chunks WHERE file_id = ?').all(old.id).map(c => c.text).join('\n');
  assert.match(chunks, /GOLDEN/);
  assert.doesNotMatch(chunks, /SILVER/);
});

test('a changed file queued behind its in-flight index is eventually indexed at the new content', async () => {
  const held = { started: deferred(), release: deferred() };
  const s = setup({ held });
  const old = s.manager.addReferenceFile({ modeId: s.mode.id, fileName: 'notes.md', content: TEXT });
  const first = s.manager.indexReferenceFile(old);
  await held.started.promise;
  const changed = { ...old, content: TEXT.replace('47 days', '83 days') };
  const second = s.manager.indexReferenceFile(changed);
  held.release.resolve();
  await Promise.all([first, second]);
  const chunks = s.db.prepare('SELECT text FROM mode_reference_chunks WHERE file_id = ?').all(old.id).map(c => c.text).join('\n');
  assert.match(chunks, /83 days/);
  assert.doesNotMatch(chunks, /47 days/);
});

test('queued content changes are applied in request order, including a return to the in-flight version', async () => {
  const held = { started: deferred(), release: deferred() };
  const s = setup({ held });
  const file = s.manager.addReferenceFile({ modeId: s.mode.id, fileName: 'notes.md', content: TEXT });
  const first = s.manager.indexReferenceFile(file);
  await held.started.promise;
  const second = s.manager.indexReferenceFile({ ...file, content: TEXT.replace('47 days', '83 days') });
  const third = s.manager.indexReferenceFile(file);
  held.release.resolve();
  await Promise.all([first, second, third]);
  const chunks = s.db.prepare('SELECT text FROM mode_reference_chunks WHERE file_id = ?').all(file.id).map(c => c.text).join('\n');
  assert.match(chunks, /47 days/);
  assert.doesNotMatch(chunks, /83 days/);
});

test('synthetic profile references still index without an ordinary upload row', async () => {
  const s = setup();
  const file = { id: 'profile:resume:lifecycle-version', modeId: '__profile_raw__', fileName: 'resume.md', content: TEXT, createdAt: '' };
  await s.manager.indexReferenceFile(file);
  assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
  assert.ok(s.manager.getReferenceFileIndexStatus(file.id).embeddedChunkCount > 0);
  s.manager.modeContextRetriever.removeReferenceFileIndex(file.id);
  assertRemoved(s, file.id);
});

test('a throwing indexing observer does not turn a persisted upload into a reported failure', async () => {
  const s = setup();
  const { file, done } = await s.upload(TEXT, s.mode.id, () => { throw new Error('renderer closed during broadcast'); });
  await done;
  assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
  assert.match(await s.context(), /47 days/);
});

test('upload to a mode deleted before persistence rejects without orphaning a reference', async () => {
  const s = setup();
  s.manager.deleteMode(s.other.id);
  await assert.rejects(s.upload(TEXT, s.other.id));
  assert.equal(s.manager.getReferenceFiles(s.other.id).length, 0);
  assert.equal(s.embedder.calls.chunks, 0);
});

test('deletion from another manager cancels a late embedding writer through persisted ownership', async () => {
  const held = { started: deferred(), release: deferred() };
  const s = setup({ held });
  const { file, done } = await s.upload();
  await held.started.promise;
  const otherManager = new s.ModesManager();
  otherManager.deleteReferenceFile(file.id);
  held.release.resolve();
  await done;
  assertRemoved(s, file.id);
});

test('deletion also cancels the queued changed version when the provider rejects late', async () => {
  const held = { started: deferred(), release: deferred() };
  const s = setup({ held, fail: true });
  const old = s.manager.addReferenceFile({ modeId: s.mode.id, fileName: 'notes.md', content: TEXT });
  const first = s.manager.indexReferenceFile(old);
  await held.started.promise;
  const second = s.manager.indexReferenceFile({ ...old, content: TEXT.replace('47 days', '83 days') });
  s.manager.deleteReferenceFile(old.id);
  held.release.resolve();
  await Promise.all([first, second]);
  assertRemoved(s, old.id);
  assert.equal(s.embedder.calls.chunks, 1, 'no queued version or retry after deletion');
});

test('a fresh upload bundle receives the RAG pipeline injected through another bundle', async () => {
  const s = setup();
  const uploadBundle = loadBundle();
  assert.notEqual(uploadBundle.ModesManager, s.ModesManager);
  const otherDatabase = uploadBundle.DatabaseManager.getInstance();
  resources.push({ database: otherDatabase });
  const filePath = path.join(s.dir, 'cross bundle upload.md');
  fs.writeFileSync(filePath, TEXT);
  const done = deferred();
  const file = await uploadBundle.ingestModeReferenceFile({
    modeId: s.mode.id, filePath,
    onIndexStatus: phase => { if (phase === 'done') done.resolve(); },
  });
  await done.promise;
  assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready', 'upload bundle never received the application RAG pipeline');
  assert.ok(s.embedder.calls.chunks > 0, 'upload must use the shared provider, not just lexical extraction');
  assert.match(await s.context(), /47 days/);
  s.manager.deleteReferenceFile(file.id);
  assertRemoved(s, file.id);
});

for (const { publisher, fail } of [
  { publisher: 'writer bundle', fail: false },
  { publisher: 'other bundle', fail: false },
  { publisher: 'other bundle', fail: true },
]) {
  test(`multi-bundle provider replacement prevents old writes (${publisher}, late ${fail ? 'failure' : 'success'})`, { timeout: 10000 }, async () => {
    const held = { started: deferred(), release: deferred() };
    const s = setup({ held, fail, space: 'test:provider-A:4' });
    const otherBundle = loadBundle('ModesManager');
    assert.notEqual(otherBundle.ModeContextRetriever, s.ModeContextRetriever);
    const database = otherBundle.DatabaseManager.getInstance();
    resources.push({ database });
    const otherManager = otherBundle.ModesManager.getInstance();
    const file = s.manager.addReferenceFile({ modeId: s.mode.id, fileName: 'provider race.md', content: TEXT });
    // Cache A in the second bundle before the first bundle publishes B.
    otherManager.getReferenceFileIndexStatus(file.id);
    const oldJob = s.manager.indexReferenceFile(file);
    let queuedJob;
    try {
      await held.started.promise;
      queuedJob = s.manager.indexReferenceFile({ ...file, content: TEXT.replace('47 days', '83 days') });
      const replacement = pipeline({ space: 'test:provider-B:4' });
      const publishingManager = publisher === 'writer bundle' ? s.manager : otherManager;
      const indexingManager = publisher === 'writer bundle' ? otherManager : s.manager;
      publishingManager.setSharedEmbeddingPipeline(replacement);
      await indexingManager.indexReferenceFile(file);
      const snapshot = () => ({
        state: s.db.prepare('SELECT * FROM mode_reference_index_state WHERE file_id = ?').get(file.id),
        chunks: s.db.prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(file.id),
      });
      const newIndex = snapshot();
      assert.equal(newIndex.state.embedding_space, 'test:provider-B:4');
      assert.ok(newIndex.chunks.length > 0);
      held.release.resolve();
      await Promise.all([oldJob, queuedJob]);
      assert.deepEqual(snapshot(), newIndex, 'provider A overwrote the completed provider B index');
      assert.equal(s.embedder.calls.chunks, 1, 'a superseded queued writer must not call provider A');
    } finally {
      held.release.resolve();
      await Promise.allSettled([oldJob, queuedJob]);
    }
  });
}

test('multi-bundle provider replacement keeps an old A job retired after A is restored', { timeout: 10000 }, async () => {
  const held = { started: deferred(), release: deferred() };
  const s = setup({ held, space: 'test:provider-A:4' });
  const otherBundle = loadBundle('ModesManager');
  const database = otherBundle.DatabaseManager.getInstance();
  resources.push({ database });
  const otherManager = otherBundle.ModesManager.getInstance();
  const file = s.manager.addReferenceFile({ modeId: s.mode.id, fileName: 'provider ABA.md', content: TEXT });
  const oldJob = s.manager.indexReferenceFile(file);
  try {
    await held.started.promise;
    otherManager.setSharedEmbeddingPipeline(pipeline({ space: 'test:provider-B:4' }));
    await otherManager.indexReferenceFile(file);
    // Reuse the exact A pipeline object, but let its new-generation call finish first.
    s.embedder.getEmbeddingsWithFallback = async texts => ({
      embeddings: texts.map(() => [0, 1, 0, 0]), space: 'test:provider-A:4',
    });
    otherManager.setSharedEmbeddingPipeline(s.embedder);
    await otherManager.indexReferenceFile({ ...file, content: TEXT.replace('47 days', '83 days') });
    const newState = s.db.prepare('SELECT * FROM mode_reference_index_state WHERE file_id = ?').get(file.id);
    const newChunks = s.db.prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(file.id);
    assert.equal(newState.embedding_space, 'test:provider-A:4');
    assert.match(newChunks[0].text, /83 days/);
    held.release.resolve();
    await oldJob;
    assert.deepEqual(s.db.prepare('SELECT * FROM mode_reference_index_state WHERE file_id = ?').get(file.id), newState);
    assert.deepEqual(s.db.prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(file.id), newChunks);
  } finally {
    held.release.resolve();
    await Promise.allSettled([oldJob]);
  }
});

test('multi-bundle indexing shares the provider and database concurrency cap', { timeout: 10000 }, async () => {
  const previousLimit = process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES;
  process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES = '2';
  const releases = [deferred(), deferred(), deferred()];
  const twoStarted = deferred(), thirdStarted = deferred();
  const jobs = [];
  let calls = 0, active = 0, peak = 0;
  try {
    const s = setup();
    const otherBundle = loadBundle('ModesManager');
    assert.notEqual(otherBundle.ModeHybridRetriever, s.ModeHybridRetriever);
    const database = otherBundle.DatabaseManager.getInstance();
    assert.notEqual(database.getDb(), s.db, 'exercise separate connections to the same database');
    assert.equal(database.getDbPath(), s.database.getDbPath());
    resources.push({ database });
    const otherManager = otherBundle.ModesManager.getInstance();
    const files = releases.map((_, i) => s.manager.addReferenceFile({
      modeId: s.mode.id, fileName: `concurrent ${i}.md`, content: TEXT,
    }));
    s.embedder.getEmbeddingsWithFallback = async (texts) => {
      const slot = calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 2) twoStarted.resolve();
      if (calls === 3) thirdStarted.resolve();
      try {
        await releases[slot].promise;
        return { embeddings: texts.map(() => [1, 0, 0, 0]), space: SPACE };
      } finally { active--; }
    };
    jobs.push(s.manager.indexReferenceFile(files[0]), s.manager.indexReferenceFile(files[1]));
    await twoStarted.promise;
    jobs.push(otherManager.indexReferenceFile(files[2]));
    // Drain the actual indexFile continuation without releasing either provider call.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'the third bundle-local job bypassed the shared cap of two');
    releases[0].resolve();
    await thirdStarted.promise;
    releases[1].resolve();
    releases[2].resolve();
    await Promise.all(jobs);
    assert.equal(peak, 2);
    for (const file of files) assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
  } finally {
    for (const release of releases) release.resolve();
    await Promise.allSettled(jobs);
    if (previousLimit === undefined) delete process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES;
    else process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES = previousLimit;
  }
});

test('multi-bundle indexing cancels old gate waiters without blocking a replacement provider', { timeout: 10000 }, async () => {
  const previousLimit = process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES;
  process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES = '2';
  const held = { started: deferred(), release: deferred() };
  const jobs = [];
  try {
    const s = setup({ held, space: 'test:provider-A:4' });
    const otherBundle = loadBundle('ModesManager');
    const database = otherBundle.DatabaseManager.getInstance();
    resources.push({ database });
    const otherManager = otherBundle.ModesManager.getInstance();
    const files = [0, 1, 2].map(i => s.manager.addReferenceFile({
      modeId: s.mode.id, fileName: `replacement gate ${i}.md`, content: TEXT,
    }));
    jobs.push(s.manager.indexReferenceFile(files[0]), s.manager.indexReferenceFile(files[1]));
    await held.started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.embedder.calls.chunks, 2);
    jobs.push(otherManager.indexReferenceFile(files[2]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.embedder.calls.chunks, 2);
    otherManager.setSharedEmbeddingPipeline(pipeline({ space: 'test:provider-B:4' }));
    await otherManager.indexReferenceFile(files[2]);
    const newState = s.db.prepare('SELECT * FROM mode_reference_index_state WHERE file_id = ?').get(files[2].id);
    const newChunks = s.db.prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(files[2].id);
    assert.equal(newState.embedding_space, 'test:provider-B:4');
    held.release.resolve();
    await Promise.all(jobs);
    assert.equal(s.embedder.calls.chunks, 2, 'the superseded gate waiter must not start another A call');
    assert.deepEqual(s.db.prepare('SELECT * FROM mode_reference_index_state WHERE file_id = ?').get(files[2].id), newState);
    assert.deepEqual(s.db.prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(files[2].id), newChunks);
  } finally {
    held.release.resolve();
    await Promise.allSettled(jobs);
    if (previousLimit === undefined) delete process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES;
    else process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES = previousLimit;
  }
});

test('multi-bundle indexing gates isolate different databases using one provider', { timeout: 10000 }, async () => {
  const previousLimit = process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES;
  process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES = '2';
  const held = { started: deferred(), release: deferred() };
  const jobs = [];
  try {
    const s = setup({ held });
    const files = [0, 1].map(i => s.manager.addReferenceFile({
      modeId: s.mode.id, fileName: `first database ${i}.md`, content: TEXT,
    }));
    jobs.push(...files.map(file => s.manager.indexReferenceFile(file)));
    await held.started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.embedder.calls.chunks, 2);
    const other = setup({ noPipeline: true });
    assert.notEqual(other.database.getDbPath(), s.database.getDbPath());
    const file = other.manager.addReferenceFile({ modeId: other.mode.id, fileName: 'second database.md', content: TEXT });
    jobs.push(other.manager.indexReferenceFile(file));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.embedder.calls.chunks, 3, 'a different database should have its own provider gate');
    assert.equal(other.embedder.calls.chunks, 0, 'the second database must still use the same shared provider');
    held.release.resolve();
    await Promise.all(jobs);
    assert.equal(other.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
  } finally {
    held.release.resolve();
    await Promise.allSettled(jobs);
    if (previousLimit === undefined) delete process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES;
    else process.env.NATIVELY_MODE_INDEX_MAX_CONCURRENT_FILES = previousLimit;
  }
});

test('a cached upload bundle follows a later replacement of the shared provider', async () => {
  const s = setup();
  const otherBundle = loadBundle();
  const database = otherBundle.DatabaseManager.getInstance();
  resources.push({ database });
  const filePath = path.join(s.dir, 'provider switch.md');
  fs.writeFileSync(filePath, TEXT);
  const upload = async () => {
    const done = deferred();
    const file = await otherBundle.ingestModeReferenceFile({ modeId: s.mode.id, filePath,
      onIndexStatus: phase => { if (phase === 'done') done.resolve(); },
    });
    await done.promise;
    return file;
  };
  await upload();
  const previousCalls = s.embedder.calls.chunks;
  const replacement = pipeline();
  s.manager.setSharedEmbeddingPipeline(replacement);
  const file = await upload();
  assert.equal(replacement.calls.chunks, 1);
  assert.equal(s.embedder.calls.chunks, previousCalls);
  assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
});

for (const failure of ['throw', 'empty', 'document-grounded throw']) {
  test(`mode switch during hybrid ${failure} cannot make lexical fallback read the new mode`, async () => {
    const s = setup();
    const a = await s.upload(); await a.done;
    const b = await s.upload(TEXT.replace('47 days', '83 days'), s.other.id); await b.done;
    const started = deferred(), release = deferred();
    s.manager.modeContextRetriever._hybridRetriever.retrieve = async () => {
      started.resolve(); await release.promise;
      if (failure.includes('throw')) throw new Error('synthetic retrieval outage');
      return { chunks: [], formattedContext: '', usedFallback: true, usedHybrid: false };
    };
    const answer = s.manager.buildRetrievedActiveModeContextBlockHybrid(
      'enterprise renewal notice period', undefined, 1500, undefined, undefined,
      undefined, false, failure.startsWith('document') ? { forceDocumentGrounding: true } : undefined,
    );
    await started.promise;
    s.manager.setActiveMode(s.other.id);
    release.resolve();
    const context = await answer;
    assert.doesNotMatch(context, /83 days/, 'fallback followed live active mode instead of the captured file owner');
    assert.match(context, /47 days/);
  });
}

function uploadHandler(s, picker, authorized = true) {
  const source = fs.readFileSync(path.join(root, 'electron/ipcHandlers.ts'), 'utf8');
  const start = source.indexOf("  safeHandle('modes:upload-reference-file'");
  const end = source.indexOf("  safeHandle('modes:delete-reference-file'", start);
  assert.ok(start >= 0 && end > start);
  const { code } = transformSync(source.slice(start, end), { loader: 'ts', format: 'cjs' });
  let handler;
  new Function('safeHandle', 'isProOrTrialActive', 'dialog', 'SAFE_DOCUMENT_EXTENSIONS', 'require', 'BrowserWindow', 'path', code)(
    (_channel, fn) => { handler = fn; }, () => authorized, { showOpenDialog: picker },
    s.MODE_REFERENCE_FILE_EXTENSIONS,
    (request) => { assert.equal(request, './services/ModeReferenceFileIngestion'); return s; },
    { getAllWindows: () => [] }, path,
  );
  return handler;
}

for (const result of [{ canceled: true, filePaths: [] }, { canceled: false, filePaths: [] }]) {
  test(`actual upload IPC does not extract, persist or index when picker returns ${JSON.stringify(result)}`, async () => {
    const s = setup();
    const handler = uploadHandler(s, async () => result);
    assert.deepEqual(await handler({}, s.mode.id), { success: false, cancelled: true });
    assert.equal(s.manager.getReferenceFiles(s.mode.id).length, 0);
    assert.equal(s.embedder.calls.chunks, 0);
  });
}

test('actual upload IPC retains authorization policy before opening the picker', async () => {
  const s = setup();
  const handler = uploadHandler(s, () => { assert.fail('unauthorized upload opened the picker'); }, false);
  assert.deepEqual(await handler({}, s.mode.id), { success: false, error: 'pro_required' });
  assert.equal(s.manager.getReferenceFiles(s.mode.id).length, 0);
});

test('mode switch while the actual picker is open keeps the selected upload attached to its original mode', async () => {
  const s = setup();
  const selected = deferred();
  const filePath = path.join(s.dir, 'picker upload.md');
  fs.writeFileSync(filePath, TEXT);
  const handler = uploadHandler(s, () => selected.promise);
  const pending = handler({}, s.mode.id);
  s.manager.setActiveMode(s.other.id);
  selected.resolve({ canceled: false, filePaths: [filePath] });
  const result = await pending;
  assert.equal(result.success, true);
  // The second call single-flights with the background upload job.
  await s.manager.indexReferenceFile(s.manager.getReferenceFiles(s.mode.id)[0]);
  assert.equal(s.manager.getReferenceFiles(s.mode.id)[0].id, result.file.id);
  assert.equal(s.manager.getReferenceFiles(s.other.id).length, 0);
  assert.doesNotMatch(await s.context(), /47 days/);
});

for (const [platform, paths, resourcesPath] of [
  ['win32', path.win32, 'C:\\Program Files\\Natively ü\\resources'],
  ['darwin', path.posix, '/Applications/Natively ü.app/Contents/Resources'],
]) {
  test(`packaged embedding worker resolution with ${platform} path semantics, spaces and Unicode`, () => {
    const resolverPath = path.join(root, 'dist-electron/electron/rag/resolveRagWorker.js');
    const mod = new Module(resolverPath);
    mod.filename = resolverPath;
    mod.paths = Module._nodeModulePaths(path.dirname(resolverPath));
    const originalRequire = mod.require.bind(mod);
    mod.require = request => request === 'path' ? paths : originalRequire(request);
    mod._compile(fs.readFileSync(resolverPath, 'utf8'), resolverPath);
    const electronRoot = paths.join(resourcesPath, 'app.asar', 'dist-electron', 'electron');
    const worker = paths.join(electronRoot, 'rag', 'providers', 'localEmbeddingWorker.js');
    const resolved = mod.exports.resolveBundledScript(paths.join(electronRoot, 'services', 'modes'),
      ['rag', 'providers', 'localEmbeddingWorker.js'], { exists: candidate => candidate === worker, unpackFromAsar: true });
    assert.equal(resolved, worker.replace('app.asar', 'app.asar.unpacked'));
  });
}

for (const [relativePath, expected] of [
  ['test-fixtures/profiles/p01/resume.pdf', /MARCUS J\. HOLLOWAY/],
  ['test-fixtures/profiles/p03/resume.docx', /MARGARET/],
]) {
  test(`ordinary upload extracts and persists the real ${path.extname(relativePath)} fixture`, async () => {
    const s = setup();
    const done = deferred();
    const file = await s.ingestModeReferenceFile({
      modeId: s.mode.id, filePath: path.join(root, relativePath),
      onIndexStatus: phase => { if (phase === 'done') done.resolve(); },
    });
    await done.promise;
    assert.match(s.manager.getReferenceFiles(s.mode.id)[0].content, expected);
    assert.equal(s.manager.getReferenceFileIndexStatus(file.id).status, 'ready');
    assert.ok(s.manager.getReferenceFileIndexStatus(file.id).embeddedChunkCount > 0);
    if (relativePath.endsWith('.pdf')) {
      assert.ok(file.pageCount > 0);
      assert.ok(file.extractedPageCount > 0);
    }
    s.manager.deleteReferenceFile(file.id);
    assertRemoved(s, file.id);
    assert.deepEqual(s.premiumRequests, []);
  });
}
