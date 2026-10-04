import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const { DirectAssistService } = require('../../../dist-electron/electron/direct-assist/index.js');
const { withProviderStreamPolicy } = require('../../../dist-electron/electron/llm/providerStreamPolicy.js');
const delta = content => `data:${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const reasoning = `data:${JSON.stringify({ choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING' } }] })}\n\n`;
const localProvider = () => ({
  id: 'lm-studio', name: 'LM Studio', responsePath: 'choices[0].message.content',
  curlCommand: `curl 'http://127.0.0.1:1234/v1/chat/completions' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'qwen-selected', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
});
function helper(lane) {
  const h = Object.create(LLMHelper.prototype);
  const p = localProvider();
  Object.assign(h, {
    customProvider: lane === 'custom' ? p : null, activeCurlProvider: lane === 'curl' ? p : null,
    configuredCustomProviders: [p], currentModelId: 'gemini-previous', useOllama: false,
    isLocalOnlyMode: false, groqFastTextMode: false, answerLatency: new Map(),
    assertOutboundScopes: () => {}, isProviderDisabled: () => false,
    getDeniedOutboundScopes: () => [], injectLanguageInstruction: x => x,
  });
  return h;
}
function input(provider = 'custom') {
  return { requestId: 'local-direct', source: 'typed', selection: { provider, model: 'lm-studio' }, currentRequest: 'Answer the question.' };
}
async function flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }
function harness(t, lane = 'custom', options = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    let body;
    const response = new Response(new ReadableStream({ start(c) {
      body = c;
      opts.signal.addEventListener('abort', () => { try { c.error(new Error('PRIVATE transport cancelled')); } catch {} }, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    requests.push({ url, body, signal: opts.signal, payload: JSON.parse(opts.body) });
    return response;
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); globalThis.fetch = original; });
  const events = [];
  const service = new DirectAssistService(helper(lane), options);
  const pending = (async () => {
    const stream = service.stream(input(lane), ctrl.signal);
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })();
  return { requests, ctrl, events, pending };
}
const visible = events => events.filter(e => e.type === 'delta').map(e => e.text).join('');

for (const lane of ['custom', 'curl']) {
  test(`${lane}: actual service survives 40s warmup and 160s hidden reasoning, with one selected request`, async t => {
    const h = harness(t, lane);
    await flush();
    assert.equal(h.requests.length, 1);
    t.mock.timers.tick(40_000); await flush();
    assert.equal(h.requests[0].signal.aborted, false, 'Direct Assist must not cancel accepted local warmup at 35s');
    h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    for (let i = 0; i < 8; i++) {
      t.mock.timers.tick(20_000); h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    }
    assert.equal(visible(h.events), '', 'private reasoning is activity, not a visible answer');
    h.requests[0].body.enqueue(Buffer.from(delta('Selected local answer.'))); await flush();
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(20_000); h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    }
    h.requests[0].body.enqueue(Buffer.from(delta(' Complete.') + 'data:[DONE]\n\n')); h.requests[0].body.close();
    assert.equal((await h.pending).state, 'complete');
    assert.equal(visible(h.events), 'Selected local answer. Complete.');
    assert.equal(h.events.filter(e => e.type === 'done').length, 1);
    assert.equal(h.events.some(e => ['error', 'cancel', 'provider_switch'].includes(e.type)), false);
    assert.equal(h.requests.length, 1, 'never replay the accepted generation');
    assert.equal(h.requests[0].payload.model, 'qwen-selected');
    assert.equal(h.requests[0].payload.stream, true);
  });
}

for (const lane of ['custom', 'curl']) {
  for (const phase of ['warmup', 'reasoning', 'answer']) {
    test(`${lane}: parent cancellation during ${phase} is immediate, silent and never replayed`, async t => {
      const h = harness(t, lane); await flush();
      if (phase !== 'warmup') {
        t.mock.timers.tick(40_000); await flush();
        h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
      }
      if (phase === 'answer') {
        h.requests[0].body.enqueue(Buffer.from(delta('Partial answer.'))); await flush();
      }
      h.ctrl.abort(); await flush();
      assert.equal((await h.pending).state, 'cancelled');
      assert.equal(h.requests[0].signal.aborted, true);
      assert.equal(h.requests.length, 1);
      assert.equal(h.events.filter(e => e.type === 'cancel').length, 1);
      assert.equal(h.events.some(e => ['error', 'done', 'provider_switch'].includes(e.type)), false);
      assert.equal(visible(h.events), phase === 'answer' ? 'Partial answer.' : '');
    });
  }
}

for (const [name, options, afterAnswer] of [
  ['explicit TTFT', { fallbackConfigOverrides: { ttftTimeoutMs: 2_000 } }, false],
  ['explicit inter-chunk', { fallbackConfigOverrides: { interChunkTimeoutMs: 2_000 } }, true],
  ['explicit service idle', { streamIdleTimeoutMs: 2_000 }, false],
]) {
  test(`${name} caller budget is not expanded by local metadata or hidden reasoning`, async t => {
    const h = harness(t, 'custom', options); await flush();
    if (afterAnswer) { h.requests[0].body.enqueue(Buffer.from(delta('Partial.'))); await flush(); }
    h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    t.mock.timers.tick(1_500); h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    t.mock.timers.tick(501); await flush();
    assert.equal((await h.pending).state, 'failed');
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.requests.length, 1);
    const error = h.events.find(e => e.type === 'error');
    assert.equal(error.partial, afterAnswer);
    assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE/);
  });
}

test('actual local body silence is bounded at 60s, with one sanitized failure and no replay', async t => {
  const h = harness(t); await flush();
  t.mock.timers.tick(40_000); await flush();
  h.requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  t.mock.timers.tick(59_999); await flush();
  assert.equal(h.requests[0].signal.aborted, false);
  t.mock.timers.tick(2); await flush();
  assert.equal((await h.pending).state, 'failed');
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.filter(e => e.type === 'error').length, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE/);
});

// No provider timers here: these exercise the service's independent protection
// even if an adapter ignores AbortSignal and never settles its pending next().
function policyHarness(t, { answer = false, failure, policy = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const activity = { firstUsefulDeadlineMs: 300_000, interTokenStallMs: 60_000 };
  const calls = [];
  let reads = 0;
  const transport = {
    listDirectAssistRungs: () => [
      { provider: 'custom', model: 'lm-studio', priority: 0, isFallback: false },
      { provider: 'openai', model: 'cloud', priority: 1, isFallback: true },
    ],
    streamDirectAssist(_request, signal, rung) {
      calls.push({ signal, rung });
      const stream = (async function* () {
        if (failure) throw failure;
        if (answer) yield 'Partial.';
        await new Promise(() => {});
      })();
      const next = stream.next.bind(stream);
      stream.next = (...args) => { reads += 1; return next(...args); };
      return policy ? withProviderStreamPolicy(stream, activity) : stream;
    },
  };
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const events = [];
  const pending = (async () => {
    for await (const event of new DirectAssistService(transport).stream(input(), ctrl.signal)) events.push(event);
  })();
  return { activity, calls, ctrl, events, pending, reads: () => reads };
}
for (const answer of [false, true]) {
  test(`independent service watchdog bounds reasoning silence ${answer ? 'after' : 'before'} visible output`, async t => {
    const h = policyHarness(t, { answer }); await flush();
    t.mock.timers.tick(40_000); h.activity.lastActivityAt = Date.now(); await flush();
    t.mock.timers.tick(59_999); await flush();
    assert.equal(h.calls[0].signal.aborted, false);
    t.mock.timers.tick(2); await flush(); await h.pending;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.events.at(-1).error.code, 'STREAM_IDLE_TIMEOUT');
    assert.equal(h.events.at(-1).partial, answer);
  });
  test(`independent service watchdog caps continuous reasoning at five minutes ${answer ? 'after' : 'before'} visible output`, async t => {
    const h = policyHarness(t, { answer }); await flush();
    h.activity.lastActivityAt = Date.now();
    for (let i = 0; i < 14; i++) {
      t.mock.timers.tick(20_000); h.activity.lastActivityAt = Date.now(); await flush();
    }
    assert.equal(h.calls[0].signal.aborted, false);
    assert.equal(h.reads(), answer ? 2 : 1, 'deadline checks must not issue parallel or replacement reads');
    t.mock.timers.tick(20_001); await flush(); await h.pending;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.events.at(-1).error.code, 'CONNECT_TIMEOUT');
    assert.equal(h.events.at(-1).partial, answer);
  });
}
test('independent service bounds warmup before any activity, even if the adapter ignores cancellation', async t => {
  const h = policyHarness(t); await flush();
  t.mock.timers.tick(299_999); await flush();
  assert.equal(h.calls[0].signal.aborted, false);
  t.mock.timers.tick(2); await flush(); await h.pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.events.at(-1).error.code, 'CONNECT_TIMEOUT');
});
test('parent abort ends an uncooperative local adapter without waiting for iterator cleanup', async t => {
  const h = policyHarness(t); await flush();
  h.ctrl.abort(); await flush(); await h.pending;
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.at(-1).type, 'cancel');
});
test('selected local pre-answer failure is never retried or routed to cloud, and retains provider status', async t => {
  const h = policyHarness(t, { failure: Object.assign(new Error('503 backend unavailable'), { status: 503 }) });
  await flush(); await h.pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.at(-1).type, 'error');
  assert.equal(h.events.at(-1).error.status, 503);
  assert.equal(h.events.some(e => e.type === 'provider_switch'), false);
});

test('a stream without local metadata keeps the default 35s TTFT guard', async t => {
  const h = policyHarness(t, { policy: false }); await flush();
  t.mock.timers.tick(34_999); await flush();
  assert.equal(h.calls[0].signal.aborted, false);
  t.mock.timers.tick(2); await flush();
  assert.equal(h.calls[0].signal.aborted, true);
  h.ctrl.abort(); await flush(); await h.pending;
});

test('synchronous cloud open errors retain the normal retry path', async () => {
  let calls = 0;
  const transport = { streamDirectAssist() {
    if (++calls === 1) throw Object.assign(new Error('503 unavailable'), { status: 503 });
    return (async function* () { yield 'Cloud answer.'; })();
  } };
  const events = [];
  for await (const event of new DirectAssistService(transport, { sleep: async () => {} }).stream(input('openai'))) events.push(event);
  assert.equal(calls, 2);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(visible(events), 'Cloud answer.');
});

test('actual cloud custom and Ollama streams without published timing do not acquire a local policy', () => {
  const remote = helper('custom');
  remote.customProvider.curlCommand = remote.customProvider.curlCommand.replace('http://127.0.0.1:1234', 'https://remote.example');
  const { providerStreamPolicy } = require('../../../dist-electron/electron/llm/providerStreamPolicy.js');
  for (const provider of ['custom', 'ollama']) {
    const stream = remote.streamDirectAssist({ requestId: 'remote', selection: input(provider).selection, systemPrompt: 's', userPrompt: 'u', imagePaths: [] });
    assert.equal(providerStreamPolicy(stream), undefined);
  }
});
