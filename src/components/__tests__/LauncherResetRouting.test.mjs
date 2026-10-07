import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const parse = (file) => ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const launcher = parse('src/components/Launcher.tsx');
const chat = parse('src/components/GlobalChatOverlay.tsx');
const overlay = parse('src/components/NativelyInterface.tsx');
const main = parse('electron/main.ts');
function find(source, predicate) {
  let found;
  const visit = node => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(source);
  assert.ok(found, 'production routing seam missing');
  return found;
}
function run(node, source, scope, receiver = {}) {
  const compiled = transformSync(`(${node.getText(source)})`, { loader: 'tsx', target: 'es2022' }).code.trim().replace(/;$/, '');
  return vm.runInNewContext(`(function() { return ${compiled}; }).call(__receiver)`, { ...scope, __receiver: receiver });
}
function effect(source, marker) {
  return find(source, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes(marker)).arguments[0];
}
const keyboardEffect = effect(launcher, "window.addEventListener('keydown', handleKeyDown)");
const resetCallback = find(launcher, node => ts.isVariableDeclaration(node) && node.name.getText(launcher) === 'resetConversation').initializer.arguments[0];
const globalEffect = source => effect(source, 'onGlobalShortcut');
const action = find(main, node => ts.isCallExpression(node) && node.expression.getText(main) === 'keybindManager.onShortcutTriggered').arguments[0];


function rig(platform, { mode = 'launcher', overlayExists = false, chord = 'r', chatOpen = true } = {}) {
  const state = { resets: 0, messages: ['old conversation'], deliveries: [] };
  const listeners = new Map();
  let sessionReset;
  const bridge = {
    resetIntelligence: async () => {
      state.resets++;
      sessionReset({ phase: 'begin', preserveWindowSize: true });
      sessionReset({ phase: 'complete', success: true });
      return { success: true };
    },
    onSessionReset: fn => { sessionReset = fn; return () => { sessionReset = undefined; }; },
    onGlobalShortcut: fn => { listeners.set('launcher', fn); return () => listeners.delete('launcher'); },
    toggleWindow() {},
  };
  const window = { electronAPI: bridge, addEventListener: (_event, fn) => { window.keydown = fn; }, removeEventListener() {} };
  run(effect(chat, 'onSessionReset'), chat, {
    window, initialQuery: '', resetPendingRef: { current: false }, pendingQuestionsRef: { current: [] },
    lastInitialQueryRef: { current: null }, cancelActiveTurnRef: { current: null },
    submitInFlightRef: { current: false }, isOpenRef: { current: chatOpen }, submitQuestionRef: { current: () => {} },
    streamBuffer: { reset() {} }, setMessages: value => { state.messages = value; },
    setQuery() {}, setChatState() {}, setErrorMessage() {},
  })();
  const shortcut = (event, id) => id === 'resetCancel' && event.key.toLowerCase() === chord && (platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey;
  const resetConversation = run(resetCallback, launcher, { window, resetPendingRef: { current: false }, console });
  run(keyboardEffect, launcher, { window, isShortcutPressed: shortcut, isGlobalChatOpen: chatOpen, isMac: platform === 'darwin', resetConversation })();
  // Default reset is local; custom reset must have a launcher IPC subscriber.
  if (chord !== 'r') run(globalEffect(launcher), launcher, { window, resetConversation })();
  if (overlayExists) {
    const overlayWindow = { electronAPI: { onGlobalShortcut: fn => { listeners.set('overlay', fn); return () => listeners.delete('overlay'); } } };
    run(globalEffect(overlay), overlay, {
      window: overlayWindow, handlersRef: { current: {} }, generalHandlersRef: { current: { resetCancel: bridge.resetIntelligence } },
      isStealthRef: { current: false }, setTimeout() {},
    })();
  }
  const windows = {
    launcher: { id: 1, isDestroyed: () => false, webContents: { send: (_channel, payload) => { state.deliveries.push('launcher'); listeners.get('launcher')?.(payload); } } },
    overlay: overlayExists ? { id: 2, isDestroyed: () => false, webContents: { send: (_channel, payload) => { state.deliveries.push('overlay'); listeners.get('overlay')?.(payload); } } } : null,
  };
  const receiver = {
    windowHelper: { getCurrentWindowMode: () => mode, getLauncherWindow: () => windows.launcher, getOverlayWindow: () => windows.overlay },
    sendToWindow(win, channel, payload) { if (!win) return false; assert.equal(channel, 'global-shortcut'); win.webContents.send(channel, payload); return true; },
  };

  const global = run(action, main, { console: { log() {}, error() {} }, SHORTCUT_TOUR_ACTIONS: new Set() }, receiver);
  return { state, window, global, press(key, inChat = true) {
    const event = { key, code: `Key${key.toUpperCase()}`, metaKey: platform === 'darwin', ctrlKey: platform === 'win32', altKey: false, shiftKey: false,
      target: { tagName: 'INPUT', closest: selector => inChat && selector === '[data-global-chat]' ? {} : null },
      prevented: false, preventDefault() { this.prevented = true; } };
    window.keydown(event);
    return event;
  } };
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: default reset is local to focused launcher chat; browser reload is untouched`, async () => {
    assert.ok(find(chat, node => ts.isJsxAttribute(node) && node.name.getText(chat) === 'data-global-chat'), 'the focused chat has the selector used by Launcher');
    const { state, press } = rig(platform, { chatOpen: false });
    assert.equal(press('r', false).prevented, false);
    assert.equal(state.resets, 0);
    const focused = rig(platform);
    assert.equal(focused.press('r', false).prevented, false, 'other launcher content is not chat');
    assert.equal(focused.press('r').prevented, true);
    assert.equal(focused.state.resets, 1);
    assert.deepEqual(Array.from(focused.state.messages), []);
  });
  for (const [mode, overlayExists] of [['launcher', false], ['launcher', true], ['overlay', true]]) {
    test(`${platform}: custom reset routes once, mode=${mode}, overlay=${overlayExists}`, async () => {
      const { state, global, press } = rig(platform, { mode, overlayExists, chord: 'k' });
      assert.equal(press('r').prevented, false, 'rebound default must not intercept reload');
      assert.equal(press('k').prevented, false, 'globally registered custom chord must not also reset locally');
      await global('general:reset-cancel');
      assert.equal(state.resets, 1, 'one backend reset for one OS shortcut');
      assert.deepEqual(Array.from(state.messages), []);
      assert.deepEqual(state.deliveries, [mode], 'only the active surface receives reset');
    });
  }
}
