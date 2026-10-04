import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const component = readFileSync(new URL('../courses/CoursePinBar.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../NativelyInterface.tsx', import.meta.url), 'utf8');
const parse = (source) => ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const walk = (node, predicate, found = []) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, (child) => { walk(child, predicate, found); });
    return found;
};

test('one Courses control is owned by the chat shell toolbar, beside model and settings', () => {
    const ast = parse(chat);
    const controls = walk(ast, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'CoursePinBar');
    assert.equal(controls.length, 1);
    const control = controls[0];
    assert.match(control.getText(ast), /panelRef=\{shellRef\}/);
    assert.match(control.getText(ast), /surfaceStyle=\{appearance.shellStyle\}/);
    assert.match(control.getText(ast), /controlStyle=\{appearance.controlStyle\}/);
    let parent = control.parent;
    let toolbar;
    let shell;
    while (parent) {
        if (ts.isJsxElement(parent)) {
            const opening = parent.openingElement.getText(ast);
            if (opening.includes('data-shell-card')) shell = parent;
            else if (!shell) assert.doesNotMatch(opening, /overflow-(?:hidden|clip|auto|scroll)/, 'no intervening composer/toolbar clipping ancestor');
            const text = parent.getText(ast);
            if (!toolbar && text.includes('data-model-selector-toggle') && text.includes('data-settings-toggle')) toolbar = parent;
        }
        parent = parent.parent;
    }
    assert.ok(shell, 'the control must not be outside the chat card');
    assert.ok(toolbar && toolbar !== shell, 'both neighbor buttons must be in the same local toolbar');
    assert.ok(control.pos > chat.indexOf('<DynamicActionBar'), 'no standalone courses row above actions/transcript');
});

test('uses quick-settings material and compact switches, without importing a window lifecycle', () => {
    for (const token of ['overlay-shell-surface overlay-popover-surface', 't-toggle t-toggle-sm', 't-toggle-thumb', 'glass-popup-row', 'glass-toggle-track', 'h-[30px]', 'rounded-[14px]']) {
        assert.ok(component.includes(token), token);
    }
    assert.doesNotMatch(component, /SettingsPopup|BrowserWindow|createPortal|toggleSettingsWindow|updateContentDimensions|setFocusable|setIgnoreMouseEvents/);
    assert.doesNotMatch(component, /\btitle\s*=/, 'no native tooltip surfaces on protected overlays');
});

test('course rows are keyboard-operable whole-row switches with confirmed grounding state', () => {
    assert.match(component, /role="switch"[\s\S]*?aria-checked=\{checked\}/);
    assert.match(component, /const checked = isCourseGroundingEnabled\(course, pins\)/);
    assert.match(component, /const enabled = !isCourseGroundingEnabled\(course, getCoursePinIds\(\)\)/);
    assert.match(component, /await setCourseGroundingEnabled\(course.id, enabled\)/);
    assert.match(component, /pendingIds.current.has\(course.id\)/);
    assert.match(component, /disabled=\{busy \|\| loading\}/);
    assert.match(component, /className="relative inline-flex no-drag/);
    assert.match(component, /aria-haspopup="dialog"/);
    assert.match(component, /const menuId = useId\(\)/, 'multiple mounted consumers need distinct IDs');
    assert.doesNotMatch(component, /type="checkbox"|setCoursePinIds/, 'no pin-only switches');
});

test('opening refreshes, empty/error states remain actionable, and subscriptions are disposed', () => {
    assert.match(component, /if \(open\) void refresh\(\)/);
    assert.match(component, /subscribeCourseStateChanged\(\(\) => \{ void refresh\(\); \}\)/);
    assert.match(component, /unsubscribe\(\)/);
    assert.match(component, /generation !== request.current/);
    assert.match(component, /role="alert"/);
    assert.match(component, /data-course-retry="true"/);
    assert.match(component, /No courses yet\. Import a course in Courses Studio in the launcher\./);
    assert.doesNotMatch(component, /return null/, 'the toolbar trigger must survive empty/unavailable courses');
});

test('Escape restores focus, ArrowDown enters rows, outside pointer/focus closes, with symmetric cleanup', () => {
    assert.match(component, /event.key !== 'Escape'[\s\S]*?event.stopPropagation\(\)[\s\S]*?chipRef.current\?\.focus\(\)/);
    assert.match(component, /event.key !== 'ArrowDown'/);
    assert.match(component, /querySelector<HTMLElement>\('\[role="switch"\], \[data-course-retry\]'\)\?\.focus\(\)/);
    for (const [event, callback, capture] of [
        ['pointerdown', 'outside', ', true'], ['focusin', 'outside', ''], ['keydown', 'onKeyDown', ', true'],
        ['scroll', 'place', ', true'], ['resize', 'place', ''], ['focus', 'onFocus', ''],
    ]) {
        assert.ok(component.includes(`addEventListener('${event}', ${callback}${capture})`));
        assert.ok(component.includes(`removeEventListener('${event}', ${callback}${capture})`));
    }
    assert.match(component, /observer.disconnect\(\)/);
});

// Execute the actual placement callback with measured DOM rectangles, rather
// than reimplementing its math in the test. This is simulated layout, not native UI.
const ast = parse(component);
const placeNode = walk(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'place')[0];
assert.ok(placeNode);
const placementCode = ts.transpileModule(`const ${placeNode.getText(ast)}; place();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const scenario of [
    { name: 'regular chat, long list', panel: [40, 50, 600, 500], anchor: [290, 500, 110, 28], scrollHeight: 2000 },
    { name: 'minimum-height chat', panel: [40, 50, 600, 140], anchor: [290, 148, 110, 28], scrollHeight: 400 },
    { name: 'narrow chat', panel: [20, 20, 240, 180], anchor: [175, 150, 65, 28], scrollHeight: 200 },
    { name: 'short list stays near trigger', panel: [40, 50, 600, 500], anchor: [290, 500, 110, 28], scrollHeight: 90 },
    { name: 'scaled card', panel: [40, 50, 588, 490], anchor: [285, 490, 107.8, 27.44], scrollHeight: 400, scale: 0.98 },
    { name: 'panel partly outside viewport', panel: [-30, -20, 600, 500], anchor: [220, 420, 110, 28], scrollHeight: 400 },
]) {
    test(`popover stays inside panel/native viewport: ${scenario.name}`, () => {
        const rect = ([left, top, width, height]) => ({ left, top, width, height, right: left + width, bottom: top + height });
        const bounds = rect(scenario.panel);
        const anchor = rect(scenario.anchor);
        const scale = scenario.scale ?? 1;
        let position;
        runInNewContext(placementCode, {
            panel: { getBoundingClientRect: () => bounds, offsetWidth: bounds.width / scale },
            root: { getBoundingClientRect: () => anchor },
            popover: { scrollHeight: scenario.scrollHeight },
            window: { innerWidth: 800, innerHeight: 600 },
            setPosition: (update) => { position = update(null); },
        });
        const left = anchor.left + position.left * scale;
        const top = anchor.top + position.top * scale;
        const height = Math.min(position.maxHeight, scenario.scrollHeight + 2) * scale;
        const epsilon = 0.001;
        assert.ok(left >= Math.max(0, bounds.left) + 8 - epsilon);
        assert.ok(left + position.width * scale <= Math.min(800, bounds.right) - 8 + epsilon);
        assert.ok(top >= Math.max(0, bounds.top) + 8 - epsilon);
        assert.ok(top + height <= Math.min(600, bounds.bottom) - 8 + epsilon);
        if (scenario.name === 'short list stays near trigger') assert.equal(top + height, anchor.top - 6);
    });
}
