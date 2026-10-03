import React, { useEffect, useRef, useState } from 'react';
import { getCoursePinIds, setCoursePinIds } from '../../lib/coursePins';

/** Minimal course row shape as returned by `courses:list` (CourseSummary[]). */
interface PinnableCourse {
    id: string;
    name?: unknown;
}

const truncateForRow = (value: string): string =>
    value.length > 34 ? `${value.slice(0, 33)}…` : value;

const labelFor = (course: PinnableCourse): string => {
    const raw = typeof course.name === 'string' && course.name.trim().length > 0
        ? course.name.trim()
        : course.id;
    return truncateForRow(raw);
};

interface CoursePinBarProps {
    compact?: boolean;
}

const CoursePinBar: React.FC<CoursePinBarProps> = ({ compact = false }) => {
    const [courses, setCourses] = useState<PinnableCourse[] | null>(null);
    const [disabled, setDisabled] = useState(false);
    const [open, setOpen] = useState(false);
    const [pins, setPins] = useState<string[]>(() => getCoursePinIds());
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await window.electronAPI.coursesList?.();
                if (!alive) return;
                // Non-premium, missing store, or IPC error all degrade to a plain
                // object such as `{ disabled: true }` — never an array.
                if (!res || (typeof res === 'object' && !Array.isArray(res))) {
                    setDisabled(true);
                    return;
                }
                const list = Array.isArray(res) ? res : [];
                setCourses(
                    list.filter((course): course is PinnableCourse => {
                        const id: unknown = (course as { id?: unknown } | null)?.id;
                        return typeof id === 'string' && id.length > 0;
                    }),
                );
            } catch {
                if (alive) setDisabled(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    const togglePin = (id: string) => {
        const next = pins.includes(id) ? pins.filter((pinnedId) => pinnedId !== id) : [...pins, id];
        setPins(next);
        setCoursePinIds(next);
    };

    // Hidden while loading, when premium/IPC is disabled, and when there are no
    // courses yet (import lives in Courses Studio) — never renders a paywall.
    if (!courses || disabled || courses.length === 0) return null;

    return (
        <div ref={rootRef} className="relative inline-block text-left">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((nextOpen) => !nextOpen)}
                className={`flex cursor-pointer select-none items-center gap-1.5 rounded-full border bg-bg-item-surface border-border-subtle text-xs font-medium text-text-primary ${compact ? 'px-2 py-0.5' : 'px-3 py-1.5'}`}
            >
                <span aria-hidden>📖</span>
                {pins.length > 0 ? `Courses · ${pins.length}` : 'Courses'}
            </button>

            {open && (
                <div
                    className="absolute z-50 rounded-xl border bg-bg-elevated border-border-subtle shadow-lg"
                    style={{ right: 0, top: 'calc(100% + 6px)', width: 288, maxHeight: 260, overflowY: 'auto' }}
                >
                    <p className="px-3 pt-2 pb-1 text-xs font-medium text-text-secondary">Ground-truth courses</p>

                    {courses.map((course) => (
                        <label key={course.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                            <input
                                type="checkbox"
                                className="h-3.5 w-3.5 shrink-0"
                                checked={pins.includes(course.id)}
                                onChange={() => togglePin(course.id)}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={labelFor(course)}>
                                {labelFor(course)}
                            </span>
                        </label>
                    ))}

                    <div className="px-3 pt-1.5 pb-2">
                        <p className="text-xs leading-relaxed text-text-secondary">Pinned courses are always available to chat.</p>
                        <p className="text-xs leading-relaxed text-text-secondary">Enabled courses may be used automatically when relevant.</p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default CoursePinBar;
