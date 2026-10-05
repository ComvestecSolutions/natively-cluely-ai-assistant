import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const electronRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeRequire = createRequire(import.meta.url);
const compiled = new Map();

// Only persistence/native boundaries are replaced. Decisions, consent gates,
// collector, source/version filters, retrieval ports and composer are real TS.
export function launcherComposer(platform, { modesManager, scopePolicy, answerPolicy = null, env = {} } = {}) {
  const context = vm.createContext({
    console, AbortController, AbortSignal, setTimeout, clearTimeout, performance,
    process: { platform, env: { ...env }, cwd: () => electronRoot },
  });
  const cache = new Map();
  const mocks = new Map([
    ['services/ModesManager.ts', { ModesManager: { getInstance: () => modesManager ?? {
      getActiveModeInfo: () => null, getReferenceFiles: () => [], getActiveModePinnedInstructions: () => '',
    } } }],
    ['services/usageInstrumentation.ts', { recordTurnTelemetry() {} }],
    ['services/SettingsManager.ts', { SettingsManager: { getInstance: () => ({ get: () => scopePolicy }) } }],
    ['services/knowledge/ProfilePackBuilder.ts', { ProfilePackBuilder: { getInstance: () => ({ getProfilePack: () => null }) } }],
    ['context-intelligence/policies/answer-policy-store.ts', { getStoredAnswerPolicy: () => answerPolicy }],
  ].map(([name, value]) => [path.join(electronRoot, name), value]));
  function load(filename) {
    if (mocks.has(filename)) return mocks.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText);
    const require = id => {
      if (!id.startsWith('.')) return nativeRequire(id);
      return load(path.resolve(path.dirname(filename), id.endsWith('.ts') ? id : `${id}.ts`));
    };
    const fn = vm.runInContext(`(function(require, module, exports) {\n${compiled.get(filename)}\n})`, context, { filename });
    fn(require, module, module.exports);
    return module.exports;
  }
  return load(path.join(electronRoot, 'rag/launcherAskContext.ts'));
}

let fallbackSource;
export function launcherFallbackHandler(platform, { helper, composer, getChatCourseGrounding, ragModule, grounding }) {
  if (!fallbackSource) {
    const filename = path.join(electronRoot, 'ipcHandlers.ts');
    const source = fs.readFileSync(filename, 'utf8');
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === '_geminiChatStreamHandler') fallbackSource = node.initializer.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!fallbackSource) throw new Error('Production launcher fallback handler was not found');
  }
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(`module.exports = ${fallbackSource};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    module, console, AbortController, setTimeout, clearTimeout, process: { platform, env: process.env },
    appState: { processingHelper: { getLLMHelper: () => helper } },
    beginTrace: () => ({}), _chatStreamId: 0, _chatStreamsBySender: new Map(),
    getChatCourseGrounding, courseGroundingAsReference: grounding.courseGroundingAsReference,
    require: id => {
      if (id === './rag/launcherAskContext') return composer;
      if (id === './rag/RAGManager') return ragModule;
      if (id === './services/ForegroundGate') return { ForegroundGate: {} };
      throw new Error(`Unexpected launcher dependency: ${id}`);
    },
  });
  return module.exports;
}

export function mockSelectedTransport(helper) {
  const onDevice = helper.selectionStaysOnDevice?.() === true;
  return Object.freeze({ selectionStaysOnDevice: () => onDevice, streamRAGAnswer: (...args) => helper.streamRAGAnswer(...args) });
}

export const contract = (sourceAuthority = 'general_mixed', switches = ['reference_files', 'profile', 'job_description', 'transcript']) => ({
  version: 1, defaultOwner: sourceAuthority.startsWith('profile') ? 'profile' : sourceAuthority === 'transcript_only' ? 'transcript' : 'reference_files',
  sourceAuthority, allowedExplicitSwitches: switches, evidenceRequired: sourceAuthority.endsWith('_only'),
  conflictPolicy: 'reference_files_win', origin: 'user_selected',
  memoryPolicy: { allowPriorAssistantFacts: false, allowPriorAssistantReferents: true },
});
