const KEY = 'natively_course_pins';
const CHANGE_EVENT = 'natively:course-state-changed';
const CHANNEL = 'natively-course-state';
const source = Math.random().toString(36).slice(2);

const normalizeIds = (ids: unknown[]): string[] => [...new Set(
    ids.filter((value): value is string => typeof value === 'string' && value.length > 0),
)];

/** Pinned course ids, persisted to localStorage; degrades to [] on any error. */
export function getCoursePinIds(): string[] {
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? normalizeIds(parsed) : [];
    } catch {
        return [];
    }
}

/** Refresh mounted course controls in this renderer and same-origin Electron renderers. */
export function notifyCourseStateChanged(): void {
    window.dispatchEvent(new Event(CHANGE_EVENT));
    // No main-process/window lifecycle dependency; each sender is closed immediately.
    let channel: BroadcastChannel | undefined;
    try {
        channel = new window.BroadcastChannel(CHANNEL);
        channel.postMessage({ source });
    } catch {
        // Older hosts still receive the local event and native storage events.
    } finally {
        channel?.close();
    }
}

export function subscribeCourseStateChanged(listener: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === KEY || event.key === null) listener();
    };
    window.addEventListener(CHANGE_EVENT, listener);
    window.addEventListener('storage', onStorage);
    let channel: BroadcastChannel | undefined;
    try {
        channel = new window.BroadcastChannel(CHANNEL);
        channel.onmessage = (event) => {
            if (event.data?.source && event.data.source !== source) listener();
        };
    } catch {
        // BroadcastChannel is optional outside Electron.
    }
    return () => {
        window.removeEventListener(CHANGE_EVENT, listener);
        window.removeEventListener('storage', onStorage);
        channel?.close();
    };
}

export function setCoursePinIds(ids: string[]): boolean {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(normalizeIds(ids)));
    } catch {
        return false;
    }
    notifyCourseStateChanged();
    return true;
}

/** Grounding selects the union, including legacy disabled-but-pinned courses. */
export function isCourseGroundingEnabled(course: { id: string; enabled?: unknown }, pins: readonly string[]): boolean {
    return course.enabled === true || pins.includes(course.id);
}

/** Only acknowledge a switch after the store confirms it; off also clears the pin override. */
export async function setCourseGroundingEnabled(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
    const api = window.electronAPI;
    if (typeof api?.coursesSetEnabled !== 'function') throw new Error('Course controls are unavailable. Try again.');
    const result = await api.coursesSetEnabled(id, enabled);
    if (result?.disabled) throw new Error('Courses are unavailable. Check Courses Studio in the launcher.');
    const course = result?.course;
    if (!course || course.id !== id || course.enabled !== enabled) {
        throw new Error('Could not update this course. Refresh and try again.');
    }
    const pins = getCoursePinIds();
    if (!enabled && pins.includes(id)) {
        if (!setCoursePinIds(pins.filter((pin) => pin !== id))) {
            notifyCourseStateChanged();
            throw new Error('Could not remove the pinned course. It is still selected; try again.');
        }
    } else {
        notifyCourseStateChanged();
    }
    return course;
}
