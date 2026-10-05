import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import ts from 'typescript';
import { abortAndInvalidateChatStreams } from '../../../electron/services/chatStreamRegistry.ts';

const compile = (source) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;
const picker = compile(readFileSync(new URL('../modes/ModePicker.tsx', import.meta.url), 'utf8'));
const parse = (url) => ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, url.pathname.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const ipcAst = parse(new URL('../../../electron/ipcHandlers.ts', import.meta.url));
const preloadAst = parse(new URL('../../../electron/preload.ts', import.meta.url));
function find(ast, predicate) {
    let found;
    const visit = (node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
    visit(ast); assert.ok(found, 'actual implementation exists'); return found;
}
const handlerSource = (channel) => find(ipcAst, (node) => ts.isCallExpression(node)
    && node.expression.getText(ipcAst) === 'safeHandle' && node.arguments[0]?.text === channel).arguments[1].getText(ipcAst);
const preloadSource = (name) => find(preloadAst, (node) => ts.isPropertyAssignment(node) && node.name.getText(preloadAst) === name).getText(preloadAst);
const evaluate = (source, context) => {
    const module = { exports: {} };
    runInNewContext(compile(`module.exports = ${source}`), { module, ...context });
    return module.exports;
};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const modeList = [
    { id: 'a', name: 'General', templateType: 'general', isBuiltin: true },
    { id: 'b', name: 'Technical Interview', templateType: 'technical-interview', isBuiltin: true },
    { id: 'c', name: 'My custom mode', templateType: 'general', isBuiltin: false },
    { id: '__profile_okf__', name: 'Hidden profile', templateType: 'general' },
    { id: 'reserved', name: 'Hidden sentinel', templateType: '__reserved__' },
];

// Actual renderer hooks/handlers -> actual preload -> actual mode IPC handlers.
// Only React scheduling, DOM, database, licensing and OS boundaries are doubles.
// Neither this harness nor its simulated platforms assert native/visual behavior.
function harness(platform, props = {}, initialActive = 'a', initialStateRead = null) {
    const slots = [], effects = [], focus = [], invokes = [], resets = [], windowListeners = new Map();
    const ipcRenderer = new EventEmitter();
    const streams = new Map([[1, { streamId: 1, controller: { abort: () => resets.push('abort') } }]]);
    let cursor = 0, tree, activeId = initialActive, pro = true, writeFailure = null, writeGate = null;
    let listRead = null, activeRead = null, stateRead = initialStateRead, listCalls = 0;
    const manager = {
        getModes: () => modeList.map((mode) => ({ ...mode, isActive: mode.id === activeId })),
        getActiveMode: () => manager.getModes().find((mode) => mode.id === activeId) ?? null,
        getReferenceFiles: () => [], getReferenceFileIndexStatuses: () => [],
        setActiveMode(id) { if (writeFailure) throw new Error(writeFailure); activeId = id; },
        prewarmModeReferenceIndex: async (id) => { resets.push(`prewarm:${id}`); },
    };
    const intelligence = {
        clearSessionContext: () => resets.push('session'),
        supersedeLiveAnswers: () => resets.push('live'),
        setDynamicActionContext: () => resets.push('dynamic'),
        clearDynamicActionContext: () => resets.push('clear-dynamic'),
    };
    const modules = {
        './services/ModesManager': { ModesManager: { getInstance: () => manager } },
        './services/chatStreamRegistry': { abortAndInvalidateChatStreams },
        './context-intelligence/question/conversation-state-store': { clearConversationState: () => resets.push('v3') },
        './services/telemetry/TelemetryService': { telemetryService: { track: () => resets.push('telemetry') } },
    };
    const context = {
        process: { platform }, crypto,
        console: { log() {}, warn() {}, error() {} },
        require: (id) => { assert.ok(modules[id], `unexpected dependency ${id}`); return modules[id]; },
        isProOrTrialActive: () => pro,
        BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
            send: (event, data) => ipcRenderer.emit(event, {}, data),
        } }] },
        appState: {
            getIntelligenceManager: () => intelligence,
            applyAutoAnswerThresholds: () => resets.push('thresholds'),
            processingHelper: { getLLMHelper: () => ({ prewarmPromptCache: async () => { resets.push('prompt-cache'); } }) },
        },
        _chatStreamsBySender: streams,
        _manualConversationMemory: { clearAllSessions: () => resets.push('manual') },
        _manualCodingState: { clearAllSessions: () => resets.push('coding') },
    };
    const handlers = Object.fromEntries(['modes:get-all', 'modes:get-active', 'modes:set-active'].map((channel) => [channel, evaluate(handlerSource(channel), context)]));
    ipcRenderer.invoke = async (channel, ...args) => {
        invokes.push([channel, ...args]);
        if (channel === 'modes:get-all') { ++listCalls; if (listRead) return listRead(); }
        if (channel === 'modes:get-active' && activeRead) return activeRead();
        if (channel === 'get-settings-popup-state') return stateRead ? stateRead() : { panel: 'settings', isVisible: false, heightBudget: 330 };
        if (channel === 'modes:set-active' && writeGate) await writeGate.promise;
        return handlers[channel]?.({}, ...args);
    };
    const api = Object.fromEntries(['modesGetAll', 'modesGetActive', 'modesSetActive', 'onModeChanged', 'onSettingsWindowShown',
        'onSettingsVisibilityChange', 'getSettingsPopupState', 'toggleSettingsWindow', 'closeSettingsWindow'].map((name) =>
        [name, evaluate(`({ ${preloadSource(name)} }).${name}`, { ipcRenderer })]));
    const window = {
        screenX: 100, screenY: 100, electronAPI: api,
        addEventListener(name, fn) { if (!windowListeners.has(name)) windowListeners.set(name, new Set()); windowListeners.get(name).add(fn); },
        removeEventListener(name, fn) { windowListeners.get(name)?.delete(fn); },
    };
    const document = { activeElement: null };
    const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    const hooks = {
        Fragment: 'fragment',
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState(initial) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
            return [slots[i].value, (update) => { slots[i].value = typeof update === 'function' ? update(slots[i].value) : update; }];
        },
        useRef(initial) { return slots[cursor++] ??= { current: initial }; },
        useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn }; return slots[i].fn; },
        useEffect(fn, deps) {
            const i = cursor++, old = slots[i];
            if (same(old?.deps, deps)) return;
            effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
        },
    };
    hooks.useLayoutEffect = hooks.useEffect;
    const module = { exports: {} };
    runInNewContext(picker, {
        module, exports: module.exports, window, document, console, Error,
        require(id) {
            if (id === 'react') return hooks;
            if (id.includes('useResolvedTheme')) return { useResolvedTheme: () => 'dark' };
            if (id === 'lucide-react') return { Check: 'icon', SlidersHorizontal: 'icon', X: 'icon' };
            throw new Error(`Unexpected renderer dependency ${id}`);
        },
    });
    const nodes = () => {
        const out = [];
        const walk = (node) => { if (Array.isArray(node)) { node.forEach(walk); return; } if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(walk); };
        walk(tree); return out;
    };
    const rows = () => nodes().filter((node) => node.props.role === 'menuitemradio');
    const elements = new Map();
    const elementFor = (node) => {
        const id = node.props['aria-label'] || 'retry';
        if (!elements.has(id)) elements.set(id, { focus() { document.activeElement = elements.get(id); focus.push(id); } });
        return elements.get(id);
    };
    const listElement = {
        querySelectorAll: () => rows().filter((row) => !row.props.disabled).map(elementFor),
        querySelector(selector) {
            const row = rows().find((node) => !node.props.disabled && (!selector.includes('aria-checked') || node.props['aria-checked']));
            return row ? elementFor(row) : selector.includes('data-mode-retry') ? { focus: () => focus.push('retry') } : null;
        },
    };
    const ownerRef = { current: { getBoundingClientRect: () => ({ bottom: 400 }) } };
    const render = () => {
        cursor = 0; tree = module.exports.default({ ...props, panelRef: ownerRef });
        for (const node of nodes()) if (node.props.ref) node.props.ref.current = listElement;
        effects.splice(0).forEach((fn) => fn());
    };
    const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise((resolve) => setImmediate(resolve)); render(); } };
    const external = (id) => { activeId = id; ipcRenderer.emit('mode-changed', {}, { id, name: manager.getActiveMode()?.name ?? null }); };
    render();
    return {
        rows, nodes, render, settle, focus, invokes, resets, streams, api,
        get listCalls() { return listCalls; }, get activeId() { return activeId; },
        button: () => nodes().find((node) => node.props['data-modes-toggle']),
        checked: () => rows().filter((row) => row.props['aria-checked']).map((row) => row.props['aria-label']),
        alert: () => nodes().find((node) => node.props.role === 'alert')?.children.join(''),
        external, show: (panel) => ipcRenderer.emit('settings-window-shown', {}, panel),
        visibility: (visible, panel) => ipcRenderer.emit('settings-visibility-changed', {}, visible, panel),
        focusWindow() { for (const fn of windowListeners.get('focus') ?? []) fn(); },
        reads(list, active) { listRead = list; activeRead = active; },
        state(read) { stateRead = read; },
        gateWrite() { writeGate = deferred(); return writeGate; },
        refuseWrite(error) { writeFailure = error; }, setPro(value) { pro = value; },
        key(key) { nodes().find((node) => node.props.onKeyDown && node.props.ref).props.onKeyDown({ key, preventDefault() {} }); },
        unmount() {
            slots.forEach((slot) => slot?.cleanup?.());
            assert.equal(ipcRenderer.eventNames().length, 0);
            assert.equal([...windowListeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0);
        },
    };
}

for (const platform of ['darwin', 'win32']) {
    test(`${platform}: actual icon matches Courses geometry, anchors the shared modes panel, tracks active/external/visibility state`, async () => {
        const h = harness(platform, { compact: true });
        await h.settle();
        assert.equal(h.button().props['aria-label'], 'Modes, General');
        assert.equal(h.button().props.title, 'Modes, General');
        assert.equal(h.button().props['data-active'], true);
        assert.match(h.button().props.className, /w-7 h-7.*rounded-\[9px\].*overlay-bare-icon/);
        assert.equal(h.button().children.some((child) => typeof child === 'string'), false);
        assert.equal(h.rows().length, 0, 'no inline popup or portal');
        h.button().props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 250 }) } });
        assert.equal(JSON.stringify(h.invokes.at(-1)), JSON.stringify(['toggle-settings-window', { panel: 'modes', x: 350, y: 508 }]));
        h.visibility(true, 'modes'); h.render(); assert.equal(h.button().props['aria-expanded'], true);
        h.visibility(true, 'courses'); h.render(); assert.equal(h.button().props['aria-expanded'], false);
        h.visibility(true, 'settings'); h.render(); assert.equal(h.button().props['aria-expanded'], false);
        h.external('c'); await h.settle(); assert.equal(h.button().props.title, 'Modes, My custom mode');
        h.external(null); await h.settle(); assert.equal(h.button().props['data-active'], false);
        h.unmount();
    });

    test(`${platform}: actual renderer/preload/IPC activate with no optimistic marker; resets, abort invalidation and prewarm are preserved`, async () => {
        const h = harness(platform);
        await h.settle();
        assert.deepEqual(h.rows().map((row) => row.props['aria-label']), ['General', 'Technical Interview', 'My custom mode']);
        assert.deepEqual(h.checked(), ['General']);
        const gate = h.gateWrite(), row = h.rows()[1];
        row.props.onClick(); row.props.onClick(); h.render();
        assert.equal(h.invokes.filter(([channel]) => channel === 'modes:set-active').length, 1);
        assert.deepEqual(h.checked(), ['General']);
        assert.ok(h.rows().every((node) => node.props.disabled));
        gate.resolve(); await h.settle();
        assert.deepEqual(h.checked(), ['Technical Interview']);
        assert.equal(h.streams.size, 0);
        for (const effect of ['abort', 'session', 'live', 'manual', 'coding', 'v3', 'dynamic', 'thresholds', 'prewarm:b', 'prompt-cache']) assert.ok(h.resets.includes(effect), effect);
        assert.equal(h.invokes.some(([channel]) => channel === 'close-settings-window'), false, 'success stays open like Courses');
        assert.ok(h.rows().every((node) => !node.props.disabled));
        assert.equal(h.focus.at(-1), 'Technical Interview', 'restore DOM focus after pending disabled the selected row');
        h.unmount();
    });

    test(`${platform}: Pro and persistence refusals keep the real active mode and do not cancel/reset its session`, async () => {
        const h = harness(platform);
        await h.settle(); h.setPro(false);
        h.rows()[1].props.onClick(); await h.settle();
        assert.match(h.alert(), /requires Pro/);
        assert.deepEqual(h.checked(), ['General']);
        assert.equal(h.resets.length, 0); assert.equal(h.streams.size, 1);
        h.show('modes'); await h.settle(); assert.match(h.alert(), /requires Pro/, 'refresh cannot hide refusal');
        h.refuseWrite('activation write refused');
        h.rows()[2].props.onClick(); await h.settle();
        assert.equal(h.alert(), 'activation write refused');
        assert.deepEqual(h.checked(), ['General']); assert.equal(h.resets.length, 0);
        h.refuseWrite(null); h.rows()[2].props.onClick(); await h.settle();
        assert.deepEqual(h.checked(), ['My custom mode']); assert.equal(h.alert(), undefined);
        h.unmount();
    });

    test(`${platform}: transport errors and missing acknowledgements are visible, never optimistic successes`, async () => {
        const h = harness(platform);
        await h.settle();
        h.api.modesSetActive = async () => { throw new Error('IPC disconnected'); };
        h.rows()[1].props.onClick(); await h.settle();
        assert.equal(h.alert(), 'IPC disconnected'); assert.deepEqual(h.checked(), ['General']);
        h.api.modesSetActive = async () => undefined;
        h.rows()[1].props.onClick(); await h.settle();
        assert.match(h.alert(), /Could not activate/); assert.deepEqual(h.checked(), ['General']);
        h.api.modesSetActive = async () => ({ success: true });
        h.rows()[1].props.onClick(); await h.settle();
        assert.deepEqual(h.checked(), ['General'], 'even a successful ack must re-read the real mode, not assume the requested id');
        assert.equal(h.alert(), undefined);
        h.unmount();
    });

    test(`${platform}: a delayed pre-selection snapshot cannot overwrite acknowledged activation or an external switch`, async () => {
        const h = harness(platform);
        await h.settle();
        const oldList = deferred(), oldActive = deferred();
        h.reads(() => oldList.promise, () => oldActive.promise);
        h.show('modes'); h.render();
        // Keep the actual DOM's disabled/loading policy. The captured handler
        // also protects writes from async read completions already in flight.
        h.reads(null, null);
        h.rows()[1].props.onClick(); await h.settle();
        assert.deepEqual(h.checked(), ['Technical Interview']);
        oldList.resolve(modeList); oldActive.resolve(modeList[0]); await h.settle();
        assert.deepEqual(h.checked(), ['Technical Interview']);
        const snapshot = deferred();
        h.reads(null, () => snapshot.promise); h.focusWindow(); h.render();
        h.reads(null, null); h.external('c'); await h.settle();
        snapshot.resolve(modeList[1]); await h.settle();
        assert.deepEqual(h.checked(), ['My custom mode']);
        h.unmount();
    });

    test(`${platform}: an external switch while activation acknowledgement is delayed remains authoritative`, async () => {
        const h = harness(platform);
        await h.settle();
        const ack = deferred(), actualWrite = h.api.modesSetActive;
        h.api.modesSetActive = async (id) => { const result = await actualWrite(id); await ack.promise; return result; };
        h.rows()[1].props.onClick(); await h.settle();
        assert.deepEqual(h.checked(), ['Technical Interview'], 'broadcast is authoritative even before ack');
        h.external('c'); await h.settle(); assert.deepEqual(h.checked(), ['My custom mode']);
        ack.resolve(); await h.settle(); assert.deepEqual(h.checked(), ['My custom mode']);
        h.unmount();
    });

    test(`${platform}: content refreshes on each modes show, handles failed reads/retry, and focuses/navigates rows`, async () => {
        const h = harness(platform, {}, 'b');
        await h.settle(); assert.equal(h.focus.at(-1), 'Technical Interview');
        assert.equal(h.listCalls, 1);
        h.show('courses'); await h.settle(); assert.equal(h.listCalls, 1);
        h.show('modes'); await h.settle(); assert.equal(h.listCalls, 2);
        h.key('ArrowDown'); assert.equal(h.focus.at(-1), 'My custom mode');
        h.key('ArrowDown'); assert.equal(h.focus.at(-1), 'General');
        h.key('End'); assert.equal(h.focus.at(-1), 'My custom mode');
        h.key('Home'); assert.equal(h.focus.at(-1), 'General');
        h.rows()[2].props.onClick(); await h.settle(); assert.deepEqual(h.checked(), ['My custom mode']);
        h.reads(async () => { throw new Error('list unavailable'); }, null);
        h.show('modes'); await h.settle(); assert.equal(h.alert(), 'list unavailable');
        assert.deepEqual(h.checked(), ['My custom mode']);
        h.reads(null, null);
        h.nodes().find((node) => node.props['data-mode-retry']).props.onClick(); await h.settle();
        assert.equal(h.alert(), undefined);
        h.nodes().find((node) => node.props['aria-label'] === 'Close modes').props.onClick();
        assert.deepEqual(h.invokes.at(-1), ['close-settings-window']);
        h.unmount();
    });

    test(`${platform}: late prewarm visibility state cannot replace a newer panel event`, async () => {
        const state = deferred();
        const h = harness(platform, { compact: true }, 'a', () => state.promise);
        h.visibility(true, 'modes'); await h.settle();
        state.resolve({ panel: 'settings', isVisible: false }); await h.settle();
        assert.equal(h.button().props['aria-expanded'], true);
        h.visibility(false, 'modes'); await h.settle();
        assert.equal(h.button().props['aria-expanded'], false);
        h.unmount();
    });
}

test('actual chat outside-mousedown guard exempts all three toggles, but dismisses elsewhere', () => {
    const ast = parse(new URL('../NativelyInterface.tsx', import.meta.url));
    const declaration = find(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onMouseDown'
        && node.initializer?.getText(ast).includes('dismissOverlayPopovers'));
    const calls = [];
    const handler = evaluate(declaration.initializer.getText(ast), { window: { electronAPI: {
        modelSelectorCloseIfOpen: async () => {}, dismissOverlayPopovers: async (options) => calls.push(options),
    } } });
    for (const attribute of ['data-settings-toggle', 'data-course-toggle', 'data-modes-toggle']) {
        handler({ target: { closest: (selector) => selector.includes(`[${attribute}="true"]`) } });
    }
    assert.equal(calls.length, 0, 'trigger mousedown cannot race its own toggle');
    handler({ target: { closest: () => false } }); assert.equal(calls.length, 1);
});
