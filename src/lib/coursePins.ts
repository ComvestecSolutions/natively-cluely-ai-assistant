const KEY = 'natively_course_pins';

/** Pinned course ids, persisted to localStorage; degrades to [] on any error. */
export function getCoursePinIds(): string[] {
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return [...new Set(
            parsed.filter((value): value is string => typeof value === 'string' && value.length > 0),
        )];
    } catch {
        return [];
    }
}

export function setCoursePinIds(ids: string[]): void {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
        // Storage full/unavailable — never throw into the UI.
    }
}
