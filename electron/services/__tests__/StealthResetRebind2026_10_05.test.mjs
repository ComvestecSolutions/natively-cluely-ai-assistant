import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');
const keybinds = ts.createSourceFile('KeybindManager.ts', read('electron/services/KeybindManager.ts'), ts.ScriptTarget.Latest, true);
const stealth = ts.createSourceFile('StealthKeyboardManager.ts', read('electron/services/StealthKeyboardManager.ts'), ts.ScriptTarget.Latest, true);

function method(source, name, scope) {
  let found;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `${name} is missing`);
  const code = found.getText(source).replace(/^(?:private|public)\s+/, '');
  const js = transformSync(`(() => { class Harness { ${code} } return Harness; })()`, { loader: 'ts', target: 'es2022' }).code;
  return vm.runInNewContext(js, scope).prototype[name];
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: live Reset rebind disables stale native R capture; restore re-enables it`, () => {
    let accelerator = 'CommandOrControl+R';
    const settings = { getKeybind: () => accelerator };
    const calls = [];
    const tap = { setResetChordEnabled: enabled => calls.push(enabled) };
    const scope = { require: () => ({ KeybindManager: { getInstance: () => settings } }), process: { platform }, console };
    const manager = { tap };
    manager.isDefaultResetChordBound = method(stealth, 'isDefaultResetChordBound', scope);
    manager.refreshResetChord = method(stealth, 'refreshResetChord', scope);
    manager.refreshResetChord();
    accelerator = 'CommandOrControl+K';
    manager.refreshResetChord();
    accelerator = '';
    manager.refreshResetChord();
    accelerator = 'R+CommandOrControl';
    manager.refreshResetChord();
    assert.deepEqual(calls, [true, false, false, true], 'native capture must track the live binding, including disabled and restored shortcuts');

    const native = { getInstance: () => manager };
    const notify = method(keybinds, 'notifyResetChordChanged', { process: { platform }, require: () => ({ StealthKeyboardManager: native }), console });
    accelerator = 'CommandOrControl+K';
    notify.call({});
    assert.equal(calls.at(-1), false, 'rebind propagates to an already-running native tap on both platforms');
  });

  test(`${platform}: persisted rebind is configured before the native hook starts`, () => {
    const calls = [];
    const settings = { getKeybind: () => 'CommandOrControl+K' };
    const scope = { require: () => ({ KeybindManager: { getInstance: () => settings } }), process: { platform }, console };
    const manager = {
      tap: {
        setResetChordEnabled(enabled) { calls.push(['capture', enabled]); },
        start(_callback, _chords, shortcutOnly) { calls.push(['start', shortcutOnly]); return true; },
      },
      overlayIgnoresMouseEvents: false,
      overlayWindow: { isDestroyed: () => false, isVisible: () => true },
      active: false,
      stopGuard() {}, broadcastState() {}, getOverlayBoundsForTap: () => null,
      getAppChordTable: () => [], hideAuxWindowsForStealth() {}, armIdleTimer() {},
      isDefaultResetChordBound: method(stealth, 'isDefaultResetChordBound', scope),
      refreshResetChord: method(stealth, 'refreshResetChord', scope),
    };
    assert.equal(method(stealth, 'start', scope).call(manager), true);
    assert.deepEqual(calls, [['capture', false], ['start', false]]);
  });
}

test('KeybindManager syncs only accepted changes to Reset, including swaps and Restore Defaults', () => {
  const updates = [];
  const sourceScope = { isClipboardEditingAccelerator: () => false, isRegisterableAccelerator: () => true, console };
  const receiver = {
    keybinds: new Map([
      ['general:reset-cancel', { id: 'general:reset-cancel', accelerator: 'CommandOrControl+R' }],
      ['chat:clarify', { id: 'chat:clarify', accelerator: 'CommandOrControl+K' }],
    ]),
    normalizeAccelerator: acc => acc.toLowerCase().split('+').sort().join('+'),
    getKeybind: id => receiver.keybinds.get(id)?.accelerator,
    save() {}, registerGlobalShortcuts() {}, broadcastUpdate() {},
    notifyResetChordChanged: () => updates.push(receiver.getKeybind('general:reset-cancel')),
  };
  const setKeybind = method(keybinds, 'setKeybind', sourceScope);
  assert.equal(setKeybind.call(receiver, 'chat:clarify', 'CommandOrControl+R'), true);
  assert.deepEqual(updates, ['CommandOrControl+K'], 'swapping another binding with Reset updates the tap');
  assert.equal(setKeybind.call(receiver, 'general:reset-cancel', 'CommandOrControl+R'), true);
  assert.deepEqual(updates, ['CommandOrControl+K', 'CommandOrControl+R']);
  assert.equal(setKeybind.call(receiver, 'no-such-action', 'CommandOrControl+Z'), false);
  assert.equal(updates.length, 2);
  const restore = method(keybinds, 'resetKeybinds', { DEFAULT_KEYBINDS: [...receiver.keybinds.values()].map(kb => ({ ...kb })), SettingsManager: { getInstance: () => ({ set() {} }) } });
  receiver.keybinds.get('general:reset-cancel').accelerator = 'CommandOrControl+K';
  restore.call(receiver);
  assert.equal(updates.at(-1), 'CommandOrControl+R');
});

test('native taps gate R on the live binding only after full-stealth gate and independently of paste', () => {
  const win = read('native-module/src/keyboard_hook_windows.rs');
  const mac = read('native-module/src/keyboard_tap.rs');
  const winHook = win.slice(win.indexOf('unsafe fn keyboard_hook_inner('), win.indexOf('/// The keyboard layout of the foreground'));
  const macHook = mac.slice(mac.indexOf('fn tap_callback_inner('), mac.indexOf('fn send_payload_to_js('));
  const winGuard = winHook.indexOf('if state.shortcut_only.load(Ordering::Acquire)');
  const winReset = winHook.indexOf('vk == 0x52');
  const winPaste = winHook.indexOf('vk == 0x56');
  assert.ok(winGuard >= 0 && winGuard < winReset && winReset < winPaste, 'Windows guard must pass Reset through before the full-stealth branch');
  assert.match(winHook.slice(winReset, winPaste), /if !state\.reset_chord_enabled\.load\(Ordering::Acquire\) \{\s*return pass\(\);/, 'unbound Windows R must pass to the foreground');
  assert.match(macHook, /key_code == 15[\s\S]{0,220}if !state\.reset_chord_enabled\.load\(Ordering::Acquire\)[\s\S]{0,130}return event;/, 'unbound macOS R must pass to the foreground');
  assert.match(win, /pub fn set_reset_chord_enabled\(&self, enabled: bool\)/);
  assert.match(mac, /pub fn set_reset_chord_enabled\(&self, enabled: bool\)/);
  assert.match(win, /reset_chord_enabled: AtomicBool::new\(false\)/, 'native capture must fail open to foreground if not configured');
  assert.match(mac, /reset_chord_enabled: AtomicBool::new\(false\)/);
  assert.match(winHook, /vk == 0x56/, 'paste remains independent on Windows');
  assert.match(macHook, /key_code == 9/, 'paste remains independent on macOS');
  const start = method(stealth, 'start', { process: { platform: 'win32' } }).toString();
  assert.ok(start.indexOf('this.refreshResetChord()') >= 0 && start.indexOf('this.refreshResetChord()') < start.indexOf('this.tap.start('), 'native binding must be set before engaging the hook');
});
