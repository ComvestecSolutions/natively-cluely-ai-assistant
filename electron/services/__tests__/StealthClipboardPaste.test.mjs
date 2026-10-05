import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const manager = ts.createSourceFile('StealthKeyboardManager.ts', read('electron/services/StealthKeyboardManager.ts'), ts.ScriptTarget.Latest, true);
const renderer = ts.createSourceFile('NativelyInterface.tsx', read('src/components/NativelyInterface.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(source, predicate) {
  let found;
  function visit(node) {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, 'production callback missing');
  return found;
}

function runMethod(source, name, scope) {
  const node = find(source, n => ts.isMethodDeclaration(n) && n.name.getText(source) === name);
  const code = node.getText(source).replace(/^(?:private|public)\s+/, '');
  const js = transformSync(`class Harness { ${code} } Harness`, { loader: 'ts', target: 'es2022' }).code;
  return vm.runInNewContext(js, scope).prototype[name];
}

function rig(platform, text = 'clipboard words') {
  const sent = [];
  let reads = 0;
  let submissions = 0;
  const warnings = [];
  const scope = {
    process: { platform },
    clipboard: { readText: () => { reads++; if (text instanceof Error) throw text; return text; } },
    console: { warn: message => warnings.push(message) },
  };
  const receiver = {
    active: true, guardRunning: false,
    overlayWebContents: { isDestroyed: () => false },
    armIdleTimer() {}, stop() { this.active = false; },
    sendKeyToOverlay(ev) { sent.push(ev); },
    dispatchAppChord() { submissions++; },
  };
  const handleCapturedKey = runMethod(manager, 'handleCapturedKey', scope).bind(receiver);
  return { receiver, sent, warnings, handleCapturedKey, reads: () => reads, submissions: () => submissions };
}

function rendererInputCallback(setInputValue, active = true) {
  const node = find(renderer, n => ts.isCallExpression(n) && n.expression.getText(renderer) === 'window.electronAPI.onStealthKeyCaptured');
  const js = transformSync(`(${node.arguments[0].getText(renderer)})`, { loader: 'ts', target: 'es2022' }).code;
  const scope = {
    stealthTapActiveRef: { current: active }, setInputValue,
    handleManualSubmitRef: { current: () => assert.fail('paste must not submit') },
    window: { electronAPI: { stealthTapStop: async () => {} } },
    console, isWindows: false,
  };
  return vm.runInNewContext(`(() => { let escSuppressUntilNextActive = false; return ${js.trim().replace(/;$/, '')}; })()`, scope);
}

for (const [platform, flag] of [['win32', 1 << 18], ['darwin', 1 << 20]]) {
  test(`${platform}: actual native callback payload pastes into overlay without focus or submit`, () => {
    const rigged = rig(platform, 'clipboard\r\nwords');
    rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: true });
    assert.equal(rigged.reads(), 1);
    assert.equal(rigged.sent.length, 1);
    let input = 'draft ';
    const onCapturedKey = rendererInputCallback(update => { input = update(input); });
    onCapturedKey(rigged.sent[0]);
    assert.equal(input, 'draft clipboard words');
    assert.equal(rigged.submissions(), 0);
  });

  test(`${platform}: keyup, stopped tap, guard mode and unrelated chords never read clipboard`, () => {
    const rigged = rig(platform);
    rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: false });
    rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag | (1 << 17), isKeyDown: true });
    rigged.receiver.active = false;
    rigged.receiver.guardRunning = true;
    rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: true });
    assert.equal(rigged.reads(), 0);
    assert.equal(rigged.submissions(), 0);
  });

  test(`${platform}: paste is capped before IPC and does not split a surrogate pair`, () => {
      const rigged = rig(platform, 'x'.repeat(99_999) + '😀' + 'private tail');
      rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: true });
      assert.equal(rigged.sent.length, 1);
      assert.equal(rigged.sent[0].chars.length, 99_999);
      assert.equal(rigged.sent[0].chars.endsWith('x'), true);
      assert.equal(rigged.sent[0].chars.includes('private tail'), false);
    });

    test(`${platform}: clipboard containing only line breaks never submits or publishes text`, () => {
    const rigged = rig(platform, '\r\n');
    rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: true });
    assert.equal(rigged.sent.length, 0);
    assert.equal(rigged.submissions(), 0);
  });

  test(`${platform}: clipboard read failure cannot emit text or leak errors`, () => {
    const rigged = rig(platform, new Error('private clipboard data'));
    assert.doesNotThrow(() => rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: true }));
    assert.equal(rigged.sent.length, 0);
    assert.equal(rigged.submissions(), 0);
    assert.equal(rigged.warnings.length, 1);
    assert.doesNotMatch(rigged.warnings[0], /private clipboard data/);
  });

  test(`${platform}: missing overlay sink cannot consume clipboard contents`, () => {
    const rigged = rig(platform);
    rigged.receiver.overlayWebContents = null;
    rigged.handleCapturedKey({ keyCode: 9, chars: '', flags: flag, isKeyDown: true });
    assert.equal(rigged.reads(), 0);
    assert.equal(rigged.sent.length, 0);
  });
}

test('stealth Backspace deletes one whole grapheme (emoji and combining marks)', () => {
  for (const [initial, expected] of [['hello😀', 'hello'], ['cafe\u0301', 'caf'], ['ok👩‍💻', 'ok']]) {
    let input = initial;
    const callback = rendererInputCallback(update => { input = update(input); });
    callback({ keyCode: 51, chars: '', flags: 0, isKeyDown: true });
    assert.equal(input, expected);
  }
});

test('macOS: passive margin hover keeps the tap; a native mouse-down through it stops before typing', () => {
  const changes = [];
  const mac = {
    active: true,
    tap: { setOverlayIgnoresMouseEvents: value => changes.push(value) },
    stop() { this.active = false; this.stops = (this.stops || 0) + 1; },
    armIdleTimer() {}, sendKeyToOverlay() { assert.fail('typing after the click must not reach chat'); },
  };
  const update = runMethod(manager, 'setOverlayIgnoresMouseEvents', { process: { platform: 'darwin' } }).bind(mac);
  update(true); // move into transparent margin, no button press
  assert.equal(mac.active, true, 'hover alone must not end stealth typing');
  assert.equal(mac.stops, undefined);
  update(false); // move back onto panel
  assert.equal(mac.active, true);
  update(true); // move back into click-through margin
  assert.deepEqual(changes, [true, false, true]);
  assert.equal(mac.active, true);
  const start = runMethod(manager, 'start', { process: { platform: 'darwin' }, console });
  const engage = {
    tap: { setOverlayIgnoresMouseEvents() {}, start: () => true },
    overlayIgnoresMouseEvents: true, active: false,
    stopGuard() {}, broadcastState() {}, getOverlayBoundsForTap: () => null,
    getAppChordTable: () => [], refreshResetChord() {}, hideAuxWindowsForStealth() {}, armIdleTimer() {},
  };
  assert.equal(start.call(engage), true, 'explicit engagement remains possible during passive hover');
  assert.equal(start.call({ tap: {}, overlayIgnoresMouseEvents: true }), false, 'stale binary fails closed');
  const onKey = runMethod(manager, 'handleCapturedKey', { process: { platform: 'darwin' } }).bind(mac);
  onKey({ isOutsideMouseDown: true }); // native event tap sees the *actual* click
  assert.equal(mac.active, false);
  assert.equal(mac.stops, 1);
  onKey({ keyCode: 0, chars: 's', isKeyDown: true });

  const win = { active: true, tap: { setOverlayIgnoresMouseEvents() { assert.fail('Windows hook must stay unchanged'); } } };
  runMethod(manager, 'setOverlayIgnoresMouseEvents', { process: { platform: 'win32' } }).call(win, true);
  assert.equal(win.active, true);

  const windowHelper = read('electron/WindowHelper.ts');
  const native = read('native-module/src/keyboard_tap.rs');
  const windowSource = ts.createSourceFile('WindowHelper.ts', windowHelper, ts.ScriptTarget.Latest, true);
  const order = [];
  const sync = runMethod(windowSource, 'syncOverlayInteractionPolicy', {
    process: { platform: 'darwin' }, console,
    require: () => ({ StealthKeyboardManager: { getInstance: () => ({
      setOverlayIgnoresMouseEvents: ignores => order.push(`native:${ignores}`),
    }) } }),
    isNoActivateManaged: () => true,
  });
  const shell = {
    overlayWindow: { isDestroyed: () => false, setIgnoreMouseEvents: value => order.push(`electron:${value}`) },
    pillWindow: null, toggleWindow: null,
    overlayHoverInteractive: false,
    appState: { getOverlayMousePassthrough: () => false },
  };
  sync.call(shell, true);
  shell.overlayHoverInteractive = true;
  sync.call(shell, true);
  assert.deepEqual(order, ['native:true', 'electron:true', 'electron:false', 'native:false']);
  assert.match(windowHelper, /if \(overlayIgnore\) \{\s*setNativeMousePolicy\(true\);[\s\S]*?setIgnoreMouseEvents\(true/);
  assert.match(windowHelper, /setIgnoreMouseEvents\(false\);\s*setNativeMousePolicy\(false\)/);
  assert.match(manager.getFullText(), /setOverlayBoundsProvider\(\(\) => win\.isDestroyed\(\) \? null : win\.getBounds\(\)\)/);
  assert.match(native, /if matches!\([\s\S]*?LEFT_MOUSE_DOWN[\s\S]*?overlay_ignores_mouse_events\.load\(Ordering::Acquire\)/);
  assert.match(native, /if should_stop_on_mouse_down\([\s\S]*?outside_mouse_down_pending\s*\.store\(true, Ordering::Release\);[\s\S]*?is_outside_mouse_down: true/);
  assert.match(native, /if !state\.active\.load\(Ordering::Acquire\)[\s\S]*?outside_mouse_down_pending\.load\(Ordering::Acquire\)/);
  assert.match(native, /ignores \|\| bounds\.map_or\(true, \|b\| !point_in_bounds\(point, b\)\)/);
});

test('macOS click classifier receives live overlay bounds and updates on move or resize', () => {
  const listeners = {};
  let bounds = { x: 5, y: 10, width: 200, height: 80 };
  const window = {
    webContents: {}, isDestroyed: () => false,
    getBounds: () => bounds,
    once: (event, fn) => { listeners[event] = fn; },
    on: (event, fn) => { listeners[event] = fn; },
  };
  const published = [];
  const receiver = {
    overlayRegistrationToken: 0,
    setOverlayBoundsProvider(provider) { this.overlayBoundsProvider = provider; },
    pushBoundsToTap() { published.push(this.overlayBoundsProvider()); },
  };
  runMethod(manager, 'setOverlayWindow', { process: { platform: 'darwin' } }).call(receiver, window);
  assert.deepEqual(receiver.overlayBoundsProvider(), bounds);
  bounds = { ...bounds, x: 42 };
  listeners.move();
  bounds = { ...bounds, width: 240 };
  listeners.resize();
  assert.deepEqual(published, [{ x: 42, y: 10, width: 200, height: 80 }, bounds]);
  listeners.closed();
  assert.equal(receiver.overlayBoundsProvider, null);
});

test('native hooks intercept only plain paste in full stealth mode, after app-chord priority', () => {
  const win = read('native-module/src/keyboard_hook_windows.rs');
  const mac = read('native-module/src/keyboard_tap.rs');
  const winHook = win.slice(win.indexOf('unsafe fn keyboard_hook_inner('), win.indexOf('/// The keyboard layout of the foreground'));
  const macHook = mac.slice(mac.indexOf('fn tap_callback_inner('), mac.indexOf('fn send_payload_to_js('));
  assert.match(winHook, /state\.shortcut_only\.load\(Ordering::Acquire\)[\s\S]*?Plain Ctrl\+V is paste[\s\S]*?if \(ctrl \|\| alt\)/i);
  assert.ok(winHook.indexOf('match_app_chord(') < winHook.indexOf('paste'), 'existing app hotkeys win before paste');
  assert.match(winHook, /is_key_down && ctrl && !alt && !modifier_held\(VK_SHIFT\) && vk == 0x56/);
  assert.match(winHook, /swallowed_ups[\s\S]*?insert\(vk\)/, 'paste key-up must not reach the foreground app');
  assert.match(macHook, /event_type == 10 && key_code == 9 && \(flags & \(SYSTEM_MODIFIER_MASK \| SHIFT\)\) == CMD/);
  assert.match(macHook, /event_type == 11 && key_code == 9 && state\.paste_v_down\.swap\(false/, 'macOS must swallow matching key-up after Cmd release');
  assert.match(winHook, /LRESULT\(1\)/, 'Windows hook must swallow intercepted keystroke');
  assert.match(macHook, /ptr::null_mut\(\)/, 'macOS tap must swallow intercepted keystroke');
});
