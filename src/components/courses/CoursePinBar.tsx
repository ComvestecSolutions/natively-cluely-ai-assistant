import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BookOpen, ChevronDown, X } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import type { MeetingInterfaceTheme } from '../../lib/meetingInterfaceTheme';
import {
    getCoursePinIds,
    isCourseGroundingEnabled,
    setCourseGroundingEnabled,
    subscribeCourseStateChanged,
} from '../../lib/coursePins';

interface PinnableCourse {
    id: string;
    name?: unknown;
    enabled?: unknown;
}

const labelFor = (course: PinnableCourse): string =>
    typeof course.name === 'string' && course.name.trim() ? course.name.trim() : course.id;

interface CoursePinBarProps {
    compact?: boolean;
    panelRef?: React.RefObject<HTMLElement | null>;
    interfaceTheme?: MeetingInterfaceTheme;
    surfaceStyle?: React.CSSProperties;
    controlStyle?: React.CSSProperties;
}

interface PopoverPosition {
    left: number;
    top: number;
    width: number;
    maxHeight: number;
}

const CoursePinBar: React.FC<CoursePinBarProps> = ({
    compact = false, panelRef, interfaceTheme = 'default', surfaceStyle, controlStyle,
}) => {
    const [courses, setCourses] = useState<PinnableCourse[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [writeError, setWriteError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [pins, setPins] = useState<string[]>(getCoursePinIds);
    const [pending, setPending] = useState<string[]>([]);
    const [position, setPosition] = useState<PopoverPosition | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const chipRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const alive = useRef(false);
    const request = useRef(0);
    const pendingIds = useRef(new Set<string>());
    const focusOnOpen = useRef(false);
    const menuId = useId();
    const reduceMotion = useReducedMotion();
    const isLight = useResolvedTheme() === 'light';
    const isDarkBg = interfaceTheme !== 'default' || !isLight;

    const refresh = useCallback(async () => {
        const generation = ++request.current;
        setLoading(true);
        setPins(getCoursePinIds());
        try {
            const result: unknown = await window.electronAPI?.coursesList?.();
            if (!alive.current || generation !== request.current) return;
            if (!Array.isArray(result)) {
                setCourses([]);
                setError('Courses are unavailable. Check Courses Studio in the launcher, then try again.');
                return;
            }
            setCourses(result.filter((course): course is PinnableCourse =>
                !!course && typeof course.id === 'string' && course.id.length > 0));
            setError(null);
        } catch {
            if (alive.current && generation === request.current) {
                setError('Could not load courses. Please try again.');
            }
        } finally {
            if (alive.current && generation === request.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        void refresh();
        const unsubscribe = subscribeCourseStateChanged(() => { void refresh(); });
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        return () => {
            alive.current = false;
            ++request.current;
            unsubscribe();
            window.removeEventListener('focus', onFocus);
        };
    }, [refresh]);

    useEffect(() => {
        if (open) void refresh();
    }, [open, refresh]);

    useEffect(() => {
        if (!open) return;
        const outside = (event: Event) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            chipRef.current?.focus();
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('focusin', outside);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('focusin', outside);
            document.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open]);

    // Position in the existing panel, not a portal or native popover window. Clamp
    // both axes and scroll the surface even when the chat card is at minimum size.
    useLayoutEffect(() => {
        if (!open) return;
        const root = rootRef.current;
        const popover = popoverRef.current;
        if (!root || !popover) return;
        const panel = panelRef?.current ?? root.closest<HTMLElement>('[data-shell-card], [role="dialog"], .overflow-hidden') ?? document.documentElement;
        const place = () => {
            const bounds = panel.getBoundingClientRect();
            const anchor = root.getBoundingClientRect();
            const scale = bounds.width / panel.offsetWidth || 1;
            const leftBound = Math.max(0, bounds.left) + 8;
            const topBound = Math.max(0, bounds.top) + 8;
            const rightBound = Math.min(window.innerWidth, bounds.right) - 8;
            const bottomBound = Math.min(window.innerHeight, bounds.bottom) - 8;
            const width = Math.max(0, Math.min(280 * scale, rightBound - leftBound));
            const maxHeight = Math.max(0, Math.min(320 * scale, bottomBound - topBound));
            const height = Math.min(maxHeight, (popover.scrollHeight + 2) * scale);
            const left = Math.max(leftBound, Math.min(anchor.right - width, rightBound - width));
            const top = Math.max(topBound, Math.min(anchor.top - 6 - height, bottomBound - height));
            const next = {
                left: (left - anchor.left) / scale,
                top: (top - anchor.top) / scale,
                width: width / scale,
                maxHeight: maxHeight / scale,
            };
            setPosition((prev) => prev && Object.keys(next).every((key) =>
                prev[key as keyof PopoverPosition] === next[key as keyof PopoverPosition]) ? prev : next);
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(panel);
        observer.observe(root);
        observer.observe(popover);
        window.addEventListener('resize', place);
        document.addEventListener('scroll', place, true);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', place);
            document.removeEventListener('scroll', place, true);
        };
    }, [open, courses, loading, error, writeError, panelRef]);

    useEffect(() => {
        if (!open || loading || !focusOnOpen.current) return;
        focusOnOpen.current = false;
        popoverRef.current?.querySelector<HTMLElement>('[role="switch"], [data-course-retry]')?.focus();
    }, [open, loading, courses]);

    const toggleCourse = async (course: PinnableCourse) => {
        if (pendingIds.current.has(course.id)) return;
        const enabled = !isCourseGroundingEnabled(course, getCoursePinIds());
        pendingIds.current.add(course.id);
        ++request.current; // Ignore a list fetched before this write.
        setPending([...pendingIds.current]);
        setLoading(false);
        setWriteError(null);
        try {
            const fresh = await setCourseGroundingEnabled(course.id, enabled);
            if (!alive.current) return;
            setCourses((prev) => prev.map((item) => item.id === course.id ? { ...item, enabled: fresh.enabled } : item));
            setPins(getCoursePinIds());
        } catch (failure) {
            if (alive.current) setWriteError(failure instanceof Error ? failure.message : 'Could not update this course. Please try again.');
        } finally {
            pendingIds.current.delete(course.id);
            if (alive.current) setPending([...pendingIds.current]);
        }
    };

    const notice = writeError ?? error;
    const activeCount = courses.filter((course) => isCourseGroundingEnabled(course, pins)).length;
    const close = () => { setOpen(false); chipRef.current?.focus(); };

    return (
        <div ref={rootRef} className="relative inline-flex no-drag text-left" data-stealth-ignore="true">
            <button
                ref={chipRef}
                type="button"
                aria-label={`Courses${activeCount ? `, ${activeCount} on` : ''}`}
                aria-expanded={open}
                aria-controls={menuId}
                aria-haspopup="dialog"
                data-state={open ? 'open' : undefined}
                onClick={() => { setPosition(null); setOpen((value) => !value); }}
                onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    focusOnOpen.current = true;
                    setOpen(true);
                    if (open) popoverRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
                }}
                className={`no-drag flex shrink-0 items-center gap-1.5 h-7 rounded-[9px] border text-xs font-medium overlay-control-surface overlay-text-primary interaction-base interaction-press focus-visible:ring-2 focus-visible:ring-accent-focus ${compact ? 'px-2' : 'px-3'}`}
                style={controlStyle}
            >
                <BookOpen size={14} aria-hidden="true" />
                <span>Courses{activeCount > 0 ? ` · ${activeCount}` : ''}</span>
                <ChevronDown size={12} aria-hidden="true" className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        ref={popoverRef}
                        id={menuId}
                        role="dialog"
                        aria-label="Courses"
                        className={`absolute z-[70] no-drag w-[280px] overflow-y-auto overscroll-contain rounded-[14px] border p-1 backdrop-blur-md overlay-shell-surface overlay-popover-surface ${isDarkBg ? 'bg-[#1E1E1E]/80 border-white/10 text-white' : 'bg-[#F3F4F6]/92 border-black/10 text-slate-900'}`}
                        style={{ ...surfaceStyle, ...position, visibility: position ? 'visible' : 'hidden' }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, pointerEvents: 'none' }}
                        transition={{ duration: reduceMotion ? 0 : 0.16 }}
                    >
                        <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-0.5">
                            <span className="text-[11px] font-medium overlay-text-muted">Chat courses</span>
                            <button type="button" aria-label="Close courses" onClick={close} className="no-drag flex h-6 w-6 items-center justify-center rounded-lg overlay-bare-icon focus-visible:ring-2 focus-visible:ring-accent-focus">
                                <X size={12} aria-hidden="true" />
                            </button>
                        </div>
                        <p className="px-2 pb-1.5 text-[11px] overlay-text-muted">Use selected courses as ground-truth context.</p>
                        {loading && <p role="status" className="px-2 py-2 text-xs overlay-text-muted">Refreshing courses…</p>}
                        {notice && (
                            <div className="px-2 py-2 text-xs">
                                <p role="alert">{notice}</p>
                                <button type="button" data-course-retry="true" onClick={() => { setWriteError(null); void refresh(); }} className="no-drag mt-1 rounded-md px-2 py-1 overlay-control-surface focus-visible:ring-2 focus-visible:ring-accent-focus">Try again</button>
                            </div>
                        )}
                        {!loading && !notice && courses.length === 0 && (
                            <p role="status" className="px-2 py-2 text-xs overlay-text-muted">No courses yet. Import a course in Courses Studio in the launcher.</p>
                        )}
                        {courses.map((course) => {
                            const checked = isCourseGroundingEnabled(course, pins);
                            const busy = pending.includes(course.id);
                            return (
                                <button
                                    key={course.id}
                                    type="button"
                                    role="switch"
                                    aria-label={labelFor(course)}
                                    aria-checked={checked}
                                    aria-busy={busy}
                                    disabled={busy || loading}
                                    onClick={() => { void toggleCourse(course); }}
                                    className={`no-drag h-[30px] w-full px-2 flex items-center gap-2 rounded-[10px] select-none text-left focus-visible:ring-2 focus-visible:ring-accent-focus disabled:opacity-45 transition-colors ${isDarkBg ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'} glass-popup-row`}
                                >
                                    <BookOpen size={14} aria-hidden="true" className={`shrink-0 ${checked ? '' : isDarkBg ? 'text-white/55' : 'text-slate-500'}`} />
                                    <span className="flex-1 min-w-0 truncate text-[12px] font-medium">{labelFor(course)}</span>
                                    <span aria-hidden="true" data-on={String(checked)} className={`t-toggle t-toggle-sm shrink-0 ${checked ? 'bg-accent-primary shadow-[0_2px_10px_var(--accent-shadow-20)]' : isDarkBg ? 'bg-white/10 glass-toggle-track' : 'bg-black/[0.22] glass-toggle-track'}`}>
                                        <span className="t-toggle-thumb" />
                                    </span>
                                </button>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default CoursePinBar;
