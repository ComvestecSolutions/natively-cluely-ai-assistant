import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../../SettingsWindowHelper.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

// Run the actual helper against Electron boundary doubles; process.platform in
// the VM is simulated, never mutated on the host. Native focus needs real OS QA.
function harness(platform) {
    const windows = [];
    const nativeCalls = [];
    const notifications = [];
    const timers = [];
    let now = 1000;
    let panelLeftMargin = 20;
    const workArea = { x: 0, y: 0, width: 1000, height: 800 };
    class Window extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.visible = false; this.destroyed = false;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
            this.sent = []; this.calls = [];
            this.webContents = Object.assign(new EventEmitter(), { send: (...args) => this.sent.push(args) });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        getBounds() { return { ...this.bounds }; }
        setSize(width, height) { Object.assign(this.bounds, { width, height }); }
        setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
        setParentWindow(win) { this.parent = win; }
        show() { this.calls.push('show'); this.visible = true; this.emit('show'); }
        showInactive() { this.calls.push('showInactive'); this.visible = true; this.emit('show'); }
        hide() { this.calls.push('hide'); this.visible = false; }
        focus() { this.calls.push('focus'); }
        setOpacity(value) { this.calls.push(['opacity', value]); }
        setContentProtection(value) { this.calls.push(['protection', value]); }
        setHiddenInMissionControl() {}
        setAlwaysOnTop() {}
        getNativeWindowHandle() { return 'handle'; }
        loadURL(url) { this.url = url; return Promise.resolve(); }
    }
    const overlay = new Window({ x: 100, y: 100, width: 600, height: 400 });
    overlay.visible = true;
    const module = { exports: {} };
    runInNewContext(compiled, {
        module, exports: module.exports, console, __dirname: '/test/electron',
        process: { platform, env: {} }, Date: { now: () => now },
        setTimeout: (fn) => { timers.push(fn); return fn; }, clearTimeout() {},
        require(id) {
            if (id === 'electron') return { BrowserWindow: Window, screen: { getDisplayNearestPoint: () => ({ workArea }) }, app: { isPackaged: true, getAppPath: () => '/test' } };
            if (id === 'node:path') return path;
            if (id.includes('windowsFocusPolicy')) return { attachNoActivate: () => nativeCalls.push('noActivate') };
            if (id.includes('macDockPolicy')) return { setVisibleOnAllWorkspacesKeepingDock: () => nativeCalls.push('workspaces') };
            if (id.includes('nativeModuleLoader')) return { loadNativeModule: () => ({ applyStealthToWindow: () => nativeCalls.push('stealth') }) };
            if (id.includes('StealthKeyboardManager')) return { StealthKeyboardManager: { getInstance: () => ({ stop: () => nativeCalls.push('stopTap') }) } };
            return {};
        },
    });
    const helper = new module.exports.SettingsWindowHelper();
    helper.setWindowHelper({ getMainWindow: () => overlay, getOverlayWindow: () => overlay, getOverlayPanelLeftMargin: () => panelLeftMargin, notifyOverlayPopover: (...args) => notifications.push(args) });
    return { helper, overlay, windows, workArea, nativeCalls, notifications, timers, advance: () => { now += 300; }, setPanelLeftMargin: (margin) => { panelLeftMargin = margin; } };
}

function findNode(source, predicate) {
    const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
    let found;
    const visit = (node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
    visit(ast);
    assert.ok(found, 'public IPC boundary must exist');
    return found.getText(ast);
}

test('actual toggle IPC validates panel and coordinate payloads before calling helper', () => {
    const source = readFileSync(new URL('../../ipcHandlers.ts', import.meta.url), 'utf8');
    const block = findNode(source, (node) => ts.isCallExpression(node) && node.expression.getText() === 'safeHandle' && node.arguments[0]?.text === 'toggle-settings-window');
    const calls = [];
    let toggle;
    const code = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { Error, Number, safeHandle: (_, callback) => { toggle = callback; }, appState: { settingsWindowHelper: { toggleWindow: (...args) => calls.push(args) } } });
    toggle({});
    toggle({}, { x: 30, y: 50, panel: 'courses' });
    toggle({}, { x: 60, y: 50, panel: 'modes' });
        assert.deepEqual(calls, [[undefined, undefined, 'settings'], [30, 50, 'courses'], [60, 50, 'modes']]);
    for (const payload of [null, [], 'courses', { panel: 'launcher' }, { panel: false }, { x: NaN, y: 5 }, { x: 4 }, { x: '4', y: 5 }]) {
        assert.throws(() => toggle({}, payload), /Invalid popup/);
    }
    assert.equal(calls.length, 3, 'invalid requests cannot mutate helper state');
});

test('actual preload forwards shown/visibility panel identity and exposes reload state and close IPC', () => {
    const source = readFileSync(new URL('../../preload.ts', import.meta.url), 'utf8');
    const ipcRenderer = new EventEmitter();
    const invokes = [];
    ipcRenderer.invoke = async (...args) => { invokes.push(args); };
    const load = (name) => {
        const code = findNode(source, (node) => ts.isPropertyAssignment(node) && node.name.getText() === name);
        const compiled = ts.transpileModule(`module.exports = ({ ${code} }).${name}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const module = { exports: {} };
        runInNewContext(compiled, { module, ipcRenderer });
        return module.exports;
    };
    const shown = []; const visibility = []; const capacities = [];
    const offBudget = load('onSettingsPopupHeightBudget')((height) => capacities.push(height));
    ipcRenderer.emit('settings-popup-height-budget', {}, 92);
    assert.deepEqual(capacities, [92]);
    offBudget();
    assert.equal(ipcRenderer.listenerCount('settings-popup-height-budget'), 0);
    const offShown = load('onSettingsWindowShown')((panel) => shown.push(panel));
    const offVisibility = load('onSettingsVisibilityChange')((...args) => visibility.push(args));
    ipcRenderer.emit('settings-window-shown', {}, 'courses');
    ipcRenderer.emit('settings-visibility-changed', {}, true, 'courses');
    assert.deepEqual(shown, ['courses']);
    assert.deepEqual(visibility, [[true, 'courses']]);
        ipcRenderer.emit('settings-window-shown', {}, 'modes');
        ipcRenderer.emit('settings-visibility-changed', {}, true, 'modes');
        assert.deepEqual(shown, ['courses', 'modes']);
        assert.deepEqual(visibility, [[true, 'courses'], [true, 'modes']]);
    offShown(); offVisibility();
    assert.equal(ipcRenderer.listenerCount('settings-window-shown') + ipcRenderer.listenerCount('settings-visibility-changed'), 0);
    load('getSettingsPopupState')(); load('closeSettingsWindow')();
    assert.deepEqual(invokes, [['get-settings-popup-state'], ['close-settings-window']]);
});

for (const platform of ['darwin', 'win32']) {
    test(`${platform}: modes prewarm, reload, three-panel transitions and same-icon toggle reuse one popup`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        h.helper.toggleWindow(300, 508, 'modes');
        assert.equal(h.helper.getPopupState().panel, 'modes');
        assert.deepEqual(h.notifications.at(-1), ['settings', true]);
        popup.emit('ready-to-show');
        popup.webContents.emit('did-finish-load');
        assert.deepEqual(popup.sent.at(-1), ['settings-window-shown', 'modes']);
        for (const panel of ['courses', 'settings', 'modes']) {
            h.helper.toggleWindow(330, 508, panel);
            assert.equal(popup.isVisible(), true);
            assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', true, panel]);
        }
        assert.equal(h.windows.length, 2);
        assert.equal(popup.calls.includes('hide'), false);
        h.helper.toggleWindow(330, 508, 'modes');
        assert.equal(popup.isVisible(), false);
        assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', false, 'modes']);
        assert.ok(h.nativeCalls.includes('noActivate'));
        if (platform === 'darwin') assert.ok(h.nativeCalls.includes('stealth'));
    });

    test(`${platform}: modes height budgets follow the anchor and do not constrain quick settings`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        Object.assign(h.overlay.bounds, { y: 292 });
        h.helper.toggleWindow(300, 700, 'modes');
        h.helper.setWindowDimensions(popup, 180, 1000);
        assert.equal(popup.bounds.y, 700);
        assert.equal(popup.bounds.height, 92);
        assert.equal(h.helper.getPopupState().heightBudget, 92);
        Object.assign(h.overlay.bounds, { y: 100 });
        h.helper.repositionForOverlay(h.overlay.getBounds(), 20);
        assert.equal(h.helper.getPopupState().heightBudget, 284);
        h.helper.setWindowDimensions(popup, 180, 330);
        assert.equal(popup.bounds.height, 284);
        h.helper.toggleWindow(300, 508, 'settings');
        h.helper.setWindowDimensions(popup, 180, 500);
        assert.equal(popup.bounds.height, 500);
        h.helper.toggleWindow(300, 508, 'modes');
        Object.assign(h.workArea, { height: 64 });
        h.helper.repositionForOverlay(h.overlay.getBounds(), 20);
        assert.equal(h.helper.getPopupState().heightBudget, 64);
        assert.equal(popup.bounds.height, 64);
    });

    test(`${platform}: modes dismissal before prewarm-ready cannot resurrect; blur and inactive focus policy stay intact`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        h.helper.toggleWindow(300, 508, 'modes');
        const source = readFileSync(new URL('../../WindowHelper.ts', import.meta.url), 'utf8');
        const method = findNode(source, (node) => ts.isMethodDeclaration(node) && node.name.getText() === 'dismissOverlayPopovers');
        const module = { exports: {} };
        const code = ts.transpileModule(`class DismissalBoundary { appState; ${method} }; module.exports = DismissalBoundary;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        runInNewContext(code, { module });
        const boundary = new module.exports();
        boundary.appState = { settingsWindowHelper: h.helper };
        boundary.dismissOverlayPopovers({ settings: true, model: false });
        popup.emit('ready-to-show');
        assert.equal(popup.isVisible(), false);
        assert.deepEqual(h.notifications.at(-1), ['settings', false]);
        h.helper.toggleWindow(300, 508, 'modes');
        popup.emit('blur');
        h.helper.toggleWindow(300, 508, 'modes');
        assert.equal(popup.isVisible(), false);
        h.helper.toggleWindow(330, 508, 'courses');
        assert.equal(popup.isVisible(), true);
        h.helper.toggleWindow(300, 508, 'modes');
        h.helper.setContentProtection(true);
        h.helper.closeWindow();
        popup.calls.length = 0;
        h.helper.showWindow(300, 508, { activate: false });
        if (platform === 'win32') h.timers.at(-1)();
        assert.ok(popup.calls.includes('showInactive'));
        assert.equal(popup.calls.includes('focus'), false);
    });

    test(`${platform}: long courses stay below chat when usable room exists and budget is reported`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        h.helper.setWindowDimensions(popup, 180, 330);
        Object.assign(h.overlay.bounds, { y: 292 }); // Chat bottom 692; popup anchor includes GAP=8.
        h.helper.toggleWindow(300, 700, 'courses');
        assert.equal(popup.bounds.y, 700, 'do not move a long course list up over the chat');
        assert.equal(popup.bounds.height, 92, 'use the room below the anchor, leaving an 8px screen margin');
        assert.equal(h.helper.getPopupState().heightBudget, 92);
        assert.ok(popup.sent.some(([channel, capacity]) => channel === 'settings-popup-height-budget' && capacity === 92));
        h.helper.setWindowDimensions(popup, 180, 1000);
        assert.equal(popup.bounds.y, 700);
        assert.equal(popup.bounds.height, 92, 'late/oversized renderer reports cannot defeat the budget');
    });

    test(`${platform}: no usable room falls back to a clamped whole course popup with a scroll capacity`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        Object.assign(h.overlay.bounds, { y: 372 });
        h.helper.toggleWindow(300, 780, 'courses');
        h.helper.setWindowDimensions(popup, 180, 330);
        assert.equal(popup.bounds.y, 470);
        assert.equal(popup.bounds.height, 330);
        assert.equal(h.helper.getPopupState().heightBudget, 330);
        popup.emit('ready-to-show');
        assert.equal(h.helper.getPopupState().heightBudget, 330, 'prewarm ready must budget from the intended anchor, not the fallback-clamped top');
        Object.assign(h.workArea, { height: 64 });
        h.helper.repositionForOverlay(h.overlay.getBounds(), 20);
        assert.equal(h.helper.getPopupState().heightBudget, 64, 'tiny displays must shrink the renderer scroll viewport too');
        h.helper.setWindowDimensions(popup, 180, 330);
        assert.equal(popup.bounds.y, 0);
        assert.equal(popup.bounds.height, 64);
    });

    test(`${platform}: courses opened before prewarm ready report the panel and arm the existing catcher`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        h.helper.toggleWindow(300, 508, 'courses');
        assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', true, 'courses']);
        assert.deepEqual(h.notifications.at(-1), ['settings', true]);
        const source = readFileSync(new URL('../../WindowHelper.ts', import.meta.url), 'utf8');
        const method = findNode(source, (node) => ts.isMethodDeclaration(node) && node.name.getText() === 'dismissOverlayPopovers');
        const module = { exports: {} };
        const code = ts.transpileModule(`class DismissalBoundary { appState; ${method} }; module.exports = DismissalBoundary;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        runInNewContext(code, { module });
        const boundary = new module.exports();
        boundary.appState = { settingsWindowHelper: h.helper };
        boundary.dismissOverlayPopovers({ settings: true, model: false });
        assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', false, 'courses']);
        assert.deepEqual(h.notifications.at(-1), ['settings', false]);
        popup.emit('ready-to-show');
        assert.equal(popup.isVisible(), false, 'outside dismissal before ready cannot resurrect the popup');
        h.helper.toggleWindow(300, 508, 'courses');
        assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', true, 'courses']);
    });

    test(`${platform}: courses/settings switch in the actual prewarmed window; same icon closes`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        popup.emit('ready-to-show');
        h.helper.toggleWindow(300, 508, 'courses');
        assert.equal(popup.isVisible(), true);
        assert.equal(popup.sent.at(-1)[1], 'courses');
        assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', true, 'courses']);
        h.helper.toggleWindow(330, 508, 'settings');
        assert.equal(popup.isVisible(), true);
        assert.equal(popup.calls.includes('hide'), false);
        assert.equal(popup.sent.at(-1)[1], 'settings');
        assert.equal(h.windows.length, 2, 'one overlay and the one shared popup');
        h.helper.toggleWindow(330, 508, 'settings');
        assert.equal(popup.isVisible(), false);
        h.helper.toggleWindow(300, 508, 'courses');
        assert.equal(popup.sent.at(-1)[1], 'courses');
    });

    test(`${platform}: cold open survives renderer reload; cancelling before ready never resurrects it`, () => {
        const h = harness(platform);
        h.helper.toggleWindow(300, 508, 'courses');
        const popup = h.helper.getSettingsWindow();
        assert.equal(h.helper.getPopupState().panel, 'courses');
        h.helper.toggleWindow(300, 508, 'courses');
        popup.emit('ready-to-show');
        assert.equal(popup.isVisible(), false);
        h.helper.toggleWindow(300, 508, 'courses');
        popup.webContents.emit('did-finish-load');
        assert.deepEqual(popup.sent.at(-1), ['settings-window-shown', 'courses']);
        assert.equal(h.helper.getPopupState().isVisible, true);
        popup.emit('closed');
        assert.equal(h.helper.getPopupState().isVisible, false);
    });

    test(`${platform}: overlay anchor follows panel moves with GAP=8 and hugs/clamps dimensions`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        h.helper.setWindowDimensions(popup, 180, 120);
        assert.equal(popup.bounds.x, -10000, 'hidden prewarm remains offscreen');
        h.helper.toggleWindow(300, 508, 'courses');
        assert.deepEqual(popup.getBounds(), { x: 300, y: 508, width: 180, height: 120 });
        assert.ok(popup.calls.includes('show'), 'preserve the existing SettingsWindowHelper activation policy');
        popup.calls.length = 0;
        h.helper.showWindow(300, 508, { activate: false });
        assert.ok(popup.calls.includes('showInactive'));
        assert.equal(popup.calls.includes('focus'), false, 'explicit inactive restore never focuses');
        Object.assign(h.overlay.bounds, { x: 200, y: 120, width: 600, height: 400 });
        h.setPanelLeftMargin(40);
        h.helper.repositionForOverlay(h.overlay.getBounds(), 40);
        assert.equal(popup.bounds.x, 420);
        assert.equal(popup.bounds.y, 528);
        h.helper.setWindowDimensions(popup, 180.2, 320.2);
        assert.equal(popup.bounds.width, 181);
        assert.equal(popup.bounds.height, 264, 'room below the moved panel minus the screen margin');
        assert.equal(popup.bounds.y, 528, 'long lists stay below the panel, rather than overlapping it');
        assert.equal(popup.bounds.x, 420);
        h.helper.toggleWindow(-90, -50, 'settings');
        assert.equal(popup.bounds.x, 0, 'screen left clamp');
        assert.equal(popup.bounds.y, 0, 'screen top clamp');
        h.helper.setWindowDimensions(popup, 5000, 5000);
        assert.deepEqual(popup.getBounds(), { x: 0, y: 0, width: 1000, height: 800 });
        h.helper.setWindowDimensions(popup, NaN, -1);
        assert.equal(popup.bounds.height, 800, 'invalid sizes are ignored');
    });

    test(`${platform}: the existing outside-click dismissal closes the courses variant`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        h.helper.toggleWindow(300, 508, 'courses');
        const source = readFileSync(new URL('../../WindowHelper.ts', import.meta.url), 'utf8');
        const method = findNode(source, (node) => ts.isMethodDeclaration(node) && node.name.getText() === 'dismissOverlayPopovers');
        const module = { exports: {} };
        const code = ts.transpileModule(`class DismissalBoundary { appState; ${method} }; module.exports = DismissalBoundary;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        runInNewContext(code, { module });
        const boundary = new module.exports();
        boundary.appState = { settingsWindowHelper: h.helper };
        boundary.dismissOverlayPopovers({ settings: true, model: false });
        assert.equal(h.helper.getSettingsWindow().isVisible(), false);
        assert.deepEqual(h.overlay.sent.at(-1), ['settings-visibility-changed', false, 'courses']);
        assert.deepEqual(h.notifications.at(-1), ['settings', false]);
    });

    test(`${platform}: clamping respects a monitor with a negative/non-zero work-area origin`, () => {
        const h = harness(platform);
        Object.assign(h.workArea, { x: -1280, y: -500, width: 1280, height: 900 });
        h.helper.preloadWindow();
        h.helper.toggleWindow(-700.6, -100.4, 'courses');
        const popup = h.helper.getSettingsWindow();
        assert.equal(popup.bounds.x, -701);
        assert.equal(popup.bounds.y, -100);
        h.helper.toggleWindow(-1400, -600, 'settings');
        assert.equal(popup.bounds.x, -1280);
        assert.equal(popup.bounds.y, -500);
        h.helper.toggleWindow(-20, 380, 'courses');
        assert.equal(popup.bounds.x, -180);
        assert.equal(popup.bounds.y, 168);
    });

    test(`${platform}: outside blur dismisses catcher; other panel can open during blur guard`, () => {
        const h = harness(platform);
        h.helper.preloadWindow();
        const popup = h.helper.getSettingsWindow();
        popup.emit('ready-to-show');
        h.helper.toggleWindow(300, 508, 'courses');
        popup.emit('blur');
        assert.equal(popup.isVisible(), false);
        assert.deepEqual(h.notifications.at(-1), ['settings', false]);
        h.helper.toggleWindow(300, 508, 'courses');
        assert.equal(popup.isVisible(), false, 'same-icon blur must not immediately reopen');
        h.helper.toggleWindow(330, 508, 'settings');
        assert.equal(popup.isVisible(), true, 'other icon must switch, not be swallowed by blur guard');
        assert.equal(popup.sent.at(-1)[1], 'settings');
        if (platform === 'darwin') {
            assert.equal(popup.options.type, 'panel');
            assert.ok(h.nativeCalls.includes('stealth'));
            assert.ok(h.nativeCalls.includes('workspaces'));
            assert.ok(h.nativeCalls.includes('stopTap'));
        } else {
            assert.equal(popup.options.type, undefined);
            h.helper.setContentProtection(true);
            h.helper.closeWindow();
            popup.calls.length = 0;
            h.helper.showWindow(330, 508, { activate: false });
            assert.ok(popup.calls.some((call) => Array.isArray(call) && call[0] === 'opacity' && call[1] === 0));
            h.timers.at(-1)();
            assert.equal(popup.calls.includes('focus'), false);
        }
    });
}
