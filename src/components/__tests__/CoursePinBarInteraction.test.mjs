import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { isCourseGroundingEnabled } from '../../lib/coursePins.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../courses/CoursePinBar.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

// Executes the component's actual hooks and handlers with scheduled IPC and DOM
// stand-ins. This tests renderer behavior, not Electron focus or native capture.
function harness(initialCourses = [], props = {}, initialPins = []) {
    const slots = [];
    const effects = [];
    const subscribers = new Set();
    const observers = [];
    const focus = [];
    const writes = [];
    const popupCalls = [];
    const shown = new Set();
    const visibility = new Set();
    let cursor = 0;
    let tree;
    let list = initialCourses;
    let pins = initialPins;
    let listCalls = 0;
    let resolveWrite;
    let rejectWrite;
    const target = () => {
        const listeners = new Map();
        return {
            addEventListener(name, callback, capture = false) {
                const key = `${name}:${capture}`;
                if (!listeners.has(key)) listeners.set(key, new Set());
                listeners.get(key).add(callback);
            },
            removeEventListener(name, callback, capture = false) { listeners.get(`${name}:${capture}`)?.delete(callback); },
            emit(name, event = {}) {
                for (const capture of [true, false]) for (const callback of [...(listeners.get(`${name}:${capture}`) ?? [])]) callback(event);
            },
            count: (name) => [...listeners].filter(([key]) => !name || key.startsWith(`${name}:`)).reduce((n, [, callbacks]) => n + callbacks.size, 0),
        };
    };
    const bounds = { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 };
    const panel = { offsetWidth: 600, getBoundingClientRect: () => bounds };
    const root = {
        contains: (node) => !!node?.inside,
        closest: () => panel,
        getBoundingClientRect: () => ({ left: 250, top: 350, right: 360, bottom: 378, width: 110, height: 28 }),
    };
    const chip = { focus: () => focus.push('trigger') };
    const popover = { scrollHeight: 160, querySelector: () => ({ focus: () => focus.push('row') }) };
    const document = { ...target(), documentElement: panel };
    const window = { ...target(), screenX: 100, screenY: 100, innerWidth: 600, innerHeight: 400, electronAPI: {
        toggleSettingsWindow: async (request) => { popupCalls.push(request); },
        closeSettingsWindow: async () => { popupCalls.push('close'); },
        onSettingsWindowShown: (callback) => { shown.add(callback); return () => shown.delete(callback); },
        onSettingsVisibilityChange: (callback) => { visibility.add(callback); return () => visibility.delete(callback); },
        getSettingsPopupState: async () => ({ panel: 'settings', isVisible: false }),
        coursesList: async () => { ++listCalls; return typeof list === 'function' ? list() : list; },
    } };
    const sameDeps = (old, deps) => old && deps && deps.length === old.length && deps.every((value, i) => Object.is(value, old[i]));
    const hooks = {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState(initial) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
            return [slots[i].value, (update) => { slots[i].value = typeof update === 'function' ? update(slots[i].value) : update; }];
        },
        useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useId() { const i = cursor++; return slots[i] ??= 'test-course-menu'; },
        useCallback(callback, deps) {
            const i = cursor++;
            if (!sameDeps(slots[i]?.deps, deps)) slots[i] = { deps, callback };
            return slots[i].callback;
        },
        useEffect(callback, deps) {
            const i = cursor++;
            const old = slots[i];
            if (sameDeps(old?.deps, deps)) return;
            effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; });
        },
    };
    hooks.useLayoutEffect = hooks.useEffect;
    const helpers = {
        getCoursePinIds: () => [...pins],
        isCourseGroundingEnabled,
        subscribeCourseStateChanged: (callback) => { subscribers.add(callback); return () => subscribers.delete(callback); },
        setCourseGroundingEnabled: (id, enabled) => {
            writes.push([id, enabled]);
            return new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
        },
    };
    const module = { exports: {} };
    runInNewContext(compiled, {
        module, exports: module.exports, window, document, console, Error,
        ResizeObserver: class {
            constructor() { this.disconnected = false; observers.push(this); }
            observe() {}
            disconnect() { this.disconnected = true; }
        },
        require(id) {
            if (id === 'react') return hooks;
            if (id === 'framer-motion') return { motion: { div: 'div' }, AnimatePresence: 'presence', useReducedMotion: () => true };
            if (id.includes('coursePins')) return helpers;
            if (id.includes('useResolvedTheme')) return { useResolvedTheme: () => 'dark' };
            return { BookOpen: 'icon', ChevronDown: 'icon', X: 'icon' };
        },
    }, { filename: 'CoursePinBar.js' });
    const nodes = () => {
        const all = [];
        const walk = (node) => {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            all.push(node);
            node.children?.forEach(walk);
        };
        walk(tree);
        return all;
    };
    const render = () => {
        cursor = 0;
        tree = module.exports.default({ compact: false, ...props, panelRef: { current: panel } });
        for (const node of nodes()) {
            if (node.props.ref) node.props.ref.current = node.props.role === 'dialog' ? popover : node.type === 'button' ? chip : root;
        }
        effects.splice(0).forEach((effect) => effect());
    };
    // Keep the prop ref stable like the real owner, so layout effects only run on
    // state changes; the small harness does not implement React's scheduler.
    const ownerRef = { current: panel };
    const Component = module.exports.default;
    module.exports.default = (props) => Component({ ...props, panelRef: ownerRef });
    const settle = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); render(); } };
    const button = () => nodes().find((node) => node.props['aria-haspopup'] === 'dialog');
    const rows = () => nodes().filter((node) => node.props.role === 'switch');
    const open = async () => { button().props.onClick(); render(); await settle(); };
    render();
    return {
        window, document, observers, focus, writes, subscribers, nodes, button, rows, render, settle, open, popupCalls,
                show(panel) { for (const callback of shown) callback(panel); },
                visibility(visible, panel) { for (const callback of visibility) callback(visible, panel); },
        setList(value) { list = value; },
        setPins(value) { pins = value; },
        get listCalls() { return listCalls; },
        changed() { for (const callback of subscribers) callback(); },
        succeed(id, enabled) {
            list = list.map((course) => course.id === id ? { ...course, enabled } : course);
            if (!enabled) pins = pins.filter((pin) => pin !== id);
            resolveWrite({ id, enabled });
            for (const callback of subscribers) callback();
        },
        fail(error) { rejectWrite(error); },
        unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
    };
}

test('compact chat control is icon-only, anchors below chat, and tracks only the courses panel', async () => {
    const h = harness([{ id: 'one', enabled: true }], { compact: true });
    await h.settle();
    assert.equal(h.button().props['aria-label'], 'Courses, 1 selected');
    assert.equal(h.rows().length, 0);
    assert.equal(h.nodes().some((node) => node.props.role === 'dialog'), false);
    assert.equal(h.button().children.some((child) => typeof child === 'string'), false, 'no visible label/chevron');
    h.button().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 250 }) } });
    assert.equal(JSON.stringify(h.popupCalls[0]), JSON.stringify({ panel: 'courses', x: 350, y: 508 }));
    h.visibility(true, 'courses'); h.render();
    assert.equal(h.button().props['aria-expanded'], true);
    h.visibility(true, 'settings'); h.render();
    assert.equal(h.button().props['aria-expanded'], false);
    h.visibility(false, 'courses'); h.render();
    assert.equal(h.button().props['aria-expanded'], false);
    h.unmount();
});

test('actual popup content refreshes on every courses show, with acknowledged toggles and shared pins', async () => {
    const h = harness([{ id: 'legacy', enabled: false }], { popupContent: true }, ['legacy']);
    await h.settle();
    assert.equal(h.button(), undefined, 'the shared shell owns the popup, not an inline trigger');
    assert.equal(h.rows()[0].props['aria-checked'], true);
    h.show('settings'); await h.settle();
    assert.equal(h.listCalls, 1);
    h.show('courses'); await h.settle();
    assert.equal(h.listCalls, 2);
    h.rows()[0].props.onClick(); h.render();
    assert.deepEqual(h.writes, [['legacy', false]]);
    assert.equal(h.rows()[0].props['aria-checked'], true);
    h.succeed('legacy', false); await h.settle();
    assert.equal(h.rows()[0].props['aria-checked'], false);
    h.setList([{ id: 'new', enabled: true }]);
    h.show('courses'); await h.settle();
    assert.equal(h.rows()[0].props['aria-label'], 'new');
    h.nodes().find((node) => node.props['aria-label'] === 'Close courses').props.onClick();
    assert.deepEqual(h.popupCalls, ['close']);
    h.unmount();
});

test('actual component refreshes on every open and shared notifications update mounted rows', async () => {
    const h = harness([{ id: 'one', name: 'Course one', enabled: true }, { id: 'legacy', enabled: false }]);
    h.setPins(['legacy']);
    await h.settle();
    assert.equal(h.listCalls, 1);
    await h.open();
    assert.equal(h.listCalls, 2);
    assert.deepEqual(h.rows().map((row) => row.props['aria-checked']), [true, true]);
    h.setList([{ id: 'one', name: 'Course one', enabled: false }]);
    h.changed();
    await h.settle();
    assert.equal(h.rows()[0].props['aria-checked'], false);
    h.button().props.onClick(); h.render();
    await h.open();
    assert.equal(h.listCalls, 4);
    h.unmount();
});

test('actual component waits for acknowledgement, guards duplicate toggles, and displays refusal', async () => {
    const h = harness([{ id: 'one', enabled: true }]);
    await h.settle(); await h.open();
    const row = h.rows()[0];
    row.props.onClick(); row.props.onClick(); h.render();
    assert.deepEqual(h.writes, [['one', false]]);
    assert.equal(h.rows()[0].props['aria-checked'], true, 'pending is not a false off acknowledgement');
    assert.equal(h.rows()[0].props.disabled, true);
    h.fail(new Error('Write refused'));
    await h.settle();
    assert.equal(h.rows()[0].props['aria-checked'], true);
    assert.ok(h.nodes().some((node) => node.props.role === 'alert' && node.children.includes('Write refused')));
    h.changed(); await h.settle();
    assert.ok(h.nodes().some((node) => node.props.role === 'alert' && node.children.includes('Write refused')), 'a background refresh must not swallow the failure');
    h.rows()[0].props.onClick(); h.render();
    h.succeed('one', false); await h.settle();
    assert.equal(h.rows()[0].props['aria-checked'], false);
    assert.equal(h.rows()[0].props.disabled, false);
    h.unmount();
});

test('actual Escape/ArrowDown/outside handlers operate and repeated open/close leaks no listeners', async () => {
    const h = harness([{ id: 'one', enabled: true }]);
    await h.settle();
    for (let i = 0; i < 3; i++) {
        h.button().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
        h.render(); await h.settle();
        assert.ok(h.focus.includes('row'));
        assert.equal(h.document.count('keydown'), 1);
        assert.equal(h.document.count('pointerdown'), 1);
        let prevented = false;
        let stopped = false;
        h.document.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
        h.render();
        assert.equal(prevented && stopped, true);
        assert.equal(h.focus.at(-1), 'trigger');
        assert.equal(h.button().props['aria-expanded'], false);
        assert.equal(h.document.count(), 0);
        assert.equal(h.window.count('resize'), 0);
        assert.equal(h.subscribers.size, 1);
    }
    await h.open();
    h.document.emit('pointerdown', { target: { inside: true } }); h.render();
    assert.equal(h.button().props['aria-expanded'], true);
    h.document.emit('pointerdown', { target: { inside: false } }); h.render();
    assert.equal(h.button().props['aria-expanded'], false);
    await h.open();
    h.document.emit('focusin', { target: { inside: false } }); h.render();
    assert.equal(h.button().props['aria-expanded'], false);
    h.unmount();
    assert.equal(h.document.count() + h.window.count(), 0);
    assert.equal(h.subscribers.size, 0);
    assert.ok(h.observers.every((observer) => observer.disconnected));
});

test('actual empty and failed list states preserve the trigger and provide retry', async () => {
    const h = harness([]);
    await h.settle(); await h.open();
    assert.ok(h.button());
    assert.ok(h.nodes().some((node) => node.props.role === 'status' && node.children.some((child) => typeof child === 'string' && child.startsWith('No courses yet'))));
    h.setList({ disabled: true }); h.changed(); await h.settle();
    assert.ok(h.nodes().some((node) => node.props.role === 'alert'));
    const retry = h.nodes().find((node) => node.props['data-course-retry']);
    assert.ok(retry);
    h.setList([{ id: 'new', enabled: false }]);
    retry.props.onClick(); await h.settle();
    assert.equal(h.rows().length, 1);
    assert.equal(h.nodes().some((node) => node.props.role === 'alert'), false);
    h.unmount();
});
