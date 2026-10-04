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
const text = (node) => Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' && node ? text(node.props?.children) : String(node ?? '');
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
test('study scope always includes the selected fifth lesson and only its module links', async () => {
    const app = await mountReader({ coursesGet: async () => ({ course, lessons: [...lessons, { ...lessons[0], id: 'lab', kind: 'lab', parent: 'other' }] }) }, { initialLessonId: 'l4' });
    const rails = app.nodes().filter((n) => n.type === 'StudyRail');
    assert.equal(rails.length, 1);
    assert.equal(rails[0].props.scopeLessons.length, 4);
    assert.ok(rails[0].props.scopeLessons.some((l) => l.id === 'l4'));
    assert.equal(rails[0].props.externalLinks.length, 0);
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
const railProps = { courseId: 'c1', scopeLessons: [{ id: 'l0', title: 'Lesson 0' }], progress: { done: 0, total: 1 }, externalLinks: [] };
test('study aid requests are single-flight and synchronous bridge failures release loading', async () => {
    let calls = 0;
    const app = mount('StudyRail', { coursesGenerateStudyAid() { calls++; throw new Error('Local provider offline'); } }, railProps);
    clickText(app, 'Summary'); await app.flush();
    assert.equal(calls, 1);
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Local provider offline')));
    assert.equal(find(app, (n) => n.props?.title === 'Summary from 1 lesson').props.disabled, false);
});
test('study aid response from the previous scope cannot populate the new scope', async () => {
    const old = deferred();
    const app = mount('StudyRail', { coursesGenerateStudyAid: () => old.promise }, railProps);
    clickText(app, 'Summary'); app.render();
    app.update({ scopeLessons: [{ id: 'l4', title: 'Lesson 4' }] });
    old.resolve({ ok: true, data: 'Stale summary' }); await app.flush();
    assert.ok(!app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'Stale summary'));
    assert.equal(find(app, (n) => n.props?.title === 'Summary from 1 lesson').props.disabled, false);
});
test('study aid errors preserve provider details, retry bypasses cache, and settings is actionable', async () => {
    const requests = []; let tab;
    const app = mount('StudyRail', { coursesGenerateStudyAid: async (...args) => { requests.push(args); return { ok: false, error: 'Selected local model is not loaded' }; }, openSettingsTab: (id) => { tab = id; } }, railProps);
    clickText(app, 'Summary'); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Selected local model is not loaded')));
    clickText(app, 'Retry summary'); await app.flush();
    assert.equal(requests[1][3], true);
    clickText(app, 'AI provider settings'); assert.equal(tab, 'ai-providers');
});
test('study aid requests cannot write after unmount', async () => {
    const late = deferred();
    const app = mount('StudyRail', { coursesGenerateStudyAid: () => late.promise }, railProps);
    clickText(app, 'Summary'); app.unmount(); late.resolve({ ok: true, data: 'Late summary' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
});
test('library transport failures do not claim premium is required, even with an empty list', async () => {
    const app = mount('CoursesHome', { coursesList: async () => { throw new Error('Library offline'); }, onCoursesProgress: () => () => {} });
    await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'SettingsNotice' && text(n).includes('Library offline')));
    clickText(app, 'Retry'); await app.flush();
});
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
    const button = find(app, (n) => n.props?.title === 'Summary from 1 lesson');
    const request = button.props.onClick(); button.props.onClick();
    assert.equal(calls, 1);
    app.update({ scopeLessons: [{ id: 'l4', title: 'Lesson 4' }] });
    clickText(app, 'Summary'); app.render();
    old.resolve({ ok: true, data: 'Old summary' }); await request; await app.flush();
    assert.equal(find(app, (n) => n.props?.title === 'Summary from 1 lesson').props.disabled, true);
    next.resolve({ ok: true, data: 'New summary' }); await app.flush();
    assert.ok(app.nodes().some((n) => n.type === 'LessonMarkdown' && n.props.content === 'New summary'));
});
test('generated aid state clears when the course or scoped lessons change', async () => {
    const app = mount('StudyRail', { coursesGenerateStudyAid: async () => ({ ok: true, data: 'First scope summary' }) }, railProps);
    clickText(app, 'Summary'); await app.flush();
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
test('regenerated drills get a new player identity, not an old quiz/deck session', async () => {
    let call = 0;
    const app = mount('StudyRail', { coursesGenerateStudyAid: async () => ({ ok: true, data: { questions: [{ q: `Question ${++call}`, options: ['Yes', 'No'], answer: 0 }] } }) }, railProps);
    clickText(app, 'Quiz'); await app.flush();
    const first = find(app, (n) => n.type === 'QuizPlayer').props.key;
    find(app, (n) => n.props?.title === 'Quiz from 1 lesson').props.onClick(); await app.flush();
    assert.notEqual(find(app, (n) => n.type === 'QuizPlayer').props.key, first);
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
    for (const token of ['SETTINGS_CARD', 'SETTINGS_INPUT', 'SETTINGS_BTN']) assert.ok(reader.includes(token));
    assert.match(reader, /aria-current=/);
    assert.match(reader, /aria-expanded=\{railOpen\}/);
    assert.match(rail, /aria-valuenow=\{pct\}/);
});
