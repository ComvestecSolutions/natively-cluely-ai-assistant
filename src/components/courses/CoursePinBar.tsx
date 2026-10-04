import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BookOpen, ChevronDown } from 'lucide-react';
import { getCoursePinIds, setCoursePinIds } from '../../lib/coursePins';

// The settings panes' smooth-out curve — the pin menu opens on it too.
const MENU_EASE = [0.22, 1, 0.36, 1] as const;

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
    // Chip is the disclosure's source of truth — Escape re-focuses it after closing.
    const chipRef = useRef<HTMLButtonElement | null>(null);
    const reduceMotion = useReducedMotion();

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

    // Escape closes and hands focus back to the chip — completes the disclosure pattern.
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                chipRef.current?.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
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
                ref={chipRef}
                type="button"
                aria-expanded={open}
                aria-controls="course-pin-menu"
                aria-haspopup="true"
                onClick={() => setOpen((nextOpen) => !nextOpen)}
                className={`flex cursor-pointer select-none items-center gap-1.5 rounded-full border bg-bg-item-surface border-border-subtle text-xs font-medium text-text-primary transition-colors duration-150 hover:bg-[var(--bg-row-hover)] focus-visible:ring-2 focus-visible:ring-accent-focus ${compact ? 'px-2 py-0.5' : 'px-3 py-1.5'}`}
            >
                <BookOpen size={14} aria-hidden />
                {pins.length > 0 ? `Courses · ${pins.length}` : 'Courses'}
                <ChevronDown size={12} aria-hidden className={`text-text-secondary transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        id="course-pin-menu"
                        className="absolute right-0 top-full z-50 mt-1.5 max-h-[260px] w-72 origin-top-right overflow-y-auto rounded-xl border border-border-muted bg-bg-elevated shadow-lg"
                        initial={{ opacity: 0, scale: 0.96, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: -2 }}
                        transition={{ duration: reduceMotion ? 0 : 0.18, ease: MENU_EASE }}
                    >
                    <p className="px-3 pt-2 pb-1 text-xs font-medium text-text-secondary">Ground-truth courses</p>

                    {courses.map((course) => (
                        <label key={course.id} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 transition-colors duration-150 hover:bg-[var(--bg-row-hover)]">
                            <input
                                type="checkbox"
                                className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--accent-primary)] focus-visible:ring-2 focus-visible:ring-accent-focus"
                                aria-label={`Pin ${labelFor(course)}`}
                                checked={pins.includes(course.id)}
                                onChange={() => togglePin(course.id)}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={labelFor(course)}>
                                {labelFor(course)}
                            </span>
                        </label>
                    ))}

                    <div className="px-3 pt-1.5 pb-2">
                        <p className="text-xs leading-relaxed text-text-secondary">Pinned courses are always available to chat as ground-truth context.</p>
                    </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default CoursePinBar;
