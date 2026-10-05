import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { launcherComposer, contract, mockSelectedTransport } from './launcherContextHarness.mjs';

// Execute both real launcher handlers and queryGlobal. Storage and transport
// are mocked; launcher assembly and the V3 ports/composer execute unchanged.
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function evaluate(source, platform, imports = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(source), {
    module, exports: module.exports, console, AbortController, setTimeout, clearTimeout,
    process: { platform, env: {} }, require: id => imports[id] ?? {}, ...globals,
  });
  return module.exports;
}

const ipc = read('../../ipcHandlers.ts');
const ast = ts.createSourceFile('ipcHandlers.ts', ipc, ts.ScriptTarget.Latest, true);
const handlers = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === '_geminiChatStreamHandler') {
    handlers.fallback = node.initializer.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'safeHandle'
    && node.arguments[0]?.getText(ast) === "'rag:query-global'") {
    handlers.rag = node.arguments[1].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handlers.rag && handlers.fallback, 'test must execute the production handlers');

const sentinels = {
  instructions: 'MODE_INSTRUCTIONS_CANARY: answer using the selected career-coach voice',
  document: 'MODE_DOCUMENT_CANARY: the Atlas project reduced latency to 73 milliseconds',
  profile: 'PROFILE_CANARY: the candidate led the Atlas project at Example Company',
  course: 'COURSE_CANARY: the enabled and pinned course defines TCP as reliable transport',
  meeting: 'MEETING_CANARY: a past meeting discussed Atlas latency',
};


async function dispatch(platform, path, opts = {}) {
  const grounding = evaluate(read('../../courses/chatGrounding.ts'), platform);
  const policies = evaluate(read('../../llm/providerStreamPolicy.ts'), platform);
  const modeInfo = { id: 'career-mode', name: 'Career coach', templateType: opts.templateType ?? 'looking-for-work', customContext: sentinels.instructions, sourceContract: 'contract' in opts ? opts.contract : contract() };
  const question = opts.question ?? `Tell me about my Atlas project experience using the uploaded file and my profile${path === 'rag' ? ' and using the transcript' : ''}.`;
  const files = opts.noFiles ? [] : [{ id: 'atlas-doc', fileName: opts.fileName ?? 'Atlas project.txt', content: opts.fileContent ?? sentinels.document, modeId: modeInfo.id }];
  const knowledge = {
    activeResume: { id: 1, structured_data: { projects: [{ name: 'Atlas', description: sentinels.profile }] }, raw_text: `# Candidate Resume\n## Experience\n${sentinels.profile}` },
    isKnowledgeMode: () => true,
    processQuestion: async () => ({ contextBlock: sentinels.profile }),
    feedForDepthScoring() {},
  };
  const mm = {
    getActiveModeInfo: () => opts.noMode ? null : modeInfo,
    getModeSnapshot: () => modeInfo,
    getActiveModePinnedInstructions: (_answerType, pinnedId) => {
      assert.equal(pinnedId, mm.getActiveModeInfo()?.id);
      return modeInfo.customContext;
    },
    getActiveModeSystemPromptSuffix: () => sentinels.instructions,
    getReferenceFiles: () => files,
    isProfileIntelligenceAllowedForMode: () => true,
    getActiveModeDocumentGroundingInfo: () => ({
      modeId: modeInfo.id, modeName: modeInfo.name, isCustom: false, hasReferenceFiles: true,
      documentGroundedCustomModeActive: false, strictDocumentGroundedActive: false,
    }),
    buildRetrievedActiveModeContextBlock: () => sentinels.document,
    buildRetrievedActiveModeContextBlockHybrid: async () => sentinels.document,
  };
  if (opts.noProfile) knowledge.activeResume = null;
  if (opts.withJD) knowledge.activeJD = { id: 2, structured_data: { roleTitle: 'Atlas engineer', requirements: ['JD_SWITCH_CANARY Atlas ownership'] }, raw_text: '# Job Description\nJD_SWITCH_CANARY Atlas ownership' };
  const profileReads = { resume: 0, jd: 0 };
  for (const [property, kind] of [['activeResume', 'resume'], ['activeJD', 'jd']]) {
    let value = knowledge[property];
    Object.defineProperty(knowledge, property, {
      get() { profileReads[kind]++; return value; }, set(next) { value = next; },
    });
  }
  if (opts.retrieveHybridRaw) mm.retrieveHybridRaw = opts.retrieveHybridRaw;
  const ModesManager = { getInstance: () => mm };
  const imports = {
    './prompts': evaluate(read('../prompts.ts'), platform),
    '../courses/chatGrounding': grounding,
    '../llm/providerStreamPolicy': policies,
    './services/ModesManager': { ModesManager },
    './services/ForegroundGate': { ForegroundGate: {} },

  };
  const composer = launcherComposer(platform, { modesManager: mm, scopePolicy: opts.scopePolicy, answerPolicy: opts.answerPolicy });
  imports['./launcherAskContext'] = composer;
  imports['./rag/launcherAskContext'] = composer;
  const ragModule = evaluate(read('../RAGManager.ts'), platform, imports);
  imports['./rag/RAGManager'] = ragModule;
  const rag = Object.create(ragModule.RAGManager.prototype);
  rag.isReady = () => true;
  let meetingRetrievals = 0;
  rag.retriever = { retrieveGlobal: async () => {
    meetingRetrievals++;
    opts.onMeeting?.({ modeInfo, files, knowledge });
    return { chunks: opts.emptyMeetings ? [] : [{}], formattedContext: sentinels.meeting, intent: 'open_question' };
  } };
  const calls = [];
  const helper = {
    captureRAGAnswerTransport() { return mockSelectedTransport(this); },
    getCodexSelectionAuthError: () => null,
    selectionStaysOnDevice: () => opts.onDevice === true,
    getKnowledgeOrchestrator: () => knowledge,
    knowledgeOrchestrator: knowledge,
    streamRAGAnswer(...args) {
      calls.push(args);
      return { outcome: { truncated: false }, stream: (async function* () { yield 'Selected model answer'; })() };
    },
    streamChat() { throw new Error('launcher must not switch to the Background Model'); },
  };
  rag.setLLMHelper(helper);
  const events = [];
  const activeRAGQueries = new Map();
  const appState = {
    getRAGManager: () => rag,
    processingHelper: { getLLMHelper: () => helper },
    getIsMeetingActive: () => false,
  };
  const handler = evaluate(`module.exports = ${handlers[path]};`, platform, imports, {
    appState, ModesManager, activeRAGQueries,
    crypto: { randomUUID: () => 'survey-turn' },
    abortPriorRAGQueriesOfClass() {},
    getChatCourseGrounding: async (message, pins) => {
      assert.equal(message, question);
      assert.deepEqual([...pins], ['selected-course']);
      opts.onCourse?.({ modeInfo, files, knowledge, activeRAGQueries });
      return opts.noCourses ? null : opts.courseGrounding ?? sentinels.course;
    },
    courseGroundingAsReference: grounding.courseGroundingAsReference,
    beginTrace: () => ({}), _chatStreamId: 0, _chatStreamsBySender: new Map(),
    CHAT_MODE_PROMPT: 'Answer the current question on the reading surface.',
  });
  const event = { sender: { id: 42, send: (...args) => events.push(args) } };
  let setupError;
  if (path === 'rag') {
    const result = await handler(event, { query: question, courseIds: ['selected-course'], requestId: 'survey-turn' });
    if (!opts.expectNoDispatch) assert.equal(result.success, true, result.error);
    setupError = result.error;
  } else {
    try {
      await handler(event, question, undefined, undefined, {
        surface: 'chat', courseIds: ['selected-course'], selectedModelOnly: true, requestId: 'survey-turn',
      });
    } catch (error) {
      if (!opts.expectNoDispatch) throw error;
      setupError = error.message;
    }
  }
  assert.equal(calls.length, opts.expectNoDispatch ? 0 : 1, 'selected-model dispatch count');
  assert.equal(activeRAGQueries.size, 0);
  return { args: calls[0], events, meetingRetrievals, composer, mm, helper, setupError, profileReads };
}

for (const platform of ['darwin', 'win32']) {
  for (const path of ['rag', 'fallback']) {
    test(`${platform}/${path}: course evidence and request correlation survive launcher dispatch`, async () => {
      const { args, events } = await dispatch(platform, path);
      assert.ok(args[0].includes(sentinels.course));
      assert.ok(!args[3].includes(sentinels.course), 'private course evidence stays out of system policy');
      assert.ok([...args[6]].includes('reference_files'));
      assert.ok(args[7] instanceof AbortSignal);
      assert.equal(events.at(-1)[0], path === 'rag' ? 'rag:stream-complete' : 'gemini-stream-done');
      assert.equal(events.at(-1)[1].requestId, 'survey-turn');
      if (path === 'rag') assert.ok(args[0].includes(sentinels.meeting));
    });
    for (const key of ['instructions', 'document', 'profile']) {
      test(`${platform}/${path}: launcher Ask receives permitted active ${key}`, async () => {
        const { args } = await dispatch(platform, path);
        const payload = [args[0], args[2], args[3]].filter(Boolean).join('\n');
        assert.ok(payload.includes(sentinels[key]), `selected-model payload is missing active ${key}`);
        if (key !== 'instructions') assert.ok(!args[3].includes(sentinels[key]), 'private evidence stays out of system policy');
      });
    }
  }
}

for (const platform of ['darwin', 'win32']) for (const path of ['rag', 'fallback']) {
  test(`${platform}/${path}: persisted profile owner does not widen to uploaded files or past meetings`, async () => {
    const { args, meetingRetrievals } = await dispatch(platform, path, {
      contract: contract('profile_only'), question: 'Tell me about my Atlas project experience.',
    });
    assert.ok(args[0].includes(sentinels.profile));
    assert.ok(!args[0].includes(sentinels.document));
    assert.ok(!args[0].includes(sentinels.meeting));
    assert.ok(args[0].includes(sentinels.course), 'course opt-in remains independent on flexible modes');
    assert.equal(meetingRetrievals, 0);
    assert.equal(args[9].pinnedModeId, 'career-mode');
    assert.equal(args[9].v3Owned, true);
    assert.equal(args[4], true); assert.equal(args[5], true);
  });

  test(`${platform}/${path}: canonical profile switch hydrates only the permitted résumé`, async () => {
    const { args, profileReads } = await dispatch(platform, path, {
      contract: contract('reference_files_primary', ['profile']), withJD: true,
      question: 'Tell me about my Atlas project experience from my profile.',
    });
    assert.ok(args[0].includes(sentinels.profile));
    assert.ok(!args[0].includes(sentinels.document));
    assert.ok(!args[0].includes('JD_SWITCH_CANARY'));
    assert.ok(profileReads.resume > 0);
    assert.equal(profileReads.jd, 0, 'profile consent is not JD consent');
  });

  test(`${platform}/${path}: canonical JD switch hydrates JD without reading résumé history`, async () => {
    const { args, profileReads } = await dispatch(platform, path, {
      contract: contract('reference_files_primary', ['job_description']), withJD: true,
      question: 'What does the job description require for Atlas?',
    });
    assert.ok(args[0].includes('JD_SWITCH_CANARY'));
    assert.ok(!args[0].includes(sentinels.profile));
    assert.ok(!args[0].includes(sentinels.document));
    assert.equal(profileReads.resume, 0, 'JD consent is not résumé consent');
    assert.ok(profileReads.jd > 0);
  });

  test(`${platform}/${path}: switch eligibility alone does not read or admit profile sources`, async () => {
    const { args, profileReads } = await dispatch(platform, path, {
      contract: contract('reference_files_primary', ['profile', 'job_description']), withJD: true,
      question: 'What Atlas latency is in the uploaded file?',
    });
    assert.ok(args[0].includes(sentinels.document));
    assert.ok(!args[0].includes(sentinels.profile));
    assert.ok(!args[0].includes('JD_SWITCH_CANARY'));
    assert.deepEqual(profileReads, { resume: 0, jd: 0 });
  });

  test(`${platform}/${path}: denied explicit profile request never reads private history`, async () => {
    const { args, profileReads } = await dispatch(platform, path, {
      contract: contract('reference_files_primary', []), withJD: true,
      question: 'Tell me about my Atlas project experience from my profile.',
    });
    assert.ok(!args[0].includes(sentinels.profile));
    assert.match(args[3], /not permitted/);
    assert.deepEqual(profileReads, { resume: 0, jd: 0 });
  });

  test(`${platform}/${path}: requested profile missing after preflight fails closed`, async () => {
    const { args, profileReads } = await dispatch(platform, path, {
      contract: contract('reference_files_primary', ['profile']), noProfile: true, withJD: true,
      question: 'Tell me about my Atlas project experience from my profile.',
    });
    for (const key of ['profile', 'document', 'meeting', 'course']) assert.ok(!args[0].includes(sentinels[key]), key);
    assert.ok(!args[0].includes('JD_SWITCH_CANARY'));
    assert.match(args[3], /unavailable/);
    assert.equal(profileReads.jd, 0);
  });

  test(`${platform}/${path}: strict reference ownership rejects an explicit profile switch`, async () => {
    const { args, meetingRetrievals } = await dispatch(platform, path, {
      contract: contract('reference_files_only'), question: 'Tell me about my Atlas project experience from my profile.',
    });
    for (const key of ['profile', 'document', 'meeting', 'course']) assert.ok(!args[0].includes(sentinels[key]), key);
    assert.match(args[3], /not permitted/);
    assert.equal(meetingRetrievals, 0);
    assert.equal(args[6].length, 0);
  });

  test(`${platform}/${path}: explicit reference switch respects consent without hydrating forbidden profile`, async () => {
    const { args } = await dispatch(platform, path, {
      contract: contract('profile_only'), question: 'What latency is in the uploaded file?',
    });
    assert.ok(args[0].includes(sentinels.document));
    assert.ok(!args[0].includes(sentinels.profile));
    assert.ok(args[0].includes(sentinels.course));
  });

  test(`${platform}/${path}: forbidden-profile templates still receive their own instructions and documents`, async () => {
    const { args } = await dispatch(platform, path, {
      templateType: 'sales', contract: contract('general_mixed'), question: 'What Atlas latency is in the uploaded file?',
    });
    assert.ok(args[0].includes(sentinels.document));
    assert.ok(args[3].includes(sentinels.instructions));
    assert.ok(!args[0].includes(sentinels.profile));
  });

  test(`${platform}/${path}: a technical answer never hydrates personal history`, async () => {
    const { args } = await dispatch(platform, path, { question: 'Explain the difference between TCP and UDP.' });
    assert.ok(!args[0].includes(sentinels.profile));
    assert.ok(args[0].includes(sentinels.course));
  });

  test(`${platform}/${path}: a mode switch during course grounding cannot replace pinned identity or sources`, async () => {
    const { args } = await dispatch(platform, path, { onCourse({ modeInfo, files, knowledge }) {
      modeInfo.id = 'new-mode'; modeInfo.templateType = 'sales';
      modeInfo.customContext = 'NEW_MODE_INSTRUCTIONS'; modeInfo.sourceContract = contract('transcript_only');
      files[0].id = 'new-doc'; files[0].content = 'NEW_MODE_PRIVATE_DOCUMENT';
      knowledge.activeResume.raw_text = 'NEW_PROFILE_PRIVATE_BODY';
      knowledge.activeResume.structured_data.projects[0].description = 'NEW_PROFILE_PRIVATE_BODY';
    } });
    for (const key of ['document', 'profile']) assert.ok(args[0].includes(sentinels[key]), key);
    assert.ok(args[3].includes(sentinels.instructions));
    assert.ok(!args[0].includes('NEW_'));
    assert.equal(args[9].pinnedModeId, 'career-mode');
  });

  test(`${platform}/${path}: cloud privacy denies every private pool before provider dispatch`, async () => {
    const { args } = await dispatch(platform, path, {
      scopePolicy: { reference_files: false, transcript: false, profile_history: false },
    });
    for (const key of ['document', 'profile', 'meeting', 'course']) assert.ok(!args[0].includes(sentinels[key]), key);
    assert.equal(args[6].length, 0);
    assert.match(args[0], /privacy/i);
    assert.ok(args[3].includes(sentinels.instructions));
  });

  test(`${platform}/${path}: selected on-device answers retain scoped evidence despite cloud denials`, async () => {
    const { args } = await dispatch(platform, path, {
      onDevice: true, scopePolicy: { reference_files: false, transcript: false, profile_history: false },
    });
    for (const key of ['document', 'profile', 'course']) assert.ok(args[0].includes(sentinels[key]), key);
    assert.ok([...args[6]].includes('reference_files'));
    assert.ok([...args[6]].includes('profile_history'));
    if (path === 'rag') assert.ok([...args[6]].includes('transcript'));
    for (const key of ['document', 'profile', 'meeting', 'course']) assert.ok(!args[3].includes(sentinels[key]), key);
  });

  test(`${platform}/${path}: no-mode launcher keeps courses without inheriting Profile Intelligence`, async () => {
    const { args } = await dispatch(platform, path, { noMode: true, question: 'What is TCP?' });
    assert.ok(args[0].includes(sentinels.course));
    assert.ok(!args[0].includes(sentinels.profile));
    assert.ok(!args[0].includes(sentinels.document));
    assert.ok(!args[3].includes(sentinels.instructions));
  });

  test(`${platform}/${path}: a missing persisted source contract fails closed`, async () => {
    const { args, setupError } = await dispatch(platform, path, { contract: null, expectNoDispatch: true,
      onCourse() { assert.fail('missing contract must fail before asynchronous grounding'); },
    });
    assert.equal(args, undefined);
    assert.match(setupError, /selected mode has no source contract/);
  });

  test(`${platform}/${path}: independently budgeted course citations are not dropped by a smaller mode budget`, async () => {
    const courseGrounding = `${'A course lesson on reliable transport. '.repeat(420)}\n${sentinels.course}\nSource URL: https://courses.test/tcp`;
    const { args } = await dispatch(platform, path, { courseGrounding });
    assert.ok(args[0].includes(sentinels.course));
    assert.ok(args[0].includes('https://courses.test/tcp'));
    assert.ok(!args[0].includes('No reference material is attached'));
    assert.ok(args[0].includes(sentinels.document));
  });
}

for (const platform of ['darwin', 'win32']) {
  for (const path of ['rag', 'fallback']) {
    test(`${platform}/${path}: course-only Seminar classifies an available source and never claims no material is attached`, async () => {
      const { args } = await dispatch(platform, path, {
        templateType: 'seminar', noFiles: true, noProfile: true, emptyMeetings: true,
        contract: contract('reference_files_primary', []), question: 'What is TCP?',
      });
      assert.ok(args[0].includes(sentinels.course));
      assert.ok(!args[3].includes('No file, slide deck or document is attached'));
      assert.ok(!args[0].includes('No reference material is attached'));
      assert.match(args[0], /source_name="Course ground truth"/);
    });

    test(`${platform}/${path}: résumé-shaped mode attachments obey reference-file outbound consent too`, async () => {
      const { args } = await dispatch(platform, path, {
        fileName: 'Resume.txt', fileContent: `# Candidate\n## Experience\n${sentinels.document}\n## Education\nUniversity`,
        question: 'What latency is in the uploaded file?', scopePolicy: { reference_files: false, profile_history: true },
      });
      assert.ok(!args[0].includes(sentinels.document));
      assert.ok(!args[0].includes(sentinels.course));
      assert.ok(![...args[6]].includes('reference_files'));
      assert.match(args[0], /privacy/i);
    });

    test(`${platform}/${path}: raw mode retrieval uses snapshotted files and rejects foreign evidence`, async () => {
      const rawCalls = [];
      const { args } = await dispatch(platform, path, {
        question: 'What latency is in the uploaded file?',
        fileContent: `${sentinels.document}\n${'Atlas project engineering notes and operational details. '.repeat(600)}`,
        retrieveHybridRaw: async (mode, files, options) => {
          rawCalls.push({ mode, files, options });
          return { chunks: [
            { sourceId: 'atlas-doc', text: sentinels.document, score: 1 },
            { sourceId: 'foreign-mode-doc', text: 'FOREIGN_PRIVATE_EVIDENCE', score: 1 },
          ] };
        },
      });
      assert.ok(rawCalls.length > 0);
      assert.ok(rawCalls.every(c => c.mode.id === 'career-mode' && c.files.length === 1 && c.files[0].id === 'atlas-doc'));
      assert.ok(args[0].includes(sentinels.document));
      assert.ok(!args[0].includes('FOREIGN_PRIVATE_EVIDENCE'));
    });
  }

  test(`${platform}/rag: empty meeting search does not suppress courses or mode evidence`, async () => {
    const { args } = await dispatch(platform, 'rag', { emptyMeetings: true, question: 'What latency is in the uploaded file?' });
    assert.ok(args[0].includes(sentinels.document)); assert.ok(args[0].includes(sentinels.course));
    assert.ok(!args[0].includes(sentinels.meeting));
    assert.ok(![...args[6]].includes('transcript'));
    assert.ok(!args[0].includes('No reference material is attached'));
  });

  test(`${platform}/rag: reference-first empty source fallback can still retrieve permitted past meetings`, async () => {
    const { args, meetingRetrievals } = await dispatch(platform, 'rag', {
      contract: contract('reference_files_primary', []), noFiles: true, noCourses: true,
      question: 'What did Atlas decide?',
    });
    assert.equal(meetingRetrievals, 1); assert.ok(args[0].includes(sentinels.meeting));
    assert.ok(!args[0].includes(sentinels.profile));
  });

  test(`${platform}/rag: transcript-only mode retains past evidence but excludes every reference/profile pool`, async () => {
    const { args, meetingRetrievals } = await dispatch(platform, 'rag', {
      contract: contract('transcript_only', []), question: 'What did Atlas decide?',
    });
    assert.equal(meetingRetrievals, 1); assert.ok(args[0].includes(sentinels.meeting));
    for (const key of ['document', 'profile', 'course']) assert.ok(!args[0].includes(sentinels[key]), key);
    assert.deepEqual([...args[6]], ['transcript']);
    assert.match(args[3], /Answer only from the evidence/);
  });

  test(`${platform}/rag: references plus transcript mode cannot inherit personal profile facts`, async () => {
    const { args } = await dispatch(platform, 'rag', {
      contract: contract('reference_files_plus_transcript', []), question: 'What did Atlas decide?',
    });
    for (const key of ['document', 'meeting', 'course']) assert.ok(args[0].includes(sentinels[key]), key);
    assert.ok(!args[0].includes(sentinels.profile));
    assert.match(args[3], /Answer only from the evidence/);
  });

  test(`${platform}/rag: identity and profile snapshot also survive a switch during meeting retrieval`, async () => {
    const { args } = await dispatch(platform, 'rag', { onMeeting({ modeInfo, files, knowledge }) {
      modeInfo.id = 'other-meeting-mode'; modeInfo.customContext = 'OTHER_INSTRUCTIONS';
      files[0].content = 'OTHER_PRIVATE_DOCUMENT'; knowledge.activeResume.raw_text = 'OTHER_PROFILE_RAW';
    } });
    assert.equal(args[9].pinnedModeId, 'career-mode');
    assert.ok(args[3].includes(sentinels.instructions));
    assert.ok(args[0].includes(sentinels.document)); assert.ok(args[0].includes(sentinels.profile));
    assert.ok(!args[0].includes('OTHER_'));
  });

  test(`${platform}: persisted source consent prevents even reading unauthorized profile documents`, () => {
    const mode = { id: 'no-profile-consent', templateType: 'looking-for-work', sourceContract: contract('reference_files_primary', []) };
    let reads = 0;
    const composer = launcherComposer(platform, { modesManager: {
      getActiveModeInfo: () => mode, getReferenceFiles: () => [], getActiveModePinnedInstructions: () => 'configured voice',
    } });
    const snapshot = composer.captureLauncherAskContext({ question: 'Tell me about my Atlas project experience.', senderId: 42,
      llmHelper: { captureRAGAnswerTransport() { return mockSelectedTransport(this); }, getKnowledgeOrchestrator() { reads++; throw new Error('must not touch the profile pool'); } },
    });
    assert.equal(reads, 0); assert.equal(snapshot.profileDocs.length, 0);
  });

  test(`${platform}/rag: cancellation while course grounding awaits never dispatches a provider`, async () => {
    const { args, events, meetingRetrievals } = await dispatch(platform, 'rag', { expectNoDispatch: true,
      onCourse({ activeRAGQueries }) { for (const controller of activeRAGQueries.values()) controller.abort(); },
    });
    assert.equal(args, undefined); assert.equal(meetingRetrievals, 0);
    assert.ok(!events.some(e => e[0] === 'rag:stream-complete'));
  });

  test(`${platform}: launcher sessions isolate both sender and unique mode identity`, async () => {
    const { composer, mm, helper } = await dispatch(platform, 'fallback');
    const capture = senderId => composer.captureLauncherAskContext({ question: 'Why not?', llmHelper: helper, senderId });
    const first = capture(42); const otherSender = capture(43);
    assert.notEqual(first.sessionId, otherSender.sessionId);
    mm.getActiveModeInfo = () => ({ id: 'same-template-other-mode', templateType: 'looking-for-work', sourceContract: contract() });
    assert.notEqual(first.sessionId, capture(42).sessionId);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(composer.composeLauncherAskContext({ snapshot: first, question: 'Why not?', signal: controller.signal }), { name: 'AbortError' });
  });
}
