import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const { raceStreamWithDeadline } = require('../../../dist-electron/electron/llm/liveDeadlines.js');
const { DirectAssistService } = require('../../../dist-electron/electron/direct-assist/index.js');
const { WhatToAnswerLLM } = require('../../../dist-electron/electron/llm/WhatToAnswerLLM.js');
const delta = content => `data:${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const reasoning = `data:${JSON.stringify({ choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING' } }] })}\n\n`;
const provider = (url = 'http://127.0.0.1:1234/v1/chat/completions') => ({
  id: 'lm-studio', name: 'LM Studio', responsePath: 'choices[0].message.content',
  curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'qwen-selected', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
});
function helper(p = provider()) {
  const h = Object.create(LLMHelper.prototype);
  Object.assign(h, {
    customProvider: p, activeCurlProvider: null, configuredCustomProviders: [p],
    currentModelId: 'gemini-previous', useOllama: false, isLocalOnlyMode: false,
    groqFastTextMode: false, answerLatency: new Map(),
    assertOutboundScopes: () => {}, isProviderDisabled: () => false,
    getDeniedOutboundScopes: () => [], resolveOutboundVisionDecision: async () => ({ decision: { action: 'allow' }, localAvailable: false }),
    injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
    buildTextSpareRungs: () => [],
    getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }),
    fitContextForCurrentModel: x => x,
  });
  return h;
}
const args = signal => ['question', undefined, undefined, 'answer grounded question', true, true, [], signal, 0, { v3Owned: true }];
async function flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }
async function collect(stream) { let out = ''; for await (const x of stream) out += x; return out; }
async function collectDirectAssist(stream, events) {
  while (true) {
    const next = await stream.next();
    if (next.done) return next.value;
    events.push(next.value);
  }
}
function assertDirectAssistCompleted(events, outcome, requests) {
  assert.equal(outcome.state, 'complete');
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Selected local answer. Complete.');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(events.some(e => ['error', 'cancel', 'provider_switch'].includes(e.type)), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING/);
  assert.equal(requests.length, 1, 'accepted local generation must never be replayed');
  assert.equal(requests[0].payload.model, 'qwen-selected');
  assert.equal(requests[0].payload.stream, true);
}
function fakeFetch(t) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    let body;
    const response = new Response(new ReadableStream({
      start(c) { body = c; opts.signal.addEventListener('abort', () => { try { c.error(new Error('PRIVATE transport cancelled')); } catch {} }, { once: true }); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    requests.push({ url, body, signal: opts.signal, payload: JSON.parse(opts.body) });
    return response;
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}
for (const lane of ['custom', 'curl', 'what-to-answer']) {
  test(`${lane}: actual selected live stream survives 40s warmup and 160s hidden reasoning under caller route default`, async t => {
    const requests = fakeFetch(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const h = helper();
    if (lane === 'curl') { h.activeCurlProvider = h.customProvider; h.customProvider = null; }
    const ctrl = new AbortController();
    t.after(() => ctrl.abort());
    let text = '';
    const liveStream = lane === 'what-to-answer'
      ? new WhatToAnswerLLM(h, {}).generateStream('Explain the concept.', undefined, undefined, undefined, undefined, undefined, { id: 'test', name: 'test', promptBlock: 'Answer the question.' }, undefined, undefined, undefined, undefined, undefined, ctrl.signal)
      : h.streamChat(...args(ctrl.signal));
    const pending = raceStreamWithDeadline({ stream: liveStream, firstUsefulDeadlineMs: 15_000, interTokenStallMs: 8_000,
      isUsefulYet: () => text.trim().length >= 5, onToken: x => { text += x; }, onCleanup: reason => { if (reason !== 'done') ctrl.abort(); } });
    await flush();
    assert.equal(requests.length, 1);
    t.mock.timers.tick(40_000); await flush();
    const warmupAborted = requests[0].signal.aborted;
    if (!warmupAborted) {
      requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
      for (let i = 0; i < 4; i++) { t.mock.timers.tick(20_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush(); }
      requests[0].body.enqueue(Buffer.from(delta('Selected local answer.'))); await flush();
      // Reasoning is activity after the first visible token too, not a second answer.
      for (let i = 0; i < 4; i++) { t.mock.timers.tick(20_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush(); }
      requests[0].body.enqueue(Buffer.from(delta(' Complete.') + 'data:[DONE]\n\n')); requests[0].body.close();
    }
    const outcome = await pending;
    assert.equal(warmupAborted, false, '15s user-endpoint default aborted a healthy selected local request');
    assert.equal(outcome, 'done');
    assert.equal(text, 'Selected local answer. Complete.');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.model, 'qwen-selected');
    assert.equal(requests[0].payload.stream, true);
  });
}
test('explicit Fast Response pick retains the caller deadline even when active model is local', async t => {
  fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = helper(); const ctrl = new AbortController();
  h.resolveFastPick = () => ({ modelId: 'fast-cloud', family: 'openai', auto: false });
  h._streamChatInner = async function* () { await new Promise(resolve => ctrl.signal.addEventListener('abort', resolve, { once: true })); };
  const pending = raceStreamWithDeadline({ stream: h.streamChat(...args(ctrl.signal)), firstUsefulDeadlineMs: 15_000,
    isUsefulYet: () => false, onToken: () => {}, onCleanup: () => ctrl.abort() });
  await flush(); t.mock.timers.tick(15_001); await flush();
  assert.equal(await pending, 'first_useful_timeout');
});
test('actual Direct Assist service survives 40s warmup, 160s hidden reasoning and 80s post-answer activity', async t => {
  const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = helper(); const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const events = [];
  const stream = new DirectAssistService(h).stream({ requestId: 'local-direct', source: 'typed', selection: { provider: 'custom', model: 'lm-studio' }, currentRequest: 'Answer the question.' }, ctrl.signal);
  const pending = collectDirectAssist(stream, events);
  await flush(); assert.equal(requests.length, 1);
  t.mock.timers.tick(40_000); await flush();
  assert.equal(requests[0].signal.aborted, false, 'default cloud TTFT must not cancel selected local warmup');
  requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(20_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    assert.equal(requests[0].signal.aborted, false);
  }
  assert.equal(events.some(e => e.type === 'delta'), false, 'reasoning is activity, not visible answer text');
  requests[0].body.enqueue(Buffer.from(delta('Selected local answer.'))); await flush();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(20_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    assert.equal(requests[0].signal.aborted, false);
  }
  requests[0].body.enqueue(Buffer.from(delta(' Complete.') + 'data:[DONE]\n\n')); requests[0].body.close();
  assertDirectAssistCompleted(events, await pending, requests);
});
test('streamRAGAnswer must be selected-model based, not legacy Gemini tier based', async () => {
  const h = helper(); let seen;
  h._streamChatInner = async function* (...call) { seen = { model: this.currentModelId, custom: this.customProvider, fast: this.fastPickForTextTurn(), call }; yield 'grounded'; };
  h.groqFastTextMode = true;
  h.resolveFastPick = function () { return this.groqFastTextMode ? { modelId: 'background', family: 'openai', auto: false } : null; };
  const signal = new AbortController().signal;
  assert.equal(typeof h.streamRAGAnswer, 'function', 'grounding needs a selected-provider helper rather than hardcoded Gemini tiers');
  const { stream, outcome } = h.streamRAGAnswer(...args(signal));
  h.customProvider = provider('https://other.example/v1/chat/completions');
  h.currentModelId = 'other-model';
  assert.equal(await collect(stream), 'grounded');
  assert.equal(seen.custom.curlCommand, provider().curlCommand);
  assert.equal(seen.model, 'gemini-previous');
  assert.equal(seen.fast, null);
  assert.equal(seen.call[7], signal);
  assert.equal(outcome.truncated, false);
});

test('explicit caller quick budget can override local warmup policy', async t => {
  const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctrl = new AbortController(); let text = '';
  const pending = raceStreamWithDeadline({ stream: helper().streamChat(...args(ctrl.signal)), firstUsefulDeadlineMs: 2000,
    deadlinePolicy: 'caller', isUsefulYet: () => false, onToken: x => { text += x; }, onCleanup: () => ctrl.abort() });
  await flush(); t.mock.timers.tick(2001); await flush();
  assert.equal(await pending, 'first_useful_timeout');
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(text, '');
});
for (const lane of ['custom', 'curl']) {
  test(`${lane}: caller cancellation during hidden reasoning is immediate, silent and never retried`, async t => {
    const requests = fakeFetch(t); const ctrl = new AbortController();
    const h = helper(); if (lane === 'curl') { h.activeCurlProvider = h.customProvider; h.customProvider = null; }
    let text = '';
    const pending = raceStreamWithDeadline({ stream: h.streamChat(...args(ctrl.signal)), firstUsefulDeadlineMs: 15000,
      isUsefulYet: () => false, onToken: x => { text += x; } });
    await flush(); requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    ctrl.abort(); await flush();
    assert.equal(await pending, 'aborted');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests.length, 1);
    assert.equal(text, '');
  });
}
test('local body silence is still bounded with meaningful sanitized errors', async t => {
  const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  let text = '';
  const pending = raceStreamWithDeadline({ stream: helper().streamChat(...args(ctrl.signal)), firstUsefulDeadlineMs: 15000,
    isUsefulYet: () => false, onToken: x => { text += x; } });
  await flush(); requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  t.mock.timers.tick(60001); await flush();
  assert.equal(await pending, 'done'); // legacy live contract reports failure as safe Error: prose
  assert.match(text, /Error: Custom provider timed out waiting for response data/);
  assert.doesNotMatch(text, /PRIVATE|Error streaming from custom provider/);
  assert.equal(requests.length, 1);
});
test('outer local warmup remains bounded even if preparation never reaches fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = helper(); const ctrl = new AbortController();
  h._streamChatInner = async function* () { await new Promise(resolve => ctrl.signal.addEventListener('abort', resolve, { once: true })); };
  const pending = raceStreamWithDeadline({ stream: h.streamChat(...args(ctrl.signal)), firstUsefulDeadlineMs: 15000,
    isUsefulYet: () => false, onToken: () => {}, onCleanup: () => ctrl.abort() });
  await flush(); t.mock.timers.tick(300001); await flush();
  assert.equal(await pending, 'first_useful_timeout');
});
test('unknown custom backend errors explain configuration failure without disclosing their message', async () => {
  const h = helper();
  h.streamWithCustom = async function* () { throw new Error('https://SECRET_URL user password Authorization SECRET_PROMPT'); };
  const text = await collect(h.streamChat(...args(undefined)));
  assert.match(text, /saved cURL URL and JSON template/);
  assert.doesNotMatch(text, /SECRET|Authorization|password|Error streaming from custom provider/);
});
test('selected Gemini RAG uses the exact model and preserves post-commit truncation outcome', async () => {
  const h = helper(); h.customProvider = null; h.currentModelId = 'gemini-3.7-pro'; h._client = {};
  let model;
  h.streamWithGeminiModel = async function* (_user, id) { model = id; yield 'grounded partial'; throw new Error('socket failed'); };
  const { stream, outcome } = h.streamRAGAnswer(...args(undefined));
  h.currentModelId = 'gemini-other';
  assert.equal(await collect(stream), 'grounded partial');
  assert.equal(model, 'gemini-3.7-pro', 'never substitute Gemini Flash tier model');
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.reason, 'provider_failed_after_first_token');
});
test('selected custom RAG sends frozen cURL model and grounded system/context in one request', async t => {
  const requests = fakeFetch(t); const h = helper();
  const ragArgs = args(undefined); ragArgs[2] = 'Retrieved evidence'; ragArgs[6] = ['transcript'];
  const { stream, outcome } = h.streamRAGAnswer(...ragArgs);
  h.customProvider = provider('https://other.example/v1/chat/completions');
  const pending = collect(stream); await flush();
  requests[0].body.enqueue(Buffer.from(delta('grounded answer') + 'data:[DONE]\n\n')); requests[0].body.close();
  assert.equal(await pending, 'grounded answer');
  assert.equal(requests[0].payload.model, 'qwen-selected');
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.match(requests[0].payload.messages[1].content, /Retrieved evidence/);
  assert.match(requests[0].payload.messages[0].content, /answer grounded question/);
  assert.equal(outcome.truncated, false);
});
for (const selected of ['custom', 'antigravity']) {
  function configuredRemoteHelper(t, partial = false) {
    const h = helper(selected === 'custom' ? provider('https://selected.example/v1/chat/completions') : null);
    h.currentModelId = selected === 'custom' ? 'gemini-previous' : 'antigravity:exact-selected-model';
    h._openaiClient = {};
    const calls = { primary: 0, spare: 0, sparePlans: 0, models: [] };
    h.streamWithOpenai = async function* () { calls.spare++; yield 'SECOND_PROVIDER_ANSWER'; };
    h.buildTextSpareRungs = () => {
      calls.sparePlans++;
      return [{ id: 'openai', name: 'Configured OpenAI', isLocal: false, priority: 1,
        ttftTimeoutMs: 1000, open: () => h.streamWithOpenai() }];
    };
    if (selected === 'custom') {
      const original = globalThis.fetch;
      globalThis.fetch = async (_url, options) => {
        calls.primary++;
        calls.models.push(JSON.parse(options.body).model);
        return partial
          ? new Response(delta('grounded partial'), { headers: { 'Content-Type': 'text/event-stream' } })
          : new Response('PRIVATE_REMOTE_ERROR', { status: 503 });
      };
      t.after(() => { globalThis.fetch = original; });
    } else {
      h.streamWithAntigravity = async function* (_user, _system, _images, _signal, model = this.currentModelId) {
        calls.primary++;
        calls.models.push(model);
        if (partial) yield 'grounded partial';
        throw new Error('selected Antigravity failed');
      };
    }
    return { h, calls };
  }
  test(`RAG selected-only ${selected} failure never calls a configured second provider or retries`, async t => {
    const { h, calls } = configuredRemoteHelper(t);
    const { stream } = h.streamRAGAnswer(...args(undefined));
    h.currentModelId = 'gemini-changed';
    h.customProvider = provider('https://changed.example/v1/chat/completions');
    let failure;
    let text = '';
    try { text = await collect(stream); } catch (error) { failure = error; }
    assert.equal(calls.spare, 0, 'selected-only must never dispatch the configured spare');
    assert.equal(calls.sparePlans, 0, 'selected-only must bypass failover planning entirely');
    assert.equal(calls.primary, 1, 'selected-only must not hedge or retry the selected model');
    assert.deepEqual(calls.models, [selected === 'custom' ? 'qwen-selected' : 'antigravity:exact-selected-model']);
    assert.ok(failure, 'selected-provider failure must reject, not become a second provider answer');
    assert.doesNotMatch(`${text}${failure.message}`, /SECOND_PROVIDER_ANSWER|PRIVATE_REMOTE_ERROR/);
    if (selected === 'custom') assert.match(failure.message, /HTTP 503/);
  });
  test(`legacy ${selected} failover still uses a configured second provider`, async t => {
    const { h, calls } = configuredRemoteHelper(t);
    assert.equal(await collect(h.streamChat(...args(undefined))), 'SECOND_PROVIDER_ANSWER');
    assert.equal(calls.spare, 1);
    assert.equal(calls.sparePlans, 1);
    assert.ok(calls.primary >= 1);
  });
  test(`RAG selected-only ${selected} post-commit failure preserves partial output and truncation`, async t => {
    const { h, calls } = configuredRemoteHelper(t, true);
    const { stream, outcome } = h.streamRAGAnswer(...args(undefined));
    assert.equal(await collect(stream), 'grounded partial');
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.reason, 'provider_failed_after_first_token');
    assert.equal(calls.primary, 1);
    assert.equal(calls.spare, 0);
    assert.equal(calls.sparePlans, 0);
  });
}
test('reasoning that never produces an answer cannot extend the existing five-minute transport ceiling', async t => {
  const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const pending = collect(helper().streamChat(...args(ctrl.signal)));
  await flush(); requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  for (let i = 0; i < 14; i++) { t.mock.timers.tick(20000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush(); }
  t.mock.timers.tick(20001); await flush();
  const answer = await pending;
  assert.match(answer, /Error: Custom provider timed out waiting for response data/);
  assert.doesNotMatch(answer, /PRIVATE_REASONING/);
  assert.equal(requests.length, 1);
});
test('raw Direct Assist exposes the frozen local rung policy even if a remote provider is active', async t => {
  const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { providerStreamPolicy } = require('../../../dist-electron/electron/llm/providerStreamPolicy.js');
  const h = helper(); h.customProvider = provider('https://remote.example/v1/chat/completions'); h.customProvider.id = 'remote';
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const stream = h.streamDirectAssist({ requestId: 'raw-direct', selection: { provider: 'custom', model: 'lm-studio' }, systemPrompt: 'system', userPrompt: 'question', imagePaths: [] }, ctrl.signal);
  const policy = providerStreamPolicy(stream);
  assert.equal(policy.firstUsefulDeadlineMs, 300000);
  assert.equal(policy.interTokenStallMs, 60000);
  assert.equal(requests.length, 0);
  const pending = collect(stream); await flush();
  t.mock.timers.tick(90000); await flush();
  assert.equal(requests[0].signal.aborted, false);
  requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  assert.equal(policy.lastActivityAt, Date.now());
  requests[0].body.enqueue(Buffer.from(delta('direct answer') + 'data:[DONE]\n\n')); requests[0].body.close();
  assert.equal(await pending, 'direct answer');
  assert.equal(requests[0].payload.model, 'qwen-selected');
});
test('explicit 120s TTFT allows local reasoning past the old 45s service watchdog and completes', async t => {
  const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctrl = new AbortController(); t.after(() => ctrl.abort()); const events = [];
  const service = new DirectAssistService(helper(), { fallbackConfigOverrides: { ttftTimeoutMs: 120_000 } });
  const pending = collectDirectAssist(service.stream({ requestId: 'local-watchdog', source: 'typed', selection: { provider: 'custom', model: 'lm-studio' }, currentRequest: 'Answer.' }, ctrl.signal), events);
  await flush(); assert.equal(requests.length, 1);
  requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  t.mock.timers.tick(45_001); await flush();
  assert.equal(requests[0].signal.aborted, false, 'default service idle must honor live local reasoning');
  requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(20_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush(); }
  assert.equal(events.some(e => e.type === 'delta'), false);
  requests[0].body.enqueue(Buffer.from(delta('Selected local answer.'))); await flush();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(20_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush(); }
  requests[0].body.enqueue(Buffer.from(delta(' Complete.') + 'data:[DONE]\n\n')); requests[0].body.close();
  assertDirectAssistCompleted(events, await pending, requests);
});
for (const [name, options, budgetMs, code] of [
  ['explicit 120s TTFT', { fallbackConfigOverrides: { ttftTimeoutMs: 120_000 } }, 120_000, 'CONNECT_TIMEOUT'],
  ['explicit 45s service idle', { streamIdleTimeoutMs: 45_000 }, 45_000, 'STREAM_IDLE_TIMEOUT'],
]) {
  test(`${name} still bounds hidden reasoning without replay or leaking content`, async t => {
    const requests = fakeFetch(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const ctrl = new AbortController(); t.after(() => ctrl.abort()); const events = [];
    const service = new DirectAssistService(helper(), options);
    const pending = collectDirectAssist(service.stream({ requestId: 'local-explicit-budget', source: 'typed', selection: { provider: 'custom', model: 'lm-studio' }, currentRequest: 'Answer.' }, ctrl.signal), events);
    await flush(); assert.equal(requests.length, 1);
    requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
    for (let elapsed = 10_000; elapsed < budgetMs; elapsed += 10_000) {
      t.mock.timers.tick(10_000); requests[0].body.enqueue(Buffer.from(reasoning)); await flush();
      assert.equal(requests[0].signal.aborted, false);
    }
    t.mock.timers.tick(budgetMs % 10_000 === 0 ? 9_999 : budgetMs % 10_000 - 1); await flush();
    assert.equal(requests[0].signal.aborted, false, 'the explicit budget must not expire early');
    t.mock.timers.tick(2); await flush();
    assert.equal((await pending).state, 'failed');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests.length, 1);
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    assert.equal(events.at(-1).error.code, code);
    assert.equal(events.at(-1).partial, false);
    assert.equal(events.some(e => ['done', 'cancel', 'provider_switch', 'delta'].includes(e.type)), false);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  });
}
