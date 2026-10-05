import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { launcherComposer, launcherFallbackHandler, contract } from './launcherContextHarness.mjs';

// Run with Electron-as-Node: the real helper has Electron-native dependencies.
const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const ragModule = require('../../../dist-electron/electron/rag/RAGManager.js');
const { RAGManager } = ragModule;
const grounding = require('../../../dist-electron/electron/courses/chatGrounding.js');
const delta = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const collect = async stream => { let out = ''; for await (const part of stream) out += part; return out; };
async function fallback(platform, h, composer, question, getChatCourseGrounding, context) {
  const events = [];
  const handler = launcherFallbackHandler(platform, { helper: h, composer, getChatCourseGrounding, ragModule, grounding });
  await handler({ sender: { id: 501, send: (...args) => events.push(args) } }, question, undefined, context,
    { selectedModelOnly: true, surface: 'chat', requestId: 'real-privacy-turn' });
  const done = events.find(e => e[0] === 'gemini-stream-done');
  assert.ok(done, 'the production fallback must complete');
  return done[1].finalText;
}

for (const platform of ['darwin', 'win32']) for (const route of ['local-custom', 'local-curl', 'cloud-custom']) {
  for (const path of ['rag', 'fallback']) test(`${platform}/${path}/${route}: assembled mode and profile evidence reaches only the selected transport`, async t => {
    const url = route.startsWith('local') ? 'http://127.0.0.1:1234/v1/chat/completions' : 'https://selected.example/v1/chat/completions';
    const provider = {
      id: 'exact-launcher-selection', name: 'Selected launcher provider', responsePath: 'choices[0].message.content',
      curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({
        model: 'exact-selected-model', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true,
      })}'`,
    };
    const priorDenials = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    if (route.startsWith('local')) process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files,profile_history,transcript';
    else delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    t.after(() => {
      if (priorDenials === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
      else process.env.NATIVELY_DENY_PROVIDER_SCOPES = priorDenials;
    });
    const h = Object.create(LLMHelper.prototype);
    Object.assign(h, {
      customProvider: route === 'local-curl' ? null : provider,
      activeCurlProvider: route === 'local-curl' ? provider : null,
      configuredCustomProviders: [provider], currentModelId: 'gemini-background-not-selected',
      useOllama: false, isLocalOnlyMode: false, groqFastTextMode: false, answerLatency: new Map(),

      injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
      buildTextSpareRungs() { assert.fail('launcher must not build a background/fallback provider ladder'); },
      getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
      getKnowledgeOrchestrator: () => ({ activeResume: {
        structured_data: { projects: [{ name: 'Atlas', description: 'TRANSPORT_PROFILE_CANARY led Atlas' }] },
        raw_text: '# Resume\n## Experience\nTRANSPORT_PROFILE_CANARY led Atlas',
      } }),
    });
    const mode = { id: `transport-${platform}-${route}-${path}`, templateType: 'looking-for-work', sourceContract: contract() };
    const mm = {
      getActiveModeInfo: () => mode,
      getReferenceFiles: () => [{ id: 'atlas-doc', fileName: 'Atlas project.txt', content: 'TRANSPORT_DOCUMENT_CANARY Atlas latency is 73 milliseconds' }],
      getActiveModePinnedInstructions: () => 'TRANSPORT_INSTRUCTIONS_CANARY: answer clearly',
    };
    const composer = launcherComposer(platform, { modesManager: mm });
    const question = 'Tell me about my Atlas project experience using the uploaded file and my profile and using the transcript.';
    const snapshot = composer.captureLauncherAskContext({ question, llmHelper: h, senderId: 501 });
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (target, options) => {
      requests.push({ url: String(target), body: JSON.parse(options.body), signal: options.signal });
      return new Response(`${delta('Selected grounded answer.')}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    let stream;
    if (path === 'rag') {
      const rag = Object.create(RAGManager.prototype);
      rag.setLLMHelper(h);
      rag.retriever = { retrieveGlobal: async () => ({ chunks: [{}], formattedContext: 'TRANSPORT_MEETING_CANARY Atlas was discussed', intent: 'open_question' }) };
      stream = rag.queryGlobal(question, undefined, 'TRANSPORT_COURSE_CANARY\nSource URL: https://courses.test/tcp', undefined, snapshot);
    } else {
      stream = null;
    }
    const answer = path === 'rag' ? await collect(stream)
      : await fallback(platform, h, composer, question, async () => 'TRANSPORT_COURSE_CANARY\nSource URL: https://courses.test/tcp', 'TRANSPORT_MEETING_CANARY Atlas was discussed');
    assert.equal(answer, 'Selected grounded answer.');
    assert.equal(Object.hasOwn(h, 'getDeniedOutboundScopes'), false);
    assert.equal(Object.hasOwn(h, 'assertOutboundScopes'), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, url);
    assert.equal(requests[0].body.model, 'exact-selected-model');
    const system = requests[0].body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const user = requests[0].body.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    assert.ok(system.includes('TRANSPORT_INSTRUCTIONS_CANARY'));
    for (const canary of ['TRANSPORT_PROFILE_CANARY', 'TRANSPORT_DOCUMENT_CANARY', 'TRANSPORT_COURSE_CANARY', 'TRANSPORT_MEETING_CANARY']) {
      assert.ok(user.includes(canary), canary);
      assert.ok(!system.includes(canary), 'private facts must never enter SYSTEM');
    }
    assert.ok(user.includes('https://courses.test/tcp'));
  });
}

for (const platform of ['darwin', 'win32']) for (const path of ['rag', 'fallback']) for (const route of ['custom', 'curl']) {
  for (const switchAt of ['before-composition', 'after-composition']) test(`${platform}/${path}/${route}: local-to-cloud switch ${switchAt} cannot change launcher privacy exemption`, async t => {
    const localUrl = 'http://127.0.0.1:1234/v1/chat/completions';
    const cloudUrl = 'https://selected-cloud.example/v1/chat/completions';
    const provider = url => ({ id: 'switchable-provider', name: 'Switchable', responsePath: 'choices[0].message.content',
      curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'selected-model', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
    });
    const prior = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
    t.after(() => { if (prior === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES; else process.env.NATIVELY_DENY_PROVIDER_SCOPES = prior; });
    const h = Object.create(LLMHelper.prototype);
    Object.assign(h, { customProvider: route === 'custom' ? provider(localUrl) : null,
          activeCurlProvider: route === 'curl' ? provider(localUrl) : null, currentModelId: 'gemini-background',
      configuredCustomProviders: [], useOllama: false, isLocalOnlyMode: false, groqFastTextMode: false, answerLatency: new Map(),
      injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
      getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
      buildTextSpareRungs() { assert.fail('no cloud ladder for a frozen launcher selection'); },
    });
    const mode = { id: `switch-${platform}-${path}-${switchAt}`, templateType: 'looking-for-work', sourceContract: contract('reference_files_primary', ['reference_files']) };
    const composer = launcherComposer(platform, { modesManager: {
      getActiveModeInfo: () => mode, getActiveModePinnedInstructions: () => 'configured voice',
      getReferenceFiles: () => [{ id: 'resume-attachment', fileName: 'Resume.txt', content: '# Resume\n## Experience\nREFERENCE_PROVENANCE_CANARY led Atlas.\n## Education\nUniversity' }],
    } });
    const question = 'What Atlas experience is in the uploaded file?';
    let snapshot = composer.captureLauncherAskContext({ question, llmHelper: h, senderId: 777 });
    const switchProvider = () => {
      const active = route === 'custom' ? h.customProvider : h.activeCurlProvider;
      active.curlCommand = provider(cloudUrl).curlCommand;
      h.configuredCustomProviders = [active];
    };
    if (path === 'rag' && switchAt === 'before-composition') { await Promise.resolve(); switchProvider(); }
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), payload: JSON.parse(options.body) });
      return new Response(`${delta('Selected answer.')}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    let stream;
    if (path === 'rag') {
      const rag = Object.create(RAGManager.prototype); rag.setLLMHelper(h);
      rag.retriever = { retrieveGlobal() { assert.fail('reference request must not retrieve meetings'); } };
      if (switchAt === 'after-composition') {
        const captured = snapshot.transport;
        snapshot = Object.freeze({ ...snapshot, transport: Object.freeze({
          ...captured, streamRAGAnswer: (...args) => { switchProvider(); return captured.streamRAGAnswer(...args); },
        }) });
      }
      stream = rag.queryGlobal(question, undefined, undefined, undefined, snapshot);
    } else {
      stream = null;
    }
    if (path === 'rag') await collect(stream);
    else await fallback(platform, h, {
      ...composer, composeLauncherAskContext: async input => {
        const composed = await composer.composeLauncherAskContext(input);
        if (switchAt === 'after-composition') switchProvider();
        return composed;
      },
    }, question, async () => {
      await Promise.resolve();
      if (switchAt === 'before-composition') switchProvider();
      return null;
    });
    assert.equal(requests.length, 1);
    assert.ok(requests.every(r => r.url !== cloudUrl || !JSON.stringify(r.payload).includes('REFERENCE_PROVENANCE_CANARY')), 'reference-denied résumé-shaped mode evidence must never reach cloud');
    assert.equal(requests[0].url, localUrl, 'composition and dispatch must use the same captured selection');
    assert.ok(JSON.stringify(requests[0].payload).includes('REFERENCE_PROVENANCE_CANARY'));
    // A later turn takes the NEW cloud selection and cannot inherit the old
    // local exemption, even though the provider identity itself is unchanged.
    if (path === 'rag') {
      const next = composer.captureLauncherAskContext({ question, llmHelper: h, senderId: 777 });
      const rag = Object.create(RAGManager.prototype); rag.setLLMHelper(h);
      rag.retriever = { retrieveGlobal() { assert.fail('reference request must not retrieve meetings'); } };
      await collect(rag.queryGlobal(question, undefined, undefined, undefined, next));
    } else await fallback(platform, h, composer, question, async () => null);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, cloudUrl);
    assert.ok(!JSON.stringify(requests[1].payload).includes('REFERENCE_PROVENANCE_CANARY'));
  });
}

for (const platform of ['darwin', 'win32']) for (const path of ['rag', 'fallback']) for (const route of ['custom', 'curl']) {
  test(`${platform}/${path}/${route}: denied-scope local failure never forwards evidence to a cloud fallback`, async t => {
    const previous = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files,profile_history,transcript';
    t.after(() => { if (previous === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES; else process.env.NATIVELY_DENY_PROVIDER_SCOPES = previous; });
    const url = 'http://127.0.0.1:1234/v1/chat/completions';
    const provider = { id: 'failing-local', name: 'Failing local', responsePath: 'choices[0].message.content',
      curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'selected-local', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
    };
    const h = Object.create(LLMHelper.prototype);
    Object.assign(h, { customProvider: route === 'custom' ? provider : null, activeCurlProvider: route === 'curl' ? provider : null,
      configuredCustomProviders: [provider], currentModelId: 'gpt-background', useOllama: false, isLocalOnlyMode: false, answerLatency: new Map(),
      _openaiClient: {}, injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
      getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
      buildTextSpareRungs() { assert.fail('selected launcher failure cannot construct a fallback ladder'); },
      streamWithOpenai() { assert.fail('selected local failure cannot call the configured cloud provider'); },
      getKnowledgeOrchestrator: () => ({ activeResume: { id: 1, structured_data: { projects: [{ name: 'Atlas', description: 'LOCAL_FAILURE_PROFILE_CANARY led Atlas' }] }, raw_text: 'LOCAL_FAILURE_PROFILE_CANARY led Atlas' } }),
    });
    const composer = launcherComposer(platform, { modesManager: {
      getActiveModeInfo: () => ({ id: 'local-failure', templateType: 'looking-for-work', sourceContract: contract() }),
      getActiveModePinnedInstructions: () => 'Answer the question.',
      getReferenceFiles: () => [{ id: 'atlas', fileName: 'Atlas.txt', content: 'LOCAL_FAILURE_REFERENCE_CANARY Atlas latency is 73 milliseconds' }],
    } });
    const question = 'Tell me about my Atlas project experience using the uploaded file and my profile and using the transcript.';
    const requests = []; const originalFetch = globalThis.fetch;
    globalThis.fetch = async (target, options) => {
      requests.push({ url: String(target), payload: JSON.parse(options.body) });
      return new Response('selected local request failed', { status: 400 });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    if (path === 'rag') {
      const snapshot = composer.captureLauncherAskContext({ question, llmHelper: h, senderId: 501 });
      const rag = Object.create(RAGManager.prototype); rag.setLLMHelper(h);
      rag.retriever = { retrieveGlobal: async () => ({ chunks: [{}], formattedContext: 'LOCAL_FAILURE_TRANSCRIPT_CANARY Atlas discussion', intent: 'open_question' }) };
      await assert.rejects(collect(rag.queryGlobal(question, undefined, null, undefined, snapshot)));
    } else {
      const events = [];
      const handler = launcherFallbackHandler(platform, { helper: h, composer, getChatCourseGrounding: async () => null, ragModule, grounding });
      await assert.rejects(handler({ sender: { id: 501, send: (...args) => events.push(args) } }, question, undefined, 'LOCAL_FAILURE_TRANSCRIPT_CANARY Atlas discussion',
        { selectedModelOnly: true, surface: 'chat', requestId: 'local-failure-turn' }), /Custom Provider HTTP 400/);
      assert.ok(!events.some(e => e[0] === 'gemini-stream-done'));
    }
    assert.equal(requests.length, 1, 'no cloud retry, hedge or spare request');
    assert.equal(requests[0].url, url);
    for (const canary of ['LOCAL_FAILURE_REFERENCE_CANARY', 'LOCAL_FAILURE_PROFILE_CANARY', 'LOCAL_FAILURE_TRANSCRIPT_CANARY']) {
      assert.ok(JSON.stringify(requests[0].payload).includes(canary), 'local transport keeps permitted evidence under real cloud-scope denials');
    }
    assert.equal(Object.hasOwn(h, 'getDeniedOutboundScopes'), false);
    assert.equal(Object.hasOwn(h, 'assertOutboundScopes'), false);
  });
}

for (const platform of ['darwin', 'win32']) for (const path of ['rag', 'fallback']) for (const route of ['custom', 'curl']) for (const denyTranscript of [false, true]) {
  test(`${platform}/${path}/${route}: live outbound privacy tightening ${denyTranscript ? 'fails closed on transcript denial' : 'strips reference provenance but preserves authorized profile'}`, async t => {
    const previous = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    delete process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    t.after(() => { if (previous === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES; else process.env.NATIVELY_DENY_PROVIDER_SCOPES = previous; });
    const url = 'https://selected-cloud.example/v1/chat/completions';
    const provider = { id: 'live-policy-cloud', name: 'Cloud', responsePath: 'choices[0].message.content',
      curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'exact-cloud-model', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
    };
    const h = Object.create(LLMHelper.prototype);
    Object.assign(h, { customProvider: route === 'custom' ? provider : null, activeCurlProvider: route === 'curl' ? provider : null,
      configuredCustomProviders: [provider], currentModelId: 'gpt-background', useOllama: true, isLocalOnlyMode: false, answerLatency: new Map(),
      injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
      getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
      buildTextSpareRungs() { assert.fail('no cloud spare for a selected launcher turn'); },
      ensureOllamaModelSelected() { assert.fail('stale Ollama flag must not change frozen cloud selection'); },
      getKnowledgeOrchestrator: () => ({ activeResume: { id: 1, structured_data: { projects: [{ name: 'Atlas', description: 'LIVE_ALLOWED_PROFILE_CANARY led Atlas' }] }, raw_text: 'LIVE_ALLOWED_PROFILE_CANARY led Atlas' } }),
    });
    const composer = launcherComposer(platform, { modesManager: {
      getActiveModeInfo: () => ({ id: 'live-cloud-scopes', templateType: 'looking-for-work', sourceContract: contract() }),
      getActiveModePinnedInstructions: () => 'Answer with supplied evidence.',
      getReferenceFiles: () => [{ id: 'resume-file', fileName: 'Resume.txt', content: '# Resume\n## Experience\nLIVE_REFERENCE_CANARY led Atlas.\n## Education\nUniversity' }],
    } });
    const question = 'Tell me about my Atlas project experience using the uploaded file and my profile and using the transcript.';
    const tighten = () => { process.env.NATIVELY_DENY_PROVIDER_SCOPES = denyTranscript ? 'reference_files,transcript' : 'reference_files'; };
    const requests = []; const originalFetch = globalThis.fetch;
    globalThis.fetch = async (target, options) => {
      requests.push({ url: String(target), payload: JSON.parse(options.body) });
      return new Response(`${delta('Privacy-aware answer.')}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const run = async () => {
      if (path === 'rag') {
        const captured = composer.captureLauncherAskContext({ question, llmHelper: h, senderId: 501 });
        const snapshot = Object.freeze({ ...captured, transport: Object.freeze({ ...captured.transport,
          streamRAGAnswer: (...args) => { tighten(); return captured.transport.streamRAGAnswer(...args); },
        }) });
        const rag = Object.create(RAGManager.prototype); rag.setLLMHelper(h);
        rag.retriever = { retrieveGlobal: async () => ({ chunks: [{}], formattedContext: 'LIVE_TRANSCRIPT_CANARY Atlas discussion', intent: 'open_question' }) };
        await collect(rag.queryGlobal(question, undefined, 'LIVE_COURSE_CANARY Atlas course', undefined, snapshot));
      } else await fallback(platform, h, { ...composer, composeLauncherAskContext: async input => {
        const composed = await composer.composeLauncherAskContext(input); tighten(); return composed;
      } }, question, async () => 'LIVE_COURSE_CANARY Atlas course', 'LIVE_TRANSCRIPT_CANARY Atlas discussion');
    };
    if (denyTranscript) {
      // The existing outbound policy classifies nonempty user text as transcript
      // data too. Do not relax that cloud boundary just to send a stripped turn.
      await assert.rejects(run(), /blocked by data scope policy: transcript/);
      assert.equal(requests.length, 0, 'fail closed before any HTTP or stale Ollama reroute');
      return;
    }
    await run();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, url);
    assert.equal(requests[0].payload.model, 'exact-cloud-model');
    const sent = JSON.stringify(requests[0].payload);
    for (const canary of ['LIVE_REFERENCE_CANARY', 'LIVE_COURSE_CANARY']) assert.ok(!sent.includes(canary), canary);
    assert.ok(sent.includes('LIVE_TRANSCRIPT_CANARY'), 'independently permitted transcript must survive');
    assert.ok(sent.includes('LIVE_ALLOWED_PROFILE_CANARY'), 'independent permitted profile evidence must survive');
    assert.ok(sent.includes('evidence_withheld'));
  });
}

for (const platform of ['darwin', 'win32']) for (const route of ['custom', 'curl']) {
  test(`${platform}/${route}: actual cloud adapter refuses undeclared reference provenance before HTTP`, async t => {
    const previous = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
    process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
    t.after(() => { if (previous === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES; else process.env.NATIVELY_DENY_PROVIDER_SCOPES = previous; });
    const provider = { id: 'boundary-cloud', name: 'Cloud', responsePath: 'choices[0].message.content',
      curlCommand: `curl 'https://selected-cloud.example/v1/chat/completions' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'cloud-model', messages: [{ role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
    };
    const h = Object.create(LLMHelper.prototype);
    Object.assign(h, { customProvider: route === 'custom' ? provider : null, activeCurlProvider: route === 'curl' ? provider : null });
    const originalFetch = globalThis.fetch; let requests = 0;
    globalThis.fetch = async () => { requests++; assert.fail('the actual transport boundary must refuse before HTTP'); };
    t.after(() => { globalThis.fetch = originalFetch; });
    const user = '# Question\nWhat does the uploaded résumé say?\n<evidence source_type="RESUME" provenance="MODE_REFERENCE_FILE">FINAL_BOUNDARY_CANARY</evidence>';
    // Enter the real adapter directly: neither the launcher filter nor chat's
    // stripping phase can hide a missing last-boundary provenance assertion.
    const stream = route === 'custom' ? h.streamWithCustom(user) : h.streamWithDirectCurl(provider, user, 'Answer safely', []);
    await assert.rejects(collect(stream), /blocked by data scope policy: reference_files/);
    assert.equal(requests, 0);
  });
}

for (const platform of ['darwin', 'win32']) test(`${platform}: cloud backstop enforces MODE_REFERENCE_FILE provenance despite a permitted RESUME type`, async t => {
  const original = process.env.NATIVELY_DENY_PROVIDER_SCOPES;
  process.env.NATIVELY_DENY_PROVIDER_SCOPES = 'reference_files';
  t.after(() => { if (original === undefined) delete process.env.NATIVELY_DENY_PROVIDER_SCOPES; else process.env.NATIVELY_DENY_PROVIDER_SCOPES = original; });
  const url = 'https://selected-cloud.example/v1/chat/completions';
  const provider = { id: 'selected-cloud', name: 'Cloud', responsePath: 'choices[0].message.content',
    curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'cloud-model', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
  };
  const h = Object.create(LLMHelper.prototype);
  Object.assign(h, { customProvider: provider, activeCurlProvider: null, configuredCustomProviders: [provider],
    currentModelId: 'gemini-background', useOllama: false, isLocalOnlyMode: false, answerLatency: new Map(),
    injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
    getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
    buildTextSpareRungs() { assert.fail('no selected-only fallback'); },
  });
  const requests = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(`${delta('Safe answer.')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  // Intentionally omit declared reference scope: the final boundary must derive
  // it from provenance, regardless of the semantic type or caller correctness.
  const user = '# Question\nWhat does the uploaded résumé say?\n<evidence source_type="RESUME" provenance="MODE_REFERENCE_FILE">OUTBOUND_REFERENCE_CANARY</evidence>\n<evidence source_type="RESUME" provenance="PROFILE_RESUME">ALLOWED_PROFILE_CANARY</evidence>';
  await collect(h.streamRAGAnswer(user, undefined, undefined, 'Answer safely', true, true, [], undefined, undefined, { v3Owned: true }).stream);
  assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(requests).includes('OUTBOUND_REFERENCE_CANARY'));
  assert.ok(JSON.stringify(requests).includes('ALLOWED_PROFILE_CANARY'), 'reference denial must not erase separately permitted Profile Intelligence');
});
