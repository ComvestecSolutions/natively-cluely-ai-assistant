import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const source = (name) => readFileSync(new URL(`../${name}.tsx`, import.meta.url), 'utf8');
const pinsCode = transformSync(readFileSync(new URL('../../../lib/coursePins.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// Execute the real TSX handlers/effects without Electron or a new DOM dependency.
// Children are opaque JSX nodes; this does not claim browser layout/focus coverage.
function mount(name, api, props = {}, initialPins = []) {
    const slots = [], effects = [];
    let cursor = 0, dirty = true, tree, alive = true;
    const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
    const hooks = {
        useState(initial) {
            const i = cursor++;
            if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
            return [slots[i].value, (next) => {
                assert.ok(alive, 'async write after unmount');
                const value = typeof next === 'function' ? next(slots[i].value) : next;
                if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
            }];
        },
        useRef(value) {
            const i = cursor++;
            return slots[i] ?? (slots[i] = { current: value });
        },
        useId() {
            const i = cursor++;
            return (slots[i] ?? (slots[i] = { value: `study-rail-${i}` })).value;
        },
        useEffect(fn, deps) {
            const i = cursor++;
            const old = slots[i];
            if (changed(old?.deps, deps)) effects.push(() => {
                old?.cleanup?.();
                slots[i] = { deps, cleanup: fn() };
            });
        },
        useCallback(fn, deps) {
            const i = cursor++;
            if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn };
            return slots[i].value;
        },
        useMemo(fn, deps) {
            const i = cursor++;
            if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() };
            return slots[i].value;
        },
    };
    const react = { ...hooks, createElement: (type, attrs, ...children) => {
        const props = { ...attrs, children };
        return typeof type === 'function' ? type(props) : { type, props };
    } };
    const settings = {
        SETTINGS_BTN: 'settings-button', SETTINGS_BTN_BASE: 'settings-button-base', SETTINGS_BTN_NEUTRAL: 'settings-button-neutral',
        SETTINGS_CARD: 'settings-card', SETTINGS_INPUT: 'settings-input',
        SettingsNotice: 'SettingsNotice', SettingsSwitch: 'SettingsSwitch', useSettingsTones: () => ({ warn: 'warn', danger: 'danger', ok: 'ok', text: { danger: 'danger' } }),
    };
    const storage = new Map([['natively_course_pins', JSON.stringify(initialPins)]]);
    const listeners = new Map();
    const win = {
        electronAPI: api,
        localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); },
        setTimeout, clearTimeout,
    };
    const pinsModule = { exports: {} };
    new Function('module', 'exports', 'window', pinsCode)(pinsModule, pinsModule.exports, win);
    const coursePins = pinsModule.exports;
    const require = (id) => {
        if (id === 'react') return { __esModule: true, ...react, default: react };
        if (id.endsWith('SettingsRow')) return settings;
        if (id.endsWith('coursePins')) return coursePins;
        if (id.endsWith('useResolvedTheme')) return { useResolvedTheme: () => 'light' };
        if (id.endsWith('i18n')) return { useT: () => (v) => v };
        if (id.endsWith('AIProvidersSettings')) return { AipBadge: 'AipBadge' };
        if (id === 'framer-motion') return { useReducedMotion: () => true, AnimatePresence: 'AnimatePresence', motion: new Proxy({}, { get: (_, key) => `motion.${key}` }) };
        if (id === 'lucide-react') return new Proxy({}, { get: (_, key) => key });
        return { __esModule: true, default: id.split('/').at(-1) };
    };
    const code = transformSync(source(name), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'window', 'document', code)(require, module, module.exports, win, { querySelector: () => null });
    const component = module.exports.default;
    const render = () => {
        for (let n = 0; dirty && n < 30; n++) {
            dirty = false; cursor = 0; tree = component(props);
            for (const effect of effects.splice(0)) effect();
        }
        assert.equal(dirty, false, 'render loop settled');
    };
    const flush = async () => { for (let n = 0; n < 12; n++) { await Promise.resolve(); render(); } };
    render();
    return {
        flush, render, coursePins, window: win,
        listenerCount: (name) => listeners.get(name)?.size ?? 0,
        nodes: () => flatten(tree),
        update(next) { props = { ...props, ...next }; dirty = true; render(); },
        unmount() { for (const slot of slots) slot?.cleanup?.(); alive = false; },
    };
}
function flatten(node) {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (!node || typeof node !== 'object') return [];
    return [node, ...flatten(node.props?.children)];
}
const text = (node) => Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' && node ? text(node.props?.children) : typeof node === 'boolean' ? '' : String(node ?? '');
const find = (app, predicate) => {
    const node = app.nodes().find(predicate);
    assert.ok(node, 'expected UI control exists');
    return node;
};
const clickLabel = (app, label) => find(app, (n) => n.props?.['aria-label'] === label || n.props?.title === label).props.onClick();
const clickText = (app, label) => find(app, (n) => n.props?.onClick && text(n).trim().replace(/\s+/g, ' ') === label).props.onClick();
const lessons = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, title: `Lesson ${i}`, parent: 'module', url: `https://example.com/${i}`, kind: 'lesson', tocPath: null, completedAt: null }));
const course = { id: 'c1', name: 'Example course' };
const readerApi = (override = {}) => ({ coursesGet: async () => ({ course, lessons }), coursesLessonContent: async () => ({ ok: true, content: 'Lesson body '.repeat(30) }), coursesSetLessonCompleted: async () => ({ ok: true }), ...override });
const mountReader = async (override = {}, props = {}) => { const app = mount('LessonReader', readerApi(override), { courseId: 'c1', onBack() {}, ...props }); await app.flush(); return app; };

for (const envelope of [{ disabled: true }, { error: 'Database busy' }, { ok: false, error: 'Save failed' }]) {
    test(`completion rolls back and reports ${JSON.stringify(envelope)}`, async () => {
        const app = await mountReader({ coursesSetLessonCompleted: async () => envelope });
        await clickLabel(app, 'Mark as complete'); await app.flush();
        assert.equal(find(app, (n) => n.props?.title === 'Mark as complete').props['aria-pressed'], false);
        assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && n.props.alert));
        if (envelope.error) assert.ok(app.nodes().some((n) => text(n).includes(envelope.error)));
    });
}
test('completion is single-flight and can retry after rejection', async () => {
    const save = deferred(); let calls = 0;
    const app = await mountReader({ coursesSetLessonCompleted: () => { calls++; return calls === 1 ? save.promise : Promise.resolve({ ok: true }); } });
    const control = find(app, (n) => n.props?.title === 'Mark as complete');
    const first = control.props.onClick(); control.props.onClick(); app.render();
    assert.equal(calls, 1);
    assert.equal(find(app, (n) => n.props?.['aria-busy']).props.disabled, true);
    save.reject(new Error('Try again')); await first; await app.flush();
    await clickText(app, 'Retry save'); await app.flush();
    assert.equal(find(app, (n) => n.props?.title === 'Mark as not complete').props['aria-pressed'], true);
});
test('six-lesson module scopes every lesson in teaching order, even when the fifth is active', async () => {
    const app = await mountReader({ coursesGet: async () => ({ course, lessons: [...lessons, { ...lessons[0], id: 'lab', kind: 'lab', parent: 'other' }] }) }, { initialLessonId: 'l4' });
    const rail = find(app, (n) => n.type === 'StudyRail');
    assert.deepEqual(rail.props.scopeLessons.map((l) => l.id), lessons.map((l) => l.id));
    assert.equal(rail.props.externalLinks.length, 0);
    clickLabel(app, 'Next lesson'); await app.flush();
    assert.equal(find(app, (n) => n.type === 'main').props.key, 'l5');
    assert.deepEqual(find(app, (n) => n.type === 'StudyRail').props.scopeLessons.map((l) => l.id), lessons.map((l) => l.id));
});
test('module overview supplies the heading and first scope lesson; generic lessons stay ungrouped', async () => {
    const overview = { ...lessons[0], id: 'c1:learning-models', url: 'https://learn.microsoft.com/en-us/training/modules/learning-models/', title: 'Learning Models', parent: null, completedAt: 'today', durationMinutes: 7, durationSource: 'provided' };
    const grouped = [overview,
        { ...lessons[0], parent: 'modules/learning-models-deadbeef', durationMinutes: 12, durationSource: 'provided' },
        { ...lessons[1], parent: 'modules/learning-models-deadbeef', durationMinutes: 4, durationSource: 'estimated' },
        { ...lessons[2], id: 'lab', parent: 'modules/learning-models-deadbeef', kind: 'lab', durationMinutes: 99, durationSource: 'provided' },
        { ...lessons[3], id: 'generic', parent: null, durationMinutes: 3, durationSource: 'estimated' },
        { ...lessons[4], id: 'second', parent: 'modules/next-module-a1b2c3d4', durationMinutes: 5, durationSource: 'provided' }];
    const app = await mountReader({ coursesGet: async () => ({ course, lessons: grouped }) });
    assert.deepEqual(find(app, (n) => n.type === 'StudyRail').props.scopeLessons.map((l) => l.id), [overview.id, 'l0', 'l1']);
    assert.equal(find(app, (n) => n.type === 'StudyRail').props.moduleLabel, 'Learning Models');
    assert.deepEqual(find(app, (n) => n.type === 'StudyRail').props.externalLinks.map((l) => l.title), ['Lesson 2']);
    assert.equal(find(app, (n) => n.props?.['aria-label'] === '1 of 5 lessons complete').type, 'span');
    assert.equal(find(app, (n) => n.type === 'StudyRail').props.progress, undefined, 'course progress is not repeated in study aids');
    const headings = app.nodes().filter((n) => n.type === 'h3').map((n) => text(n).replace(/\s+/g, ' ').trim());
    assert.ok(headings.some((s) => s.includes('Learning Models') && /1\s*\/\s*3/.test(s)));
    assert.ok(headings.some((s) => s.includes('Next Module')));
    assert.ok(headings.some((s) => s.includes('Course lessons (ungrouped)')));
    const heading = find(app, (n) => n.type === 'h3' && text(n).includes('Learning Models')).props.children[0];
    const panel = () => find(app, (n) => n.props?.id === heading.props['aria-controls']);
    assert.equal(heading.props['aria-expanded'], false);
    assert.equal(panel().props.hidden, true);
    heading.props.onClick(); app.render();
    assert.equal(find(app, (n) => n.props?.['aria-controls'] === heading.props['aria-controls']).props['aria-expanded'], true);
    assert.equal(panel().props.hidden, false);
    find(app, (n) => n.type === 'button' && n.props?.['aria-controls'] === heading.props['aria-controls']).props.onClick(); app.render();
    assert.equal(panel().props.hidden, true);
    const time = () => text(find(app, (n) => n.type === 'aside' && n.props?.['aria-label'] === 'Course lessons')).replace(/\s+/g, ' ');
    assert.match(time(), /Course · ~31 min/);
    assert.match(time(), /This module · ~23 min/);
    const assertHeaderTime = (position, duration) => assert.match(text(find(app, (n) => n.type === 'header')),
        new RegExp(`Lesson\\s+${position}\\s*\\/\\s*6\\s*·\\s*${duration}\\s*min`));
    assertHeaderTime(1, '7');
    searchFor(app, 'Lesson 1');
    assert.equal(panel().props.hidden, false, 'search expands matching modules');
    const toggleSearchModule = () => find(app, (n) => n.type === 'button' && n.props?.['aria-controls'] === heading.props['aria-controls']).props.onClick();
    toggleSearchModule(); app.render();
    assert.equal(panel().props.hidden, true, 'a search result module can be collapsed');
    toggleSearchModule(); app.render();
    assert.equal(panel().props.hidden, false, 'a search result module can be reopened');
    assert.equal(find(app, (n) => n.props?.['aria-label'] === 'Search lessons').props.value, 'Lesson 1');
    clickLabel(app, 'Next lesson'); await app.flush();
    assertHeaderTime(2, '12');
    clickLabel(app, 'Next lesson'); await app.flush();
    assertHeaderTime(3, '~4');
    for (let i = 0; i < 2; i++) { clickLabel(app, 'Next lesson'); await app.flush(); }
    assertHeaderTime(5, '~3');
    assert.match(time(), /This module · ~3 min/);
    assert.equal(find(app, (n) => n.type === 'StudyRail').props.moduleLabel, 'Course lessons (ungrouped)');
    assert.deepEqual(find(app, (n) => n.type === 'StudyRail').props.scopeLessons.map((l) => l.id), ['generic']);
    clickLabel(app, 'Next lesson'); await app.flush();
    assertHeaderTime(6, '5');
    assert.match(time(), /This module · ~5 min/);
    assert.equal(find(app, (n) => n.type === 'StudyRail').props.moduleLabel, 'Next Module');
    assert.deepEqual(find(app, (n) => n.type === 'StudyRail').props.scopeLessons.map((l) => l.id), ['second']);
    app.unmount();
    const generic = await mountReader({ coursesGet: async () => ({ course, lessons: grouped.filter((l) => l.parent === null && l.id === 'generic') }) });
    assert.equal(find(generic, (n) => n.type === 'StudyRail').props.moduleLabel, 'Course lessons (ungrouped)');
    generic.unmount();
});
test('long Microsoft Learn module slugs group both TOC-hashed and detail-feed lessons with their overview', async () => {
    const slug = 'intro_to-building-scalable-distributed-applications-with-azure-services';
    const overview = { ...lessons[0], id: 'overview', title: 'Scalable applications', url: `https://learn.microsoft.com/en-us/training/modules/${slug}/`, parent: null };
    const parents = [
        `modules/${slug.slice(0, 48).replace(/_/g, '-')}-deadbeef`,
        `modules/${slug.replace(/_/g, '-').slice(0, 60)}`,
    ];
    for (const parent of parents) {
        const child = { ...lessons[1], parent };
        const app = await mountReader({ coursesGet: async () => ({ course, lessons: [overview, child] }) });
        assert.deepEqual(find(app, (n) => n.type === 'StudyRail').props.scopeLessons.map((l) => l.id), ['overview', 'l1']);
        assert.equal(find(app, (n) => n.type === 'StudyRail').props.moduleLabel, 'Scalable applications');
        assert.ok(app.nodes().some((n) => n.type === 'h3' && text(n).includes('Scalable applications')));
        app.unmount();
    }
});
const searchFor = (app, value) => { find(app, (n) => n.props?.['aria-label'] === 'Search lessons').props.onChange({ target: { value } }); app.render(); };
const searchDelay = async (app) => { await new Promise((resolve) => setTimeout(resolve, 320)); await app.flush(); };
test('one debounced search filters titles and opens a body hit', async () => {
    const calls = [];
    const app = await mountReader({ coursesSearch: async (...args) => { calls.push(args); return { ok: true, results: [{ lessonId: 'l5', title: 'Lesson 5', snippet: '<b>matched body</b>', parent: 'module' }] }; } });
    assert.deepEqual(app.nodes().filter((n) => n.type === 'input' && n.props.type === 'search').map((n) => n.props['aria-label']), ['Search lessons']);
    searchFor(app, 'Lesson 1');
    assert.deepEqual(app.nodes().filter((n) => n.type === 'button' && n.props?.title?.startsWith('Lesson ')).map((n) => n.props.title), ['Lesson 1']);
    searchFor(app, 'body phrase');
    assert.ok(app.nodes().some((n) => n.props?.role === 'status' && text(n).includes('Searching course')));
    await searchDelay(app);
    assert.deepEqual(calls, [['c1', 'body phrase']]);
    const hit = find(app, (n) => n.type === 'button' && text(n).includes('<b>matched body</b>'));
    assert.equal(hit.props.children[1].props.children[0], '<b>matched body</b>');
    hit.props.onClick(); await app.flush();
    assert.equal(find(app, (n) => n.type === 'main').props.key, 'l5');
    assert.equal(find(app, (n) => n.props?.['aria-label'] === 'Search lessons').props.value, 'body phrase');
    assert.equal(find(app, (n) => n.type === 'button' && n.props?.title === 'Lesson 5').props['aria-current'], 'page');
    app.unmount();
});
test('search handles empty, disabled, error and stale query responses', async () => {
    const old = deferred();
    const app = await mountReader({ coursesSearch: (_, query) => query === 'old' ? old.promise : Promise.resolve(query === 'off' ? { disabled: true } : query === 'broken' ? { ok: false, error: 'Index offline' } : { ok: true, hits: [] }) });
    searchFor(app, 'old'); await searchDelay(app);
    searchFor(app, 'new'); await searchDelay(app);
    old.resolve({ ok: true, results: [{ lessonId: 'l1', title: 'Stale title', snippet: 'Stale body' }] }); await app.flush();
    assert.ok(app.nodes().some((n) => text(n) === 'No content matches.'));
    assert.ok(!app.nodes().some((n) => text(n) === 'Stale body'));
    searchFor(app, 'off'); await searchDelay(app);
    assert.ok(app.nodes().some((n) => n.props?.role === 'alert' && text(n).includes('disabled')));
    searchFor(app, 'broken'); await searchDelay(app);
    assert.ok(app.nodes().some((n) => n.props?.role === 'alert' && text(n) === 'Index offline'));
    searchFor(app, ''); assert.ok(!app.nodes().some((n) => n.props?.['aria-label'] === 'Course search results'));
    app.unmount();
});
test('a search resolving after unmount cannot update the reader', async () => {
    const late = deferred();
    const app = await mountReader({ coursesSearch: () => late.promise });
    searchFor(app, 'late'); await searchDelay(app);
    app.unmount(); late.resolve({ ok: true, results: [{ lessonId: 'l0', title: 'Late', snippet: 'Too late' }] });
    await Promise.resolve(); await Promise.resolve();
});
test('course switch drops late full-text hits and only the new course can be searched', async () => {
    const old = deferred(), calls = [];
    const app = await mountReader({ coursesGet: async (id) => ({ course: { ...course, id }, lessons }), coursesSearch: (id, q) => { calls.push([id, q]); return id === 'c1' ? old.promise : Promise.resolve({ ok: true, results: [{ lessonId: 'l3', title: 'New course hit', snippet: 'Fresh result' }] }); } });
    searchFor(app, 'first'); await searchDelay(app);
    app.update({ courseId: 'c2' }); await app.flush();
    old.resolve({ ok: true, results: [{ lessonId: 'l2', title: 'Old course hit', snippet: 'Old result' }] }); await app.flush();
    assert.ok(!app.nodes().some((n) => text(n).includes('Old result')));
    searchFor(app, 'second'); await searchDelay(app);
    assert.deepEqual(calls, [['c1', 'first'], ['c2', 'second']]);
    clickText(app, 'New course hit Fresh result'); await app.flush();
    assert.equal(find(app, (n) => n.type === 'main').props.key, 'l3');
    app.unmount();
});
for (const envelope of [{ disabled: true }, { error: 'Read failed' }, { ok: true, content: '' }]) {
    test(`lesson failure is visible and retryable: ${JSON.stringify(envelope)}`, async () => {
        let calls = 0;
        const app = await mountReader({ coursesLessonContent: async () => ++calls === 1 ? envelope : { ok: true, content: 'Recovered lesson' } });
        assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && n.props.alert));
        clickText(app, 'Retry lesson'); await app.flush();
        assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Recovered lesson'));
    });
}
test('old lesson responses cannot replace the newer lesson or write after unmount', async () => {
    const old = deferred();
    const app = await mountReader({ coursesLessonContent: async (_, id) => id === 'l0' ? old.promise : { ok: true, content: 'Newer lesson' } });
    clickLabel(app, 'Next lesson'); await app.flush();
    old.resolve({ ok: true, content: 'Stale lesson' }); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Newer lesson'));
    const late = deferred();
    const closed = await mountReader({ coursesLessonContent: () => late.promise });
    closed.unmount(); late.resolve({ ok: true, content: 'Too late' }); await Promise.resolve(); await Promise.resolve();
});
test('course switch cancels old saves and old content while the new course loads', async () => {
    const save = deferred(), body = deferred(), nextCourse = deferred();
    const app = await mountReader({ coursesGet: (id) => id === 'c1' ? Promise.resolve({ course, lessons }) : nextCourse.promise, coursesSetLessonCompleted: () => save.promise, coursesLessonContent: () => body.promise });
    const saving = clickLabel(app, 'Mark as complete');
    app.update({ courseId: 'c2' });
    save.resolve({ error: 'Old failure' }); body.resolve({ ok: true, content: 'Old content' });
    await saving; await app.flush();
    nextCourse.resolve({ course: { id: 'c2', name: 'Next course' }, lessons }); await app.flush();
    assert.equal(find(app, (n) => n.props?.title === 'Mark as complete').props['aria-pressed'], false);
    assert.ok(!app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Old failure')));
});
test('course load reports its actual error and supports retry', async () => {
    let calls = 0;
    const app = await mountReader({ coursesGet: async () => ++calls === 1 ? { error: 'Course read failed' } : { course, lessons } });
    assert.ok(app.nodes().some((n) => text(n).includes('Course read failed')));
    clickText(app, 'Retry'); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'StudyRail'));
});
const railProps = { courseId: 'c1', scopeLessons: [{ id: 'l0', title: 'Lesson 0' }], externalLinks: [] };
test('study aid requests are single-flight and synchronous bridge failures release loading', async () => {
    let calls = 0;
    const app = mount('StudyRail', { coursesGenerateStudyAid() { calls++; throw new Error('Local provider offline'); } }, railProps);
    clickText(app, 'Generate Summary'); await app.flush();
    assert.equal(calls, 1);
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Local provider offline')));
    assert.equal(find(app, (n) => text(n) === 'Generate Summary').props.disabled, false);
});
test('study aid response from the previous scope cannot populate the new scope', async () => {
    const old = deferred();
    const app = mount('StudyRail', { coursesGenerateStudyAid: () => old.promise }, railProps);
    clickText(app, 'Generate Summary'); app.render();
    app.update({ scopeLessons: [{ id: 'l4', title: 'Lesson 4' }] });
    old.resolve({ ok: true, data: 'Stale summary' }); await app.flush();
    assert.ok(!app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Stale summary'));
    assert.equal(find(app, (n) => text(n) === 'Generate Summary').props.disabled, false);
});
test('study aid errors preserve provider details, retry bypasses cache, and settings is actionable', async () => {
    const requests = []; let tab;
    const app = mount('StudyRail', { coursesGenerateStudyAid: async (...args) => { requests.push(args); return { ok: false, error: 'Selected local model is not loaded' }; }, openSettingsTab: (id) => { tab = id; } }, railProps);
    clickText(app, 'Generate Summary'); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Selected local model is not loaded')));
    clickText(app, 'Retry summary'); await app.flush();
    assert.equal(requests[1][3], true);
    clickText(app, 'AI provider settings'); assert.equal(tab, 'ai-providers');
});
test('study aid requests cannot write after unmount', async () => {
    const late = deferred();
    const app = mount('StudyRail', { coursesGenerateStudyAid: () => late.promise }, railProps);
    clickText(app, 'Generate Summary'); app.unmount(); late.resolve({ ok: true, data: 'Late summary' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
});
test('library transport failures do not claim premium is required, even with an empty list', async () => {
    const app = mount('CoursesHome', { coursesList: async () => { throw new Error('Library offline'); }, onCoursesProgress: () => () => {} });
    await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Library offline')));
    clickText(app, 'Retry'); await app.flush();
});
for (const platform of ['darwin', 'win32']) {
    test(`${platform}: library estimate and import progress stay distinct from study progress`, async () => {
        const app = mount('CoursesHome', {
            platform,
            coursesList: async () => [{ ...course, lessonCount: 6, chunkCount: 2, readingMinutes: 41, providedMinutes: 17, status: 'partial', enabled: true, stats: { planned: 8, succeeded: 3 } }],
        });
        await app.flush();
        assert.ok(app.nodes().some((n) => text(n).includes('6 lessons')));
        const readingLabels = app.nodes().filter((n) => n.type === 'span' && n.props?.className?.includes('border-accent-border')).map((n) => text(n).replace(/\s+/g, ' '));
        assert.ok(readingLabels.some((label) => /Reading time\s*:\s*~41 min/.test(label) && /17 min source durations\s*·\s*~\s*24 min estimated from lesson content/.test(label)), JSON.stringify(readingLabels));
        const bar = find(app, (n) => n.props?.role === 'progressbar');
        assert.equal(bar.props['aria-label'], 'Import progress');
        assert.equal(bar.props['aria-valuenow'], 38);
        const open = find(app, (n) => n.props?.['aria-label'] === 'Open course: Example course');
        assert.equal(open.type, 'LiquidGlassButton');
        assert.equal(open.props.variant, 'action');
        assert.ok(open.props.className.includes('bg-accent-primary'));
        open.props.onClick(); app.render();
        assert.ok(app.nodes().some((n) => n.type === 'LessonReader' && n.props.courseId === 'c1'));
        app.unmount();
    });
    test(`${platform}: source-only and estimate-only reading times keep their origin labels`, async () => {
        const app = mount('CoursesHome', { platform, coursesList: async () => [
            { ...course, readingMinutes: 18, providedMinutes: 18, lessonCount: 3, enabled: true, status: 'ready', stats: {} },
            { ...course, id: 'c2', name: 'Estimated course', readingMinutes: 23, providedMinutes: 0, lessonCount: 2, enabled: true, status: 'ready', stats: {} },
        ] });
        await app.flush();
        const labels = app.nodes().filter((n) => n.type === 'span' && n.props?.className?.includes('border-accent-border') && text(n).includes('Reading time')).map((n) => text(n).replace(/\s+/g, ' '));
        assert.match(labels[0], /18 min\s*\(\s*source durations\s*\)/);
        assert.match(labels[1], /~23 min\s*\(\s*estimated from lesson content\s*\)/);
        app.unmount();
    });
    test(`${platform}: library labels partial timing coverage without claiming an untimed course total`, async () => {
        const app = mount('CoursesHome', { platform, coursesList: async () => [
            { ...course, lessonCount: 6, timedLessonCount: 2, readingMinutes: 41, providedMinutes: 17, enabled: true, status: 'ready', stats: {} },
            { ...course, id: 'c2', name: 'Untimed course', lessonCount: 6, timedLessonCount: 0, readingMinutes: 0, providedMinutes: 0, enabled: true, status: 'ready', stats: {} },
        ] });
        await app.flush();
        const readingLabel = (id) => {
            const row = find(app, (n) => n.type === 'li' && n.props?.key === id);
            return text(flatten(row).find((n) => n.type === 'span' && text(n).includes('Reading time'))).replace(/\s+/g, ' ');
        };
        const partial = readingLabel('c1');
        assert.match(partial, /Reading time\s*:\s*~41 min/);
        assert.match(partial, /2\s*\/\s*6 timed lessons/);
        assert.match(partial, /17 min source durations\s*·\s*~\s*24 min estimated from lesson content/);
        const untimed = readingLabel('c2');
        assert.match(untimed, /Reading time\s*:\s*Not available/);
        assert.match(untimed, /0\s*\/\s*6 timed lessons/);
        assert.doesNotMatch(untimed, /\d+\s*min\b|source durations|estimated from lesson content/);
        app.unmount();
    });
    test(`${platform}: missing or invalid duration totals never invent a reading time`, async () => {
        const app = mount('CoursesHome', {
            platform,
            coursesList: async () => [
                { ...course, lessonCount: 6, readingMinutes: -2, status: 'ready', enabled: true, stats: {} },
                { ...course, id: 'c2', name: 'Second course', status: 'importing', enabled: true, stats: { planned: -1, succeeded: 2 } },
            ],
        });
        await app.flush();
        assert.equal(app.nodes().filter((n) => n.type === 'span' && n.props?.className?.includes('border-accent-border') && text(n).includes('Not available')).length, 2);
        assert.ok(!app.nodes().some((n) => n.props?.role === 'progressbar'));
        app.unmount();
    });
}
test('library management rejection is reported rather than escaping the event handler', async () => {
    const app = mount('CoursesHome', { coursesList: async () => [{ ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' }], onCoursesProgress: () => () => {}, coursesExportBundle: async () => { throw new Error('Save dialog failed'); } });
    await app.flush();
    const btn = find(app, (n) => n.props?.onClick && text(n).trim() === 'Export');
    btn.props.onClick({ stopPropagation() {} }); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Save dialog failed')));
});
test('study aid single-flight lock survives a stale request finishing in the new scope', async () => {
    const old = deferred(), next = deferred(); let calls = 0;
    const app = mount('StudyRail', { coursesGenerateStudyAid: () => ++calls === 1 ? old.promise : next.promise }, railProps);
    const button = find(app, (n) => text(n) === 'Generate Summary');
    const request = button.props.onClick(); button.props.onClick();
    assert.equal(calls, 1);
    app.update({ scopeLessons: [{ id: 'l4', title: 'Lesson 4' }] });
    clickText(app, 'Generate Summary'); app.render();
    old.resolve({ ok: true, data: 'Old summary' }); await request; await app.flush();
    assert.equal(find(app, (n) => text(n) === 'Generating Summary…').props.disabled, true);
    next.resolve({ ok: true, data: 'New summary' }); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'New summary'));
});
test('generated aid state clears when the course or scoped lessons change', async () => {
    const app = mount('StudyRail', { coursesGenerateStudyAid: async () => ({ ok: true, data: 'First scope summary' }) }, railProps);
    clickText(app, 'Generate Summary'); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown'));
    app.update({ courseId: 'c2' });
    assert.ok(!app.nodes().some((n) => n.type === 'LessonMarkdown'));
});
test('completion failure remains associated with its lesson after navigating', async () => {
    const save = deferred();
    const app = await mountReader({ coursesSetLessonCompleted: () => save.promise });
    const saving = clickLabel(app, 'Mark as complete');
    clickLabel(app, 'Next lesson'); await app.flush();
    save.resolve({ error: 'Lesson zero save failed' }); await saving; await app.flush();
    assert.ok(!app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Lesson zero save failed')));
    clickLabel(app, 'Previous lesson'); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Lesson zero save failed')));
});
test('opening a searched resource reveals its index row without offering lesson completion', async () => {
    let saves = 0;
    const extra = { ...lessons[0], id: 'lab', title: 'Practice lab', parent: 'module', kind: 'lab', completedAt: null };
    const app = await mountReader({
        coursesGet: async () => ({ course, lessons: [...lessons, extra] }),
        coursesSearch: async () => ({ ok: true, results: [{ lessonId: 'lab', title: 'Practice lab', snippet: 'hands on', parent: 'module' }] }),
        coursesSetLessonCompleted: async () => { saves += 1; return { ok: true }; },
    });
    searchFor(app, 'hands on'); await searchDelay(app);
    const module = find(app, (n) => n.type === 'button' && n.props?.['aria-expanded'] === true && n.props?.['aria-controls']?.startsWith('course-module-'));
    module.props.onClick(); app.render();
    assert.equal(find(app, (n) => n.props?.id === module.props['aria-controls']).props.hidden, true);
    find(app, (n) => n.type === 'button' && text(n).includes('hands on')).props.onClick(); await app.flush();
    assert.equal(find(app, (n) => n.props?.id === module.props['aria-controls']).props.hidden, false);
    assert.ok(!app.nodes().some((n) => n.props?.['aria-label'] === 'Mark as complete'));
    assert.equal(saves, 0);
    app.unmount();
});
test('completion rejection after closing the reader cannot update state', async () => {
    const save = deferred();
    const app = await mountReader({ coursesSetLessonCompleted: () => save.promise });
    const saving = clickLabel(app, 'Mark as complete');
    app.unmount(); save.reject(new Error('Late failure')); await saving;
});
test('failed empty-library import exposes the returned backend error in the form', async () => {
    const app = mount('CoursesHome', { coursesList: async () => [], coursesImport: async () => ({ ok: false, error: 'No pages were imported' }), onCoursesProgress: () => () => {} });
    await app.flush(); clickText(app, 'Import course'); app.render();
    find(app, (n) => n.props?.id === 'course-import-url').props.onChange({ target: { value: 'https://example.com/course' } }); app.render();
    find(app, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.ok(app.nodes().some((n) => n.props?.role === 'alert' && text(n).includes('No pages were imported')));
    assert.equal(find(app, (n) => n.props?.id === 'course-import-url').props['aria-invalid'], true);
});
test('library shows one course count and one course title', async () => {
    const row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' };
    const app = mount('CoursesHome', { coursesList: async () => [row] });
    await app.flush();
    assert.equal(app.nodes().filter((n) => n.type === 'span' && text(n).replace(/\s+/g, ' ').trim() === '1 course').length, 1);
    assert.equal(app.nodes().filter((n) => n.type === 'span' && text(n) === course.name).length, 1);
    app.unmount();
});
test('failed import reports the error once in the form, without a second notice', async () => {
    const app = mount('CoursesHome', { coursesList: async () => [], coursesImport: async () => ({ ok: false, error: 'No pages were imported' }) });
    await app.flush(); clickText(app, 'Import course'); app.render();
    find(app, (n) => n.props?.id === 'course-import-url').props.onChange({ target: { value: 'https://example.com/course' } }); app.render();
    find(app, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.equal(app.nodes().filter((n) => n.props?.role === 'alert' && text(n).includes('No pages were imported')).length, 1);
    assert.ok(!app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('No pages were imported')));
    app.unmount();
});
test('active import uses its progress card instead of repeating its row meter', async () => {
    const rows = [
        { ...course, lessonCount: 6, enabled: true, status: 'importing', stats: { planned: 8, succeeded: 3 } },
        { ...course, id: 'c2', name: 'Another course', lessonCount: 4, enabled: true, status: 'partial', stats: { planned: 6, succeeded: 2 } },
    ];
    const app = mount('CoursesHome', { coursesList: async () => rows, coursesImport: async () => ({ courseId: 'c1' }) });
    await app.flush();
    assert.equal(app.nodes().filter((n) => n.props?.role === 'progressbar').length, 2);
    clickText(app, 'Import course'); app.render();
    find(app, (n) => n.props?.id === 'course-import-url').props.onChange({ target: { value: 'https://example.com/course' } }); app.render();
    find(app, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.equal(app.nodes().filter((n) => n.type === 'CourseProgressCard' && n.props.progress.courseId === 'c1').length, 1);
    assert.equal(app.nodes().filter((n) => n.props?.role === 'progressbar').length, 1, 'other course retains its own meter');
    app.unmount();
});
test('terminal import card displays status once while retaining details and recovery', () => {
    const done = mount('CourseProgressCard', {}, { progress: { phase: 'done', done: 3, total: 3, failed: 0, skipped: 0 } });
    assert.equal(done.nodes().filter((n) => n.type === 'AipBadge' && n.props.label === 'Complete').length, 1);
    assert.ok(!done.nodes().some((n) => n.type === 'p' && text(n).includes('Complete')));
    assert.ok(done.nodes().some((n) => n.type === 'p' && text(n).replace(/\s+/g, ' ').trim() === '3 pages'));
    done.unmount();
    const failed = mount('CourseProgressCard', {}, { progress: { phase: 'failed', done: 1, total: 3, current: 'Server returned 500', failed: 0, skipped: 0 }, onRetry() {}, onDismiss() {} });
    assert.equal(failed.nodes().filter((n) => n.type === 'AipBadge' && n.props.label === 'Failed').length, 1);
    assert.ok(!failed.nodes().some((n) => n.type === 'p' && text(n).includes('Failed')));
    assert.equal(failed.nodes().filter((n) => n.type === 'p' && text(n) === 'Server returned 500').length, 1);
    assert.ok(failed.nodes().some((n) => n.type === 'LiquidGlassButton' && text(n) === 'Retry'));
    assert.ok(failed.nodes().some((n) => n.type === 'LiquidGlassButton' && text(n) === 'Dismiss'));
    failed.unmount();
});
test('library course toggle rolls back a resolved error envelope and reports it', async () => {
    const row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' };
    const app = mount('CoursesHome', { coursesList: async () => [row], coursesSetEnabled: async () => ({ error: 'Toggle failed' }), onCoursesProgress: () => () => {} });
    await app.flush(); find(app, (n) => n.type === 'SettingsSwitch').props.onChange(); await app.flush();
    assert.equal(find(app, (n) => n.type === 'SettingsSwitch').props.checked, true);
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Could not update this course')));
});
test('late library responses are ignored after unmount', async () => {
    const list = deferred();
    const app = mount('CoursesHome', { coursesList: () => list.promise, onCoursesProgress: () => () => {} });
    app.unmount(); list.resolve([]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
});
test('tabs expose only the selected saved aid with scope, progress and external links', async () => {
    const data = {
        summary: 'Saved summary', glossary: { entries: [{ term: 'Key term', definition: 'Meaning' }] },
        quiz: { questions: [{ q: 'Question', options: ['Yes', 'No'], answer: 0 }] },
        flashcards: { cards: [{ front: 'Front', back: 'Back' }] },
    };
    const lookups = [], generations = [], links = [];
    const api = {
        coursesLookupStudyAid: async (...args) => { lookups.push(args); return { ok: true, cached: true, data: data[args[1]] }; },
        coursesGenerateStudyAid: (...args) => { generations.push(args); throw new Error('Unexpected generation'); },
        openExternal: async (url) => { links.push(url); },
    };
    const props = { ...railProps, moduleLabel: 'Module A', externalLinks: [{ title: 'Lab A', url: 'https://example.com/lab' }] };
    const app = mount('StudyRail', api, props); await app.flush();
    assert.deepEqual(lookups.map((args) => args.slice(0, 3)), ['summary', 'glossary', 'quiz', 'flashcards'].map((type) => ['c1', type, ['l0']]));
    assert.equal(generations.length, 0);
    const tabs = app.nodes().filter((n) => n.props?.role === 'tab');
    assert.equal(app.nodes().filter((n) => n.props?.role === 'tablist').length, 1);
    assert.deepEqual(tabs.map((n) => [text(n), n.props['aria-selected'], n.props.tabIndex]), [['Summary', true, 0], ['Glossary', false, -1], ['Quiz', false, -1], ['Flashcards', false, -1]]);
    const panel = find(app, (n) => n.props?.role === 'tabpanel');
    assert.equal(panel.props.id, tabs[0].props['aria-controls']);
    assert.equal(panel.props['aria-labelledby'], tabs[0].props.id);
    assert.ok(text(panel).replace(/\s+/g, ' ').includes('Module A · 1 lesson'));
    const disclosure = find(app, (n) => n.type === 'details' && text(n).includes('Scope:'));
    assert.equal(disclosure.props.open, undefined, 'scope starts collapsed');
    assert.ok(flatten(disclosure).some((n) => n.type === 'summary' && text(n).includes('Module A')));
    assert.ok(flatten(disclosure).some((n) => n.type === 'li' && text(n) === 'Lesson 0'));
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Saved summary'));
    assert.ok(app.nodes().some((n) => n.type === 'QuizPlayer' && n.props.questions.length === 1));
    assert.ok(app.nodes().some((n) => n.type === 'Flashcards' && n.props.cards.length === 1));
    assert.ok(app.nodes().filter((n) => n.props?.inert).length === 2, 'inactive drills stay mounted but cannot be interacted with');
    assert.ok(!app.nodes().some((n) => n.props?.['aria-label'] === 'Course completion'), 'study aids do not repeat the index progress');
    clickLabel(app, 'Open Lab A in the browser'); await app.flush(); assert.deepEqual(links, ['https://example.com/lab']);
    clickText(app, 'Glossary'); app.render();
    assert.equal(find(app, (n) => n.props?.role === 'tabpanel').props['aria-labelledby'], tabs[1].props.id);
    assert.ok(!app.nodes().some((n) => n.type === 'LessonMarkdown'));
    assert.ok(app.nodes().some((n) => n.type === 'QuizPlayer'), 'switching tabs does not reset a saved quiz');
    assert.ok(text(find(app, (n) => n.props?.role === 'tabpanel')).includes('Key term'));
    clickText(app, 'Quiz'); app.render();
    assert.ok(app.nodes().some((n) => n.type === 'QuizPlayer'));
    assert.ok(app.nodes().some((n) => n.type === 'Flashcards'));
    const quizKey = find(app, (n) => n.type === 'QuizPlayer').props.key;
    clickText(app, 'Flashcards'); app.render();
    assert.ok(app.nodes().some((n) => n.type === 'Flashcards'));
    assert.equal(find(app, (n) => n.type === 'QuizPlayer').props.key, quizKey, 'tab switch keeps quiz session mounted');
    assert.ok(app.nodes().some((n) => n.props?.['data-study-aid-player'] === ''), 'only the active drill claims Escape');
    app.unmount();
    const reopened = mount('StudyRail', api, props); await reopened.flush();
    assert.ok(reopened.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Saved summary'));
    assert.equal(lookups.length, 8);
    assert.equal(generations.length, 0);
    reopened.unmount();
});
test('tab keyboard arrows, Home and End select the only panel without generating', () => {
    const app = mount('StudyRail', {}, railProps);
    const key = (name, eventKey) => {
        let prevented = false;
        find(app, (n) => n.props?.role === 'tab' && text(n) === name).props.onKeyDown({ key: eventKey, preventDefault() { prevented = true; } });
        app.render(); assert.equal(prevented, true);
    };
    key('Summary', 'ArrowLeft'); assert.equal(find(app, (n) => n.props?.role === 'tabpanel').props['aria-labelledby'], find(app, (n) => n.props?.role === 'tab' && text(n) === 'Flashcards').props.id);
    key('Flashcards', 'Home'); assert.equal(find(app, (n) => n.props?.role === 'tab' && text(n) === 'Summary').props['aria-selected'], true);
    key('Summary', 'End'); assert.equal(find(app, (n) => n.props?.role === 'tab' && text(n) === 'Flashcards').props['aria-selected'], true);
    app.unmount();
});
test('switching module loads its saved aids and ignores late cache from an earlier scope', async () => {
    const old = deferred(), late = deferred(); const calls = [];
    const app = mount('StudyRail', { coursesLookupStudyAid: (id, type, ids) => {
        calls.push([id, type, ids]);
        if (id === 'c1' && type === 'summary') return old.promise;
        if (id === 'c2' && type === 'quiz') return late.promise;
        if (id === 'c2' && type === 'summary') return Promise.resolve({ ok: true, cached: true, data: 'New saved summary' });
        return Promise.resolve({ ok: true, cached: false, data: null });
    }, coursesGenerateStudyAid: () => { throw new Error('Lookup must not generate'); } }, railProps);
    await app.flush();
    app.update({ courseId: 'c2', scopeLessons: [{ id: 'l4', title: 'Lesson 4' }], moduleLabel: 'Module B' }); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'New saved summary'));
    old.resolve({ ok: true, cached: true, data: 'Old saved summary' }); await app.flush();
    assert.ok(!app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Old saved summary'));
    assert.ok(text(find(app, (n) => n.props?.role === 'tabpanel')).replace(/\s+/g, ' ').includes('Module B · 1 lesson'));
    assert.equal(calls.length, 8);
    app.unmount(); late.resolve({ ok: true, cached: true, data: { questions: [{ q: 'Too late', options: ['A', 'B'], answer: 0 }] } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
});
test('missing lookup API does not trigger legacy cache calls or background generation', async () => {
    const calls = [];
    const app = mount('StudyRail', { coursesGenerateStudyAid: async (...args) => { calls.push(args); return { ok: true, data: 'Generated' }; } }, railProps);
    await app.flush(); assert.equal(calls.length, 0);
    clickText(app, 'Generate Summary'); await app.flush();
    assert.deepEqual(calls, [['c1', 'summary', ['l0'], false]]);
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Generated'));
    app.unmount();
});
test('regenerated drills get a new player identity even with identical quiz content', async () => {
    const requests = [];
    const app = mount('StudyRail', { coursesGenerateStudyAid: async (...args) => {
        requests.push(args); return { ok: true, data: { questions: [{ q: 'Same question', options: ['Yes', 'No'], answer: 0 }] } };
    } }, railProps);
    clickText(app, 'Quiz'); app.render();
    clickText(app, 'Generate Quiz'); await app.flush();
    const first = find(app, (n) => n.type === 'QuizPlayer').props.key;
    clickText(app, 'Regenerate Quiz'); await app.flush();
    assert.notEqual(find(app, (n) => n.type === 'QuizPlayer').props.key, first);
    assert.deepEqual(requests.map((args) => args[3]), [false, true]);
});
for (const platform of ['darwin', 'win32']) {
    test(`${platform}: library off clears the stale pin override after confirmed IPC`, async () => {
        let row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' };
        const save = deferred(), calls = [];
        const app = mount('CoursesHome', {
            platform,
            coursesList: async () => [row],
            coursesSetEnabled: (id, enabled) => { calls.push([id, enabled]); return save.promise; },
        }, {}, ['c1', 'other']);
        await app.flush();
        const saving = find(app, (n) => n.type === 'SettingsSwitch').props.onChange();
        assert.deepEqual(app.coursePins.getCoursePinIds(), ['c1', 'other'], 'pins survive until the store acknowledges');
        app.coursePins.setCoursePinIds(['c1', 'other', 'new']);
        row = { ...row, enabled: false }; save.resolve({ course: row });
        await saving; await app.flush();
        assert.deepEqual(calls, [['c1', false]]);
        assert.deepEqual(app.coursePins.getCoursePinIds(), ['other', 'new']);
        assert.equal(app.coursePins.isCourseGroundingEnabled(row, app.coursePins.getCoursePinIds()), false);
        assert.equal(find(app, (n) => n.type === 'SettingsSwitch').props.checked, false);
        app.unmount();
    });
    test(`${platform}: legacy disabled-but-pinned library row can actually be switched off`, async () => {
        const row = { ...course, lessonCount: 6, stats: {}, enabled: false, status: 'ready' };
        const calls = [];
        const app = mount('CoursesHome', { platform, coursesList: async () => [row], coursesSetEnabled: async (id, enabled) => { calls.push([id, enabled]); return { course: { ...row, enabled } }; } }, {}, ['c1']);
        await app.flush();
        assert.equal(find(app, (n) => n.type === 'SettingsSwitch').props.checked, true);
        await find(app, (n) => n.type === 'SettingsSwitch').props.onChange(); await app.flush();
        assert.deepEqual(calls, [['c1', false]]);
        assert.deepEqual(app.coursePins.getCoursePinIds(), []);
        app.unmount();
    });
}
test('library refresh receives reciprocal toolbar events once and unsubscribes without a loop', async () => {
    let row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' }, reads = 0, notifications = 0;
    const app = mount('CoursesHome', { coursesList: async () => { reads++; return [row]; } });
    const unsubscribe = app.coursePins.subscribeCourseStateChanged(() => { notifications++; });
    await app.flush(); assert.equal(reads, 1); assert.equal(notifications, 0);
    row = { ...row, enabled: false }; app.coursePins.notifyCourseStateChanged(); await app.flush();
    assert.equal(reads, 2); assert.equal(notifications, 1);
    assert.equal(find(app, (n) => n.type === 'SettingsSwitch').props.checked, false);
    app.coursePins.setCoursePinIds(['c1']); await app.flush();
    assert.equal(reads, 3); assert.equal(notifications, 2);
    assert.equal(find(app, (n) => n.type === 'SettingsSwitch').props.checked, true);
    app.unmount(); unsubscribe();
    assert.equal(app.listenerCount('natively:course-state-changed'), 0);
    assert.equal(app.listenerCount('storage'), 0);
    app.coursePins.notifyCourseStateChanged(); await app.flush(); assert.equal(reads, 3);
});
test('failed pin persistence leaves library grounding on and reports the helper failure', async () => {
    let row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' };
    const app = mount('CoursesHome', { coursesList: async () => [row], coursesSetEnabled: async () => { row = { ...row, enabled: false }; return { course: row }; } }, {}, ['c1']);
    await app.flush(); app.window.localStorage.setItem = () => { throw new Error('Storage full'); };
    await find(app, (n) => n.type === 'SettingsSwitch').props.onChange(); await app.flush();
    assert.equal(find(app, (n) => n.type === 'SettingsSwitch').props.checked, true);
    assert.deepEqual(app.coursePins.getCoursePinIds(), ['c1']);
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('still selected')));
    app.unmount();
});
for (const [label, apiName, response] of [
    ['Import bundle (.zip)', 'coursesImportBundle', { ok: true, courseId: 'c2' }],
    ['Re-index', 'coursesReindex', { indexed: 4, skipped: 0 }],
]) {
    test(`${label}: successful mutation notifies reciprocal subscribers without a refresh loop`, async () => {
        const row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' };
        let notifications = 0, reads = 0;
        const app = mount('CoursesHome', { coursesList: async () => { reads++; return [row]; }, [apiName]: async () => response });
        const unsubscribe = app.coursePins.subscribeCourseStateChanged(() => { notifications++; });
        await app.flush();
        find(app, (n) => n.props?.onClick && text(n).trim() === label).props.onClick({ stopPropagation() {} }); await app.flush();
        assert.equal(notifications, 1); assert.equal(reads, 2);
        app.unmount(); unsubscribe();
    });
    test(`${label}: failed or canceled mutation does not notify`, async () => {
        const row = { ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' };
        let notifications = 0;
        const app = mount('CoursesHome', { coursesList: async () => [row], [apiName]: async () => apiName === 'coursesImportBundle' ? { canceled: true } : { error: 'Index failed' } });
        const unsubscribe = app.coursePins.subscribeCourseStateChanged(() => { notifications++; });
        await app.flush();
        find(app, (n) => n.props?.onClick && text(n).trim() === label).props.onClick({ stopPropagation() {} }); await app.flush();
        assert.equal(notifications, 0); app.unmount(); unsubscribe();
    });
}
test('successful deletion clears only that course pin using the latest persisted selection', async () => {
    let rows = [{ ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' }], reads = 0, notifications = 0;
    const deletion = deferred();
    const app = mount('CoursesHome', { coursesList: async () => { reads++; return rows; }, coursesDeleteCourse: () => deletion.promise }, {}, ['c1', 'other']);
    const unsubscribe = app.coursePins.subscribeCourseStateChanged(() => { notifications++; });
    await app.flush();
    find(app, (n) => n.props?.onClick && text(n).trim() === 'Delete').props.onClick({ stopPropagation() {} }); app.render();
    find(app, (n) => n.props?.onClick && text(n).trim() === 'Confirm').props.onClick({ stopPropagation() {} });
    app.coursePins.setCoursePinIds(['c1', 'other', 'new']); await app.flush();
    const before = reads;
    rows = []; deletion.resolve({ ok: true }); await app.flush();
    assert.deepEqual(app.coursePins.getCoursePinIds(), ['other', 'new']);
    assert.equal(notifications, 2); assert.equal(reads, before + 1);
    app.unmount(); unsubscribe();
});
test('delete pin-persistence failure reports partial success and still notifies', async () => {
    const app = mount('CoursesHome', { coursesList: async () => [{ ...course, lessonCount: 6, stats: {}, enabled: true, status: 'ready' }], coursesDeleteCourse: async () => ({ ok: true }) }, {}, ['c1']);
    let notifications = 0; const unsubscribe = app.coursePins.subscribeCourseStateChanged(() => { notifications++; });
    await app.flush(); app.window.localStorage.setItem = () => { throw new Error('Storage full'); };
    find(app, (n) => n.props?.onClick && text(n).trim() === 'Delete').props.onClick({ stopPropagation() {} }); app.render();
    find(app, (n) => n.props?.onClick && text(n).trim() === 'Confirm').props.onClick({ stopPropagation() {} }); await app.flush();
    assert.equal(notifications, 1);
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('pinned selection could not be cleared')));
    app.unmount(); unsubscribe();
});
test('import adoption and both terminal statuses notify, but intermediate progress does not', async () => {
    let progress, reads = 0, notifications = 0;
    const app = mount('CoursesHome', {
        coursesList: async () => { reads++; return []; },
        coursesImport: async () => ({ courseId: 'c1' }),
        onCoursesProgress: (fn) => { progress = fn; return () => { progress = undefined; }; },
    });
    const unsubscribe = app.coursePins.subscribeCourseStateChanged(() => { notifications++; });
    await app.flush(); clickText(app, 'Import course'); app.render();
    find(app, (n) => n.props?.id === 'course-import-url').props.onChange({ target: { value: 'https://example.com/course' } }); app.render();
    find(app, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.equal(notifications, 1); assert.equal(reads, 2);
    progress({ courseId: 'c1', phase: 'page', done: 1, total: 2 }); await app.flush();
    assert.equal(notifications, 1);
    progress({ courseId: 'c1', phase: 'failed' }); await app.flush();
    assert.equal(notifications, 2); assert.equal(reads, 3);
    progress({ courseId: 'c1', phase: 'done' }); await app.flush();
    assert.equal(notifications, 3); assert.equal(reads, 4);
    app.unmount(); unsubscribe(); assert.equal(progress, undefined);
});
test('terminal import outside a local run refreshes reciprocal consumers too', async () => {
    let progress, reads = 0;
    const app = mount('CoursesHome', { coursesList: async () => { reads++; return []; }, onCoursesProgress: (fn) => { progress = fn; return () => {}; } });
    await app.flush(); progress({ courseId: 'external', stage: 'done' }); await app.flush();
    assert.equal(reads, 2); app.unmount();
});
test('reader and aids stay inside the launcher with shared settings tokens', () => {
    const reader = source('LessonReader'), home = source('CoursesHome'), rail = source('StudyRail');
    assert.match(reader, /h-full min-h-0/);
    assert.match(home, /if \(openCourseId\) return <LessonReader/);
    assert.equal((reader.match(/<StudyRail\b/g) ?? []).length, 1);
    assert.ok(!/fixed inset-0|bg-black\/|bg-\[#/.test(reader + rail));
    for (const token of ['SETTINGS_CARD', 'SETTINGS_INPUT']) assert.ok(reader.includes(token));
    assert.match(reader, /<LiquidGlassButton/);
    assert.match(home, /<LiquidGlassButton/);
    assert.match(reader, /aria-current=/);
    assert.match(reader, /aria-expanded=\{railOpen\}/);
    assert.doesNotMatch(rail, /aria-valuenow=\{pct\}/);
});
