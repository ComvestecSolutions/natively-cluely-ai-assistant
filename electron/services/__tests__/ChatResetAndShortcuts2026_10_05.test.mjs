import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const renderer = ts.createSourceFile('NativelyInterface.tsx', read('src/components/NativelyInterface.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const keybinds = ts.createSourceFile('KeybindManager.ts', read('electron/services/KeybindManager.ts'), ts.ScriptTarget.Latest, true);
const engineSource = ts.createSourceFile('IntelligenceEngine.ts', read('electron/IntelligenceEngine.ts'), ts.ScriptTarget.Latest, true);
const parse = rel => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const ipc = parse('electron/ipcHandlers.ts');
const main = parse('electron/main.ts');
const shortcutsSource = parse('src/hooks/useShortcuts.ts');
const keyboardSource = parse('src/utils/keyboardUtils.ts');
const require = createRequire(import.meta.url);
const phoneMirrorBoundary = { getInstance: () => ({ publishMeetingState() {} }) };
const method = (source, name) => find(source, n => ts.isMethodDeclaration(n) && n.name.getText(source) === name);
const variable = (source, name) => find(source, n => ts.isVariableDeclaration(n) && n.name.getText(source) === name);
const expression = (node, source, scope = {}) => vm.runInNewContext(transformSync(`(${node.getText(source)})`, { loader: 'ts', target: 'es2022' }).code, scope);
const ipcCallback = name => find(ipc, n => ts.isCallExpression(n) && n.expression.getText(ipc) === 'safeHandle' && n.arguments[0]?.text === name).arguments[1];
function find(source, predicate) {
  let found;
  const visit = node => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(source);
  assert.ok(found, 'production symbol not found');
  return found;
}
function callback(name) {
  const node = find(renderer, n => ts.isVariableDeclaration(n) && n.name.getText(renderer) === name);
  return ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
}
function execute(node, source, scope, receiver) {
  let text = node.getText(source).replace(/^export\s+/, '');
  if (ts.isMethodDeclaration(node)) text = text.replace(/^(?:public|private)\s+/, '');
  if (ts.isMethodDeclaration(node)) text = text.startsWith('async ') ? `async function ${text.slice(6)}` : `function ${text}`;
  const js = transformSync(`(${text})`, { loader: 'ts', target: 'es2022' }).code;
  scope.__testReceiver = receiver;
  return vm.runInNewContext(`(function() { return ${js.trim().replace(/;$/, '')}; }).call(__testReceiver)`, scope).bind(receiver);
}
function rendererRig() {
  const state = { messages: [{ id: 'old', text: 'old answer' }], attachedContext: [{ path: 'old.png' }], inputValue: 'old question' };
  const refs = {
    tokenBufRef: { current: { intent: '', text: '', raf: null } },
    diagramRepairsRef: { current: new Map() },
    diagramRepairBlockedRef: { current: new Set() },
    phoneShotPathsRef: { current: new Map() },
    overlayActionInFlightRef: { current: new Set() },
    chatResetEpochRef: { current: 0 },
    chatResetPendingRef: { current: false },
  };
  const scope = new Proxy({
    console, performance, Date, Promise,
    mergeTranscriptChunks: (a, b) => [a, b].filter(Boolean).join(' '),
    inputValue: 'new question', attachedContext: [], messages: [], directAssistEnabled: false,
    shouldDedupeManualSubmit: () => false, genMessageId: () => 'id',
    buildConversationContextFromMessages: () => '', getCoursePinIds: () => ['selected-course'],
    createPacerState: () => ({}), useCallback: fn => fn,
    tryBeginOverlayAction: () => true, analytics: { trackCommandExecuted() {} },
    QUICK_ACTION_LABELS: {},
    window: { electronAPI: { cancelChatStream() {}, resetIntelligence: async () => ({ success: true }) } },
    cancelAnimationFrame() {}, clearTimeout,
  }, { get(target, key) {
    if (key in target) return target[key];
    if (typeof key !== 'string') return undefined;
    if (key.endsWith('Ref')) return refs[key] ??= { current: null };
    if (key.startsWith('set')) return value => {
      const name = key[3].toLowerCase() + key.slice(4);
      state[name] = typeof value === 'function' ? value(state[name]) : value;
    };
    return () => {};
  } });
  scope.cancelActiveChatStream = execute(callback('cancelActiveChatStream'), renderer, scope);
  scope.resetChatState = execute(callback('resetChatState'), renderer, scope);
  scope.resetConversation = execute(callback('resetConversation'), renderer, scope);
  scope.resetChatStateRef = { current: scope.resetChatState };
  return { scope, state, refs };
}

for (const processing of [false, true]) {
  test(`Reset / Cancel clears chat immediately, processing=${processing}`, async () => {
    const { scope, state } = rendererRig();
    scope.isProcessing = processing;
    let release;
    let calls = 0;
    scope.window.electronAPI.resetIntelligence = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const property = find(renderer, n => ts.isPropertyAssignment(n) && n.name.getText(renderer) === 'resetCancel');
    const run = execute(property.initializer, renderer, scope)();
    const immediateMessages = Array.from(state.messages);
    if (release) release({ success: true });
    await run;
    assert.deepEqual(immediateMessages, [], 'clear synchronously, before the reset IPC resolves');
    assert.equal(calls, 1, 'reset during generation must not be cancel-only');
  });
}

test('renderer reset removes pending text, page/screenshot context and stream refs without touching preferences', () => {
  const { scope, state, refs } = rendererRig();
  const dirty = {
    streamingMsgIdRef: 'old', streamingIntentRef: 'chat', streamingTextRef: 'old text',
    pendingCaptureRef: { path: 'old.png' }, capturedEnvelopeRef: { text: 'old page' }, capturedMetaRef: { title: 'old page' },
    manualTranscriptRef: 'old dictation', voiceInputRef: 'old voice',
    ragArrivedTextRef: 'old rag', liveAnswerGenIdRef: 7,
  };
  for (const [key, value] of Object.entries(dirty)) refs[key] = { current: value };
  refs.tokenBufRef = { current: { intent: 'chat', text: 'old token', raf: null } };
  refs.diagramRepairBlockedRef = { current: new Set() };
  refs.phoneShotPathsRef = { current: new Map([['old', 'old.png']]) };
  scope.resetChatState();
  assert.deepEqual(Array.from(state.messages), []);
  for (const key of ['streamingMsgIdRef', 'streamingIntentRef', 'pendingCaptureRef', 'capturedEnvelopeRef', 'capturedMetaRef']) assert.equal(refs[key].current, null, key);
  for (const key of ['streamingTextRef', 'manualTranscriptRef', 'voiceInputRef', 'ragArrivedTextRef']) assert.equal(refs[key].current, '', key);
  assert.equal(state.inputValue, '');
  assert.deepEqual(Array.from(state.attachedContext), []);
  assert.equal(refs.legacyIntelligenceTombstonedRef.current, true);
  assert.equal(refs.phoneShotPathsRef.current.size, 0);
  assert.deepEqual(scope.getCoursePinIds(), ['selected-course']);
});

test('a stale manual-submit IPC rejection cannot recreate history or release the new request after reset', async () => {
  const { scope, state, refs } = rendererRig();
  refs.tokenBufRef = { current: { intent: '', text: '', raf: null } };
  refs.diagramRepairBlockedRef = { current: new Set() };
  refs.phoneShotPathsRef = { current: new Map() };
  state.messages = [];
  let reject;
  scope.window.electronAPI.streamGeminiChat = () => new Promise((_, fail) => { reject = fail; });
  const submit = execute(callback('handleManualSubmit'), renderer, scope);
  const pending = submit();
  assert.equal(typeof reject, 'function', 'exercise the real submit path up to IPC');
  scope.resetChatState();
  refs.manualSubmitInFlightRef.current = true; // a new request now owns the surface
  reject(new Error('old request failed'));
  await pending;
  assert.deepEqual(Array.from(state.messages), []);
  assert.equal(refs.manualSubmitInFlightRef.current, true, 'old finally must not unlock a newer request');
});

for (const [name, api] of [
  ['handleWhatToSay', 'generateWhatToSay'], ['handleFollowUp', 'generateFollowUp'],
  ['handleRecap', 'generateRecap'], ['handleFollowUpQuestions', 'generateFollowUpQuestions'],
  ['handleClarify', 'generateClarify'], ['handleCodeHint', 'generateCodeHint'],
  ['handleBrainstorm', 'generateBrainstorm'],
]) {
  test(`${name}: a delayed IPC error after reset cannot restore history or stop a new turn`, async () => {
    const { scope, state } = rendererRig();
    let reject;
    scope.window.electronAPI[api] = () => new Promise((_, fail) => { reject = fail; });
    const pending = execute(callback(name), renderer, scope)();
    for (let i = 0; i < 10 && !reject; i++) await Promise.resolve();
    assert.equal(typeof reject, 'function');
    scope.resetChatState();
    state.isProcessing = true;
    reject(new Error('stale error'));
    await pending;
    assert.deepEqual(Array.from(state.messages), []);
    assert.equal(state.isProcessing, true);
  });
}

test('What to Answer waiting for page context must not dispatch after reset', async () => {
  const { scope } = rendererRig();
  let release;
  let asked = false;
  scope.window.electronAPI.phoneMirrorRequestAutoContext = () => new Promise(done => { release = done; });
  scope.window.electronAPI.generateWhatToSay = async () => { asked = true; return {}; };
  const pending = execute(callback('handleWhatToSay'), renderer, scope)();
  assert.equal(typeof release, 'function');
  scope.resetChatState();
  release();
  await pending;
  assert.equal(asked, false);
});

test('Answer / Record waiting for the STT tail must not fall through to another answer after reset', async () => {
  const { scope, refs, state } = rendererRig();
  scope.isManualRecording = true;
  scope.window.electronAPI.finalizeMicSTT = async () => ({ pending: false });
  let release;
  let asked = false;
  refs.answerTailWaiterRef = { current: { wait: () => new Promise(done => { release = done; }) } };
  refs.voiceInputRef = { current: 'old speech' };
  refs.manualTranscriptRef = { current: '' };
  scope.handlersRef = { current: { handleWhatToSay: () => { asked = true; } } };
  scope.setTimeout = () => 0;
  const pending = execute(callback('handleAnswerNow'), renderer, scope)();
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, 'function');
  scope.resetChatState();
  release();
  await pending;
  assert.equal(asked, false);
  assert.deepEqual(Array.from(state.messages), []);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: application menu does not intercept the reset chord as Reload`, () => {
    const method = find(keybinds, n => ts.isMethodDeclaration(n) && n.name.getText(keybinds) === 'updateMenu');
    let template;
    const receiver = { keybinds: new Map(), getKeybind: () => undefined };
    execute(method, keybinds, {
      process: { platform }, app: { name: 'test' }, console,
      Menu: { buildFromTemplate: t => { template = t; return {}; }, setApplicationMenu() {} },
    }, receiver)();
    for (const item of template.flatMap(item => item.submenu ?? [])) {
      assert.ok(!['reload', 'forceReload'].includes(item.role) || item.accelerator === '', 'Electron role defaults must not own Cmd/Ctrl+R');
    }
  });
}

test('Windows native dispatch rejects disabled and launcher-scoped chat actions', () => {
  const method = find(keybinds, n => ts.isMethodDeclaration(n) && n.name.getText(keybinds) === 'triggerActionById');
  const dispatched = [];
  const receiver = {
    keybinds: new Map([['chat:whatToAnswer', { isGlobal: true, accelerator: 'CommandOrControl+1' }]]),
    shouldRegister: () => false,
    onShortcutTriggeredCallbacks: [id => dispatched.push(id)],
  };
  execute(method, keybinds, {}, receiver)('chat:whatToAnswer');
  assert.deepEqual(dispatched, [], 'a chord queued before a mode/global-enable change must be dropped');
});

test('manual engine answer resolving after reset cannot emit or save into the fresh session', async () => {
  const method = find(engineSource, n => ts.isMethodDeclaration(n) && n.name.getText(engineSource) === 'runManualAnswerInner');
  const writes = [];
  let resolve;
  const receiver = {
    currentGenerationId: 0, emit: (...event) => writes.push(event), setMode() {},
    getActiveModeInfo: () => null,
    answerLLM: { generate: () => new Promise(done => { resolve = done; }) },
    session: { getFormattedContext: () => '', addAssistantMessage: () => writes.push(['saved']), pushUsage: () => writes.push(['usage']) },
  };
  const run = execute(method, engineSource, {
    console, Date,
    planAnswer: () => ({ answerType: 'general' }),
    require: name => name.includes('codingPromptSignals') ? { resolveCodingPromptSignals: () => ({}) } : {},
    validateAnswerStructure: () => ({ ok: true }), isCodingAnswerType: () => false,
    resolveDiagramTurn: () => ({}),
  }, receiver)('old question');
  for (let i = 0; i < 10 && !resolve; i++) await Promise.resolve();
  assert.equal(typeof resolve, 'function');
  writes.length = 0;
  receiver.currentGenerationId++; // IntelligenceEngine.reset's cancellation boundary
  resolve('old answer');
  assert.equal(await run, null);
  assert.deepEqual(writes, []);
});

// Execute the production callbacks, with only transport/native boundaries stubbed.
test('new turns wait for reset acknowledgement, so session-reset cannot erase an accepted turn', async () => {
  const { scope, state, refs } = rendererRig();
  let release;
  const calls = [];
  scope.window.electronAPI.resetIntelligence = () => new Promise(done => { release = done; });
  scope.window.electronAPI.streamGeminiChat = async (...args) => { calls.push(args); };
  scope.shouldDedupeOverlayAction = () => false;
  const begin = execute(callback('tryBeginOverlayAction'), renderer, scope);
  const submit = execute(callback('handleManualSubmit'), renderer, scope);
  const pending = scope.resetConversation();
  await submit();
  assert.equal(calls.length, 0, 'do not accept a new turn against the outgoing backend context');
  assert.equal(begin('clarify'), false);
  scope.resetChatStateRef.current(); // main sends this before the IPC reply
  release({ success: true });
  await pending;
  scope.messages = state.messages;
  await submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], '', 'the next real submit carries no old UI history');
  assert.deepEqual(Array.from(calls[0][3].courseIds), ['selected-course']);
  assert.equal(refs.chatResetPendingRef.current, false);
});

for (const [action, api] of [['takeScreenshot', 'takeScreenshot'], ['selectiveScreenshot', 'takeSelectiveScreenshot']]) {
  test(`${action}: a capture resolving after reset cannot reattach old temporary context`, async () => {
    const { scope, refs } = rendererRig();
    let release;
    const attached = [];
    scope.window.electronAPI[api] = () => new Promise(done => { release = done; });
    scope.handleScreenshotAttach = data => attached.push(data);
    const handler = find(renderer, n => ts.isPropertyAssignment(n) && n.name.getText(renderer) === action).initializer;
    const pending = execute(handler, renderer, scope)();
    scope.resetChatState();
    release({ path: 'old.png', preview: 'old' });
    await pending;
    assert.deepEqual(attached, []);
    assert.ok(refs.chatResetEpochRef.current > 0);
  });
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: capture-and-process resolving after reset cannot dispatch another answer`, async () => {
    let release;
    const sends = [];
    let epoch = 0;
    const receiver = {
      intelligenceManager: { getContextEpoch: () => epoch },
      takeScreenshot: () => new Promise(done => { release = done; }), getImagePreview: async () => 'preview',
      showMainWindow() {}, getMainWindow: () => ({}), sendToWindow: (...args) => sends.push(args),
    };
    const pending = execute(method(main, 'captureScreenAndProcess'), main, { process: { platform }, app: {} }, receiver)();
    epoch++;
    release('old.png');
    await pending;
    assert.deepEqual(sends, []);
  });
}

test('a capture-and-process animation frame queued before reset cannot start a new answer', () => {
  const { scope } = rendererRig();
  let frame;
  let asked = false;
  scope.requestAnimationFrame = fn => { frame = fn; };
  scope.handlersRef = { current: { handleWhatToSay: () => { asked = true; } } };
  const onCapture = find(renderer, n => ts.isCallExpression(n) && n.expression.getText(renderer) === 'window.electronAPI.onCaptureAndProcess').arguments[0];
  execute(onCapture, renderer, scope)({ path: 'old.png', preview: 'old' });
  scope.resetChatState();
  frame();
  assert.equal(asked, false);
});

test('accepting a suggestion that was awaiting IPC before reset cannot restore its old question', () => {
  const { scope, refs } = rendererRig();
  let asked = false;
  scope.renderedChatResetEpoch = refs.chatResetEpochRef.current;
  scope.handleWhatToSay = () => { asked = true; };
  const attribute = find(renderer, n => ts.isJsxAttribute(n) && n.name.getText(renderer) === 'onAcceptAction');
  const accept = execute(attribute.initializer.expression, renderer, scope);
  scope.resetChatState();
  accept({ promptInstruction: 'old suggestion context' });
  assert.equal(asked, false);
  const bar = find(renderer, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(renderer) === 'DynamicActionBar');
  assert.ok(bar.attributes.properties.some(n => n.name?.getText(renderer) === 'key' && n.initializer.getText(renderer).includes('renderedChatResetEpoch')), 'reset must discard the child suggestion queue, not just main engine candidates');
});

function engineRig() {
  const receiver = {
    activeMode: 'what_to_say', currentGenerationId: 7,
    whatToAnswerCancellationToken: new AbortController(),
    whatToAnswerBackgroundCancellationTokens: new Set([new AbortController()]),
    assistCancellationToken: new AbortController(), speculativeTimer: null,
    wtaDiversityGuard: { reset() { receiver.diversityCleared = true; } },
    currentSessionId: 'meeting-1', currentDynamicActionModeId: 'technical', currentDynamicActionTemplateType: 'technical_interview', meetingConversationId: 'meeting-1',
    dynamicActionEngine: { staleCandidate: 'old' }, lastTriggerQuestion: 'old question',
    questionLedgerShadow: { old: true }, lastTrace: { old: true },
  };
  for (const name of ['reset', 'clearWtaDiversityHistory', 'resetConversationState']) {
    receiver[name] = execute(method(engineSource, name), engineSource, { clearTimeout, DynamicActionEngine: class {} }, receiver);
  }
  return receiver;
}

test('provider-only reset preserves conversation state; fresh-chat reset clears transient state but retains bindings', () => {
  const engine = engineRig();
  engine.reset();
  assert.equal(engine.lastTriggerQuestion, 'old question');
  assert.equal(engine.diversityCleared, undefined);
  const controller = engine.assistCancellationToken = new AbortController();
  engine.resetConversationState();
  assert.equal(controller.signal.aborted, true);
  for (const key of ['lastTriggerQuestion', 'questionLedgerShadow', 'lastTrace', 'speculativeQuestionId']) assert.equal(engine[key], null, key);
  assert.equal(engine.diversityCleared, true);
  assert.equal(engine.dynamicActionEngine.staleCandidate, undefined);
  assert.equal(engine.currentDynamicActionModeId, 'technical');
  assert.equal(engine.currentSessionId, 'meeting-1');
  assert.equal(engine.meetingConversationId, 'meeting-1');
});

function resetTerminalRig() {
  const sessionSource = parse('electron/SessionTracker.ts');
  const managerSource = parse('electron/IntelligenceManager.ts');
  const { SessionTracker } = require(path.join(root, 'dist-electron/electron/SessionTracker.js'));
  const session = new SessionTracker();
  // Use the on-disk reset even before a rebuild, with the real SessionTracker
  // storage/readers and the real manager orchestration around it.
  session.reset = execute(method(sessionSource, 'reset'), sessionSource, { Date }, session);
  const events = [];
  const engine = engineRig();
  Object.assign(engine, {
    session, emit: (...args) => events.push(args),
    getActiveModeInfo: () => ({ id: 'technical', templateType: 'technical_interview' }),
    buildRecapFollowUpContract: () => null,
    buildV3ForTranscriptSurface: async () => null,
    buildPreparedTranscriptContext: () => session.getFormattedContext(120),
    buildActionContextWithManualFallback: () => session.getFormattedContext(120),
    v3ModeRetrievalContext: () => null,
  });
  const scope = {
    console, Date, AbortController, contextOsStatic: {},
    planAnswer: ({ question }) => ({ answerType: 'direct_answer', question }),
    isCodingAnswerType: () => false,
    validateAnswerStructure: () => ({ ok: true }),
    require: name => require(path.join(root, 'dist-electron/electron', name)),
  };
  for (const name of ['setMode', 'runRecap', 'runBrainstorm', 'runFollowUp', 'runClarify', 'runFollowUpQuestions', 'runCodeHint', 'runAssistModeInner', 'runManualAnswerInner']) {
    engine[name] = execute(method(engineSource, name), engineSource, scope, engine);
  }
  const manager = { engine, session, emit: (...args) => events.push(args) };
  manager.reset = execute(method(managerSource, 'reset'), managerSource, scope, manager);
  manager.getLastAssistantMessage = execute(method(managerSource, 'getLastAssistantMessage'), managerSource, {}, manager);
  return { session, engine, manager, events };
}

const settleTerminal = () => new Promise(done => setImmediate(done));
const deferredTerminal = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const actionLLMs = {
  runRecap: 'recapLLM', runBrainstorm: 'brainstormLLM', runFollowUp: 'followUpLLM',
  runClarify: 'clarifyLLM', runFollowUpQuestions: 'followUpQuestionsLLM', runCodeHint: 'codeHintLLM',
};

function installHeldAction(engine, name, ending) {
  const gate = deferredTerminal();
  let started = false;
  engine[actionLLMs[name]] = {
    async *generateStream() {
      started = true;
      if (ending.startsWith('partial-')) yield 'Old answer fragment before reset';
      await gate.promise;
      if (ending.endsWith('error')) throw new Error('old provider failed');
      if (ending === 'answer' || ending === 'token') yield 'Old provider answer after reset';
      if (ending === 'short') yield 'old';
    },
  };
  return { release: gate.resolve, get started() { return started; } };
}

test('reset clears every surface answer and the next document-grounded manual prompt referent', () => {
  const { session, manager } = resetTerminalRig();
  const surfaces = ['manual_chat', 'what_to_answer', 'screenshot', 'meeting_auto_answer', 'phone_mirror'];
  const hintNode = find(ipc, n => ts.isPropertyAssignment(n) && n.name.getText(ipc) === 'followUpReferentHint').initializer;
  const hint = () => expression(hintNode, ipc, { intelligenceManager: manager });
  for (const surface of surfaces) session.addAssistantMessage(`Old answer stored on ${surface}`, undefined, surface);
  assert.equal(hint(), 'Old answer stored on manual_chat', 'exercise the real next-prompt referent expression');
  manager.reset();
  assert.equal(hint(), undefined, 'document-grounded prompt must not inherit the pre-reset manual answer');
  assert.equal(session.getLastAssistantMessage(), null);
  for (const surface of surfaces) assert.equal(session.getLastAssistantMessage(surface), null, surface);
  assert.equal(session.getFullSessionContext(), '');
  session.addAssistantMessage('Fresh answer from the new manual turn', undefined, 'manual_chat');
  assert.equal(hint(), 'Fresh answer from the new manual turn');
  for (const surface of surfaces.filter(s => s !== 'manual_chat')) assert.equal(session.getLastAssistantMessage(surface), null, surface);
});

for (const [name, endings] of [
  ['runBrainstorm', ['empty', 'short', 'answer', 'error', 'partial-empty', 'partial-error', 'token']],
  ['runRecap', ['error', 'partial-error']],
]) for (const ending of endings) for (const newManualTurn of [false, true]) {
  test(`${name}: reset suppresses stale ${ending} terminals, newer manual turn=${newManualTurn}`, async () => {
    const { engine, session, manager, events } = resetTerminalRig();
    session.addTranscript({ speaker: 'user', text: 'Old question with sufficient context', timestamp: Date.now(), final: true });
    const held = installHeldAction(engine, name, ending);
    const pending = engine[name]();
    await settleTerminal();
    assert.equal(held.started, true, 'the old generator is held before terminal completion');
    manager.reset();
    let manual;
    const freshAnswer = deferredTerminal();
    if (newManualTurn) {
      engine.answerLLM = { generate: () => freshAnswer.promise };
      manual = engine.runManualAnswerInner('Fresh manual question');
      await settleTerminal();
      assert.equal(engine.activeMode, 'manual', 'exercise the real newer manual-turn path');
    }
    const generation = engine.currentGenerationId;
    events.length = 0;
    held.release();
    await pending;
    // Snapshot before finishing the manual fixture, so cleanup also happens
    // on the broken version without obscuring the old terminal's side effects.
    const terminalEvents = events.slice();
    const mode = engine.activeMode;
    const history = session.getFullSessionContext();
    const usage = Array.from(session.getFullUsage());
    freshAnswer.resolve('Fresh manual answer from the newer generation');
    if (manual) await manual;
    assert.deepEqual(terminalEvents, [], 'stale terminal must not emit fallback/final/error/idle events');
    assert.equal(mode, newManualTurn ? 'manual' : 'idle');
    assert.equal(generation, engine.currentGenerationId, 'old terminal must not change generation ownership');
    assert.equal(history, '', 'old answer or fallback must not repopulate reset history');
    assert.deepEqual(usage, [], 'old usage must not repopulate the reset session');
    if (manual) assert.equal(session.getLastAssistantMessage('manual_chat'), 'Fresh manual answer from the newer generation');
    assert.equal(engine.currentDynamicActionModeId, 'technical');
    assert.equal(engine.currentSessionId, 'meeting-1');
  });
}

for (const name of Object.keys(actionLLMs)) for (const ending of ['empty', 'answer', 'error']) {
  test(`${name}: current-generation ${ending} terminal keeps existing behavior`, async () => {
    const { engine, session, events } = resetTerminalRig();
    session.addTranscript({ speaker: 'user', text: 'Current question with enough context', timestamp: Date.now(), final: true });
    if (name === 'runFollowUp') session.addAssistantMessage('Previous answer to refine for the current turn');
    const held = installHeldAction(engine, name, ending);
    const pending = engine[name](...(name === 'runFollowUp' ? ['simplify'] : []));
    await settleTerminal();
    held.release();
    const result = await pending;
    assert.equal(engine.activeMode, 'idle');
    if (ending === 'error') {
      assert.equal(result, null);
      assert.equal(events.filter(([event]) => event === 'error').length, 1);
      assert.equal(session.getFullUsage().length, 0);
    } else if (ending === 'answer' || ['runBrainstorm', 'runCodeHint'].includes(name)) {
      assert.ok(result.length > 5);
      const finalEvent = { runBrainstorm: 'suggested_answer', runCodeHint: 'suggested_answer', runRecap: 'recap', runFollowUp: 'refined_answer', runClarify: 'clarify', runFollowUpQuestions: 'follow_up_questions_update' }[name];
      assert.equal(events.filter(([event]) => event === finalEvent).length, 1);
      assert.equal(session.getFullUsage().length, 1);
    } else {
      assert.equal(result, '');
      assert.equal(session.getFullUsage().length, 0);
    }
  });
}

for (const name of ['runFollowUp', 'runClarify', 'runFollowUpQuestions', 'runCodeHint']) {
  for (const ending of ['empty', 'error', 'partial-empty', 'partial-error', 'answer']) for (const interruption of ['reset', 'cancel']) {
    test(`${name}: ${interruption} guards held ${ending} provider and newer action state`, async () => {
      const { engine, session, manager, events } = resetTerminalRig();
      session.addTranscript({ speaker: 'user', text: 'Old question with sufficient context', timestamp: Date.now(), final: true });
      if (name === 'runFollowUp') session.addAssistantMessage('Previous answer to refine for the old turn');
      const held = installHeldAction(engine, name, ending);
      const pending = engine[name](...(name === 'runFollowUp' ? ['simplify'] : []));
      await settleTerminal();
      assert.equal(held.started, true);
      if (interruption === 'reset') manager.reset();
      else engine.reset();
      const expectedHistory = session.getFullSessionContext();
      const expectedUsage = session.getFullUsage().length;
      const freshAnswer = deferredTerminal();
      engine.answerLLM = { generate: () => freshAnswer.promise };
      const manual = engine.runManualAnswerInner('Fresh manual question');
      await settleTerminal();
      assert.equal(engine.activeMode, 'manual');
      events.length = 0;
      held.release();
      const result = await pending;
      const terminalEvents = events.slice();
      const mode = engine.activeMode;
      const history = session.getFullSessionContext();
      const usageCount = session.getFullUsage().length;
      freshAnswer.resolve('Fresh manual answer from the newer generation');
      await manual;
      assert.equal(result, null, 'superseded actions must not return an old answer to their caller');
      assert.deepEqual(terminalEvents, [], 'no stale tokens, final, fallback, error or idle');
      assert.equal(mode, 'manual');
      assert.equal(history, expectedHistory);
      assert.equal(usageCount, expectedUsage);
    });
  }
}

for (const name of ['runClarify', 'runCodeHint', 'runBrainstorm', 'runAssistModeInner']) {
  for (const reject of [false, true]) test(`${name}: reset during awaited V3 preflight must not start a provider or touch newer action state, reject=${reject}`, async () => {
    const { engine, session, manager, events } = resetTerminalRig();
    session.addTranscript({ speaker: 'user', text: 'Old question with sufficient context', timestamp: Date.now(), final: true });
    engine.activeMode = 'idle';
    let finish;
    engine.buildV3ForTranscriptSurface = () => new Promise((resolve, fail) => { finish = () => reject ? fail(new Error('old preflight failed')) : resolve(null); });
    let providerCalls = 0;
    const provider = { generate: async () => { providerCalls++; return ''; }, async *generateStream() { providerCalls++; } };
    engine[name === 'runAssistModeInner' ? 'assistLLM' : actionLLMs[name]] = provider;
    const pending = engine[name]();
    assert.equal(typeof finish, 'function');
    manager.reset();
    engine.currentGenerationId++;
    engine.setMode('manual');
    events.length = 0;
    finish();
    await pending;
    assert.equal(providerCalls, 0, 'do not launch a stale request after preflight resumes');
    assert.equal(engine.activeMode, 'manual');
    assert.deepEqual(events, []);
    assert.equal(session.getFullSessionContext(), '');
    assert.equal(session.getFullUsage().length, 0);
  });
}

for (const ending of ['empty', 'answer', 'error']) {
  for (const replacement of ['manual', 'assist']) test(`Assist: reset during held ${ending} provider preserves newer ${replacement} controller/state`, async () => {
    const { engine, session, manager, events } = resetTerminalRig();
    session.addTranscript({ speaker: 'user', text: 'Old question for passive assist', timestamp: Date.now(), final: true });
    engine.activeMode = 'idle';
    const gate = deferredTerminal();
    engine.assistLLM = { generate: async () => { await gate.promise; if (ending === 'error') throw new Error('old assist failed'); return ending === 'empty' ? '' : 'Old assist insight'; } };
    const pending = engine.runAssistModeInner();
    await settleTerminal();
    manager.reset();
    engine.currentGenerationId++;
    engine.setMode(replacement);
    const newerController = new AbortController();
    engine.assistCancellationToken = newerController;
    events.length = 0;
    gate.resolve();
    await pending;
    assert.deepEqual(events, []);
    assert.equal(engine.activeMode, replacement);
    assert.equal(engine.assistCancellationToken, newerController, 'old finally must not clear the new controller');
  });
}

for (const ending of ['empty', 'answer', 'error']) test(`Assist: current-generation ${ending} preserves completion/error behavior`, async () => {
  const { engine, session, events } = resetTerminalRig();
  session.addTranscript({ speaker: 'user', text: 'Current question for passive assist', timestamp: Date.now(), final: true });
  engine.activeMode = 'idle';
  engine.assistLLM = { generate: async () => { if (ending === 'error') throw new Error('current assist failure'); return ending === 'empty' ? '' : 'Current assist insight'; } };
  const result = await engine.runAssistModeInner();
  assert.equal(result, ending === 'error' ? null : ending === 'empty' ? '' : 'Current assist insight');
  assert.equal(engine.activeMode, 'idle');
  assert.equal(engine.assistCancellationToken, null);
  assert.equal(events.filter(([event]) => event === 'error').length, ending === 'error' ? 1 : 0);
  assert.equal(events.filter(([event]) => event === 'assist_update').length, ending === 'answer' ? 1 : 0);
});

function executeWithModuleLoader(node, source, loadModule, scope, receiver) {
  // Replace only the import loader seam, not the production method's await,
  // generation checks, event dispatch, or correction control flow.
  const transformed = ts.transform(node, [context => {
    const visit = current => {
      if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.updateCallExpression(current, ts.factory.createIdentifier('__loadModule'), current.typeArguments, current.arguments);
      }
      return ts.visitEachChild(current, visit, context);
    };
    return current => ts.visitNode(current, visit);
  }]);
  try {
    const text = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], source);
    const parsed = ts.createSourceFile('module-boundary.ts', `class ModuleBoundary { ${text} }`, ts.ScriptTarget.Latest, true);
    return execute(method(parsed, node.name.getText(source)), parsed, { ...scope, __loadModule: loadModule }, receiver);
  } finally {
    transformed.dispose();
  }
}

for (const boundary of ['verifier-import', 'formatting-import']) for (const interruption of ['reset', 'new-generation', 'abort', 'current']) {
  test(`coding verification module boundary: ${boundary}, ${interruption}`, async () => {
    const { engine, session, events } = resetTerminalRig();
    const generationId = engine.currentGenerationId;
    const controller = new AbortController();
    const gate = deferredTerminal();
    const reachedBoundary = deferredTerminal();
    let verifierCalls = 0;
    let formatterCalls = 0;
    const shownAnswer = 'Old code answer with a hidden verification spec';
    const question = 'Verify the old coding question';
    const verdict = { passed: false, passedCount: 0, total: 1, language: 'javascript' };
    const correctedAnswer = '```js\nfunction fixed() { return 1; }\n```';
    const verifier = { verifyCodingAnswer: async () => {
      verifierCalls++;
      return { verdict, corrected: { answer: correctedAnswer, note: 'Corrected the old code', reVerifiedPassed: true } };
    } };
    const { stripVerificationSpec } = require(path.join(root, 'dist-electron/electron/llm/codingContract.js'));
    const formatter = { stripVerificationSpec: answer => { formatterCalls++; return stripVerificationSpec(answer); } };
    const loadModule = async name => {
      const isVerifier = name === './llm/codeVerification/verifyCodingAnswer';
      assert.ok(isVerifier || name === './llm/codingContract', 'exercise the real module specifiers');
      if ((boundary === 'verifier-import') === isVerifier) {
        reachedBoundary.resolve();
        await gate.promise;
      }
      return isVerifier ? verifier : formatter;
    };
    const run = executeWithModuleLoader(method(engineSource, 'maybeVerifyCoding'), engineSource, loadModule, { console }, engine);
    const pending = run(shownAnswer, question, undefined, { mark() {} }, generationId, controller.signal);
    await reachedBoundary.promise;
    if (interruption === 'reset') {
      engine.resetConversationState();
      session.reset();
    } else if (interruption === 'new-generation') {
      engine.currentGenerationId++;
      engine.setMode('manual');
    } else if (interruption === 'abort') controller.abort();
    const stateBefore = {
      generation: engine.currentGenerationId, mode: engine.activeMode,
      history: session.getFullSessionContext(), usage: JSON.stringify(session.getFullUsage()),
    };
    events.length = 0;
    gate.resolve();
    await pending;
    assert.equal(engine.currentGenerationId, stateBefore.generation);
    assert.equal(engine.activeMode, stateBefore.mode);
    assert.equal(session.getFullSessionContext(), stateBefore.history);
    assert.equal(JSON.stringify(session.getFullUsage()), stateBefore.usage);
    if (interruption !== 'current') assert.deepEqual(events, [], 'old verification must not badge or correct a reset/newer answer');
    assert.equal(verifierCalls, boundary === 'verifier-import' && interruption !== 'current' ? 0 : 1);
    assert.equal(formatterCalls, interruption === 'current' ? 1 : 0, 'superseded work must stop before formatting/dispatch');
    if (interruption === 'current') {
      assert.equal(events.length, 1);
      assert.equal(events[0][0], 'code_correction');
      assert.equal(events[0][1].question, question);
      assert.equal(events[0][1].answer, correctedAnswer);
      assert.equal(events[0][1].note, 'Corrected the old code');
      assert.equal(events[0][1].reVerified, true);
    }
  });
}

for (const branch of ['follow-up-source-switch', 'recap-empty-context', 'follow-up-questions-empty-context']) for (const interrupted of [false, true]) {
  test(`early action terminal: ${branch} preserves ${interrupted ? 'listener-reset ownership' : 'current-generation fallback'}`, async () => {
    const { engine, session, manager, events } = resetTerminalRig();
    const freshAnswer = deferredTerminal();
    let manual;
    let listenerReset = false;
    let providerCalls = 0;
    const provider = { async *generateStream() { providerCalls++; } };
    engine.recapLLM = provider;
    engine.followUpQuestionsLLM = provider;
    const finalEvent = branch === 'follow-up-source-switch' ? 'refined_answer'
      : branch === 'recap-empty-context' ? 'recap' : 'follow_up_questions_update';
    const emit = engine.emit;
    engine.emit = (event, ...args) => {
      emit(event, ...args);
      if (interrupted && !listenerReset && (branch === 'follow-up-source-switch' ? event === finalEvent : event === 'mode_changed' && args[0] === 'idle')) {
        listenerReset = true;
        manager.reset();
        engine.answerLLM = { generate: () => freshAnswer.promise };
        manual = engine.runManualAnswerInner('New manual turn started by the reset listener');
        events.length = 0;
      }
    };
    let pending;
    if (branch === 'follow-up-source-switch') {
      session.addAssistantMessage('Old profile-grounded answer');
      engine.followUpLLM = provider;
      engine.buildRecapFollowUpContract = () => ({ sourceOwner: 'profile' });
      const run = execute(method(engineSource, 'runFollowUp'), engineSource, {
        console,
        contextOsStatic: { detectFollowUpSourceSwitch: () => 'reference_files' },
      }, engine);
      pending = run('simplify', 'Use the uploaded material instead');
    } else pending = engine[branch === 'recap-empty-context' ? 'runRecap' : 'runFollowUpQuestions']();
    const result = await pending;
    const terminalEvents = events.slice();
    const mode = engine.activeMode;
    const history = session.getFullSessionContext();
    const usage = session.getFullUsage().length;
    freshAnswer.resolve('Fresh manual answer after the reset');
    if (manual) await manual;
    assert.equal(providerCalls, 0, 'early fallback must not launch a provider');
    assert.equal(mode, interrupted ? 'manual' : 'idle');
    if (interrupted) {
      assert.equal(result, null, 'stale source-switch text must not reach the caller');
      assert.deepEqual(terminalEvents, [], 'old fallback/idle must not land after the listener reset');
      assert.equal(history, '');
      assert.equal(usage, 0);
    } else {
      assert.equal(terminalEvents.filter(([event]) => event === finalEvent).length, 1);
      if (branch === 'follow-up-source-switch') assert.match(result, /Switching sources needs a fresh question/);
      else assert.equal(result, null);
    }
  });
}

for (const name of [...Object.keys(actionLLMs), 'runAssistModeInner', 'runManualAnswerInner']) for (const ending of ['answer', 'error']) {
  test(`${name}: reset from a terminal ${ending} listener must not write or idle the newer action`, async () => {
    const { engine, session, manager, events } = resetTerminalRig();
    session.addTranscript({ speaker: 'user', text: 'Old question with sufficient context', timestamp: Date.now(), final: true });
    if (name === 'runFollowUp') session.addAssistantMessage('Previous answer to refine before reset');
    const finalEvent = { runRecap: 'recap', runFollowUp: 'refined_answer', runClarify: 'clarify', runFollowUpQuestions: 'follow_up_questions_update', runCodeHint: 'suggested_answer', runBrainstorm: 'suggested_answer', runAssistModeInner: 'assist_update', runManualAnswerInner: 'manual_answer_result' }[name];
    const emit = engine.emit;
    engine.emit = (event, ...args) => {
      emit(event, ...args);
      if (event === (ending === 'error' ? 'error' : finalEvent)) {
        manager.reset();
        engine.currentGenerationId++;
        engine.setMode('manual');
      }
    };
    engine.activeMode = 'idle';
    let held;
    if (name === 'runAssistModeInner' || name === 'runManualAnswerInner') {
      const gate = deferredTerminal();
      engine[name === 'runAssistModeInner' ? 'assistLLM' : 'answerLLM'] = { generate: async () => { await gate.promise; if (ending === 'error') throw new Error('old failure'); return 'Old generated insight'; } };
      held = { release: gate.resolve };
    } else held = installHeldAction(engine, name, ending);
    const pending = engine[name](...(name === 'runFollowUp' ? ['simplify'] : []));
    await settleTerminal();
    held.release();
    await pending;
    assert.equal(engine.activeMode, 'manual');
    assert.equal(session.getFullSessionContext(), '');
    assert.equal(session.getFullUsage().length, 0);
    assert.equal(events.at(-1)[0], 'mode_changed');
    assert.equal(events.at(-1)[1], 'manual');
  });
}

for (const terminal of ['success', 'error']) test(`WTA: reset from terminal ${terminal} listener preserves the newer action`, () => {
  const { engine, manager } = resetTerminalRig();
  const wta = method(engineSource, 'runWhatShouldISayInner');
  let body;
  if (terminal === 'error') body = find(wta, n => ts.isCatchClause(n) && n.block.getText(engineSource).includes('isWtaSuperseded()')).block.getText(engineSource);
  else {
    const emit = find(wta, n => ts.isExpressionStatement(n) && n.getText(engineSource).startsWith("this.emit('suggested_answer', finalWtaAnswer"));
    const statements = Array.from(emit.parent.statements);
    body = `{${statements.slice(statements.indexOf(emit)).map(n => n.getText(engineSource)).join('\n')}}`;
  }
  const blockSource = ts.createSourceFile('wta-terminal.ts', `const terminal = () => ${body}`, ts.ScriptTarget.Latest, true);
  engine.currentGenerationId = 7;
  engine.emit = event => {
    if (event === (terminal === 'success' ? 'suggested_answer' : 'error')) {
      manager.reset();
      engine.currentGenerationId++;
      engine.setMode('manual');
    }
  };
  const trace = new Proxy({}, { get: () => () => trace });
  const result = execute(variable(blockSource, 'terminal').initializer, blockSource, {
    generationId: 7, isSpeculative: false, openedStreamRow: false,
    isWtaSuperseded: () => engine.currentGenerationId !== 7,
    recordWtaCancellation() {}, wtaTrace: trace, commitTrace() {},
    error: new Error('old failure'), providerFailureUserMessage: () => 'Old provider fallback',
    finalWtaAnswer: 'Old answer', fullAnswer: 'Old answer', question: 'Old question', confidence: 1,
    require: () => ({}), trace, isCoding: false, process: { env: {} },
  }, engine)();
  assert.equal(engine.activeMode, 'manual');
  assert.equal(result, null, 'do not return an answer or fallback after a reset from its listener');
});

for (const terminal of ['abort', 'catch']) test(`WTA: superseded ${terminal} cannot discard a newer row or clear its speculative state`, () => {
  const { engine, events } = resetTerminalRig();
  const wta = method(engineSource, 'runWhatShouldISayInner');
  const node = terminal === 'abort'
    ? find(wta, n => ts.isIfStatement(n) && n.expression.getText(engineSource) === 'streamAborted' && n.thenStatement.getText(engineSource).includes('recordWtaCancellation')).thenStatement
    : find(wta, n => ts.isCatchClause(n) && n.block.getText(engineSource).includes('isWtaSuperseded()')).block;
  const blockSource = ts.createSourceFile('wta-terminal.ts', `const terminal = () => ${node.getText(engineSource)}`, ts.ScriptTarget.Latest, true);
  engine.ownsSpeculativeSlot = execute(method(engineSource, 'ownsSpeculativeSlot'), engineSource, {}, engine);
  engine.currentGenerationId = 42;
  engine.speculativeGenerationId = null;
  engine.speculativeText = 'New speculative text';
  engine.lastTriggerTime = 0;
  engine.activeMode = 'manual';
  execute(variable(blockSource, 'terminal').initializer, blockSource, {
    generationId: 7, isSpeculative: true, openedStreamRow: true,
    whatToAnswerCancellationToken: new AbortController(),
    recordWtaCancellation() {}, isWtaSuperseded: () => true, Date,
  }, engine)();
  assert.deepEqual(events, []);
  assert.equal(engine.speculativeText, 'New speculative text');
  assert.equal(engine.lastTriggerTime, 0);
  assert.equal(engine.activeMode, 'manual');
});

for (const name of ['runManualAnswer', 'runWhatShouldISay']) for (const reset of [false, true]) {
  test(`${name}: ${reset ? 'reset' : 'current turn'} at the awaited recorder boundary`, async () => {
    const { engine, manager } = resetTerminalRig();
    const writes = [];
    engine.recordLiveTurn = answer => writes.push(answer);
    engine[name === 'runManualAnswer' ? 'runManualAnswerInner' : 'runWhatShouldISayInner'] = async () => {
      engine.currentGenerationId++;
      if (reset) queueMicrotask(() => manager.reset());
      return 'Answer completed before the reset boundary';
    };
    const result = await execute(method(engineSource, name), engineSource, {}, engine)('Old question');
    assert.deepEqual(writes, reset ? [] : ['Answer completed before the reset boundary']);
    assert.equal(result, reset ? null : 'Answer completed before the reset boundary');
  });
}

test('WTA: reset during awaited router precheck cannot idle a newer action or restore trigger context', async () => {
  const { engine, manager, events } = resetTerminalRig();
  const gate = deferredTerminal();
  engine.routerSaysStaySilent = () => gate.promise;
  const run = execute(method(engineSource, 'runWhatShouldISayInner'), engineSource, {
    console, Date, beginTrace: () => ({}), shouldThrottleTrigger: () => false,
    IntelligenceEngine: { routerAvailableSync: () => true },
  }, engine);
  const pending = run('Old speculative question', 1, undefined, { speculative: true });
  manager.reset();
  engine.currentGenerationId++;
  engine.setMode('manual');
  const generation = engine.currentGenerationId;
  events.length = 0;
  gate.resolve(true);
  assert.equal(await pending, null);
  assert.deepEqual(events, []);
  assert.equal(engine.activeMode, 'manual');
  assert.equal(engine.lastTriggerQuestion, null);
  assert.equal(engine.currentGenerationId, generation);
});

for (const kind of ['silent', 'clarify']) test(`planner: reset during awaited ${kind} decision must not dispatch an old action`, async () => {
  const { engine, manager, events } = resetTerminalRig();
  const gate = deferredTerminal();
  const dispatched = [];
  engine.planSuggestionTrigger = () => gate.promise;
  engine.runPlannerDecision = decision => dispatched.push(decision);
  const pending = execute(method(engineSource, 'handleSuggestionTriggerInner'), engineSource, { console }, engine)({ lastQuestion: 'Old question', confidence: 1 });
  manager.reset();
  engine.currentGenerationId++;
  engine.setMode('manual');
  events.length = 0;
  gate.resolve({ kind, reason: 'old decision', confidence: 1 });
  await pending;
  assert.deepEqual(dispatched, []);
  assert.deepEqual(events, []);
  assert.equal(engine.activeMode, 'manual');
});

test('automatic fast routing: reset restores the prior default and old finally cannot restore over a new override', async () => {
  const { engine, manager } = resetTerminalRig();
  let fast = false;
  engine.llmHelper = { getGroqFastTextMode: () => fast, setGroqFastTextMode: value => { fast = value; } };
  engine.planSuggestionTrigger = async () => ({ kind: 'answer' });
  engine.speculativeText = null;
  const gates = [];
  engine.runWhatShouldISay = () => {
    engine.currentGenerationId++;
    const gate = deferredTerminal();
    gates.push(gate);
    return gate.promise;
  };
  const dispatch = execute(method(engineSource, 'handleSuggestionTriggerInner'), engineSource, {
    console, process: { env: { NATIVELY_AUTO_ANSWER_FAST: 'on' } },
  }, engine);
  const old = dispatch({ automatic: true });
  await settleTerminal();
  assert.equal(fast, true);
  manager.reset();
  const restored = fast;
  engine.automaticTriggerCancelled = false; // the fresh outer trigger owns this flag
  const fresh = dispatch({ automatic: true });
  await settleTerminal();
  gates[0].resolve(null);
  await old;
  const freshStillFast = fast;
  gates[1].resolve(null);
  await fresh;
  assert.equal(restored, false, 'temporary fast routing must not survive a fresh-chat reset');
  assert.equal(freshStillFast, true, 'old completion must not clear the fresh override');
  assert.equal(fast, false, 'the fresh action restores its own prior routing state');
});

for (const priorFast of [false, true]) for (const successor of ['manual', 'automatic']) for (const ending of ['empty', 'error']) {
  test(`automatic fast routing: superseded ${ending} restores its owned default, prior=${priorFast}, successor=${successor}`, async () => {
    const { engine } = resetTerminalRig();
    let fast = priorFast;
    engine.llmHelper = { getGroqFastTextMode: () => fast, setGroqFastTextMode: value => { fast = value; } };
    engine.planSuggestionTrigger = async () => ({ kind: 'answer' });
    engine.speculativeText = null;
    const gates = [];
    engine.runWhatShouldISay = () => {
      engine.currentGenerationId++;
      const gate = deferredTerminal();
      gates.push(gate);
      return gate.promise.then(() => {
        if (gates.indexOf(gate) === 0 && ending === 'error') throw new Error('old automatic provider failed');
        return null;
      });
    };
    const dispatch = execute(method(engineSource, 'handleSuggestionTriggerInner'), engineSource, {
      console, process: { env: { NATIVELY_AUTO_ANSWER_FAST: 'on' } },
    }, engine);
    // Attach rejection handling immediately; hold the actual dispatch until
    // another generation has taken over without a conversation reset.
    const old = dispatch({ automatic: true }).then(() => 'empty', () => 'error');
    await settleTerminal();
    assert.equal(fast, true);
    let fresh;
    if (successor === 'automatic') {
      fresh = dispatch({ automatic: true });
      await settleTerminal();
    } else {
      engine.currentGenerationId++;
      engine.setMode('manual');
    }
    const generation = engine.currentGenerationId;
    const mode = engine.activeMode;
    gates[0].resolve();
    assert.equal(await old, ending);
    assert.equal(engine.currentGenerationId, generation);
    assert.equal(engine.activeMode, mode);
    assert.equal(fast, successor === 'automatic' ? true : priorFast, 'old cleanup restores only its owned hint');
    if (fresh) {
      gates[1].resolve();
      await fresh;
    }
    assert.equal(fast, priorFast, 'temporary routing cannot become the next turn default');
    assert.equal(engine.automaticFastModeOverride ?? null, null);
  });
}

test('automatic trigger: old finally after reset must not clear newer trigger ownership', async () => {
  const { engine, manager } = resetTerminalRig();
  const gate = deferredTerminal();
  engine.handleSuggestionTriggerInner = () => gate.promise;
  const pending = execute(method(engineSource, 'handleSuggestionTrigger'), engineSource, {}, engine)({ automatic: true });
  manager.reset();
  engine.automaticTriggerPending = true;
  engine.automaticTriggerCancelled = true;
  gate.resolve();
  await pending;
  assert.equal(engine.automaticTriggerPending, true);
  assert.equal(engine.automaticTriggerCancelled, true);
});

for (const newTurn of [false, true]) test(`V3 preflight: reset during held retrieval cannot repopulate referents, new turn=${newTurn}`, async () => {
  const { orchestrate } = require(path.join(root, 'dist-electron/electron/context-intelligence/orchestration/orchestrator.js'));
  const store = require(path.join(root, 'dist-electron/electron/context-intelligence/question/conversation-state-store.js'));
  store.clearConversationState();
  const gate = deferredTerminal();
  let started = false;
  const request = { requestId: 'old-preflight', requestSequence: 1, surface: 'manual-chat', modeId: 'technical-interview', scope: { userId: 'test-user' }, sessionId: 'reset-preflight', manualQuestion: 'Tell me about your WebRTC project.' };
  const pending = orchestrate(request, { retrieve: async () => { started = true; await gate.promise; return { evidence: [], attempts: [] }; } });
  await settleTerminal();
  assert.equal(started, true);
  store.clearConversationState();
  if (newTurn) await orchestrate({ ...request, requestId: 'fresh', requestSequence: 2, manualQuestion: 'Tell me about your Kubernetes experience.' }, { retrieve: async () => ({ evidence: [], attempts: [] }) });
  const before = JSON.stringify(store.getConversationState(request.sessionId));
  gate.resolve();
  await pending;
  const after = JSON.stringify(store.getConversationState(request.sessionId));
  store.clearConversationState();
  assert.equal(after, before, 'stale retrieval completion must not seed or overwrite the new conversation state');
});

for (const boundary of ['bridge', 'orchestrator']) for (const cancel of [false, true]) {
  test(`V3 ${boundary}: ${cancel ? 'cancelled' : 'current'} held retrieval respects caller generation at the state-write boundary`, async () => {
    const { orchestrate } = require(path.join(root, 'dist-electron/electron/context-intelligence/orchestration/orchestrator.js'));
    const { buildV3Prompt } = require(path.join(root, 'dist-electron/electron/context-intelligence/orchestration/engine-bridge.js'));
    const { CONTEXT_INTELLIGENCE_V3_ENV_KEY } = require(path.join(root, 'dist-electron/electron/context-intelligence/contracts/flag.js'));
    const store = require(path.join(root, 'dist-electron/electron/context-intelligence/question/conversation-state-store.js'));
    const beforeEnv = process.env[CONTEXT_INTELLIGENCE_V3_ENV_KEY];
    process.env[CONTEXT_INTELLIGENCE_V3_ENV_KEY] = '1';
    store.clearConversationState();
    try {
      const gate = deferredTerminal();
      let generation = 1;
      let started = false;
      const isSuperseded = () => generation !== 1;
      const retrieval = { retrieve: async () => { started = true; await gate.promise; return { evidence: [], attempts: [] }; } };
      const request = { requestId: 'held', requestSequence: 1, surface: 'manual-chat', modeId: 'technical-interview', scope: { userId: 'test-user' }, sessionId: 'generation-guard', manualQuestion: 'Tell me about your WebRTC project.' };
      const pending = boundary === 'bridge'
        ? buildV3Prompt({ question: request.manualQuestion, surface: request.surface, modeTemplateType: request.modeId, scope: { ...request.scope, sessionId: request.sessionId }, retrieval, isSuperseded })
        : orchestrate(request, retrieval, isSuperseded);
      await settleTerminal();
      assert.equal(started, true);
      if (cancel) generation++;
      gate.resolve();
      const result = await pending;
      assert.equal(store.getConversationState(request.sessionId) === null, cancel);
      if (boundary === 'bridge') assert.equal(result === null, cancel);
    } finally {
      store.clearConversationState();
      if (beforeEnv === undefined) delete process.env[CONTEXT_INTELLIGENCE_V3_ENV_KEY];
      else process.env[CONTEXT_INTELLIGENCE_V3_ENV_KEY] = beforeEnv;
    }
  });
}

test('Recap synchronous preflight errors still emit error and idle for the current generation', async () => {
  const { engine, events } = resetTerminalRig();
  engine.recapLLM = {};
  engine.session.getFormattedContext = () => { throw new Error('preflight failed'); };
  assert.equal(await engine.runRecap(), null);
  assert.equal(engine.activeMode, 'idle');
  assert.equal(events.filter(([event]) => event === 'error').length, 1);
});

test('real reset orchestration clears session, manual/coding memory and V3 referents without writing preferences', async () => {
  const { SessionTracker } = require(path.join(root, 'dist-electron/electron/SessionTracker.js'));
  const { ConversationMemoryService } = require(path.join(root, 'dist-electron/electron/intelligence/ConversationMemoryService.js'));
  const { CodingConversationState } = require(path.join(root, 'dist-electron/electron/intelligence/CodingConversationState.js'));
  const store = require(path.join(root, 'dist-electron/electron/context-intelligence/question/conversation-state-store.js'));
  const registry = require(path.join(root, 'dist-electron/electron/services/chatStreamRegistry.js'));
  const managerSource = parse('electron/IntelligenceManager.ts');
  const session = new SessionTracker();
  session.addTranscript({ speaker: 'user', text: 'old question', timestamp: Date.now(), final: true });
  session.addAssistantMessage('old answer');
  session.pushUsage({ type: 'chat', source: 'manual_chat', question: 'old question', answer: 'old answer', timestamp: Date.now() });
  session.setCodingQuestion('old code problem', 'screenshot');
  session.transcriptEpochSummaries.push('old summary');
  const memory = new ConversationMemoryService();
  memory.record({ sessionId: '42', userMessage: 'old question', assistantAnswer: 'old answer', timestamp: Date.now() });
  const coding = new CodingConversationState();
  coding.recordCodingTurn('42', { userMessage: 'old problem', assistantAnswer: 'old solution', isContinuation: false });
  store.recordAnswerSummary('s:42', 'old answer', undefined, 'old question');
  const preferences = Object.freeze({ defaultModel: 'selected-model', modeId: 'technical', profileId: 'profile-1', courseIds: Object.freeze(['course-1']) });
  const before = JSON.stringify(preferences);
  const engine = engineRig();
  const manager = { engine, session, emit() {} };
  manager.reset = execute(method(managerSource, 'reset'), managerSource, { require: () => store }, manager);
  const appReceiver = {
    simpleAutoAnswer: { onMeetingStop() {} }, autoAnswerUsage: { stopAwaitingAnswer() {} },
    phoneImages: ['old.png'], ragManager: null, preferences,
  };
  const appReset = execute(method(main, 'resetConversationTransientState'), main, { PhoneMirrorService: phoneMirrorBoundary }, appReceiver);
  const directController = new AbortController();
  const liveController = new AbortController();
  const globalController = new AbortController();
  const activeRAGQueries = new Map([['live-1', liveController], ['global-1', globalController]]);
  const streams = new Map([[42, { streamId: 1, controller: new AbortController() }]]);
  const scope = {
    console, _chatStreamsBySender: streams, _phoneChatLatestId: 1,
    activeDirectAssistByRequest: new Map([['old', { controller: directController }]]), activeDirectAssistBySurface: new Map(),
    _manualConversationMemory: memory, _manualCodingState: coding, _manualDiversityGuard: { reset() {} },
    abortPriorRAGQueriesOfClass: execute(find(ipc, n => ts.isFunctionDeclaration(n) && n.name?.text === 'abortPriorRAGQueriesOfClass'), ipc, { activeRAGQueries }),
    require: () => registry,
    appState: { resetConversationTransientState: appReset, getIntelligenceManager: () => manager, clearQueues() {} },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const result = await execute(ipcCallback('reset-intelligence'), ipc, scope)();
  assert.equal(result.success, true);
  assert.equal(session.getFullSessionContext(), '');
  assert.equal(session.getLastAssistantMessage(), null);
  assert.equal(session.getRecentManualTurn(), null);
  assert.equal(session.getDetectedCodingQuestion().question, null);
  assert.deepEqual(session.getFullUsage(), []);
  assert.equal(memory.getLastAssistantAnswer('42'), null);
  assert.equal(coding.get('42'), null);
  assert.equal(store.getConversationState('s:42'), null);
  assert.equal(store.resolveAgainstSession('s:42', 'what was that?').resolved, 'what was that?');
  assert.equal(streams.size, 0);
  assert.equal(directController.signal.aborted, true);
  assert.equal(liveController.signal.aborted, true);
  assert.equal(globalController.signal.aborted, false, 'launcher search is not a live chat reset target');
  assert.deepEqual(Array.from(appReceiver.phoneImages), []);
  assert.equal(JSON.stringify(preferences), before);
  assert.equal(engine.currentDynamicActionModeId, preferences.modeId);
  session.addTranscript({ speaker: 'user', text: 'fresh question', timestamp: Date.now(), final: true });
  assert.doesNotMatch(session.getFullSessionContext(), /old/);
});

test('reset drains and purges the live transcript index, then resumes indexing only fresh context', async () => {
  let release;
  const oldChunks = ['old transcript evidence'];
  const calls = [];
  const receiver = {
    simpleAutoAnswer: { onMeetingStop() {} }, autoAnswerUsage: { stopAwaitingAnswer() {} }, phoneImages: ['old.png'],
    isMeetingActive: true,
    intelligenceManager: { getCurrentMeetingTranscript: () => [{ speaker: 'user', text: 'fresh speech', timestamp: 1 }] },
    ragManager: {
      isLiveIndexingActive: () => true,
      stopLiveIndexing: () => new Promise(done => { release = () => { calls.push('drained'); done(); }; }),
      deleteMeetingData: () => { oldChunks.length = 0; calls.push('purged'); },
      startLiveIndexing: () => { oldChunks.length = 0; calls.push('started'); },
      feedLiveTranscript: segments => oldChunks.push(...segments.map(s => s.text)),
    },
  };
  const pending = execute(method(main, 'resetConversationTransientState'), main, { PhoneMirrorService: phoneMirrorBoundary }, receiver)();
  assert.equal(typeof release, 'function', 'the existing live index still contains pre-reset context');
  assert.deepEqual(calls, []);
  release();
  await pending;
  assert.ok(calls.includes('started'));
  assert.deepEqual(oldChunks, ['fresh speech']);
});

for (const preflight of [false, true]) {
  test(`Direct Assist reset rejects late provider events and delayed preflight, preflight=${preflight}`, async () => {
    let release;
    const events = [];
    let started = 0;
    const requests = new Map();
    const surfaces = new Map();
    const request = { requestId: 'request-1', source: 'typed', currentRequest: 'old question', history: [] };
    const scope = {
      console, AbortController,
      SettingsManager: { getInstance: () => ({ getDirectAssistEnabled: () => true }) },
      normalizeDirectAssistRequest: () => ({ request }), resolveDirectAssistSkill: () => ({ currentRequest: request.currentRequest }),
      directAssistRequestKey: (id, req) => `${id}:${req}`, directAssistSurfaceKey: (id, src) => `${id}:${src}`,
      activeDirectAssistByRequest: requests, activeDirectAssistBySurface: surfaces,
      appState: { processingHelper: { getLLMHelper: () => ({ getDirectAssistSelection: () => ({ provider: 'fake', model: 'fake' }) }) }, getIntelligenceManager: () => ({ getFormattedContext: () => '' }) },
      require: () => ({ ModesManager: { getInstance: () => ({ getActiveModeInfo: () => null }) } }),
      getChatCourseGrounding: () => preflight ? new Promise(done => { release = done; }) : Promise.resolve(''),
      DirectAssistService: class { async *stream() { started++; if (!preflight) await new Promise(done => { release = done; }); yield { requestId: request.requestId, type: 'start', sequence: 0 }; yield { requestId: request.requestId, type: 'delta', text: 'old answer', sequence: 1 }; yield { requestId: request.requestId, type: 'done', sequence: 2 }; } },
      sendDirectAssistEvent: (_sender, event) => events.push(event), directAssistError: (code, message) => ({ code, message }),
    };
    const pending = execute(ipcCallback('direct-assist-stream'), ipc, scope)({ sender: { id: 42, once() {}, removeListener() {} } }, request);
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    assert.equal(typeof release, 'function');
    // This is reset-intelligence's exact invalidation, independent of provider abort compliance.
    for (const active of requests.values()) active.controller.abort();
    requests.clear(); surfaces.clear();
    release('');
    await pending;
    await new Promise(done => setImmediate(done));
    assert.ok(!events.some(event => ['start', 'delta', 'done'].includes(event.type)), 'no stale answer event may restore the UI');
    if (preflight) assert.equal(started, 0, 'do not send outgoing conversation context after a reset during course lookup');
  });
}

test('an explicit reset clears phone replay and invalidates a pending browser capture without changing pairing or meeting state', async () => {
  const phone = parse('electron/services/PhoneMirrorService.ts');
  const broadcasts = [];
  const receiver = {
    meetingActive: true, meetingEnded: false, history: [{ content: 'old answer' }], transcriptFinals: [{ text: 'old transcript' }], transcriptPartial: { text: 'old partial' },
    awaitingAnswers: new Set(['old']), livePartial: { streamId: 'old', content: 'old answer' }, droppedStreams: new Set(),
    attachments: [{ path: 'old.png' }], attachmentPaths: ['old.png'], shots: new Map([['old.png', {}]]),
    pendingCaptures: new Map(), openCaptureReqIds: new Set(),
    token: 'paired-phone', extToken: 'paired-extension',
    pickExtensionClient: () => ({ send() {} }), isRunning: () => true,
    cancelLiveRender() {}, broadcast: event => broadcasts.push(event),
  };
  const capture = execute(method(phone, 'requestDomCapture'), phone, { generateToken: () => 'old-req', setTimeout: () => 1, clearTimeout() {}, CAPTURE_TIMEOUT_MS: 2500 }, receiver)();
  assert.equal(receiver.openCaptureReqIds.has('old-req'), true);
  execute(method(phone, 'publishMeetingState'), phone, { clearTimeout() {} }, receiver)(true, true);
  // Always settle the fixture even on the broken version (no hanging test timers).
  receiver.pendingCaptures.get('old-req')?.resolve({ ok: false, reason: 'test-cleanup' });
  const result = await capture;
  assert.equal(result.reason, 'conversation-reset');
  assert.equal(receiver.openCaptureReqIds.size, 0, 'late /dom with this reqId hits the existing duplicate gate');
  assert.equal(receiver.pendingCaptures.size, 0);
  assert.deepEqual(Array.from(receiver.history), []);
  assert.deepEqual(Array.from(receiver.transcriptFinals), []);
  assert.deepEqual(Array.from(receiver.attachmentPaths), []);
  assert.equal(receiver.livePartial, null);
  assert.equal(receiver.droppedStreams.has('old'), true);
  assert.equal(receiver.token, 'paired-phone');
  assert.equal(receiver.extToken, 'paired-extension');
  assert.equal(receiver.meetingActive, true);
  assert.equal(broadcasts.at(-1).reset, true);
});

test('reset aborts a held live RAG stream even when the generator ignores abort', async () => {
  let release;
  const events = [];
  const saved = [];
  const activeRAGQueries = new Map();
  const scope = {
    console, AbortController, crypto: { randomUUID: () => 'test-query' }, activeRAGQueries,
    appState: { getRAGManager: () => ({ isReady: () => true, getLiveMeetingId: () => 'live', queryMeeting: async function* () { await new Promise(done => { release = done; }); yield 'old answer'; } }), getIntelligenceManager: () => ({}) },
    liveQuestionWantsADrawing: () => false, resolveDiagramTurn: () => ({}), getChatCourseGrounding: async () => '',
    require: () => ({ ModesManager: { getInstance: () => ({ getActiveMode: () => ({ id: 'technical' }) }) } }),
    recordLiveRagTurn: (...args) => saved.push(args),
  };
  scope.abortPriorRAGQueriesOfClass = execute(find(ipc, n => ts.isFunctionDeclaration(n) && n.name?.text === 'abortPriorRAGQueriesOfClass'), ipc, scope);
  const pending = execute(ipcCallback('rag:query-live'), ipc, scope)({ sender: { id: 42, send: (...args) => events.push(args) } }, { query: 'old question' });
  for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, 'function');
  scope.abortPriorRAGQueriesOfClass(key => key.startsWith('live-'));
  release();
  await pending;
  assert.deepEqual(events, []);
  assert.deepEqual(saved, []);
});

const backendDefaults = Array.from(expression(variable(keybinds, 'DEFAULT_KEYBINDS').initializer, keybinds));
const backendToAction = expression(variable(shortcutsSource, 'BACKEND_ID_TO_ACTION').initializer, shortcutsSource);
const settings = parse('src/components/SettingsOverlay.tsx');
const settingsActions = new Set();
function visitSettings(node) {
  if (ts.isCallExpression(node) && node.expression.getText(settings) === 'renderShortcutConflictBadge' && ts.isStringLiteral(node.arguments[0])) settingsActions.add(node.arguments[0].text);
  if (ts.isArrayLiteralExpression(node) && node.elements.some(e => ts.isObjectLiteralExpression(e) && e.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(settings) === 'id' && ['whatToAnswer', 'moveWindowUp'].includes(p.initializer.text)))) {
    for (const entry of node.elements) for (const prop of entry.properties) if (prop.name?.getText(settings) === 'id') settingsActions.add(prop.initializer.text);
  }
  ts.forEachChild(node, visitSettings);
}
visitSettings(settings);

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: all 25 Settings shortcuts agree with defaults, rebind IPC, registration and native table`, async () => {
    assert.equal(backendDefaults.length, 25);
    assert.equal(settingsActions.size, 25);
    const isMac = platform === 'darwin';
    const scope = { isMac, getModifierSymbol: name => ({ commandorcontrol: isMac ? '⌘' : 'Ctrl', ctrl: isMac ? '⌃' : 'Ctrl', alt: isMac ? '⌥' : 'Alt', shift: isMac ? '⇧' : 'Shift' })[name] };
    const frontend = execute(find(shortcutsSource, n => ts.isFunctionDeclaration(n) && n.name?.text === 'buildDefaultShortcuts'), shortcutsSource, scope)();
    const display = execute(find(keyboardSource, n => ts.isFunctionDeclaration(n) && n.name?.text === 'acceleratorToKeys'), keyboardSource, scope);
    const pressedNode = variable(shortcutsSource, 'isShortcutPressed').initializer.arguments[0];
    const pressed = execute(pressedNode, shortcutsSource, { isMac, shortcuts: frontend });
    const rebinds = [];
    const update = execute(variable(shortcutsSource, 'updateShortcut').initializer.arguments[0], shortcutsSource, {
      setShortcuts() {}, pushSettledRef: { current: new Set() }, setConflicts() {}, keysToAccelerator: () => 'Control+F9',
      window: { electronAPI: { setKeybind: (...args) => rebinds.push(args) } }, console,
    });
    for (const kb of backendDefaults) {
      const action = backendToAction[kb.id];
      assert.ok(settingsActions.has(action), kb.id);
      assert.deepEqual(Array.from(display(kb.accelerator)).map(k => k.toLowerCase()), Array.from(frontend[action]).map(k => k.toLowerCase()), action);
      const tokens = kb.accelerator.split('+');
      const mainKey = tokens.at(-1);
      const event = { key: ({ Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Space: ' ' })[mainKey] ?? mainKey, code: mainKey === 'Space' ? 'Space' : '', metaKey: isMac, ctrlKey: !isMac, shiftKey: tokens.includes('Shift'), altKey: tokens.includes('Alt') };
      assert.equal(pressed(event, action), true, `${action} matches on ${platform}`);
      assert.equal(pressed({ ...event, shiftKey: !event.shiftKey }, action), false, `${action} requires exact modifiers`);
      await update(action, ['Ctrl', 'F9']);
      assert.equal(rebinds.at(-1)[0], kb.id);
    }
    const receiver = { keybinds: new Map(backendDefaults.map(kb => [kb.id, kb])), unusableAccelerators: new Set(), registrationFailures: new Set(), onShortcutTriggeredCallbacks: [], updateMenu() {}, startHealthCheck() {}, markRegistration() {} };
    const registered = new Map();
    const fired = [];
    receiver.onShortcutTriggeredCallbacks = [id => fired.push(id)];
    receiver.triggerActionById = execute(method(keybinds, 'triggerActionById'), keybinds, {}, receiver);
    const register = execute(method(keybinds, 'registerGlobalShortcuts'), keybinds, {
      console: { log() {}, warn() {}, error() {} }, isRegisterableAccelerator: () => true,
      beginFullRegistrationPass: prior => prior,
      globalShortcut: { unregisterAll: () => registered.clear(), register: (acc, fn) => registered.set(acc, fn), isRegistered: acc => registered.has(acc) },
    }, receiver);
    const { buildChordTable } = require(path.join(root, 'dist-electron/electron/services/winChord.js'));
    const table = execute(method(keybinds, 'getGlobalChordTable'), keybinds, { buildChordTable }, receiver);
    receiver.getGlobalChordTable = table;
    const stealth = parse('electron/services/StealthKeyboardManager.ts');
    const nativeTable = execute(method(stealth, 'getAppChordTable'), stealth, {
      process: { platform }, require: () => ({ KeybindManager: { getInstance: () => receiver } }), console,
    }, {});
    receiver.shouldRegister = execute(method(keybinds, 'shouldRegister'), keybinds, {}, receiver);
    for (const enabled of [true, false]) for (const mode of ['overlay', 'launcher']) {
      receiver.activeMode = mode;
      receiver.getGlobalShortcutsEnabled = () => enabled;
      register();
      const expected = backendDefaults.filter(kb => kb.isGlobal && (enabled ? mode === 'overlay' || ['general:toggle-visibility', 'general:toggle-mouse-passthrough', 'general:take-screenshot', 'general:selective-screenshot', 'general:capture-and-process', 'general:capture-dom'].includes(kb.id) : kb.id === 'general:toggle-visibility'));
      assert.deepEqual([...registered.keys()].sort(), expected.map(kb => kb.accelerator).sort());
      assert.deepEqual(Array.from(nativeTable(), chord => chord.id).sort(), isMac ? [] : expected.map(kb => kb.id).sort());
      assert.ok(!registered.has('CommandOrControl+R'), 'reset stays focus-local');
    }
    receiver.activeMode = 'overlay';
    receiver.getGlobalShortcutsEnabled = () => true;
    register();
    const queued = registered.get('CommandOrControl+1');
    receiver.getGlobalShortcutsEnabled = () => false;
    queued();
    assert.deepEqual(fired, [], 'a queued OS callback must obey the current global-disable gate');
  });
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a page-capture shortcut waiting for the extension must not dispatch after reset`, async () => {
    let release;
    let epoch = 0;
    let requested = 0;
    const receiver = {
      intelligenceManager: { getContextEpoch: () => epoch },
      windowHelper: { getOverlayWindow: () => ({}) }, getMainWindow: () => ({}), sendToWindow() {},
    };
    const svc = { isRunning: () => true, waitForExtension: () => new Promise(done => { release = done; }), requestDomCapture: async () => { requested++; return { ok: true }; } };
    const node = find(main, n => ts.isCallExpression(n) && n.expression.getText(main) === 'keybindManager.onShortcutTriggered').arguments[0];
    const pending = execute(node, main, { console, process: { platform }, PhoneMirrorService: { getInstance: () => svc }, PAGE_CAPTURE_STARTED_CHANNEL: 'capture-start' }, receiver)('general:capture-dom');
    assert.equal(typeof release, 'function');
    epoch++;
    release(true);
    await pending;
    assert.equal(requested, 0);
  });

  test(`${platform}: stealth-typing shortcut dispatch uses native capture, with the existing platform-specific focus fallback`, async () => {
    const calls = [];
    const overlay = { isDestroyed: () => false, focus: () => calls.push('focus') };
    let available = true;
    const mgr = { isAvailable: () => available, isActive: () => false, start: () => calls.push('start'), stop: () => calls.push('stop') };
    const receiver = { windowHelper: { getOverlayWindow: () => overlay }, showMainWindow() {}, sendToWindow: (_win, _channel, data) => calls.push(data?.action ?? 'expanded') };
    const node = find(main, n => ts.isCallExpression(n) && n.expression.getText(main) === 'keybindManager.onShortcutTriggered').arguments[0];
    const dispatch = execute(node, main, { console, process: { platform }, require: () => ({ StealthKeyboardManager: { getInstance: () => mgr } }) }, receiver);
    await dispatch('chat:focusInput');
    assert.ok(calls.includes('start'));
    assert.ok(!calls.includes('focus'), 'native capture must not focus the window');
    available = false;
    calls.length = 0;
    await dispatch('chat:focusInput');
    assert.ok(calls.includes('focusInput'));
    assert.equal(calls.includes('focus'), platform === 'darwin');
  });
}

test('global chat dispatch covers Settings-listed actions without changing focus; direct general and movement actions have main routes', async () => {
  const dispatchNode = find(main, n => ts.isCallExpression(n) && n.expression.getText(main) === 'keybindManager.onShortcutTriggered').arguments[0];
  const sent = [];
  const calls = [];
  const receiver = {
    windowHelper: { moveWindowUp: () => calls.push('moveWindowUp'), moveWindowDown: () => calls.push('moveWindowDown'), moveWindowLeft: () => calls.push('moveWindowLeft'), moveWindowRight: () => calls.push('moveWindowRight') },
    getMainWindow: () => ({}), sendToWindow: (_win, _channel, data) => sent.push(data.action), sendToMeetingSurfaces: (_channel, data) => sent.push(data.action),
    toggleMainWindow: () => calls.push('toggleVisibility'), toggleOverlayMousePassthrough: () => calls.push('toggleMousePassthrough'), captureScreenAndProcess: async () => calls.push('captureAndProcess'),
  };
  const dispatch = execute(dispatchNode, main, { console, SHORTCUT_TOUR_ACTIONS: new Set() }, receiver);
  for (const kb of backendDefaults.filter(kb => !['chat:focusInput', 'general:capture-dom'].includes(kb.id))) {
    const action = backendToAction[kb.id];
    await dispatch(kb.id);
    assert.ok([...sent, ...calls].includes(action), kb.id);
  }
  const globalRenderer = find(renderer, n => ts.isCallExpression(n) && n.expression.getText(renderer) === 'window.electronAPI.onGlobalShortcut').arguments[0];
  const performed = [];
  const run = execute(globalRenderer, renderer, {
    handlersRef: { current: { handleWhatToSay: () => performed.push('whatToAnswer'), handleClarify: () => performed.push('clarify'), handleFollowUpQuestions: () => performed.push('followUp'), handleRecap: () => performed.push('dynamicAction4'), handleAnswerNow: () => performed.push('answer'), handleCodeHint: () => performed.push('codeHint'), handleBrainstorm: () => performed.push('brainstorm') } },
    generalHandlersRef: { current: {} }, isStealthRef: { current: false }, actionButtonMode: 'recap',
    inertialScrollRef: { current: { kick: (axis, direction) => performed.push(`${axis}:${direction}`) } }, setTimeout() {},
  });
  for (const action of ['whatToAnswer', 'clarify', 'followUp', 'dynamicAction4', 'answer', 'codeHint', 'brainstorm']) { run({ action }); assert.equal(performed.at(-1), action); }
  for (const [action, expected] of [['scrollUp', 'vert:-1'], ['scrollDown', 'vert:1'], ['scrollLeft', 'horiz:-1'], ['scrollRight', 'horiz:1']]) { run({ action }); assert.equal(performed.at(-1), expected); }
  // acceptSuggestion intentionally belongs to DynamicActionBar's dedicated listener;
  // AcceptSuggestionShortcut2026_09_27 executes that component's real handler.
});

function enclosingEffect(node) {
  while (node && !(ts.isCallExpression(node) && node.expression.getText(renderer) === 'useEffect')) node = node.parent;
  assert.ok(node, 'shortcut registration effect not found');
  return node.arguments[0];
}

function shortcutRenderRig(platform, route, initialMode = 'recap') {
  const calls = [];
  const listeners = new Map();
  const frames = [];
  const timers = [];
  let subscriptions = 0;
  let frame = 0;
  const shared = {
    console, Math,
    handlersRef: { current: {} }, generalHandlersRef: { current: {} },
    isStealthRef: { current: false }, inertialScrollRef: { current: null },
    textInputRef: { current: null }, scrollContainerRef: { current: null },
    chatResetEpochRef: { current: 0 },
    setIsExpanded: value => calls.push(`expanded:${value}`),
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    setTimeout: fn => { timers.push(fn); return timers.length; },
    window: {
      addEventListener: (event, fn) => { subscriptions++; listeners.set(event, fn); },
      removeEventListener: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); },
      electronAPI: {
        onGlobalShortcut: fn => { subscriptions++; listeners.set('global', fn); return () => listeners.delete('global'); },
        setOverlayMousePassthrough: value => calls.push(`passthrough:${value}`),
        toggleWindow() {},
        takeScreenshot: async () => ({ path: 'shot.png' }),
        takeSelectiveScreenshot: async () => ({ path: 'selection.png' }),
      },
    },
  };
  const isMac = platform === 'darwin';
  const shortcuts = execute(find(shortcutsSource, n => ts.isFunctionDeclaration(n) && n.name?.text === 'buildDefaultShortcuts'), shortcutsSource, { isMac })();
  const isShortcutPressed = execute(variable(shortcutsSource, 'isShortcutPressed').initializer.arguments[0], shortcutsSource, { isMac, shortcuts });
  const assignment = name => find(renderer, n => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText(renderer) === `${name}.current`);
  function render(mode, mousePassthrough = false) {
    const currentFrame = ++frame;
    // A new scope per render keeps the installed closure's state immutable,
    // as in React; only production ref assignments carry new state to it.
    const scope = { ...shared, actionButtonMode: mode, isMousePassthrough: mousePassthrough, isShortcutPressed };
    for (const name of ['handleWhatToSay', 'handleFollowUp', 'handleFollowUpQuestions', 'handleRecap', 'handleAnswerNow', 'handleClarify', 'handleCodeHint', 'handleBrainstorm', 'resetConversation', 'handleScreenshotAttach']) {
      scope[name] = (...args) => calls.push(`${currentFrame}:${name}${name === 'handleFollowUp' ? `:${args[0]}` : ''}`);
    }
    scope.setIsMousePassthrough = value => calls.push(`${currentFrame}:setIsMousePassthrough:${value}`);
    expression(assignment('handlersRef'), renderer, scope);
    expression(assignment('generalHandlersRef'), renderer, scope);
    return scope;
  }
  const mountScope = render(initialMode);
  const registration = route === 'global'
    ? find(renderer, n => ts.isCallExpression(n) && n.expression.getText(renderer) === 'window.electronAPI.onGlobalShortcut')
    : variable(renderer, 'handleKeyDown');
  const cleanup = execute(enclosingEffect(registration), renderer, mountScope)();
  const dispatchMain = execute(find(main, n => ts.isCallExpression(n) && n.expression.getText(main) === 'keybindManager.onShortcutTriggered').arguments[0], main, {
    console: { log() {} }, process: { platform }, SHORTCUT_TOUR_ACTIONS: new Set(),
  }, { sendToMeetingSurfaces: (channel, payload) => { assert.equal(channel, 'global-shortcut'); listeners.get('global')(payload); } });
  return {
    calls, render, cleanup, shared, frames, timers, listeners,
    get subscriptions() { return subscriptions; },
    dispatch: action => listeners.get('global')({ action }),
    press: async (modifiers = { metaKey: isMac, ctrlKey: !isMac }) => {
      const event = { key: '3', code: 'Digit3', altKey: false, shiftKey: false, ...modifiers, preventDefault() { this.prevented = true; } };
      if (route === 'global') {
        if (isShortcutPressed(event, 'dynamicAction4')) await dispatchMain('chat:dynamicAction4');
      } else {
        listeners.get('keydown')(event);
      }
      return event;
    },
  };
}

for (const platform of ['darwin', 'win32']) {
  for (const route of ['global', 'local']) for (const initialMode of ['recap', 'brainstorm']) {
    test(`${platform}: ${route} Ctrl/Cmd+3 follows dynamic mode changes from ${initialMode} without re-registering`, async () => {
      const rig = shortcutRenderRig(platform, route, initialMode);
      try {
        const subscriptions = rig.subscriptions;
        const otherMode = initialMode === 'recap' ? 'brainstorm' : 'recap';
        for (const [index, mode] of [initialMode, otherMode, initialMode].entries()) {
          if (index) rig.render(mode);
          const before = rig.calls.length;
          await rig.press({ metaKey: platform !== 'darwin', ctrlKey: platform === 'darwin' });
          assert.equal(rig.calls.length, before, 'the other platform modifier must not dispatch');
          const event = await rig.press();
          assert.equal(rig.calls.at(-1), `${index + 1}:${mode === 'brainstorm' ? 'handleBrainstorm' : 'handleRecap'}`, 'use current mode and current handler, not the mount snapshot');
          if (route === 'local') assert.equal(event.prevented, true);
          assert.equal(rig.subscriptions, subscriptions, 'mode changes do not re-register shortcuts');
        }
      } finally {
        rig.cleanup();
        assert.equal(rig.listeners.size, 0, 'registration cleanup removes the installed listeners');
      }
    });
  }

  test(`${platform}: other global shortcut callbacks use current handlers, state and delayed target refs`, async () => {
    const rig = shortcutRenderRig(platform, 'global');
    try {
      rig.render('brainstorm', true);
      for (const [action, handler] of [
        ['whatToAnswer', 'handleWhatToSay'], ['shorten', 'handleFollowUp:shorten'],
        ['followUp', 'handleFollowUpQuestions'], ['recap', 'handleRecap'],
        ['answer', 'handleAnswerNow'], ['clarify', 'handleClarify'],
        ['codeHint', 'handleCodeHint'], ['brainstorm', 'handleBrainstorm'],
        ['processScreenshots', 'handleWhatToSay'], ['resetCancel', 'resetConversation'],
        ['takeScreenshot', 'handleScreenshotAttach'], ['selectiveScreenshot', 'handleScreenshotAttach'],
      ]) {
        rig.dispatch(action);
        // The IPC listener is fire-and-forget, including async screenshot handlers.
        await new Promise(done => setImmediate(done));
        assert.equal(rig.calls.at(-1), `2:${handler}`, action);
      }
      // Also execute the real refreshed stateful general callback rather than
      // replacing it with a stub (its OS-global route is owned by main).
      rig.shared.generalHandlersRef.current.toggleMousePassthrough();
      assert.ok(rig.calls.includes('2:setIsMousePassthrough:false'));
      rig.render('recap', false);
      rig.shared.generalHandlersRef.current.toggleMousePassthrough();
      assert.ok(rig.calls.includes('3:setIsMousePassthrough:true'));
      rig.shared.inertialScrollRef.current = { kick: (axis, direction) => rig.calls.push(`${axis}:${direction}`) };
      for (const [action, expected] of [['scrollUp', 'vert:-1'], ['scrollDown', 'vert:1'], ['scrollLeft', 'horiz:-1'], ['scrollRight', 'horiz:1']]) {
        rig.dispatch(action);
        assert.equal(rig.calls.at(-1), expected);
      }
      rig.shared.textInputRef.current = { focus: () => assert.fail('must not focus the old target') };
      rig.dispatch('focusInput');
      assert.equal(rig.calls.at(-1), 'expanded:true');
      rig.shared.textInputRef.current = { focus: () => rig.calls.push('current-input') };
      while (rig.frames.length) rig.frames.shift()();
      assert.equal(rig.calls.at(-1), 'current-input');
      assert.equal(rig.shared.isStealthRef.current, true);
      for (const timer of rig.timers) timer();
      assert.equal(rig.shared.isStealthRef.current, false);
      assert.equal(rig.subscriptions, 1);
    } finally {
      rig.cleanup();
    }
  });
}
