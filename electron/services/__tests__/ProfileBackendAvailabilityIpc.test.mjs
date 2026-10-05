import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const handlers = new Map();
let orchestrator = null;
const selected = path.join(os.tmpdir(), 'profile-availability-resume.txt');

before(() => {
  const noop = () => {};
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-availability-ipc-'));
  const electron = {
    app: { getPath: () => userData, getAppPath: () => root, isPackaged: false, isReady: () => true,
      getVersion: () => '0.0.0-test', getName: () => 'natively', on: noop, once: noop,
      off: noop, removeAllListeners: noop, whenReady: () => Promise.resolve() },
    BrowserWindow: Object.assign(function BrowserWindow() {}, { getAllWindows: () => [] }),
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), handleOnce: (channel, fn) => handlers.set(channel, fn),
      on: noop, once: noop, off: noop, removeHandler: noop, removeListener: noop, removeAllListeners: noop,
      listenerCount: () => 0, emit: noop },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    desktopCapturer: {}, shell: {}, systemPreferences: {},
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s),
      decryptString: b => Buffer.from(b).toString(), getSelectedStorageBackend: () => 'basic_text' },
    nativeTheme: { on: noop }, screen: { on: noop }, session: {}, globalShortcut: {},
    Menu: {}, Tray: {}, clipboard: {},
  };
  const originalLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electron;
    if (request.endsWith('/premium/electron/knowledge/types')) return { DocType: { RESUME: 'resume', JD: 'jd' } };
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const { initializeIpcHandlers } = require(path.join(root, 'dist-electron/electron/ipcHandlers.js'));
    const state = { processingHelper: { getLLMHelper: () => ({ setModel: noop, setNativelyKey: noop,
      getCodexCliConfig: () => ({ enabled: false }) }) }, sendModelChanged: noop,
      reconfigureSttProvider: async () => {}, getKnowledgeOrchestrator: () => orchestrator };
    try { initializeIpcHandlers(state); } catch { /* unrelated lifecycle wiring */ }
  } finally { Module._load = originalLoad; }
  assert.ok(handlers.has('profile:get-status'), 'real profile IPC handler registered');
});

test('missing knowledge engine is distinct from an empty profile, and refuses engine-backed operations', async () => {
  orchestrator = null;
  const status = await handlers.get('profile:get-status')({});
  assert.deepEqual(status, { hasProfile: false, profileMode: false,
    backendAvailable: false, backendUnavailable: 'knowledge_engine_unavailable' });
  const enable = await handlers.get('profile:set-mode')({}, true);
  assert.equal(enable.success, false);
  assert.match(enable.error, /knowledge engine.*unavailable/i);
  assert.doesNotMatch(enable.error, /api keys|premium\/|\\|\.ts/i);
  for (const channel of ['profile:upload-resume', 'profile:upload-jd']) {
    const pick = await handlers.get('profile:select-file')({});
    const result = await handlers.get(channel)({}, pick.filePath);
    assert.equal(result.success, false, channel);
    assert.match(result.error, /knowledge engine.*unavailable/i);
    assert.doesNotMatch(result.error, /api keys|premium\/|\\|\.ts/i);
  }
  for (const [channel, args] of [
    ['profile:research-company', ['Example Corp', false]],
    ['profile:generate-cover-letter', [false]],
    ['profile:generate-negotiation', [false]],
    ['profile:delete', []],
    ['profile:delete-jd', []],
  ]) {
    const result = await handlers.get(channel)({}, ...args);
    assert.equal(result.success, false, channel);
    assert.match(result.error, /knowledge engine.*unavailable/i);
  }
});

test('a status failure does not expose its exception text or claim the profile is empty', async () => {
  orchestrator = { getStatus: () => { throw new Error('C:\\private\\résumé.txt: key=secret'); } };
  assert.deepEqual(await handlers.get('profile:get-status')({}), {
    hasProfile: false, profileMode: false, backendAvailable: false, backendUnavailable: 'status_unavailable',
  });
});

test('operational knowledge engine with no résumé reports available, not missing', async () => {
  orchestrator = { getStatus: () => ({ hasResume: false, activeMode: false }), activeResume: null,
    activeJD: null, isIngesting: () => false };
  const status = await handlers.get('profile:get-status')({});
  assert.equal(status.backendAvailable, true);
  assert.equal(status.backendUnavailable, null);
  assert.equal(status.hasProfile, false);
  assert.equal(status.profileMode, false);
});
