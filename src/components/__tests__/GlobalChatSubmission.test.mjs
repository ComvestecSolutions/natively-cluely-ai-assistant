import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import test from 'node:test';
import ts from 'typescript';


const source = fs.readFileSync(new URL('../GlobalChatOverlay.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

// Execute the actual component/effects with deterministic hook and IPC scheduling;
// no browser, provider, credentials, or native Electron dependencies are involved.
function harness() {
  const slots = [];
  const effects = [];
  const timers = new Map();
  const listeners = new Map();
  const requests = [];
  let cursor = 0;
  let timerId = 0;
  let messageId = 0;
  let props;
  let tree;
  let buffered = '';
  let pins = ['pinned-course'];
  let now = 0;
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) {
      const i = cursor++;
      return slots[i] ??= { current: initial };
    },
    useCallback(callback) { cursor++; return callback; },
    useEffect(callback, deps) {
      const i = cursor++;
      const old = slots[i];
      if (!old || deps.some((dep, n) => !Object.is(dep, old.deps[n]))) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; });
      }
    },
  };
  const subscribe = (channel) => (callback) => {
    const set = listeners.get(channel) ?? new Set();
    listeners.set(channel, set);
    set.add(callback);
    return () => set.delete(callback);
  };
  const api = {
    onChatStreamPolicy: subscribe('policy'),
    onRAGStreamChunk: subscribe('chunk'),
    onRAGStreamComplete: subscribe('done'),
    onRAGStreamError: subscribe('error'),
    ragQueryGlobal(question, courseIds, requestId) {
      assert.equal(listeners.get('chunk')?.size, 1, 'subscribe before dispatch');
      assert.equal(listeners.get('done')?.size, 1, 'subscribe before dispatch');
      return new Promise((resolve) => requests.push({ question, courseIds, requestId, resolve }));
    },
    ragCancelQuery: async () => ({ success: true }),
    onGeminiStreamToken: subscribe('fallback-token'),
    onGeminiStreamDone: subscribe('fallback-done'),
    onGeminiStreamError: subscribe('fallback-error'),
    streamGeminiChat: async (...args) => { api.fallbackArgs = args; emit('fallback-done'); },
  };
  const streamBuffer = {
    reset: () => { buffered = ''; },
    appendToken: (token, flush) => { buffered += token; flush(buffered); },
    getBufferedContent: () => buffered,
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, console, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    window: { electronAPI: api, addEventListener() {}, removeEventListener() {} },
    require(id) {
      if (id === 'react') return hooks;
      if (id.includes('useStreamBuffer')) return { useStreamBuffer: () => streamBuffer };
      if (id.includes('useResolvedTheme')) return { useResolvedTheme: () => 'dark' };
      if (id.includes('coursePins')) return { getCoursePinIds: () => [...pins] };
      if (id.includes('messageId')) return { genMessageId: () => `m${++messageId}` };
      if (id.includes('displayMarkup')) return { stripGistTrailer: (s) => s };
      if (id === 'framer-motion') return { motion: new Proxy({}, { get: (_, key) => key }), AnimatePresence: 'presence' };
      return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) });
    },
  });
  vm.runInContext(compiled, context, { filename: 'GlobalChatOverlay.js' });
  const Component = module.exports.default;
  function render(next = props) {
    props = next;
    cursor = 0;
    tree = Component(props);
    effects.splice(0).forEach((effect) => effect());
  }
  const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); render(); };
  async function advanceShortTimers() {
    for (let round = 0; round < 4; round++) {
      const pending = [...timers].filter(([, timer]) => timer.ms < 1000);
      if (!pending.length) break;
      for (const [id, timer] of pending) { timers.delete(id); timer.fn(); }
      await settle();
    }
  }
  function emit(channel, data) { [...(listeners.get(channel) ?? [])].forEach((fn) => fn(data)); }
  async function finish(text = 'Answer') {
    emit('chunk', { global: true, chunk: text });
    emit('done', { global: true });
    requests.at(-1).resolve({ success: true });
    await settle();
    await advanceShortTimers();
  }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]); next[1].fn();
      await settle();
    }
    now = end;
    await settle();
  }
  return { render, requests, slots, timers, api, settle, advance, advanceShortTimers, finish, emit,
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    setPins: (next) => { pins = next; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

const open = (initialQuery) => ({ isOpen: true, initialQuery, onClose() {} });

test('initial global query subscribes before invoking IPC and forwards course pins', async () => {
  const h = harness();
  h.render(open('first question'));
  await h.advanceShortTimers();
  assert.equal(h.requests.length, 1);
  assert.deepEqual([...h.requests[0].courseIds ?? []], ['pinned-course']);
  await h.finish();
});

test('a parent query arriving while busy is dispatched after the current turn, not dropped', async () => {
  const h = harness();
  h.render(open('first question'));
  await h.advanceShortTimers();
  h.render(open('second question'));
  await h.advanceShortTimers();
  assert.equal(h.requests.length, 1, 'one stream at a time');
  await h.finish();
  assert.deepEqual(h.requests.map((r) => r.question), ['first question', 'second question']);
  await h.finish();
});

test('closing before an initial-query timer fires must not create a bubble or dispatch', async () => {
  const h = harness();
  h.render(open('cancelled question'));
  h.render({ ...open('cancelled question'), isOpen: false });
  await h.advanceShortTimers();
  assert.equal(h.requests.length, 0);
  assert.equal(h.slots[0].length, 0);
});

test('rerenders do not resubmit the same initial query; reopening can submit it again', async () => {
  const h = harness();
  h.render(open('repeatable question'));
  await h.advanceShortTimers();
  await h.finish();
  h.render(open('repeatable question'));
  await h.advanceShortTimers();
  assert.equal(h.requests.length, 1);
  h.render({ ...open('repeatable question'), isOpen: false });
  h.render(open('repeatable question'));
  await h.advanceShortTimers();
  assert.equal(h.requests.length, 2);
  await h.finish();
});

test('explicit IPC failure leaves an actionable error, never an empty streaming bubble', async () => {
  const h = harness();
  h.render(open('failing question'));
  await h.advanceShortTimers();
  h.requests[0].resolve({ success: false, error: 'backend failed' });
  await h.settle();
  assert.equal(h.slots[1], 'error');
  assert.equal(h.slots[0].filter((m) => m.role === 'assistant' && !m.content).length, 0);
});

test('fallback preserves the pins captured for the original global request', async () => {
  const h = harness();
  h.render(open('fallback question'));
  await h.advanceShortTimers();
  h.setPins(['changed-mid-request']);
  h.requests[0].resolve({ fallback: true });
  await h.settle();
  assert.deepEqual([...h.api.fallbackArgs[3].courseIds], ['pinned-course']);
  assert.equal(h.api.fallbackArgs[3].selectedModelOnly, true);
  assert.equal(h.slots[0].filter((m) => m.isStreaming).length, 0);
});

test('IPC success without a done event finalizes buffered text instead of an empty bubble', async () => {
  const h = harness();
  h.render(open('missing terminal event'));
  await h.advanceShortTimers();
  h.emit('chunk', { global: true, chunk: 'Buffered answer' });
  h.requests[0].resolve({ success: true });
  await h.settle();
  const answer = h.slots[0].find((m) => m.role === 'assistant');
  assert.equal(answer.content, 'Buffered answer');
  assert.equal(answer.isStreaming, false);
});

test('a terminal event releases the busy guard even when invoke never settles', async () => {
  const h = harness();
  h.render(open('terminal without invoke')); await h.advanceShortTimers();
  h.emit('chunk', { global: true, requestId: h.requests[0].requestId, chunk: 'Complete answer' });
  h.emit('done', { global: true, requestId: h.requests[0].requestId });
  await h.settle();
  h.render(open('follow-up')); await h.advanceShortTimers();
  assert.equal(h.requests.length, 2, 'finished turn must not keep a later question queued');
  assert.equal(h.slots[0].find(m => m.role === 'assistant').content, 'Complete answer');
  await h.finish();
});

test('client timeout cancels the global request and allows a later question', async () => {
  const h = harness();
  let cancelled = 0;
  h.api.ragCancelQuery = async ({ global }) => { assert.equal(global, true); cancelled++; };
  h.render(open('hung question'));
  await h.advanceShortTimers();
  const timeout = [...h.timers.values()].find((timer) => timer.ms === 20000);
  assert.ok(timeout);
  timeout.fn();
  await h.settle();
  assert.equal(cancelled, 1);
  assert.equal(h.slots[1], 'error');
  assert.equal(h.slots[0].filter((m) => m.isStreaming).length, 0);
  h.render(open('next question'));
  await h.advanceShortTimers();
  assert.equal(h.requests.length, 2);
  await h.finish();
});

test('local policy keeps one global request alive through 90s warmup without exposing reasoning', async () => {
  const h = harness();
  h.render(open('local warmup')); await h.advanceShortTimers();
  h.emit('policy', { requestId: h.requests[0].requestId, source: 'rag', firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000 });
  await h.advance(90000);
  assert.equal(h.slots[1], 'waiting_for_llm');
  assert.equal(h.requests.length, 1);
  await h.finish('Local answer');
  assert.equal(h.slots[1], 'idle');
  assert.equal(h.listenerCount(), 0);
});

test('local policy has a fixed total ceiling, never extended by repeated metadata or tokens', async () => {
  const h = harness(); let cancelled = 0;
  h.api.ragCancelQuery = async () => { cancelled++; };
  h.render(open('endless local')); await h.advanceShortTimers();
  const policy = { requestId: h.requests[0].requestId, source: 'rag', firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000 };
  h.emit('policy', policy);
  await h.advance(250000);
  h.emit('policy', policy); h.emit('chunk', { global: true, requestId: policy.requestId, chunk: 'Still running' });
  await h.advance(52000);
  assert.equal(cancelled, 1); assert.equal(h.slots[1], 'error');
  assert.equal(h.listenerCount(), 0);
});

test('closing a pending global query cancels immediately and reopening ignores its late events', async () => {
  const h = harness(); let cancelled = 0;
  h.api.ragCancelQuery = async () => { cancelled++; };
  h.render(open('old turn')); await h.advanceShortTimers();
  const oldId = h.requests[0].requestId;
  h.render({ ...open('old turn'), isOpen: false }); await h.settle();
  assert.equal(cancelled, 1); assert.equal(h.listenerCount(), 0);
  h.render(open('new turn')); await h.advanceShortTimers();
  assert.equal(h.requests.length, 2);
  h.emit('chunk', { global: true, requestId: oldId, chunk: 'STALE' });
  h.emit('policy', { requestId: oldId, source: 'rag', firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000 });
  assert.ok(!h.slots[0].some((m) => m.content.includes('STALE')));
  await h.advance(20001);
  assert.equal(h.slots[1], 'error', 'stale metadata cannot extend a new cloud query');
});

test('unmount cancels the selected-model fallback and removes every listener', async () => {
  const h = harness(); let cancelled = 0;
  h.api.cancelChatStream = () => { cancelled++; };
  h.api.streamGeminiChat = (...args) => { h.api.fallbackArgs = args; return new Promise(() => {}); };
  h.render(open('fallback close')); await h.advanceShortTimers();
  h.requests[0].resolve({ fallback: true }); await h.settle();
  h.unmount(); await h.settle();
  assert.equal(cancelled, 1); assert.equal(h.listenerCount(), 0);
});

test('selected fallback adopts its local timing before invoke, dispatching once', async () => {
  const h = harness(); let resolve;
  h.api.streamGeminiChat = (...args) => {
    h.api.fallbackArgs = args;
    h.emit('policy', { requestId: args[3].requestId, source: 'fallback', streamId: 8, firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000 });
    return new Promise((r) => { resolve = r; });
  };
  h.render(open('fallback warmup')); await h.advanceShortTimers();
  h.requests[0].resolve({ fallback: true }); await h.settle();
  await h.advance(90000);
  assert.equal(h.slots[1], 'waiting_for_llm'); assert.equal(h.requests.length, 1);
  h.emit('fallback-token', 'Selected local answer'); h.emit('fallback-done', { streamId: 8 });
  resolve(); await h.settle();
  assert.equal(h.slots[1], 'idle'); assert.equal(h.listenerCount(), 0);
});

test('global header removes the pin control without removing independent grounding', () => {
  assert.doesNotMatch(source, /CoursePinBar/);
  assert.match(source, /ragQueryGlobal\(question, courseIds, assistantMessageId\)/);
});
