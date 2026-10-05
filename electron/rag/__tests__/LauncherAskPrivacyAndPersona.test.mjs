import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contract, launcherComposer, launcherFallbackHandler } from './launcherContextHarness.mjs';

// Electron-as-Node runs the real helper and custom/cURL adapters. Only HTTP and
// persistence/native seams in the launcher harness are substituted, never gates.
const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const ragModule = require('../../../dist-electron/electron/rag/RAGManager.js');
const grounding = require('../../../dist-electron/electron/courses/chatGrounding.js');
const collect = async stream => { let text = ''; for await (const part of stream) text += part; return text; };
const provider = url => ({ id: 'privacy-persona-selected', name: 'Selected provider', responsePath: 'choices[0].message.content',
  curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'exact-selected-model', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
});
function helper(route, url = 'https://selected-cloud.example/v1/chat/completions') {
  const selected = provider(url);
  const h = Object.create(LLMHelper.prototype);
  Object.assign(h, { customProvider: route === 'custom' ? selected : null, activeCurlProvider: route === 'curl' ? selected : null,
    configuredCustomProviders: [selected], currentModelId: 'gemini-background', useOllama: false, isLocalOnlyMode: false,
    answerLatency: new Map(), injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
    getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
    buildTextSpareRungs() { assert.fail('captured launcher requests cannot reroute or build spares'); },
  });
  return h;
}
function captureHTTP(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), payload: JSON.parse(options.body) });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Selected answer.' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return requests;
}
async function realHTTP(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, payload: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Selected answer.' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
}
function denyScopes(t, scopes) {
  const before = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
  if (scopes) process.env.NATIVELY_DENY_PROVIDER_SCOPES = scopes;
  else delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
  t.after(() => { if (before === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES; else process.env.NATIVELY_DENY_PROVIDER_SCOPES = before; });
}
const args = user => [user, undefined, undefined, 'Answer the question safely.', true, true, [], undefined, undefined, { v3Owned: true }];

const personaCases = [
  { label: 'custom General', templateType: 'general', isCustom: true, expectedMode: 'custom' },
  { label: 'custom Tutor', templateType: 'general', isCustom: true, expectedMode: 'custom', instruction: 'Act as a patient tutor. Explain the approach first, assuming the reader is new to programming.' },
  { label: 'built-in Sales', templateType: 'sales', expectedMode: 'sales' },
  { label: 'built-in Technical Interview coding action', templateType: 'technical-interview', expectedMode: 'technical_interview', coding: true },
  { label: 'no mode', noMode: true, expectedMode: 'general' },
  { label: 'custom Tutor legacy fallback', templateType: 'general', isCustom: true, legacy: true },
  { label: 'custom Tutor local-tier coding', templateType: 'general', isCustom: true, expectedMode: 'custom', coding: true, tiny: true },
];
for (const platform of ['darwin', 'win32']) for (const path of ['rag', 'fallback']) for (const fixture of personaCases) {
  test(`${platform}/${path}/${fixture.label}: captured payload preserves surface base, standing instructions and evidence boundaries`, async t => {
    denyScopes(t, 'reference_files,profile_history,transcript');
    const h = helper('custom', 'http://127.0.0.1:1234/v1/chat/completions');
    if (fixture.tiny) h.getPromptTier = () => 'tiny';
    const instruction = fixture.instruction ?? 'PERSONA_INSTRUCTION_CANARY: Use exactly three short sections in this answer.';
    const mode = fixture.noMode ? null : { id: 'captured-persona-mode', name: fixture.label, templateType: fixture.templateType,
      isCustom: fixture.isCustom === true, sourceContract: contract(), customContext: instruction };
    const mm = {
      getActiveModeInfo: () => mode,
      getActiveModePinnedInstructions: () => instruction,
      getReferenceFiles: () => [{ id: 'persona-doc', fileName: 'Atlas.txt', content: 'PRIVATE_PERSONA_REFERENCE_CANARY Atlas latency is 73 milliseconds.' }],
    };
    const composer = launcherComposer(platform, { modesManager: mm, env: { NATIVELY_PROMPT_SYSTEM_V2: fixture.legacy ? '0' : '1' } });
    const question = fixture.coding ? 'Write a Python script that prints the numbers 1 to 3 as JSON.' : 'What does the uploaded file say about Atlas?';
    const switchMode = () => {
      mm.getActiveModeInfo = () => ({ id: 'new-mode', templateType: 'recruiting', sourceContract: contract() });
      mm.getActiveModePinnedInstructions = () => 'NEW_UNCAPTURED_PERSONA_CANARY';
    };
    const requests = captureHTTP(t);
    if (path === 'rag') {
      const snapshot = composer.captureLauncherAskContext({ question, llmHelper: h, senderId: 88 });
      await Promise.resolve(); switchMode();
      const rag = Object.create(ragModule.RAGManager.prototype); rag.setLLMHelper(h);
      rag.retriever = { retrieveGlobal: async () => ({ chunks: [], formattedContext: '', intent: 'open_question' }) };
      assert.equal(await collect(rag.queryGlobal(question, undefined, 'PRIVATE_PERSONA_COURSE_CANARY Atlas lesson', undefined, snapshot)), 'Selected answer.');
    } else {
      const events = [];
      const handler = launcherFallbackHandler(platform, { helper: h, composer, ragModule, grounding,
        getChatCourseGrounding: async () => { await Promise.resolve(); switchMode(); return 'PRIVATE_PERSONA_COURSE_CANARY Atlas lesson'; },
      });
      await handler({ sender: { id: 88, send: (...args) => events.push(args) } }, question, undefined, undefined, { selectedModelOnly: true, surface: 'chat' });
      assert.ok(events.some(e => e[0] === 'gemini-stream-done'));
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.model, 'exact-selected-model');
    const system = requests[0].payload.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const user = requests[0].payload.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    assert.match(system, /You are Natively.*Evin John/);
    if (fixture.legacy) {
      assert.match(system, /Use markdown/);
      assert.match(system, /complete, runnable solution/);
    } else {
      assert.match(system, /<chat_layout>/);
      assert.match(system, new RegExp(`<active_mode name="${fixture.expectedMode}">`));
      assert.match(system, /<active_action name="answer">/);
      assert.ok(!system.includes('<active_mode name="recruiting">'), 'never reread the switched mode for the base prompt');
      if (fixture.coding) {
        assert.match(system, /<coding_contract>/);
        assert.match(system, /complete.*code|ready-to-run implementation/i);
      } else assert.match(system, /code minimal and runnable/);
    }
    if (!fixture.noMode) {
      assert.ok(system.includes(instruction), 'standing directives remain SYSTEM instructions');
      assert.match(system, /default.*override|override.*default|outrank.*default/i);
    }
    for (const canary of ['PRIVATE_PERSONA_REFERENCE_CANARY', 'PRIVATE_PERSONA_COURSE_CANARY', 'NEW_UNCAPTURED_PERSONA_CANARY']) assert.ok(!system.includes(canary), canary);
    assert.ok(user.includes('PRIVATE_PERSONA_COURSE_CANARY'));
    assert.ok(!user.includes('NEW_UNCAPTURED_PERSONA_CANARY'));
    assert.equal(Object.hasOwn(h, 'getDeniedOutboundScopes'), false);
    assert.equal(Object.hasOwn(h, 'assertOutboundScopes'), false);
  });
}

for (const route of ['custom', 'curl']) {
  test(`${route}: enabling local-only after cloud transport capture refuses before HTTP`, async t => {
    denyScopes(t);
    const h = helper(route); const requests = captureHTTP(t);
    const captured = h.captureRAGAnswerTransport();
    const { stream } = captured.streamRAGAnswer(...args('What is TCP?'));
    h.setLocalOnlyMode(true);
    await assert.rejects(collect(stream), /cloud providers.*local-only/i);
    assert.equal(requests.length, 0, 'the captured cloud endpoint must not send or reroute');
    assert.equal(Object.hasOwn(h, 'getDeniedOutboundScopes'), false);
    assert.equal(Object.hasOwn(h, 'assertOutboundScopes'), false);
  });

  test(`${route}: replaying a captured cloud transport rechecks current local-only prohibition`, async t => {
    denyScopes(t);
    const h = helper(route); const requests = captureHTTP(t);
    const captured = h.captureRAGAnswerTransport();
    assert.equal(await collect(captured.streamRAGAnswer(...args('What is TCP?')).stream), 'Selected answer.');
    h.setLocalOnlyMode(true);
    await assert.rejects(collect(captured.streamRAGAnswer(...args('What is UDP?')).stream), /cloud providers.*local-only/i);
    assert.equal(requests.length, 1, 'a later dispatch cannot reuse an obsolete privacy grant');
  });

  for (const tightenAt of ['capture', 'dispatch']) test(`${route}/${tightenAt}: observed local-only prohibition cannot be relaxed for the captured turn`, async t => {
    denyScopes(t);
    const h = helper(route); const requests = captureHTTP(t);
    if (tightenAt === 'capture') h.setLocalOnlyMode(true);
    const captured = h.captureRAGAnswerTransport();
    if (tightenAt === 'dispatch') {
      h.setLocalOnlyMode(true);
      await assert.rejects(collect(captured.streamRAGAnswer(...args('What is TCP?')).stream), /cloud providers.*local-only/i);
    }
    h.setLocalOnlyMode(false);
    await assert.rejects(collect(captured.streamRAGAnswer(...args('What is UDP?')).stream), /cloud providers.*local-only/i);
    assert.equal(requests.length, 0, 'relaxing privacy only applies to a newly captured turn');
    assert.equal(await collect(h.captureRAGAnswerTransport().streamRAGAnswer(...args('What is TCP?')).stream), 'Selected answer.');
    assert.equal(requests.length, 1);
  });

  test(`${route}: a live scope denial remains narrowed after settings are relaxed`, async t => {
    denyScopes(t);
    const h = helper(route); const requests = captureHTTP(t);
    const captured = h.captureRAGAnswerTransport();
    const user = '# Question\nWhat does Atlas say?\n<evidence source_type="RESUME" provenance="MODE_REFERENCE_FILE">LIVE_DENIED_REFERENCE_CANARY</evidence>\n<evidence source_type="RESUME" provenance="PROFILE_RESUME">LIVE_PERMITTED_PROFILE_CANARY</evidence>';
    process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
    await collect(captured.streamRAGAnswer(...args(user)).stream);
    delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    await collect(captured.streamRAGAnswer(...args(user)).stream);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.ok(!JSON.stringify(request).includes('LIVE_DENIED_REFERENCE_CANARY'));
      assert.ok(JSON.stringify(request).includes('LIVE_PERMITTED_PROFILE_CANARY'));
    }
    await collect(h.captureRAGAnswerTransport().streamRAGAnswer(...args(user)).stream);
    assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests[2]).includes('LIVE_DENIED_REFERENCE_CANARY'), 'only the new turn can use the relaxed scope policy');
  });

  for (const prohibition of ['local-only', 'reference-scope']) test(`${route}/${prohibition}: privacy tightened during real attachment preparation blocks the final HTTP attempt`, { timeout: 15000 }, async t => {
    denyScopes(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-late-policy-'));
    const image = path.join(dir, 'test image.png');
    fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5aUAAAAASUVORK5CYII=', 'base64'));
    let markPreparing; const preparing = new Promise(resolve => { markPreparing = resolve; });
    let release; const held = new Promise(resolve => { release = resolve; });
    t.after(() => { release(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    const readFile = fs.promises.readFile.bind(fs.promises);
    t.mock.method(fs.promises, 'readFile', async (...readArgs) => {
      markPreparing(); await held; return readFile(...readArgs);
    });
    const h = helper(route); const requests = captureHTTP(t);
    const captured = h.captureRAGAnswerTransport();
    const user = '# Question\nDescribe this image with Atlas context.\n<evidence source_type="RESUME" provenance="MODE_REFERENCE_FILE">LATE_PRIVACY_REFERENCE_CANARY</evidence>';
    const dispatchArgs = args(user); dispatchArgs[1] = [image];
    const pending = collect(captured.streamRAGAnswer(...dispatchArgs).stream);
    // Register rejection handling before the deferred native read is released.
    const refused = assert.rejects(pending, prohibition === 'local-only' ? /cloud providers.*local-only/i : /data scope policy: reference_files/);
    await preparing;
    if (prohibition === 'local-only') h.setLocalOnlyMode(true);
    else process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
    release();
    await refused;
    assert.equal(requests.length, 0, 'a prior guard cannot authorize HTTP after asynchronous image preparation');
  });

  for (const prohibition of ['local-only', 'reference-scope']) test(`${route}/${prohibition}: real HTTP transport obeys live cloud prohibitions without a fetch stub`, { timeout: 15000 }, async t => {
    denyScopes(t);
    const endpoint = await realHTTP(t);
    const h = helper(route, endpoint.url);
    // The explicit provider policy marks this destination as cloud; the real
    // loopback server only substitutes for a hosted HTTP service, not a gate.
    (h.customProvider ?? h.activeCurlProvider).localOnly = false;
    const captured = h.captureRAGAnswerTransport();
    assert.equal(captured.selectionStaysOnDevice(), false);
    assert.equal(await collect(captured.streamRAGAnswer(...args('What is TCP?')).stream), 'Selected answer.');
    assert.equal(endpoint.requests.length, 1, 'control proves the real adapter can reach this exact HTTP server');
    assert.equal(endpoint.requests[0].payload.model, 'exact-selected-model');
    if (prohibition === 'local-only') {
      h.setLocalOnlyMode(true);
      await assert.rejects(collect(captured.streamRAGAnswer(...args('What is UDP?')).stream), /cloud providers.*local-only/i);
      await assert.rejects(collect(h.captureRAGAnswerTransport().streamRAGAnswer(...args('What is UDP?')).stream), /cloud providers.*local-only/i);
    } else {
      process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
      const user = '# Question\nWhat does Atlas say?\n<evidence source_type="RESUME" provenance="MODE_REFERENCE_FILE">REAL_HTTP_REFERENCE_CANARY</evidence>\n<evidence source_type="RESUME" provenance="PROFILE_RESUME">REAL_HTTP_PROFILE_CANARY</evidence>';
      await collect(captured.streamRAGAnswer(...args(user)).stream);
      assert.equal(endpoint.requests.length, 2);
      assert.ok(!JSON.stringify(endpoint.requests[1]).includes('REAL_HTTP_REFERENCE_CANARY'));
      assert.ok(JSON.stringify(endpoint.requests[1]).includes('REAL_HTTP_PROFILE_CANARY'));
      process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files,transcript';
      await assert.rejects(collect(captured.streamRAGAnswer(...args(user)).stream), /data scope policy: transcript/);
    }
    assert.equal(endpoint.requests.length, prohibition === 'local-only' ? 1 : 2, 'the newly prohibited dispatch never reaches real HTTP or a fallback');
    assert.equal(Object.hasOwn(h, 'getDeniedOutboundScopes'), false);
    assert.equal(Object.hasOwn(h, 'assertOutboundScopes'), false);
  });

  test(`${route}: relaxing reference consent cannot widen an already captured cloud turn`, async t => {
    denyScopes(t, 'reference_files');
    const h = helper(route); const requests = captureHTTP(t);
    const captured = h.captureRAGAnswerTransport();
    delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    const user = '# Question\nWhat does Atlas say?\n<evidence source_type="RESUME" provenance="MODE_REFERENCE_FILE">CAPTURE_DENIED_REFERENCE_CANARY</evidence>\n<evidence source_type="RESUME" provenance="PROFILE_RESUME">PERMITTED_PROFILE_CANARY</evidence>';
    await collect(captured.streamRAGAnswer(...args(user)).stream);
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(requests).includes('CAPTURE_DENIED_REFERENCE_CANARY'));
    assert.ok(JSON.stringify(requests).includes('PERMITTED_PROFILE_CANARY'));
  });
}
