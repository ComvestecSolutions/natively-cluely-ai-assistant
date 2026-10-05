import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import test from 'node:test';
import { launcherComposer, launcherFallbackHandler } from './launcherContextHarness.mjs';

// Real HTTP -> custom/cURL -> _streamChatTracked -> global RAG/launcher IPC.
// Only launcher persistence/native seams and capability fixtures are replaced.
const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
const ragModule = require('../../../dist-electron/electron/rag/RAGManager.js');
const grounding = require('../../../dist-electron/electron/courses/chatGrounding.js');
const { frameCurrentQuestion } = require('../../../dist-electron/electron/llm/localContextTrim.js');
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const question = 'What is 2+3?';
const frame = frameCurrentQuestion(question);
const cases = [
  { name: 'exact echoed prolog', question, response: `${frame}\n5`, expected: '5' },
  { name: 'multiline Markdown question', question: 'What is 2+3?\n# Evidence\nExplain briefly.',
    response: `${frameCurrentQuestion('What is 2+3?\n# Evidence\nExplain briefly.')}\n5\nTwo plus three is five.`, expected: '5\nTwo plus three is five.' },
  { name: 'normal answer', question, response: '5', expected: '5' },
  { name: 'fenced literal framing', question, response: `\`\`\`xml\n${frame}\n\`\`\`\n5`, expected: `\`\`\`xml\n${frame}\n\`\`\`\n5` },
  { name: 'intentional exact literal wrapper', question: 'Show the literal current_question XML wrapper for this request.',
    response: `${frameCurrentQuestion('Show the literal current_question XML wrapper for this request.')}\nThis is an example.`,
    expected: `${frameCurrentQuestion('Show the literal current_question XML wrapper for this request.')}\nThis is an example.` },
  { name: 'literal tag explanation', question: 'Explain <current_question> and </current_question>.',
    response: '<current_question> begins the question; </current_question> ends it.', expected: '<current_question> begins the question; </current_question> ends it.' },
  { name: 'non-leading framing example', question, response: `For example:\n${frame}\n5`, expected: `For example:\n${frame}\n5` },
  { name: 'different question is not our echo', question, response: `${frameCurrentQuestion('What is 8+9?')}\n17`, expected: `${frameCurrentQuestion('What is 8+9?')}\n17` },
  { name: 'code answer whitespace is unchanged', question, response: `${frame}\n    print(5)\n`, expected: '    print(5)\n' },
  { name: 'echo after hidden working', question, response: `<think>Check arithmetic.</think>[[CALC]]\n2 + 3 = 5\n[[/CALC]]\n${frame}\n5`, expected: '5' },
  { name: 'echo before hidden working', question, response: `${frame}\n[[CALC]]\n2 + 3 = 5\n[[/CALC]]\n5`, expected: '5' },
  { name: 'incomplete echo flushes unchanged', question, response: '<current_quest', expected: '<current_quest' },
];

async function endpoint(t, response) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // One-character provider deltas exercise all marker and question splits.
      for (const content of response) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
}
function helper(route, url) {
  const provider = { id: 'echo-selected', name: 'Selected endpoint', responsePath: 'choices[0].message.content',
    curlCommand: `curl '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'exact-selected-model', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{USER_MESSAGE}}' }], stream: true })}'`,
  };
  const h = Object.create(LLMHelper.prototype);
  Object.assign(h, { customProvider: route === 'custom' ? provider : null, activeCurlProvider: route === 'curl' ? provider : null,
    configuredCustomProviders: [provider], currentModelId: 'unused-background', useOllama: false, isLocalOnlyMode: false,
    answerLatency: new Map(), injectLanguageInstruction: x => x, getPromptTier: () => 'balanced',
    getCapabilities: () => ({ outputBudgetTokens: 2000, maxContextTokens: 131072 }), fitContextForCurrentModel: x => x,
    buildTextSpareRungs() { assert.fail('an echo regression must not reroute the selected provider'); },
  });
  return h;
}

let nextSenderId = 987;
for (const platform of ['darwin', 'win32']) for (const path of ['rag', 'fallback']) for (const route of ['custom', 'curl']) for (const fixture of cases) {
  test(`${platform}/${path}/${route}: ${fixture.name}`, async t => {
    const senderId = nextSenderId++;
    const server = await endpoint(t, fixture.response);
    const h = helper(route, server.url);
    const composer = launcherComposer(platform);
    let chunks;
    if (path === 'rag') {
      const rag = Object.create(ragModule.RAGManager.prototype); rag.setLLMHelper(h);
      rag.retriever = { retrieveGlobal: async () => ({ chunks: [], formattedContext: '', intent: 'open_question' }) };
      const snapshot = composer.captureLauncherAskContext({ question: fixture.question, llmHelper: h, senderId });
      chunks = await collect(rag.queryGlobal(fixture.question, undefined, null, undefined, snapshot));
    } else {
      const events = [];
      const handler = launcherFallbackHandler(platform, { helper: h, composer, ragModule, grounding, getChatCourseGrounding: async () => null });
      await handler({ sender: { id: senderId, send: (...args) => events.push(args) } }, fixture.question, undefined, undefined,
        { selectedModelOnly: true, surface: 'chat', requestId: 'echo-request' });
      chunks = events.filter(e => e[0] === 'gemini-stream-token').map(e => e[1]);
      const done = events.find(e => e[0] === 'gemini-stream-done');
      assert.ok(done, 'fallback must complete');
      assert.equal(done[1].finalText, fixture.expected);
    }
    assert.equal(chunks.join(''), fixture.expected, 'the rendered answer must be exact, without the internal echoed prolog');
    assert.ok(chunks.every(Boolean), 'never emit empty chunks while matching a framing prefix');
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].model, 'exact-selected-model');
    const user = server.requests[0].messages.find(m => m.role === 'user').content;
    assert.ok(user.startsWith(frameCurrentQuestion(fixture.question)), 'provider must receive the real composer framing, not a hand-built test prompt');
    assert.equal(Object.hasOwn(h, '_streamChatTracked'), false);
    assert.equal(Object.hasOwn(h, '_streamChatInner'), false);
    assert.equal(Object.hasOwn(h, 'assertOutboundScopes'), false);
  });
}
