import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../SettingsPopup.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

// Executes SettingsPopup's actual hooks/handlers with DOM boundary doubles.
// No browser layout, CDP, or native-window behavior is inferred from this test.
function harness(initialPanel = 'settings') {
    const slots = [];
    const effects = [];
    const shown = new Set();
    const budgets = new Set();
    const keys = new Set();
    const animations = [];
    const dimensions = [];
    let cursor = 0;
    let tree;
    let closed = 0;
    let resolveState;
    const state = new Promise((resolve) => { resolveState = resolve; });
    const panelElement = { animate: (...args) => animations.push(args) };
    const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const hooks = {
        Fragment: 'fragment',
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState(initial) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
            return [slots[i].value, (update) => { slots[i].value = typeof update === 'function' ? update(slots[i].value) : update; }];
        },
        useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useMemo(callback) { ++cursor; return callback(); },
        useEffect(callback, deps) {
            const i = cursor++;
            if (same(slots[i]?.deps, deps)) return;
            const old = slots[i];
            effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; });
        },
    };
    hooks.useLayoutEffect = hooks.useEffect;
    const window = {
        screen: { availHeight: 800 },
        addEventListener() {}, removeEventListener() {},
        matchMedia: () => ({ matches: false }),
        electronAPI: {
            setGroqFastTextMode() {},
            onSettingsWindowShown: (fn) => { shown.add(fn); return () => shown.delete(fn); },
            getSettingsPopupState: () => state,
            onSettingsPopupHeightBudget: (fn) => { budgets.add(fn); return () => budgets.delete(fn); },
            closeSettingsWindow: async () => { ++closed; },
            updateContentDimensions: async (size) => { dimensions.push(size); },
        },
    };
    const document = {
        addEventListener: (name, fn) => { if (name === 'keydown') keys.add(fn); },
        removeEventListener: (name, fn) => { if (name === 'keydown') keys.delete(fn); },
    };
    const module = { exports: {} };
    runInNewContext(compiled, {
        module, exports: module.exports, window, document, console,
        localStorage: { getItem: () => null, setItem() {} },
        getComputedStyle: () => ({ width: '180.2px', height: '235.1px' }),
        ResizeObserver: class { observe() {} disconnect() {} },
        require(id) {
            if (id === 'react') return hooks;
            if (id.includes('useShortcuts')) return { useShortcuts: () => ({ shortcuts: {} }) };
            if (id.includes('useResolvedTheme')) return { useResolvedTheme: () => 'dark' };
            if (id.includes('platformUtils')) return { getModifierSymbol: () => 'Ctrl' };
            if (id.includes('meetingInterfaceTheme')) return { getMeetingInterfaceTheme: () => 'default' };
            if (id.includes('overlayAppearance')) return { getDefaultOverlayOpacity: () => 0.7, clampOverlayOpacity: (v) => v, getOverlayAppearance: () => ({ shellStyle: { opacity: 0.7 } }), getGlassOverlayAppearance: () => ({ shellStyle: {} }), OVERLAY_OPACITY_DEFAULT: 0.8 };
            if (id.includes('useToggleInit')) return { useToggleInit: () => ({ arm() {}, className: '' }) };
            if (id.includes('CoursePinBar')) return { __esModule: true, default: 'course-content' };
                        if (id.includes('ModePicker')) return { __esModule: true, default: 'mode-content' };
            return { MessageSquare: 'icon', Camera: 'icon', Zap: 'icon', Eye: 'icon' };
        },
    });
    const nodes = () => {
        const out = [];
        const walk = (node) => {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            out.push(node); node.children?.forEach(walk);
        };
        walk(tree); return out;
    };
    const render = () => {
        cursor = 0; tree = module.exports.default();
        for (const node of nodes()) if (node.props.ref) node.props.ref.current = panelElement;
        effects.splice(0).forEach((fn) => fn());
    };
    const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); render(); } };
    render();
    return {
        nodes, animations, dimensions, settle, render,
        get closed() { return closed; },
        resolveState(panel = initialPanel, heightBudget = 330) { resolveState({ panel, isVisible: true, heightBudget }); },
        async budget(height) { for (const fn of budgets) fn(height); await settle(); },
        async show(panel) { for (const fn of shown) fn(panel); await settle(); },
        escape() { for (const fn of keys) fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); },
        unmount() { for (const slot of slots) slot?.cleanup?.(); assert.equal(shown.size + keys.size + budgets.size, 0); },
    };
}

test('actual SettingsPopup restores modes, scrolls within the same shell, and switches independently to courses/settings', async () => {
    const h = harness('modes');
    h.resolveState('modes', 92); await h.settle();
    const shell = () => h.nodes().find((node) => node.props.role === 'dialog');
    assert.equal(shell().props['data-popup-panel'], 'modes');
    assert.equal(shell().props['aria-label'], 'Modes');
    assert.ok(h.nodes().some((node) => node.type === 'mode-content'));
    assert.equal(h.nodes().find((node) => node.props.className === 'overflow-y-auto overscroll-contain').props.style.maxHeight, 82);
    const material = JSON.stringify(shell().props.style);
    await h.show('courses');
    assert.equal(h.nodes().some((node) => node.type === 'mode-content'), false);
    assert.ok(h.nodes().some((node) => node.type === 'course-content'));
    await h.show('settings');
    assert.ok(h.nodes().some((node) => node.props.label === 'Fast Response'));
    await h.show('modes');
    assert.equal(JSON.stringify(shell().props.style), material);
    assert.equal(h.animations.length, 3);
    await h.budget(64);
    assert.equal(h.nodes().find((node) => node.props.className === 'overflow-y-auto overscroll-contain').props.style.maxHeight, 54);
    h.escape(); assert.equal(h.closed, 1);
    h.unmount();
});

test('a stale prewarm settings snapshot cannot replace a modes show', async () => {
    const h = harness();
    await h.show('modes');
    h.resolveState('settings'); await h.settle();
    assert.equal(h.nodes().find((node) => node.props.role === 'dialog').props['data-popup-panel'], 'modes');
    h.unmount();
});

test('actual SettingsPopup restores courses on mount/reload and switches inside the same material shell', async () => {
    const h = harness('courses');
    h.resolveState(); await h.settle();
    const shell = () => h.nodes().find((node) => node.props.role === 'dialog');
    assert.equal(shell().props['data-popup-panel'], 'courses');
    assert.match(shell().props.className, /overlay-shell-surface overlay-popover-surface/);
    assert.match(shell().props.className, /origin-top-left/);
    assert.equal(h.nodes().find((node) => node.type === 'course-content').props.popupContent, true);
    assert.ok(h.nodes().some((node) => node.props.className === 'overflow-y-auto overscroll-contain' && node.props.style.maxHeight === 320));
    assert.equal(JSON.stringify(h.dimensions[0]), JSON.stringify({ width: 181, height: 236 }), 'unscaled border box is rounded up');
    const material = JSON.stringify(shell().props.style);
    await h.show('settings');
    assert.equal(shell().props['data-popup-panel'], 'settings');
    assert.ok(h.nodes().some((node) => node.props.label === 'Fast Response'));
    assert.equal(h.nodes().some((node) => node.type === 'course-content'), false);
    assert.equal(JSON.stringify(shell().props.style), material);
    await h.show('courses'); await h.show('courses');
    assert.equal(h.animations.length, 3, 'same animation is replayed for every show/switch');
    assert.equal(h.animations[0][0][0].transform, 'translateY(-4px) scale(0.98)');
    h.escape(); assert.equal(h.closed, 1);
    h.unmount();
});

test('actual courses viewport uses helper room minus shell chrome and remains scrollable at the fallback edge', async () => {
    const h = harness('courses');
    h.resolveState('courses', 92); await h.settle();
    const scroll = () => h.nodes().find((node) => node.props.className === 'overflow-y-auto overscroll-contain');
    assert.equal(scroll().props.style.maxHeight, 82, '92px whole popup includes 10px padding/border');
    await h.budget(64);
    assert.equal(scroll().props.style.maxHeight, 54, 'tiny screen fallback cannot leave content clipped behind the native window');
    await h.budget(330);
    assert.equal(scroll().props.style.maxHeight, 320, 'moving to a roomier anchor restores the list capacity');
    h.unmount();
});

test('a delayed state fetch cannot replace a newer helper height budget', async () => {
    const h = harness('courses');
    await h.budget(92);
    h.resolveState('courses', 330); await h.settle();
    assert.equal(h.nodes().find((node) => node.props.className === 'overflow-y-auto overscroll-contain').props.style.maxHeight, 82);
    h.unmount();
});

test('a delayed mount-state fetch cannot overwrite a newer panel selection', async () => {
    const h = harness();
    await h.show('courses');
    h.resolveState('settings'); await h.settle();
    assert.equal(h.nodes().find((node) => node.props.role === 'dialog').props['data-popup-panel'], 'courses');
    h.unmount();
});
