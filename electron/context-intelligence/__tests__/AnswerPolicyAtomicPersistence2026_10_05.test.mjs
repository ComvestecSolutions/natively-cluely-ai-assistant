// Actual policy-store persistence: isolated temp userdata, no fixture policy mocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const storePath = path.join(root, 'dist-electron/electron/context-intelligence/policies/answer-policy-store.js');
const fileName = 'context-intelligence-answer-policy.json';
const strict = 'only_answer_from_references';
const general = 'use_references_when_relevant';
const source = fs.readFileSync(storePath, 'utf8');
function isolatedStore(extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require, process, console, ...extra }, { filename: storePath });
  return module.exports;
}
function storeWithFs(overrides, platform = process.platform, context = {}) {
  const fileSystem = { ...fs, ...overrides };
  return isolatedStore({
    require: id => id === 'fs' ? fileSystem : require(id),
    process: { platform, pid: process.pid, env: process.env, cwd: () => process.cwd(), kill: process.kill.bind(process) },
    Atomics: { wait: () => 'timed-out' },
    ...context,
  });
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy atomic Unicode λ '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return dir;
}

// Freeze real children at filesystem boundaries; killing them also closes their
// OS handles. Both the old file lock and the replacement directory protocol
// reach these checkpoints, so these regressions can run against either build.
const crashChildCode = `
const fs = require('node:fs'); const path = require('node:path');
const d = JSON.parse(process.argv[1]); const native = { ...fs };
const lock = path.join(d.dir, d.fileName + '.lock');
const wait = new Int32Array(new SharedArrayBuffer(4)); const fired = new Set();
function checkpoint(stage) {
  if (fired.has(stage)) return; fired.add(stage);
  native.writeSync(1, JSON.stringify({stage, pid:process.pid}) + '\\n');
  const resume = d.control + '.' + stage;
  while (!native.existsSync(resume)) Atomics.wait(wait,0,0,10);
  native.unlinkSync(resume);
}
const isOwner = p => path.dirname(String(p)) === lock && path.basename(String(p)).startsWith('owner-');
fs.openSync = (...args) => {
  const fd = native.openSync(...args);
  if (d.checkpoint === 'initializer' && String(args[0]) === lock && args[1] === 'wx') checkpoint('initializer');
  if (['reclaimer-before','contender'].includes(d.checkpoint) && String(args[0]) === lock + '.recovery') checkpoint('reclaimer-before');
  return fd;
};
fs.mkdirSync = (...args) => {
  const result = native.mkdirSync(...args);
  if (d.checkpoint === 'initializer' && String(args[0]).endsWith('.claim')) checkpoint('initializer');
  return result;
};
fs.writeFileSync = (...args) => {
  const result = native.writeFileSync(...args);
  if (d.checkpoint === 'prepared' && typeof args[0] === 'string' && path.dirname(args[0]).endsWith('.claim')) checkpoint('prepared');
  if (['writer','contender'].includes(d.checkpoint) && typeof args[0] === 'number' && String(args[1]).startsWith(process.pid + ':')) checkpoint('writer');
  return result;
};
fs.renameSync = (...args) => {
  const result = native.renameSync(...args);
  if (['writer','contender'].includes(d.checkpoint) && String(args[1]) === lock) checkpoint('writer');
  return result;
};
fs.unlinkSync = (...args) => {
  const owner = isOwner(args[0]);
  if (['reclaimer-before','contender'].includes(d.checkpoint) && owner) checkpoint('reclaimer-before');
  const result = native.unlinkSync(...args);
  if (d.checkpoint === 'reclaimer-after' && (owner || String(args[0]) === lock)) checkpoint('reclaimer-after');
  if (d.checkpoint === 'reclaimer-removed' && String(args[0]) === lock) checkpoint('reclaimer-removed');
  return result;
};
fs.rmdirSync = (...args) => {
  const result = native.rmdirSync(...args);
  if (d.checkpoint === 'reclaimer-removed' && String(args[0]) === lock) checkpoint('reclaimer-removed');
  return result;
};
try {
  const store = require(d.storePath);
  if (d.read) {
    if (store.getStoredAnswerPolicy('seed',d.dir) !== 'only_answer_from_references') throw new Error('committed seed missing');
  } else store.setStoredAnswerPolicy(d.mode || 'child', 'use_references_when_relevant', d.dir);
  native.writeSync(1, JSON.stringify({stage:'done',pid:process.pid}) + '\\n');
} catch (e) {
  native.writeSync(1, JSON.stringify({stage:'error',code:e.code || e.name,message:e.message,pid:process.pid}) + '\\n');
  process.exitCode = 1;
}
`;
function actualChild(t, dir, checkpoint, extra = {}) {
  const control = path.join(temp(t), 'resume');
  const child = spawn(process.execPath, ['-e', crashChildCode, JSON.stringify({ dir, fileName, storePath, checkpoint, control, ...extra })], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const messages = []; const listeners = new Set(); let output = '', stderr = '', closed = false;
  child.stdout.on('data', data => {
    output += data;
    for (;;) {
      const newline = output.indexOf('\n'); if (newline < 0) break;
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try { const message = JSON.parse(line); messages.push(message); for (const notify of listeners) notify(); } catch { stderr += line; }
    }
  });
  child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal, stderr, messages }); for (const notify of listeners) notify(); });
  });
  async function kill() { if (!closed) child.kill('SIGKILL'); return completion; }
  t.after(kill);
  function until(stage) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`child ${child.pid} missed ${stage}: ${stderr}`)), 10000);
      function finish(error, value) { clearTimeout(timeout); listeners.delete(check); error ? reject(error) : resolve(value); }
      function check() {
        const message = messages.find(m => m.stage === stage);
        if (message) finish(null, message);
        else if (messages.some(m => m.stage === 'error') || closed) finish(new Error(`child missed ${stage}: ${JSON.stringify(messages)} ${stderr}`));
      }
      listeners.add(check); check();
    });
  }
  return { child, completion, until, kill, resume: stage => fs.writeFileSync(control + '.' + stage, '') };
}
async function killedOwner(t, dir) {
  const owner = actualChild(t, dir, 'writer');
  const message = await owner.until('writer');
  await owner.kill();
  assert.throws(() => process.kill(message.pid, 0), error => error.code === 'ESRCH');
}

for (const boundary of ['initializer', 'prepared', 'writer', 'reclaimer-before', 'reclaimer-after', 'reclaimer-removed']) {
  test(`crash at ${boundary} cannot wedge fresh process reads or writes (repeated)`, { timeout: 45000 }, async t => {
    const dir = temp(t); isolatedStore().setStoredAnswerPolicy('seed', strict, dir);
    for (let repeat = 0; repeat < 3; repeat++) {
      if (boundary.startsWith('reclaimer')) await killedOwner(t, dir);
      const child = actualChild(t, dir, boundary);
      await child.until(boundary); await child.kill();
      const reader = actualChild(t, dir, '', { read: true });
      assert.equal((await reader.completion).code, 0, JSON.stringify(await reader.completion));
      const writer = actualChild(t, dir, '', { mode: 'recovered-' + repeat });
      assert.equal((await writer.completion).code, 0, JSON.stringify(await writer.completion));
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
      assert.equal(persisted.seed, strict);
      for (let previous = 0; previous <= repeat; previous++) assert.equal(persisted['recovered-' + previous], general);
      assert.deepEqual(fs.readdirSync(dir), [fileName]);
    }
  });
}

test('live private initializer is never stolen and merges intervening writes after publication', { timeout: 15000 }, async t => {
  const dir = temp(t); isolatedStore().setStoredAnswerPolicy('seed', strict, dir);
  const initializer = actualChild(t, dir, 'initializer', { mode: 'initializer' });
  try {
    await initializer.until('initializer');
    const claims = fs.readdirSync(dir).filter(entry => entry.endsWith('.claim'));
    assert.equal(claims.length, 1, 'uninitialized ownership is private, never published');
    const concurrent = actualChild(t, dir, '', { mode: 'concurrent' });
    assert.equal((await concurrent.completion).code, 0);
    assert.ok(fs.existsSync(path.join(dir, claims[0])), 'a live initializer keeps its private claim');
    initializer.resume('initializer');
    assert.equal((await initializer.completion).code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')), { seed: strict, concurrent: general, initializer: general });
    assert.deepEqual(fs.readdirSync(dir), [fileName]);
  } finally { await initializer.kill(); }
});

test('simultaneous delayed reclaimers cannot unlink a newly published live successor', { timeout: 30000 }, async t => {
  const dir = temp(t); isolatedStore().setStoredAnswerPolicy('seed', strict, dir);
  for (let repeat = 0; repeat < 3; repeat++) {
    await killedOwner(t, dir);
    const contenders = Array.from({ length: 4 }, (_, id) => actualChild(t, dir, 'contender', { mode: 'contender-' + repeat + '-' + id }));
    try {
      await Promise.all(contenders.map(child => child.until('reclaimer-before')));
      contenders[0].resume('reclaimer-before');
      await contenders[0].until('writer');
      const lock = path.join(dir, fileName + '.lock');
      const [successor] = fs.readdirSync(lock);
      assert.ok(successor.startsWith('owner-' + contenders[0].child.pid + '-'));
      for (const child of contenders.slice(1)) child.resume('reclaimer-before');
      const results = await Promise.all(contenders.slice(1).map(child => child.completion));
      for (const result of results) {
        assert.equal(result.code, 1, 'a contender must fail, not acknowledge a write while the successor owns the lock');
        assert.equal(result.messages.at(-1)?.code, 'EBUSY', JSON.stringify(result));
      }
      assert.deepEqual(fs.readdirSync(lock), [successor], 'all delayed removals leave the live successor intact');
      contenders[0].resume('writer');
      assert.equal((await contenders[0].completion).code, 0);
      const next = actualChild(t, dir, '', { mode: 'after-' + repeat });
      assert.equal((await next.completion).code, 0);
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
      assert.equal(persisted.seed, strict);
      assert.equal(persisted['contender-' + repeat + '-0'], general);
      assert.equal(persisted['after-' + repeat], general);
      assert.deepEqual(fs.readdirSync(dir), [fileName]);
    } finally { await Promise.all(contenders.map(child => child.kill())); }
  }
});

function fixtureLock(dir, pid) {
  const lock = path.join(dir, fileName + '.lock');
  const owner = 'owner-' + pid + '-' + randomUUID();
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, owner), '', { flag: 'wx' });
  return { lock, owner };
}

for (const [platform, collision] of [['darwin', 'ENOTEMPTY'], ['win32', 'EPERM']]) {
  test(`${platform}: publication is initialized and cannot overwrite a live nonempty owner`, t => {
    const dir = temp(t); isolatedStore().setStoredAnswerPolicy('seed', strict, dir);
    const live = fixtureLock(dir, process.pid); let attempts = 0, now = 0;
    const clock = class extends Date { static now() { now += 200; return now; } };
    const store = storeWithFs({ renameSync: (from, to) => {
      if (String(to) === live.lock) {
        const entries = fs.readdirSync(from);
        assert.equal(entries.length, 1, 'only initialized ownership can become visible');
        assert.match(entries[0], /^owner-\d+-[0-9a-f-]{36}$/);
        attempts++;
        throw Object.assign(new Error('nonempty owner collision'), { code: collision });
      }
      return fs.renameSync(from, to);
    } }, platform, { Date: clock });
    assert.throws(() => store.setStoredAnswerPolicy('other', general, dir), e => e.code === 'EBUSY');
    assert.ok(attempts > 0);
    assert.deepEqual(fs.readdirSync(live.lock), [live.owner]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')), { seed: strict });
    assert.deepEqual(fs.readdirSync(dir), [fileName, fileName + '.lock'], 'failed acquisition removes only its private claim');
  });
}

const workerCode = `
const { workerData: d, parentPort } = require('node:worker_threads');
const fs = require('node:fs'); const path = require('node:path');
const store = require(d.storePath); const state = new Int32Array(d.state);
const errors = []; let operations = 0;
const record = e => { if (errors.length < 8) errors.push({code:e.code || e.name, syscall:e.syscall, file:e.path ? path.basename(e.path) : undefined, message:e.message}); };
store.getStoredAnswerPolicy('seed', d.dir);
parentPort.postMessage({ready:true});
Atomics.wait(state, 0, 0, 5000);
if (d.reader) {
  while (Atomics.load(state, 1) < d.writers) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(d.dir, d.fileName), 'utf8'));
      if (parsed.seed !== 'only_answer_from_references') throw new Error('reader observed missing committed seed');
      store._resetAnswerPolicyStoreForTest();
      if (store.getStoredAnswerPolicy('seed', d.dir) !== 'only_answer_from_references') throw new Error('store reader defaulted a committed policy');
      operations++;
    } catch (e) { record(e); }
  }
} else {
  try {
    for (let i = 0; i < d.iterations; i++) {
      const value = i % 2 ? 'use_references_when_relevant' : 'only_answer_from_references';
      try {
        store.setStoredAnswerPolicy('writer-' + d.id, value, d.dir);
        if (store.getStoredAnswerPolicy('writer-' + d.id, d.dir) !== value) throw new Error('acknowledged policy not visible');
        operations++;
      } catch (e) { record(e); }
    }
    try { store.setStoredAnswerPolicy('writer-' + d.id, 'only_answer_from_references', d.dir); operations++; } catch (e) { record(e); }
  } finally { Atomics.add(state, 1, 1); }
}
parentPort.postMessage({done:true, errors, operations});
`;

async function race(t, dir, writers = 4, iterations = 60) {
  const state = new SharedArrayBuffer(8);
  const workers = [];
  const ready = [];
  const done = [];
  for (let id = 0; id <= writers; id++) {
    const worker = new Worker(workerCode, { eval: true, workerData: { storePath, state, dir, fileName, writers, iterations, id, reader: id === writers } });
    workers.push(worker);
    let resolveReady, rejectReady;
    ready.push(new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }));
    done.push(new Promise((resolve, reject) => {
      let result;
      worker.on('message', message => { if (message.ready) resolveReady(); if (message.done) result = message; });
      worker.on('error', error => { rejectReady(error); reject(error); });
      worker.once('exit', code => {
        if (code || !result) { const error = new Error(`worker ${id} exited ${code} without clean completion`); rejectReady(error); reject(error); }
        else resolve(result);
      });
    }));
  }
  // A done message precedes native worker teardown. Await normal exit above;
  // forced termination is reserved for unfinished workers on a failing test.
  t.after(async () => { await Promise.all(workers.filter(w => w.threadId !== -1).map(w => w.terminate())); });
  await Promise.all(ready);
  Atomics.store(new Int32Array(state), 0, 1);
  Atomics.notify(new Int32Array(state), 0);
  const results = await Promise.all(done);
  return { errors: results.flatMap(r => r.errors), writes: results.slice(0, writers).reduce((n, r) => n + r.operations, 0), reads: results[writers].operations };
}

for (const platform of ['win32', 'darwin']) test(`${platform}: transient replacement failures never acknowledge an unpersisted choice`, t => {
  const dir = temp(t);
  isolatedStore().setStoredAnswerPolicy('mode', strict, dir);
  let attempts = 0;
  const store = storeWithFs({ renameSync: (...args) => {
    if (String(args[1]) !== path.join(dir, fileName)) return fs.renameSync(...args);
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('replacement busy'), { code: 'EPERM' });
    return fs.renameSync(...args);
  } }, platform);
  if (platform === 'win32') {
    store.setStoredAnswerPolicy('mode', general, dir);
    assert.equal(attempts, 3);
    assert.equal(store.getStoredAnswerPolicy('mode', dir), general);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, general);
  } else {
    assert.throws(() => store.setStoredAnswerPolicy('mode', general, dir), e => e.code === 'EPERM');
    assert.equal(attempts, 1, 'macOS permanent permission errors are not retried as Windows sharing violations');
    assert.equal(store.getStoredAnswerPolicy('mode', dir), strict);
  }
  assert.deepEqual(fs.readdirSync(dir), [fileName]);
});

test('permanent replacement failure preserves disk and cache and removes staging files', t => {
  const dir = temp(t);
  const store = storeWithFs({ renameSync: (...args) => {
      if (String(args[1]) !== path.join(dir, fileName)) return fs.renameSync(...args);
      throw Object.assign(new Error('replacement denied'), { code: 'EPERM' });
    } }, 'win32');
  isolatedStore().setStoredAnswerPolicy('mode', strict, dir);
  assert.equal(store.getStoredAnswerPolicy('mode', dir), strict);
  assert.throws(() => store.setStoredAnswerPolicy('mode', general, dir), e => e.code === 'EPERM');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, strict);
  assert.equal(store.getStoredAnswerPolicy('mode', dir), strict);
  assert.deepEqual(fs.readdirSync(dir), [fileName]);
});

test('unreadable or corrupt existing policy is not silently replaced with defaults', t => {
  const dir = temp(t);
  isolatedStore().setStoredAnswerPolicy('mode', strict, dir);
  const store = storeWithFs({ readFileSync: p => {
    if (String(p).endsWith(fileName)) throw Object.assign(new Error('policy denied'), { code: 'EACCES' });
    return fs.readFileSync(p, 'utf8');
  } }, 'darwin');
  assert.throws(() => store.getStoredAnswerPolicy('mode', dir), e => e.code === 'EACCES');
  assert.throws(() => store.setStoredAnswerPolicy('other', general, dir), e => e.code === 'EACCES');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, strict);
  fs.writeFileSync(path.join(dir, fileName), '{broken JSON');
  assert.throws(() => isolatedStore().getStoredAnswerPolicy('mode', dir));
  assert.throws(() => isolatedStore().setStoredAnswerPolicy('other', general, dir));
  assert.equal(fs.readFileSync(path.join(dir, fileName), 'utf8'), '{broken JSON');
});

test('Windows actual held reader releases before atomic replacement is acknowledged', { skip: process.platform !== 'win32' }, async t => {
  const dir = temp(t);
  const store = isolatedStore();
  store.setStoredAnswerPolicy('mode', strict, dir);
  const reader = new Worker(`const fs=require('node:fs'); const {workerData,parentPort}=require('node:worker_threads'); const fd=fs.openSync(workerData,'r'); parentPort.postMessage('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80); fs.closeSync(fd);`, { eval: true, workerData: path.join(dir, fileName) });
  const exited = new Promise((resolve, reject) => { reader.once('exit', code => code ? reject(new Error(`reader exited ${code}`)) : resolve()); reader.once('error', reject); });
  t.after(async () => { if (reader.threadId !== -1) await reader.terminate(); });
  await new Promise((resolve, reject) => { reader.once('message', resolve); reader.once('error', reject); });
  store.setStoredAnswerPolicy('mode', general, dir);
  await exited;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, general);
  assert.equal(store.getStoredAnswerPolicy('mode', dir), general);
  assert.deepEqual(fs.readdirSync(dir), [fileName]);
});

test('Windows permanently held reader leaves the old policy intact and reports bounded failure', { skip: process.platform !== 'win32' }, t => {
  const dir = temp(t);
  const store = isolatedStore();
  store.setStoredAnswerPolicy('mode', strict, dir);
  const fd = fs.openSync(path.join(dir, fileName), 'r');
  try {
    assert.throws(() => store.setStoredAnswerPolicy('mode', general, dir), e => e.code === 'EPERM' && e.syscall === 'rename');
    assert.equal(store.getStoredAnswerPolicy('mode', dir), strict);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, strict);
    assert.deepEqual(fs.readdirSync(dir), [fileName]);
  } finally { fs.closeSync(fd); }
});

test('a proven exited writer lock is recovered, never a live writer lock', t => {
  const dir = temp(t);
  isolatedStore().setStoredAnswerPolicy('mode', strict, dir);
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(exited.status, 0);
  const exitedPid = Number(exited.stdout.trim());
  assert.ok(Number.isSafeInteger(exitedPid) && exitedPid > 0, JSON.stringify(exited.stdout));
  assert.throws(() => process.kill(exitedPid, 0), error => error.code === 'ESRCH', 'fixture uses a proven exited process');
  fixtureLock(dir, exitedPid);
  const store = isolatedStore();
  store.setStoredAnswerPolicy('other', general, dir);
  assert.equal(store.getStoredAnswerPolicy('mode', dir), strict);
  assert.equal(store.getStoredAnswerPolicy('other', dir), general);
  assert.deepEqual(fs.readdirSync(dir), [fileName]);
  const live = fixtureLock(dir, process.pid);
  let now = 0;
  const clock = class extends Date { static now() { now += 200; return now; } };
  const liveStore = isolatedStore({ Date: clock, Atomics: { wait: () => 'timed-out' } });
  assert.throws(() => liveStore.setStoredAnswerPolicy('mode', general, dir), e => e.code === 'EBUSY');
  assert.deepEqual(fs.readdirSync(live.lock), [live.owner]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, strict);
});

for (const platform of ['win32', 'darwin']) test(`${platform}: readers respect the native replacement/held-writer contract`, t => {
  const dir = temp(t);
  isolatedStore().setStoredAnswerPolicy('mode', strict, dir);
  const live = fixtureLock(dir, process.pid);
  let now = 0;
  const clock = class extends Date { static now() { now += 200; return now; } };
  const store = storeWithFs({}, platform, { Date: clock });
  if (platform === 'win32') assert.throws(() => store.getStoredAnswerPolicy('mode', dir), e => e.code === 'EBUSY');
  else assert.equal(store.getStoredAnswerPolicy('mode', dir), strict, 'macOS reads the last atomic snapshot without waiting on a writer');
  assert.deepEqual(fs.readdirSync(live.lock), [live.owner]);
});

test('staging write failure does not change the committed map or leak a writer lock', t => {
  const dir = temp(t);
  isolatedStore().setStoredAnswerPolicy('mode', strict, dir);
  const store = storeWithFs({ fsyncSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  assert.throws(() => store.setStoredAnswerPolicy('other', general, dir), e => e.code === 'ENOSPC');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')), { mode: strict });
  assert.equal(store.getStoredAnswerPolicy('mode', dir), strict);
  assert.deepEqual(fs.readdirSync(dir), [fileName]);
});

test('rapid serial atomic replacements persist each acknowledged policy', t => {
  const dir = temp(t);
  const store = isolatedStore();
  for (let i = 0; i < 300; i++) {
    const policy = i % 2 ? strict : general;
    store.setStoredAnswerPolicy('mode', policy, dir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')).mode, policy);
    assert.equal(store.getStoredAnswerPolicy('mode', dir), policy);
  }
  assert.deepEqual(fs.readdirSync(dir), [fileName], 'successful writes leave no temp or lock files');
});

test('independent warm caches cannot overwrite another writer or miss its next policy', t => {
  const dir = temp(t);
  const a = isolatedStore();
  const b = isolatedStore();
  assert.equal(a.getStoredAnswerPolicy('mode-a', dir), null);
  assert.equal(b.getStoredAnswerPolicy('mode-b', dir), null);
  a.setStoredAnswerPolicy('mode-a', strict, dir);
  assert.equal(b.getStoredAnswerPolicy('mode-a', dir), strict, 'independent reader must see the committed policy');
  b.setStoredAnswerPolicy('mode-b', general, dir);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
  assert.deepEqual(persisted, { 'mode-a': strict, 'mode-b': general }, 'merge against current disk, not a stale process cache');
  a.setStoredAnswerPolicy('mode-a', null, dir);
  assert.equal(b.getStoredAnswerPolicy('mode-a', dir), null);
  assert.equal(a.getStoredAnswerPolicy('mode-b', dir), general);
});

test('a writer merges another isolate\'s committed mode rather than its cached empty snapshot', t => {
  const dir = temp(t);
  const a = isolatedStore();
  const b = isolatedStore();
  a.getStoredAnswerPolicy('mode-a', dir);
  b.getStoredAnswerPolicy('mode-b', dir);
  a.setStoredAnswerPolicy('mode-a', strict, dir);
  b.setStoredAnswerPolicy('mode-b', general, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')), { 'mode-a': strict, 'mode-b': general });
});

test('simultaneous actual writers and read loops retain every acknowledged mode without partial JSON', { timeout: 60000 }, async t => {
  const dir = temp(t);
  const store = isolatedStore();
  store.setStoredAnswerPolicy('seed', strict, dir);
  const result = await race(t, dir);
  const errorsByCode = result.errors.reduce((counts, e) => { counts[e.code] = (counts[e.code] ?? 0) + 1; return counts; }, {});
  t.diagnostic(JSON.stringify({ platform: process.platform, writes: result.writes, reads: result.reads, errorsByCode, firstErrors: result.errors.slice(0, 4).map(({code, syscall, file}) => ({code, syscall, file})) }));
  assert.equal(result.errors.length, 0, `actual filesystem failures must not lose a requested policy: ${JSON.stringify(errorsByCode)}`);
  assert.equal(result.writes, 244);
  assert.ok(result.reads > 0);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
  assert.equal(persisted.seed, strict);
  for (let id = 0; id < 4; id++) assert.equal(persisted[`writer-${id}`], strict);
  assert.deepEqual(fs.readdirSync(dir), [fileName]);
});
