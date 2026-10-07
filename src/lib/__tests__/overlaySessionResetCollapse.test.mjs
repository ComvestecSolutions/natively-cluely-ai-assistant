// Regression test for the "stale expanded overlay on meeting restart" bug.
//
// Symptom: the overlay BrowserWindow/renderer is reused across meetings (never
// destroyed). On Stop→Start, the overlay briefly showed the PREVIOUS meeting's
// expanded coding/answer view at its wide shell width, then "refreshed" to the
// clean collapsed state a second or two later.
//
// Root cause: the `onSessionReset` handler in NativelyInterface cleared
// `messages` but never collapsed the code-width expansion. The shell only
// contracted later via the deferred checkCodeVisibility chain (rAF → 120ms
// stability gate → 0.7s spring), so the old wide frame was painted on the
// first frame of the new meeting.
//
// Fix: onSessionReset now snaps the code-width state back to the collapsed
// baseline SYNCHRONOUSLY — stops any in-flight width animation, clears
// codeExpandedRef + the visibility timers, and does an imperative
// `shellWidth.set(SHELL_WIDTH_COLLAPSED)` (not animate, so no transient wide
// frame). It deliberately does NOT touch isExpanded (the vertical
// content-shown flag), whose mounted default is correct for a fresh meeting
// and whose setter would trigger hideWindow().
//
// Strategy: source-contract assertions against the onSessionReset handler in
// NativelyInterface.tsx. The reset is component-internal state manipulation
// (motion values + refs), not a pure function, so a behavioural test would
// need a full React/DOM harness. These structural assertions pin the
// load-bearing reset lines so a future refactor that drops the collapse fails
// CI loudly — the gap that let this regress silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../../components/NativelyInterface.tsx');
const source = readFileSync(sourcePath, 'utf8');

// Locate the subscription as a call expression, then keep only statements
// after the early-return chat-reset guards. Braces in comments or nested
// callbacks must not affect the meeting-only branch these tests protect.
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNodes(predicate) {
  const matches = [];
  const visit = node => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}
const subscriptions = findNodes(node => ts.isCallExpression(node) && node.expression.getText(file) === 'window.electronAPI.onSessionReset');
assert.equal(subscriptions.length, 1, 'expected exactly one onSessionReset subscription');
const handler = subscriptions[0].arguments[0];
assert.ok(ts.isArrowFunction(handler) && ts.isBlock(handler.body), 'onSessionReset must have a block callback');
const statements = handler.body.statements;
const completeIndex = statements.findIndex(node => ts.isIfStatement(node) && /\.phase\s*===\s*['"]complete['"]/.test(node.expression.getText(file)));
const explicitIndex = statements.findIndex(node => ts.isIfStatement(node) && /\.preserveWindowSize\b/.test(node.expression.getText(file)));
assert.ok(completeIndex >= 0 && explicitIndex > completeIndex, 'completion and explicit reset must be handled before meeting teardown');
for (const index of [completeIndex, explicitIndex]) {
  const branch = statements[index].thenStatement;
  assert.ok(ts.isBlock(branch) && ts.isReturnStatement(branch.statements.at(-1)), 'non-meeting reset must return before collapsing the meeting layout');
}
const explicitBody = statements[explicitIndex].thenStatement.getText(file);
const meetingBody = statements.slice(explicitIndex + 1).map(node => node.getText(file)).join('\n');
assert.match(meetingBody, /resetChatStateRef\.current\(\)/, 'meeting reset must clear the reused chat tree');

// Strip line comments so assertions match on actual code, not on the
// explanatory comments (which intentionally mention strings like
// `setIsExpanded(false)` to document why we DON'T call them).
function stripLineComments(s) {
  return s
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const body = stripLineComments(meetingBody);

test('explicit chat reset exits before meeting width/height teardown and pins the existing height', () => {
  assert.match(explicitBody, /resetChatStateRef\.current\(true\)/, 'explicit reset must clear chat while preserving its window envelope');
  assert.doesNotMatch(stripLineComments(explicitBody), /(?:shellWidth\.set|setCustomWindowWidth|setAppliedWindowWidth|customOverlayHeightRef\.current\s*=\s*null)/,
    'explicit reset must not run the meeting-only size reset');
  const resetDeclarations = findNodes(node => ts.isVariableDeclaration(node) && node.name.getText(file) === 'resetChatState');
  assert.equal(resetDeclarations.length, 1, 'expected exactly one resetChatState implementation');
  const reset = resetDeclarations[0].initializer;
  assert.ok(ts.isCallExpression(reset) && ts.isArrowFunction(reset.arguments[0]) && ts.isBlock(reset.arguments[0].body));
  const sizeGuard = reset.arguments[0].body.statements.find(node => ts.isIfStatement(node) && /preserveWindowSize/.test(node.expression.getText(file)));
  assert.ok(sizeGuard && ts.isBlock(sizeGuard.thenStatement), 'chat clear must guard the existing-height pin');
  const pin = stripLineComments(sizeGuard.thenStatement.getText(file));
  assert.match(pin, /customOverlayHeightRef\.current\s*=\s*window\.innerHeight/);
  assert.match(pin, /setHeightPinned\(true\)/);
  assert.doesNotMatch(pin, /setCustomWindowWidth|setAppliedWindowWidth/);
});

test('meeting reset releases the previous meeting’s manual size pins', () => {
  assert.match(body, /customOverlayHeightRef\.current\s*=\s*null/);
  assert.match(body, /setHeightPinned\(false\)/);
  assert.match(body, /setCustomWindowWidth\(null\)/);
  assert.match(body, /setAppliedWindowWidth\(null\)/);
});

test('onSessionReset snaps shellWidth back to the collapsed baseline (imperative set, not animate)', () => {
  assert.ok(
    // Either the render's collapsed width or the DEFAULT collapsed width — the
    // latter since the reset also forgets a width pinned in the previous
    // meeting, which SHELL_WIDTH_COLLAPSED would still reflect.
    //
    // defaultCollapsedPanelWidth() is the current spelling of that default. It
    // replaced a bare collapsedWidthFor(OVERLAY_DEFAULT_WINDOW_WIDTH) when the
    // panel gained its transparent gutter: the panel is now inset from the
    // window on every side, so the WINDOW width is no longer the panel's
    // expanded width and feeding it to collapsedWidthFor left the reset paths
    // 10px wider than the SHELL_WIDTH_COLLAPSED every other path derived.
    //
    // defaultCollapsedForRowRef.current (2026-09-27) is that same default,
    // widened for the measured quick-action row, so a new meeting in a
    // language with long chip labels does not open with Answer wrapped. It is
    // a ref because onSessionReset is a long-lived subscription.
    /shellWidth\.set\(\s*(?:SHELL_WIDTH_COLLAPSED|defaultCollapsedPanelWidth\(\s*\)|defaultCollapsedForRowRef\.current|collapsedWidthFor\(\s*OVERLAY_DEFAULT_WINDOW_WIDTH\s*\))\s*\)/.test(body),
    'BUG: meeting reset must imperatively collapse the shell on the first paint — otherwise the previous meeting\'s expanded panel is shown until the deferred checkCodeVisibility collapse fires ~1-2s later.',
  );
  // Must be an imperative set, NOT an animate() (which would play a visible
  // wide→narrow tween on meeting start).
  assert.ok(
    !/animate\(\s*shellWidth\s*,\s*SHELL_WIDTH_COLLAPSED/.test(body),
    'BUG: the reset must use shellWidth.set() (instant), not animate(shellWidth, SHELL_WIDTH_COLLAPSED) which plays a transient wide frame.',
  );
});

test('onSessionReset clears the code-expansion ref so the next visibility scan starts collapsed', () => {
  assert.ok(
    /codeExpandedRef\.current\s*=\s*false/.test(body),
    'BUG: onSessionReset must reset codeExpandedRef.current = false — otherwise checkCodeVisibility believes the shell is still expanded and may not contract, and a stale expansion can re-fire.',
  );
});

test('onSessionReset stops any in-flight width animation and clears the deferred visibility machinery', () => {
  assert.ok(
    /animationControlsRef\.current\s*\.stop\(\)/.test(body) || /animationControlsRef\.current\?\.stop\(\)/.test(body),
    'BUG: onSessionReset must stop any in-flight shell-width animation (animationControlsRef.current.stop()) so a previous meeting\'s expansion tween cannot keep driving the width after reset.',
  );
  assert.ok(
    /clearTimeout\(\s*stableVisibilityTimerRef\.current\s*\)/.test(body),
    'BUG: onSessionReset must clear stableVisibilityTimerRef — a pending stability-gate timer from the old meeting could otherwise fire a stale expansion after reset.',
  );
  assert.ok(
    /pendingVisibilityRef\.current\s*=\s*null/.test(body),
    'BUG: onSessionReset must null pendingVisibilityRef so no stale pending visibility change survives into the new meeting.',
  );
});

test('onSessionReset does NOT call setIsExpanded(false) (would hide the just-started overlay)', () => {
  // isExpanded is the vertical content-shown flag; its mounted default (true)
  // is correct for a fresh meeting, and setIsExpanded(false) triggers
  // hideWindow() via the [isExpanded] effect. The stale "expanded" the user
  // saw was the code-WIDTH expansion, fixed above — not isExpanded.
  assert.ok(
    !/setIsExpanded\(\s*false\s*\)/.test(body),
    'BUG: onSessionReset must NOT call setIsExpanded(false) — that hides the overlay window of a meeting that just started. Collapse the code-width state (shellWidth/codeExpandedRef) instead.',
  );
});
