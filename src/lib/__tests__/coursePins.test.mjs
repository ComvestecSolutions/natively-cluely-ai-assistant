import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    getCoursePinIds,
    isCourseGroundingEnabled,
    notifyCourseStateChanged,
    setCourseGroundingEnabled,
    setCoursePinIds,
    subscribeCourseStateChanged,
} from '../coursePins.ts';

const KEY = 'natively_course_pins';
const originalWindow = globalThis.window;
let storage;
let channels;
let calls;
let courses;

class TestChannel {
    constructor(name) {
        this.name = name;
        this.closed = false;
        channels.push(this);
    }
    postMessage(data) {
        for (const channel of channels) {
            if (channel !== this && !channel.closed && channel.name === this.name) channel.onmessage?.({ data });
        }
    }
    close() { this.closed = true; }
}

beforeEach(() => {
    storage = new Map();
    channels = [];
    calls = [];
    courses = new Map();
    globalThis.window = Object.assign(new EventTarget(), {
        BroadcastChannel: TestChannel,
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
        },
        electronAPI: {
            coursesSetEnabled: async (id, enabled) => {
                calls.push([id, enabled]);
                const course = { id, enabled };
                courses.set(id, course);
                return { course };
            },
        },
    });
});
afterEach(() => { globalThis.window = originalWindow; });

const storageEvent = (key) => Object.assign(new Event('storage'), { key });

test('pin reads validate, deduplicate, and tolerate corrupt or unavailable storage', () => {
    assert.deepEqual(getCoursePinIds(), []);
    storage.set(KEY, JSON.stringify(['one', 'one', '', null, 42, 'two']));
    assert.deepEqual(getCoursePinIds(), ['one', 'two']);
    for (const raw of ['{', '{}', 'null', '42']) {
        storage.set(KEY, raw);
        assert.deepEqual(getCoursePinIds(), []);
    }
    window.localStorage.getItem = () => { throw new Error('unavailable'); };
    assert.deepEqual(getCoursePinIds(), []);
});

test('checked state matches enabled OR pinned, not just the local pin list', () => {
    for (const enabled of [true, false, undefined]) {
        for (const pinned of [true, false]) {
            assert.equal(isCourseGroundingEnabled({ id: 'one', enabled }, pinned ? ['one'] : []), enabled === true || pinned);
        }
    }
    assert.equal(isCourseGroundingEnabled({ id: 'one', enabled: false }, ['two']), false);
});

for (const platform of ['darwin', 'win32']) {
    test(`${platform} renderer contract: off clears both sources of grounding without touching other courses`, async () => {
        window.electronAPI.platform = platform;
        setCoursePinIds(['one', 'two']);
        courses.set('one', { id: 'one', enabled: true });
        courses.set('two', { id: 'two', enabled: true });
        const result = await setCourseGroundingEnabled('one', false);
        assert.deepEqual(calls, [['one', false]], 'the preload API is positional');
        assert.deepEqual(getCoursePinIds(), ['two']);
        assert.equal(isCourseGroundingEnabled(result, getCoursePinIds()), false);
        const candidates = new Set([...getCoursePinIds(), ...[...courses.values()].filter((c) => c.enabled).map((c) => c.id)]);
        assert.deepEqual([...candidates], ['two'], 'the existing backend union no longer contains the disabled course');
    });
    test(`${platform} renderer contract: legacy disabled-but-pinned courses stay checked until explicitly disabled`, async () => {
        window.electronAPI.platform = platform;
        setCoursePinIds(['legacy']);
        const course = { id: 'legacy', enabled: false };
        assert.equal(isCourseGroundingEnabled(course, getCoursePinIds()), true);
        const result = await setCourseGroundingEnabled(course.id, false);
        assert.equal(isCourseGroundingEnabled(result, getCoursePinIds()), false);
        assert.deepEqual(calls, [['legacy', false]]);
    });
}

test('on persists enabled state without creating another pin override', async () => {
    const result = await setCourseGroundingEnabled('one', true);
    assert.deepEqual(calls, [['one', true]]);
    assert.equal(result.enabled, true);
    assert.deepEqual(getCoursePinIds(), []);
});

test('pins are not removed before the store acknowledges off; concurrent unrelated pins survive', async () => {
    setCoursePinIds(['one']);
    let resolve;
    window.electronAPI.coursesSetEnabled = () => new Promise((done) => { resolve = done; });
    const pending = setCourseGroundingEnabled('one', false);
    assert.deepEqual(getCoursePinIds(), ['one']);
    setCoursePinIds(['one', 'new']);
    resolve({ course: { id: 'one', enabled: false } });
    await pending;
    assert.deepEqual(getCoursePinIds(), ['new']);
});

for (const result of [undefined, null, { disabled: true }, { course: null }, { course: { id: 'other', enabled: false } }, { course: { id: 'one', enabled: true } }]) {
    test(`refused or malformed IPC response leaves pins intact: ${JSON.stringify(result)}`, async () => {
        setCoursePinIds(['one']);
        window.electronAPI.coursesSetEnabled = async () => result;
        await assert.rejects(setCourseGroundingEnabled('one', false));
        assert.deepEqual(getCoursePinIds(), ['one']);
    });
}

test('missing API and rejected IPC do not silently show off', async () => {
    setCoursePinIds(['one']);
    window.electronAPI.coursesSetEnabled = undefined;
    await assert.rejects(setCourseGroundingEnabled('one', false), /unavailable/);
    window.electronAPI.coursesSetEnabled = async () => { throw new Error('IPC failed'); };
    await assert.rejects(setCourseGroundingEnabled('one', false), /IPC failed/);
    assert.deepEqual(getCoursePinIds(), ['one']);
});

test('failed pin persistence is reported rather than falsely acknowledging off', async () => {
    setCoursePinIds(['one']);
    window.localStorage.setItem = () => { throw new Error('storage full'); };
    assert.equal(setCoursePinIds([]), false);
    await assert.rejects(setCourseGroundingEnabled('one', false), /still selected/);
    assert.equal(courses.get('one').enabled, false);
    assert.equal(isCourseGroundingEnabled(courses.get('one'), getCoursePinIds()), true);
});

test('same-window state/pin changes notify mounted subscribers once and clean up', async () => {
    let changes = 0;
    const unsubscribe = subscribeCourseStateChanged(() => ++changes);
    assert.equal(setCoursePinIds(['one', 'one', '']), true);
    assert.deepEqual(getCoursePinIds(), ['one']);
    assert.equal(changes, 1, 'own BroadcastChannel messages must not double-notify');
    await setCourseGroundingEnabled('one', false);
    assert.equal(changes, 2);
    await setCourseGroundingEnabled('one', true);
    assert.equal(changes, 3);
    unsubscribe();
    notifyCourseStateChanged();
    window.dispatchEvent(storageEvent(KEY));
    assert.equal(changes, 3);
    assert.ok(channels.every((channel) => channel.closed), 'sender and subscriber channels are released');
});

test('native storage notifications only refresh for course pins or storage clear', () => {
    let changes = 0;
    const unsubscribe = subscribeCourseStateChanged(() => ++changes);
    window.dispatchEvent(storageEvent('unrelated'));
    assert.equal(changes, 0);
    window.dispatchEvent(storageEvent(KEY));
    window.dispatchEvent(storageEvent(null));
    assert.equal(changes, 2);
    unsubscribe();
});

test('other-renderer channel notifications refresh consumers and stop after unsubscribe', () => {
    let changes = 0;
    const unsubscribe = subscribeCourseStateChanged(() => ++changes);
    const peer = new TestChannel('natively-course-state');
    peer.postMessage({ source: 'another-renderer' });
    assert.equal(changes, 1);
    unsubscribe();
    peer.postMessage({ source: 'another-renderer' });
    assert.equal(changes, 1);
    peer.close();
    assert.ok(channels.every((channel) => channel.closed));
});

test('local notifications still work when BroadcastChannel is unavailable', () => {
    window.BroadcastChannel = undefined;
    let changes = 0;
    const unsubscribe = subscribeCourseStateChanged(() => ++changes);
    notifyCourseStateChanged();
    assert.equal(changes, 1);
    unsubscribe();
    notifyCourseStateChanged();
    assert.equal(changes, 1);
});
