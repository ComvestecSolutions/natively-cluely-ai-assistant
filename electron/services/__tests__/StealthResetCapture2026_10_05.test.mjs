import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const windows = readFileSync(new URL('../../../native-module/src/keyboard_hook_windows.rs', import.meta.url), 'utf8');
const mac = readFileSync(new URL('../../../native-module/src/keyboard_tap.rs', import.meta.url), 'utf8');
const winHook = windows.slice(windows.indexOf('unsafe fn keyboard_hook_inner('), windows.indexOf('/// The keyboard layout of the foreground'));
const macHook = mac.slice(mac.indexOf('fn tap_callback_inner('), mac.indexOf('fn send_payload_to_js('));

// These native boundaries cannot be invoked from Node on both OSes. The mounted
// renderer test exercises the delivered payload; these pin the interception
// gates that decide whether the foreground app receives its refresh shortcut.
test('Windows intercepts only engaged plain Ctrl+R, never the shortcut-only guard or AltGr', () => {
  const fullMode = winHook.indexOf('if state.shortcut_only.load(Ordering::Acquire)');
  const reset = winHook.indexOf('vk == 0x52');
  const passthrough = winHook.indexOf('if (ctrl || alt) && !altgr');
  assert.ok(fullMode >= 0 && fullMode < reset && reset < passthrough, 'reset belongs only to full stealth typing');
  assert.match(winHook, /is_key_down && ctrl && !alt && !modifier_held\(VK_SHIFT\) && vk == 0x52/);
  assert.match(winHook.slice(reset, passthrough), /key_code: 15[\s\S]*?flags: 1 << 18[\s\S]*?swallowed_ups[\s\S]*?insert\(vk\)/);
  assert.match(winHook, /if is_key_up \{[\s\S]*?ups\.remove\(&vk\)/, 'swallow matching key-up after Ctrl is released');
});

test('macOS intercepts only engaged plain Cmd+R and swallows its matching key-up', () => {
  const active = macHook.indexOf('if !state.active.load(Ordering::Acquire)');
  const reset = macHook.indexOf('key_code == 15');
  const passthrough = macHook.indexOf('if (flags & SYSTEM_MODIFIER_MASK) != 0');
  assert.ok(active >= 0 && active < reset && reset < passthrough, 'inactive tap must pass refresh through');
  assert.match(macHook, /event_type == 10 && key_code == 15 && \(flags & \(SYSTEM_MODIFIER_MASK \| SHIFT\)\) == CMD/);
  assert.match(macHook, /event_type == 11 && key_code == 15 && state\.reset_r_down\.swap\(false/);
  assert.match(macHook.slice(reset, passthrough), /key_code: 15[\s\S]*?flags: CMD[\s\S]*?return ptr::null_mut\(\)/);
});
