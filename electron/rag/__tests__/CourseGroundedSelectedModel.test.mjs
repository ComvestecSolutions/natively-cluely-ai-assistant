import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { launcherComposer, mockSelectedTransport } from './launcherContextHarness.mjs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function evaluate(source, imports = {}, platform = 'win32', clock = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(source), {
    module, exports: module.exports, console, setTimeout, clearTimeout, AbortController,
    process: { platform }, require: (id) => imports[id] ?? {}, ...clock,
  });
  return module.exports;
}
const grounding = evaluate(read('../../courses/chatGrounding.ts'));
const prompts = evaluate(read('../prompts.ts'));
const policies = evaluate(read('../../llm/providerStreamPolicy.ts'));
const ragSource = read('../RAGManager.ts');
const collect = async (stream) => { let result = ''; for await (const chunk of stream) result += chunk; return result; };

for (const platform of ['darwin', 'win32']) {
  function manager({ empty = false, truncated = false } = {}) {
    const { RAGManager, RAG_STREAM_INCOMPLETE_CODA } = evaluate(ragSource, {
      './prompts': prompts, '../courses/chatGrounding': grounding, '../llm/providerStreamPolicy': policies,
    }, platform);
    // Bypass startup/embedding workers, not query logic: all methods below are
    // the actual RAGManager methods, with only retrieval and transport mocked.
    const rag = Object.create(RAGManager.prototype);
    const context = { chunks: empty ? [] : [{}], formattedContext: 'MEETING_ONLY_SECRET', intent: 'open_question' };
    rag.retriever = { retrieveGlobal: async () => context, retrieve: async () => context };
    rag.vectorStore = { hasEmbeddings: () => true };
    const calls = [];
    let selection = 'custom/local-model';
    const helper = {
      streamChatWithGemini() { throw new Error('legacy router must not answer'); },
      streamChatWithOutcome() { throw new Error('ordinary chat can select the Background Model'); },
      streamRAGAnswer(...args) {
        calls.push({ args, selection });
        return { outcome: { truncated }, stream: (async function* () { yield 'Selected model answer'; })() };
      },
    };
    rag.setLLMHelper(helper);
    return { rag, calls, coda: RAG_STREAM_INCOMPLETE_CODA, select: (model) => { selection = model; } };
  }

  test(`${platform}: global search invokes the selected chat route with scoped course evidence`, async () => {
    const { rag, calls, select } = manager();
    const signal = new AbortController().signal;
    await collect(rag.queryGlobal('Explain networking', signal, 'COURSE_ONLY_SECRET\nSource URL: https://courses.test/net'));
    assert.equal(calls.length, 1);
    const { args } = calls[0];
    assert.equal(calls[0].selection, 'custom/local-model');
    assert.equal(args[0], 'Explain networking');
    assert.equal(args[1], undefined, 'text only');
    assert.ok(args[2].includes('MEETING_ONLY_SECRET'));
    assert.ok(args[2].includes('<reference_file source="courses">'));
    assert.ok(args[2].includes('COURSE_ONLY_SECRET'));
    assert.ok(!args[3].includes('COURSE_ONLY_SECRET'), 'private evidence must not leak into system instructions');
    assert.ok(!args[3].includes('MEETING_ONLY_SECRET'));
    assert.deepEqual([...args[6]], ['transcript', 'reference_files']);
    assert.ok(args[7] instanceof AbortSignal, 'transport receives a cancellable signal');
    assert.equal(args[7].aborted, signal.aborted);
    assert.notEqual(args[7], signal, 'watchdog owns transport cancellation without aborting the caller');
    assert.equal(args[9].v3Owned, true, 'no profile/mode interceptor may steal this query');
    select('openai/new-selection');
    await collect(rag.queryGlobal('Follow-up', signal));
    assert.equal(calls[1].selection, 'openai/new-selection', 'not a cached/default Gemini selection');
  });

  test(`${platform}: empty global meeting search still dispatches the selected model with courses`, async () => {
    const { rag, calls } = manager({ empty: true });
    assert.equal(await collect(rag.queryGlobal('Hello', undefined, 'Pinned course identity')), 'Selected model answer');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args[2].includes('Pinned course identity'));
    assert.ok(calls[0].args[2].includes('No matching excerpts'));
    assert.ok(!calls[0].args[2].includes('MEETING_ONLY_SECRET'));
  });

  test(`${platform}: a cancelled query never dispatches a provider`, async () => {
    const { rag, calls } = manager();
    const controller = new AbortController();
    controller.abort();
    assert.equal(await collect(rag.queryGlobal('Cancelled', controller.signal, 'course')), '');
    assert.equal(await collect(rag.queryMeeting('meeting', 'Cancelled', controller.signal, 'course')), '');
    assert.equal(calls.length, 0);
  });

  test(`${platform}: meeting/live RAG carries the same grounding, route and incomplete outcome`, async () => {
    const { rag, calls, coda } = manager({ truncated: true });
    const answer = await collect(rag.queryMeeting('meeting-id', 'What is TCP?', undefined, 'TCP course ground truth'));
    assert.ok(calls[0].args[2].includes('TCP course ground truth'));
    assert.ok(answer.endsWith(coda));
  });
}

test('all IPC chat paths compute course grounding locally, independently of V3', () => {
  const ipc = read('../../ipcHandlers.ts');
  const helperStart = ipc.indexOf('const getChatCourseGrounding =');
  const chatStart = ipc.indexOf('const _geminiChatStreamHandler =');
  assert.ok(helperStart >= 0 && chatStart > helperStart);
  assert.doesNotMatch(ipc.slice(helperStart, chatStart), /pipeline:|getEmbeddingPipeline|fetch\(/);
  const bufferedChat = ipc.slice(ipc.indexOf("'gemini-chat'"), ipc.indexOf('// Streaming IPC Handler'));
  assert.match(bufferedChat, /getChatCourseGrounding\(strippedMessage, options\?\.courseIds\)/);
  assert.match(bufferedChat, /chatWithGemini\(strippedMessage, imagePaths, groundedContext/);
  const legacy = ipc.slice(chatStart, ipc.indexOf("safeHandle('direct-assist-stream'"));
  assert.ok(legacy.indexOf('courseBlock = courseGroundingAsReference') < legacy.indexOf('isContextIntelligenceV3Enabled'));
  assert.match(legacy, /if \(courseBlock\) composed\.user/);
  assert.match(legacy, /const ctxForCall = courseBlock/);
  const selectedFallback = legacy.slice(legacy.indexOf('if (options?.selectedModelOnly)'), legacy.indexOf('// ── CONTEXT INTELLIGENCE V3'));
  assert.match(selectedFallback, /launcherSnapshot!\.transport\.streamRAGAnswer\(/);
  assert.match(selectedFallback, /composeLauncherAskContext\(/);
  assert.match(selectedFallback, /courseGrounding: launcherCourseGrounding/);
  assert.ok(legacy.indexOf('captureLauncherAskContext') < legacy.indexOf('await getChatCourseGrounding'));
  assert.match(selectedFallback, /return null;/);
  assert.doesNotMatch(selectedFallback, /streamChatWithGemini|claimFastTurn|planAnswer/);
  for (const channel of ['rag:query-meeting', 'rag:query-live', 'rag:query-global']) {
    const start = ipc.indexOf(`'${channel}'`);
    const block = ipc.slice(start, ipc.indexOf('\n  });', start) + 6);
    assert.match(block, /courseIds\??/);
    assert.match(block, /getChatCourseGrounding\(query, courseIds\)/);
    assert.match(block, /ragManager\.query(?:Global|Meeting)\((?:(?:meetingId|liveMeetingId), )?query, abortController\.signal, courseGrounding(?:,|\))/);
  }
  const directStart = ipc.indexOf("safeHandle('direct-assist-stream'");
  const direct = ipc.slice(directStart, ipc.indexOf("'direct-assist-cancel'", directStart));
  assert.match(direct, /getChatCourseGrounding\(resolvedSkill\.currentRequest, request\.courseIds\)/);
  assert.match(direct, /referenceFiles\.unshift\(\{ fileName: 'Course ground truth', content: courseGrounding \}\)/);
  assert.match(ipc, /phoneCourseGrounding = courseGroundingAsReference\(await getChatCourseGrounding\(message\)\)/);
});

for (const truncated of [false, true]) test(`global fallback executes the selected-model IPC branch with grounding and incomplete=${truncated} before V3`, async () => {
  const source = read('../../ipcHandlers.ts');
  const ast = ts.createSourceFile('ipcHandlers.ts', source, ts.ScriptTarget.Latest, true);
  let handlerSource;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === '_geminiChatStreamHandler') {
      handlerSource = node.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handlerSource);
  const calls = [];
  const events = [];
  const helper = {
    captureRAGAnswerTransport() { return mockSelectedTransport(this); },
    getCodexSelectionAuthError: () => null,
    streamRAGAnswer(...args) {
      calls.push(args);
      const stream = (async function* () { yield 'Selected fallback answer'; })();
      return { stream: truncated ? policies.withProviderStreamPolicy(stream, {
        firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000, signal: args[7], lastActivityAt: 123,
      }) : stream, outcome: { truncated } };
    },
    streamChat() { throw new Error('must not enter the Background Model route'); },
  };
  const composer = launcherComposer('win32');
  const context = {
    appState: { processingHelper: { getLLMHelper: () => helper } },
    getChatCourseGrounding: async (question, pins) => {
      assert.equal(question, 'Fallback question');
      assert.deepEqual([...pins], ['disabled-pin']);
      return 'PINNED_GROUND_TRUTH';
    },
    courseGroundingAsReference: grounding.courseGroundingAsReference,
    beginTrace: () => ({}),
    _chatStreamId: 0,
    _chatStreamsBySender: new Map(),
    CHAT_MODE_PROMPT: 'Answer the current question',
    AbortController, console,
    require: (id) => {
      if (id === './rag/RAGManager') return evaluate(ragSource, { '../llm/providerStreamPolicy': policies });
      if (id === './rag/launcherAskContext') return composer;
      assert.equal(id, './services/ForegroundGate', 'launcher context may assemble but must not enter background routing');
      return { ForegroundGate: {} };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(transpile(`module.exports = ${handlerSource};`), { ...context, module });
  await module.exports({ sender: { id: 17, send: (...args) => events.push(args) } },
    'Fallback question', undefined, undefined, { courseIds: ['disabled-pin'], selectedModelOnly: true, requestId: 'fallback-turn' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].includes('Fallback question'));
  assert.equal(calls[0][1], undefined);
  assert.ok(calls[0][0].includes('PINNED_GROUND_TRUTH'));
  assert.equal(calls[0][2], undefined);
  assert.deepEqual([...calls[0][6]], ['reference_files']);
  const tokenEvent = events.find(e => e[0] === 'gemini-stream-token');
  assert.ok(tokenEvent);
  assert.equal(events.at(-1)[0], 'gemini-stream-done');
  assert.equal(tokenEvent[2].streamId, events.at(-1)[1].streamId);
  assert.equal(tokenEvent[2].requestId, 'fallback-turn');
  assert.equal(events.at(-1)[1].requestId, 'fallback-turn');
  if (truncated) {
    assert.equal(events[0][0], 'chat:stream-policy', 'publish before the first answer chunk');
    assert.deepEqual(JSON.parse(JSON.stringify(events[0][1])), {
      source: 'fallback', requestId: 'fallback-turn', streamId: tokenEvent[2].streamId,
      firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000,
    }, 'only deadlines and correlation cross IPC — no activity, reasoning, or signal');
  } else assert.ok(events.every(e => e[0] !== 'chat:stream-policy'), 'cloud budgets are unchanged');
  assert.equal(events.at(-1)[1].incomplete, truncated);
  assert.equal(events.at(-1)[1].finalText.includes('Answer incomplete'), truncated);
  assert.equal(calls[0][7].aborted, false, 'normal completion is not cancellation');
});

for (const platform of ['darwin', 'win32']) test(`${platform}: global IPC publishes timing-only policy before the selected grounded answer`, async () => {
  const source = read('../../ipcHandlers.ts');
  const ast = ts.createSourceFile('ipcHandlers.ts', source, ts.ScriptTarget.Latest, true);
  let handlerSource;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'safeHandle'
      && node.arguments[0]?.getText(ast) === "'rag:query-global'") handlerSource = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(handlerSource, 'execute the actual global IPC handler');
  const composer = launcherComposer(platform);
  const { RAGManager } = evaluate(ragSource, { './prompts': prompts, '../courses/chatGrounding': grounding, '../llm/providerStreamPolicy': policies, './launcherAskContext': composer }, platform);
  const rag = Object.create(RAGManager.prototype); const calls = []; const events = [];
  rag.isReady = () => true;
  rag.retriever = { retrieveGlobal: async () => ({ chunks: [{}], formattedContext: 'MEETING EVIDENCE' }) };
  const helper = { captureRAGAnswerTransport() { return mockSelectedTransport(this); }, streamRAGAnswer(...args) {
    calls.push(args);
    return { outcome: { truncated: false }, stream: policies.withProviderStreamPolicy((async function* () { yield 'Selected local answer'; })(), {
      firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000, signal: args[7], lastActivityAt: 123,
    }) };
  } };
  rag.setLLMHelper(helper);
  const activeRAGQueries = new Map(); const module = { exports: {} };
  vm.runInNewContext(transpile(`module.exports = ${handlerSource};`), {
    module, AbortController, appState: { getRAGManager: () => rag, processingHelper: { getLLMHelper: () => helper } }, activeRAGQueries,
    require: id => { assert.equal(id, './rag/launcherAskContext'); return composer; },
    crypto: { randomUUID: () => 'isolated-test' }, abortPriorRAGQueriesOfClass: () => {},
    getChatCourseGrounding: async (query, pins) => {
      assert.equal(query, 'Pinned question'); assert.deepEqual([...pins], ['course-pin']); return 'PINNED EVIDENCE';
    },
  });
  assert.equal((await module.exports({ sender: { send: (...args) => events.push(args) } }, { query: 'Pinned question', courseIds: ['course-pin'], requestId: 'global-turn' })).success, true);
  assert.equal(calls.length, 1); assert.ok(calls[0][0].includes('PINNED EVIDENCE'));
  assert.deepEqual(events.map(e => e[0]), ['chat:stream-policy', 'rag:stream-chunk', 'rag:stream-complete']);
  assert.deepEqual(JSON.parse(JSON.stringify(events[0][1])), {
    source: 'rag', requestId: 'global-turn', firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000,
  });
  assert.ok(events.every(e => e[1].requestId === 'global-turn'));
  assert.equal(activeRAGQueries.size, 0); assert.equal(calls[0][7].aborted, false);
});

for (const platform of ['darwin', 'win32']) {
  function timedManager({ local = true, steps = [] } = {}) {
    let now = 0; let id = 0; let pulls = 0; let returned = 0;
    const timers = new Map(); const calls = []; const published = [];
    const clock = {
      Date: class extends Date { static now() { return now; } },
      setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
      clearTimeout(key) { timers.delete(key); },
    };
    const { RAGManager } = evaluate(ragSource, {
      './prompts': prompts, '../courses/chatGrounding': grounding, '../llm/providerStreamPolicy': policies,
    }, platform, clock);
    const rag = Object.create(RAGManager.prototype);
    rag.retriever = { retrieveGlobal: async () => ({ chunks: [{}], formattedContext: 'LOCAL EVIDENCE' }) };
    let pending;
    const stream = {
      [Symbol.asyncIterator]() { return this; },
      next() {
        pulls++;
        const step = steps.shift();
        return new Promise((resolve) => {
          pending = resolve;
          if (step) clock.setTimeout(() => resolve(step.result), step.ms);
        });
      },
      return() { returned++; return Promise.resolve({ done: true }); },
    };
    const policy = { firstUsefulDeadlineMs: 300000, interTokenStallMs: 60000 };
    rag.setLLMHelper({ streamRAGAnswer(...args) {
      calls.push(args); policy.signal = args[7];
      return { stream: local ? policies.withProviderStreamPolicy(stream, policy) : stream, outcome: { truncated: false } };
    } });
    const controller = new AbortController();
    const chunks = [];
    const result = (async () => {
      try { for await (const chunk of rag.queryGlobal('Warmup', controller.signal, 'course', (p) => published.push(p))) chunks.push(chunk); return { ok: true }; }
      catch (error) { return { error }; }
    })();
    async function flush() { for (let n = 0; n < 16; n++) await Promise.resolve(); }
    async function advance(ms) {
      await flush(); const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    }
    return { advance, flush, result, chunks, calls, published, policy, controller, timers,
      activity: () => { policy.lastActivityAt = now; },
      complete: () => pending({ done: true }), pulls: () => pulls, returned: () => returned };
  }

  test(`${platform}: local global RAG survives 90s first useful warmup with one request`, async () => {
    const h = timedManager({ steps: [{ ms: 90000, result: { done: false, value: 'Local answer' } }] });
    await h.advance(90000);
    assert.deepEqual(h.chunks, ['Local answer']); assert.equal(h.calls.length, 1);
    assert.equal(h.published.length, 1, 'timing is available before the first pull');
    assert.equal(h.policy.signal.aborted, false);
    h.complete(); await h.flush(); assert.equal((await h.result).ok, true); assert.equal(h.timers.size, 0);
  });

  test(`${platform}: hidden activity re-arms idle without concurrent pulls`, async () => {
    const h = timedManager({ steps: [{ ms: 1, result: { done: false, value: 'Visible' } }] });
    await h.advance(1); await h.advance(50000); h.activity(); await h.advance(20000);
    assert.equal(h.policy.signal.aborted, false); assert.equal(h.pulls(), 2);
    h.complete(); await h.flush(); assert.equal((await h.result).ok, true);
  });

  test(`${platform}: 5min total ends even continuously active hidden reasoning and aborts transport`, async () => {
    const h = timedManager();
    for (let n = 0; n < 5; n++) { await h.advance(59000); h.activity(); }
    await h.advance(5000);
    assert.match((await h.result).error?.message ?? '', /timed out/);
    assert.equal(h.policy.signal.aborted, true); assert.equal(h.returned(), 1); assert.equal(h.pulls(), 1);
    assert.equal(h.timers.size, 0);
  });

  test(`${platform}: after output, 60s idle fails explicitly rather than reporting complete`, async () => {
    const h = timedManager({ steps: [{ ms: 1, result: { done: false, value: 'Partial' } }] });
    await h.advance(60001);
    assert.match((await h.result).error?.message ?? '', /stalled/);
    assert.equal(h.policy.signal.aborted, true); assert.deepEqual(h.chunks, ['Partial']); assert.equal(h.returned(), 1);
  });

  test(`${platform}: explicit cancellation releases a parked pull immediately`, async () => {
    const h = timedManager(); await h.flush(); h.controller.abort(); await h.flush();
    assert.equal((await h.result).error?.name, 'AbortError');
    assert.equal(h.policy.signal.aborted, true); assert.equal(h.returned(), 1); assert.equal(h.timers.size, 0);
  });

  test(`${platform}: cloud retains 15s per-pull watchdog and publishes no local policy`, async () => {
    const h = timedManager({ local: false }); await h.advance(15000);
    assert.match((await h.result).error?.message ?? '', /stalled/);
    assert.equal(h.calls[0][7].aborted, true); assert.equal(h.published.length, 0);
  });
}

test('global preload bridge carries pins without changing existing callers', () => {
  const preload = read('../../preload.ts');
  assert.match(preload, /ragQueryGlobal: \(query: string, courseIds\?: string\[\], requestId\?: string\) => ipcRenderer\.invoke\('rag:query-global', \{ query, courseIds, requestId \}\)/);
  assert.match(preload, /interface DirectAssistRequest \{\s*courseIds\?: string\[\]/);
});
