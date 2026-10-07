import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, CircleHelp, Download, GraduationCap, Layers3, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useT } from '../../i18n';
import CourseProgressCard, { type CourseImportRun } from './CourseProgressCard';
import LessonReader from './LessonReader';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { SETTINGS_CARD, SETTINGS_INPUT, SettingsNotice, SettingsSwitch, useSettingsTones } from '../settings/SettingsRow';
import { getCoursePinIds, isCourseGroundingEnabled, notifyCourseStateChanged, setCourseGroundingEnabled, setCoursePinIds, subscribeCourseStateChanged } from '../../lib/coursePins';

// Mirrors CourseSummary in electron/courses/courseStore.ts — the renderer has no
// shared type for it; preload types coursesList() as Promise<any>.
interface CourseSummary {
    id: string;
    name: string;
    profile: string;
    sourceUrl: string;
    status: string;
    enabled: boolean;
    stats: Record<string, unknown>;
    updatedAt: string;
    lessonCount?: number;
    chunkCount?: number;
    timedLessonCount?: number | null;
    readingMinutes?: number | null;
    providedMinutes?: number | null;
}

interface CoursesHomeProps {
    isLight?: boolean;
    onBack?: () => void;
    // Opens Settings > Plans & Billing for the premium notice.
    onUpgrade?: () => void;
}

const statusLabel = (t: (key: string) => string, status: string): string => {
    if (status === 'ready') return t('Ready');
    if (status === 'importing') return t('Importing');
    if (status === 'complete') return t('Complete');
    if (status === 'partial') return t('Partial');
    return status;
};

const validCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;


const isHttpUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

/** Relative "updated" label from an ISO timestamp ('' when missing or invalid). */
const relativeUpdatedLabel = (t: (key: string) => string, iso?: string): string => {
    if (!iso) return '';
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return t('just now');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} ${t('min ago')}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ${t('h ago')}`;
    const days = Math.round(hours / 24);
    if (days < 31) return `${days} ${t('d ago')}`;
    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Narrow the loose stats record to just the numbers and failure lines rows render. */
const courseStats = (stats?: Record<string, unknown>) => {
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const s = stats ?? {};
    return {
        planned: num(s.planned),
        succeeded: num(s.succeeded),
        failed: num(s.failed),
        failures: Array.isArray(s.failures)
            ? (s.failures as unknown[]).filter((f): f is string => typeof f === 'string')
            : [],
    };
};

/** Shape of one courses:progress event. Today's main process sends P0 stage events
 * ({stage, detail}) without a courseId; the P1 ingest contract adds courseId/phase/
 * done/total/status. Both are normalized at the subscription site. */
interface CoursesProgressEvent {
    courseId?: unknown;
    phase?: string;
    done?: number;
    total?: number;
    current?: string;
    status?: string;
    stage?: string;
    detail?: string;
}

/** Course id of a newly started run, across the possible result shapes. */
const pickImportedCourseId = (result: unknown): string | null => {
    if (!result || typeof result !== 'object') return null;
    const r = result as { courseId?: unknown; course?: { id?: unknown } | null };
    if (typeof r.courseId === 'string' && r.courseId.length > 0) return r.courseId;
    if (r.course && typeof r.course.id === 'string' && r.course.id.length > 0) return r.course.id;
    return null;
};

const CoursesHome: React.FC<CoursesHomeProps> = ({ isLight, onBack, onUpgrade }) => {
    const t = useT();
    const tones = useSettingsTones();
    const [loading, setLoading] = useState(true);
    // coursesList() resolves to { disabled: true } when premium/trial is off or the
    // store is unavailable — same contract as the other intelligence surfaces.
    const [disabled, setDisabled] = useState(false);
    const [courses, setCourses] = useState<CourseSummary[]>([]);
    const [pins, setPins] = useState<string[]>(getCoursePinIds);
    const [listError, setListError] = useState<string | null>(null);
    const listSeq = useRef(0);
    const mounted = useRef(true);
    const actionInFlight = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; ++listSeq.current; };
    }, []);

    // ── Import run (P1) ────────────────────────────────────────────────────────
    const [importOpen, setImportOpen] = useState(false);
    const [importUrl, setImportUrl] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    // True while the coursesImport() promise is in flight (submits are single-flight).
    const [submitting, setSubmitting] = useState(false);
    // The course id the UI believes is being imported. Events carrying a different
    // courseId are ignored; P0 stage events (no courseId) apply to this run.
    const [run, setRun] = useState<CourseImportRun | null>(null);
    const runRef = useRef<CourseImportRun | null>(null);
    useEffect(() => { runRef.current = run; }, [run]);
    // Timer that ends the active run ~800ms after its terminal event.
    const runEndTimer = useRef<number | undefined>(undefined);
    // The URL behind the active run — Retry on a failed terminal re-sends it without the form.
    const runSourceUrlRef = useRef<string | null>(null);
    // Course ids with an in-flight enable/disable toggle (guards double-clicks).
    const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});
    const pendingToggleIds = useRef(new Set<string>());

    // The course the P3 reader is open for; null shows the course list.
    const [openCourseId, setOpenCourseId] = useState<string | null>(null);

    // ── Management actions (P4) — export / re-index / delete / import-bundle ─────
    // Non-null while one action's IPC round-trip is in flight; keyed per row+action.
    const [busyAction, setBusyAction] = useState<string | null>(null);
    // Transient result line rendered under the toolbar until a later action replaces it.
    const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);

    // Two-step delete confirm: id of the row whose Delete armed a Confirm/Cancel pair. Auto-disarms,
    // so an abandoned arm never outlives the moment; no native dialogs.
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const confirmDeleteTimer = useRef<number | undefined>(undefined);

    const refreshCourses = useCallback(async (): Promise<CourseSummary[] | null> => {
        const seq = ++listSeq.current;
        setListError(null);
        try {
            const api = window.electronAPI;
            if (!api || typeof api.coursesList !== 'function') throw new Error('Courses are unavailable in this build.');
            const res = await api.coursesList();
            if (!mounted.current || seq !== listSeq.current) return null;
            if (res?.disabled) { setDisabled(true); setCourses([]); return null; }
            if (!Array.isArray(res)) throw new Error(typeof res?.error === 'string' ? res.error : 'Could not load the course library.');
            setCourses(res as CourseSummary[]); setDisabled(false);
            return res as CourseSummary[];
        } catch (e) {
            if (mounted.current && seq === listSeq.current) setListError(e instanceof Error && e.message ? e.message : 'Could not load the course library.');
            return null;
        }
    }, []);

    useEffect(() => subscribeCourseStateChanged(() => {
        setPins(getCoursePinIds());
        void refreshCourses();
    }), [refreshCourses]);

    // Terminal 'done' for a run: the list fetch doubles as the refresh, and we read the
    // finished course's fresh stats off the refreshed row for the completion notice.
    const finishImportRun = useCallback(async (courseId: string) => {
        const fresh = (await refreshCourses())?.find((c) => c.id === courseId);
        if (!fresh || !mounted.current) return;
        const st = courseStats(fresh.stats);
        if (!(st.planned > 0)) return;
        setNotice(st.failed === 0
            ? { tone: 'ok', text: `Imported ${st.succeeded} of ${st.planned} pages` }
            : { tone: 'warn', text: `${st.succeeded} of ${st.planned} pages imported · ${st.failed} failed` });
    }, [refreshCourses]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await refreshCourses();
            if (!cancelled) setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [refreshCourses]);

    // Live progress for the active run. Subscribed once for the component's lifetime;
    // correlation goes through runRef so the handler never sees a stale run.
    useEffect(() => {
        const api = window.electronAPI;
        if (!api || typeof api.onCoursesProgress !== 'function') return undefined;
        return api.onCoursesProgress((raw: unknown) => {
            if (!raw || typeof raw !== 'object') return;
            const event = raw as CoursesProgressEvent;
            // Store status may change even for an import started outside this local run.
            const isFailure = event.phase === 'failed' || event.stage === 'failed';
            const terminal = event.phase === 'done' || event.stage === 'done' || isFailure;
            if (terminal) notifyCourseStateChanged();
            const active = runRef.current;
            if (!active) return;

            // Never apply events for another course. P0 stage events carry no courseId —
            // those correlate to the single UI-side active run.
            if (typeof event.courseId === 'string' && event.courseId !== active.courseId) return;

            setRun((prev) => {
                if (!prev) return prev;
                const next: CourseImportRun = { ...prev };
                // P1 phase-level events. Per-phase counters: adopt done/total wholesale
                // when the phase or its total changes, otherwise ratchet forward only.
                if (event.phase === 'plan' || event.phase === 'page' || event.phase === 'assets') {
                    next.phase = event.phase;
                    const total = Number(event.total);
                    if (Number.isFinite(total) && total >= 0) {
                        const done = Number.isFinite(Number(event.done)) ? Math.max(0, Number(event.done)) : 0;
                        if (total !== prev.total || event.phase !== prev.phase) {
                            next.total = total;
                            next.done = done;
                        } else {
                            next.done = Math.max(prev.done, done);
                        }
                    }
                } else if (event.phase === 'done') {
                    next.phase = 'done';
                    // Collapse the bar so a finished run renders complete.
                    if (next.total > 0) next.done = next.total;
                } else if (event.phase === 'failed') {
                    next.phase = 'failed';
                } else if (event.stage === 'importing') {
                    next.phase = 'importing';
                } else if (event.stage === 'done' || event.stage === 'failed') {
                    // P0 stage events are terminal too.
                    next.phase = event.stage === 'failed' ? 'failed' : 'done';
                }

                // Per-item status from the P1 contract feeds the running tally; P0 events
                // have no status field and therefore never double-count.
                if (event.status === 'failed') next.failed += 1;
                else if (event.status === 'skipped') next.skipped += 1;

                const label = typeof event.current === 'string' && event.current !== ''
                    ? event.current
                    : (typeof event.detail === 'string' && event.detail !== '' ? event.detail : undefined);
                if (label) next.current = label;
                return next;
            });

            if (terminal) {
                window.clearTimeout(runEndTimer.current);
                // Failed runs remain on screen for Retry / Dismiss; the notification refreshed them.
                if (!isFailure) {
                    // Brief beat so the final state is visible, then drop the run and refresh.
                    const detailId = typeof event.detail === 'string' && event.detail !== '' ? event.detail : active.courseId;
                    runEndTimer.current = window.setTimeout(() => {
                        setRun(null);
                        // Terminal 'done': finishImportRun performs the same refresh and, in
                        // passing, posts the fresh-stats completion notice. Only success auto-clears.
                        void finishImportRun(detailId);
                    }, 800);
                }
            }
        });
    }, [finishImportRun]);

    useEffect(() => () => {
        window.clearTimeout(runEndTimer.current);
        window.clearTimeout(confirmDeleteTimer.current);
    }, []);

    // One-shot import submit: validate the URL, ask main to start the run, adopt its
    // course id as the active one. The UI never starts a second run; main guards it too.
    const startImport = async (retryUrl?: string) => {
        if (submitting || runRef.current) return;
        // Retry re-sends the captured URL without touching the form field.
        const url = (retryUrl ?? importUrl).trim();
        if (!isHttpUrl(url)) {
            setFormError(t('Enter a valid http(s) URL.'));
            return;
        }
        const api = window.electronAPI;
        if (!api || typeof api.coursesImport !== 'function') return;
        setSubmitting(true);
        setFormError(null);
        try {
            // The P0 channel expects an object payload with sourceUrl; a richer contract
            // surfaces the run id as {started|alreadyRunning, courseId} or {course}. All
            // of those are accepted; everything else leaves the form open without crashing.
            const res = await api.coursesImport({ sourceUrl: url });
            if (!res || (res as { disabled?: boolean })?.disabled) {
                setDisabled(true); // premium off or store unavailable — existing inline notice
                return;
            }
            const importError = res as { ok?: boolean; error?: string };
            if (importError.error || importError.ok === false) {
                // Zero-lesson guard from main ({ok:false,error}) — surface the reason in the shared notice slot.
                setFormError(importError.error || t('Import failed'));
                return;
            }
            const courseId = pickImportedCourseId(res);
            if (!courseId) { setFormError(t('No course was returned. Check the URL and retry.')); return; }
            window.clearTimeout(runEndTimer.current);
            runSourceUrlRef.current = url; // Retry's anchor for this run
            setRun({ courseId, phase: 'importing', done: 0, total: 0, failed: 0, skipped: 0 });
            setImportOpen(false);
            notifyCourseStateChanged();
        } catch (e) {
            setFormError(e instanceof Error && e.message ? e.message : t('Import failed. Try again.'));
        } finally {
            setSubmitting(false);
        }
    };

    const toggleCourseEnabled = async (course: CourseSummary) => {
        if (pendingToggleIds.current.has(course.id)) return;
        const next = !isCourseGroundingEnabled(course, getCoursePinIds());
        pendingToggleIds.current.add(course.id);
        setPendingToggles((prev) => ({ ...prev, [course.id]: true }));
        // Optimistic flip…
        setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, enabled: next } : c)));
        try {
            // The shared helper confirms IPC and clears a pin override before acknowledging off.
            // It also notifies both library and toolbar subscribers; do not double-notify here.
            const fresh = await setCourseGroundingEnabled(course.id, next);
            if (!mounted.current) return;
            setCourses((prev) => prev.map((c) => c.id === course.id ? { ...c, enabled: fresh.enabled } : c));
        } catch (e) {
            if (!mounted.current) return;
            setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, enabled: course.enabled } : c)));
            setNotice({ tone: 'err', text: e instanceof Error && e.message ? e.message : t('Course setting could not be saved.') });
        } finally {
            pendingToggleIds.current.delete(course.id);
            if (mounted.current) setPendingToggles((prev) => {
                const copy = { ...prev };
                delete copy[course.id];
                return copy;
            });
        }
    };

    // P4 management actions. Busy keys are '<action>:<courseId>' per row plus 'imp' for the
    // toolbar bundle import; results flow through the shared notice slot under the toolbar.
    const withAction = async (key: string, fn: () => Promise<void>) => {
        if (actionInFlight.current) return;
        actionInFlight.current = true;
        setBusyAction(key);
        try {
            await fn();
        } catch (e) {
            if (mounted.current) setNotice({ tone: 'err', text: e instanceof Error && e.message ? e.message : t('Course action failed. Try again.') });
        } finally {
            actionInFlight.current = false;
            if (mounted.current) setBusyAction(null);
        }
    };

    const exportCourseBundle = (courseId: string) => withAction(`exp:${courseId}`, async () => {
        const api = window.electronAPI;
        if (!api || typeof api.coursesExportBundle !== 'function') return;
        const res = (await api.coursesExportBundle(courseId)) as
            | { ok?: boolean; canceled?: boolean; path?: string; error?: string; disabled?: boolean }
            | null;
        if (!res) return;
        // Main degrades to { disabled: true } when premium flips off or the store is gone.
        if (res.disabled) setNotice({ tone: 'err', text: t('Courses Studio is disabled') });
        else if (res.canceled) return; // user dismissed the save dialog — nothing to report
        else if (res.ok && typeof res.path === 'string') {
            // Show just the file name; split on both separators so it reads right on any OS.
            setNotice({ tone: 'ok', text: `Bundle saved — ${res.path.split(/[\\/]/).pop()}` });
        } else setNotice({ tone: 'err', text: res.error ?? t('Export failed') });
    });

    const reindexCourse = (courseId: string) => withAction(`ridx:${courseId}`, async () => {
        const api = window.electronAPI;
        if (!api || typeof api.coursesReindex !== 'function') return;
        // Main resolves to { indexed, skipped } on success, or { disabled } / { error }.
        const res = (await api.coursesReindex(courseId)) as
            | { indexed?: number; skipped?: number; error?: string; disabled?: boolean }
            | null;
        if (!res) return;
        if (res.disabled) setNotice({ tone: 'err', text: t('Courses Studio is disabled') });
        else if (res.error) setNotice({ tone: 'err', text: res.error });
        else {
            setNotice({ tone: 'ok', text: t('Course re-indexed for AI grounding') });
            notifyCourseStateChanged();
        }
    });

    // Two-step delete without a native dialog: Delete arms a Confirm/Cancel pair on the row
    // for a few seconds; the armed Confirm performs it, Cancel or timeout disarms.
    const armDeleteConfirm = (courseId: string) => {
        window.clearTimeout(confirmDeleteTimer.current);
        setConfirmDelete(courseId);
        confirmDeleteTimer.current = window.setTimeout(() => setConfirmDelete(null), 4000);
    };

    const cancelDeleteConfirm = () => {
        window.clearTimeout(confirmDeleteTimer.current);
        setConfirmDelete(null);
    };

    const deleteCourse = (course: CourseSummary) => {
        window.clearTimeout(confirmDeleteTimer.current);
        setConfirmDelete(null);
        void withAction(`del:${course.id}`, async () => {
            const api = window.electronAPI;
            if (!api || typeof api.coursesDeleteCourse !== 'function') return;
            const res = (await api.coursesDeleteCourse(course.id)) as
                | { ok?: boolean; error?: string; disabled?: boolean }
                | null;
            if (!res) return;
            if (res.disabled) setNotice({ tone: 'err', text: t('Courses Studio is disabled') });
            else if (res.ok) {
                const currentPins = getCoursePinIds();
                if (currentPins.includes(course.id)) {
                    if (setCoursePinIds(currentPins.filter((id) => id !== course.id))) {
                        setNotice({ tone: 'ok', text: t('Course deleted') });
                    } else {
                        setNotice({ tone: 'warn', text: t('Course deleted, but its pinned selection could not be cleared. Try clearing it in course controls.') });
                        notifyCourseStateChanged();
                    }
                } else {
                    setNotice({ tone: 'ok', text: t('Course deleted') });
                    notifyCourseStateChanged();
                }
            } else setNotice({ tone: 'err', text: res.error ?? t('Delete failed') });
        });
    };

    const importBundle = () => withAction('imp', async () => {
        const api = window.electronAPI;
        if (!api || typeof api.coursesImportBundle !== 'function') return;
        const res = (await api.coursesImportBundle()) as
            | { ok?: boolean; canceled?: boolean; courseId?: string; error?: string; disabled?: boolean }
            | null;
        if (!res) return;
        if (res.disabled) setNotice({ tone: 'err', text: t('Courses Studio is disabled') });
        else if (res.canceled) return; // user dismissed the open dialog — nothing to report
        else if (res.ok && typeof res.courseId === 'string') {
            setNotice({ tone: 'ok', text: `Course "${res.courseId}" imported` });
            notifyCourseStateChanged();
        } else setNotice({ tone: 'err', text: res.error ?? t('Import failed') });
    });

    // Terminal-failure recovery, wired to the progress card's Retry / Dismiss actions.
    const retryFailedRun = () => {
        const url = runSourceUrlRef.current;
        if (!url || submitting) return;
        // startImport single-flights on both of these — clear them before re-arming a fresh run,
        // or the second call would silently no-op.
        window.clearTimeout(runEndTimer.current);
        runRef.current = null;
        setRun(null);
        void startImport(url);
    };

    const dismissImportRun = () => {
        window.clearTimeout(runEndTimer.current);
        runSourceUrlRef.current = null;
        setRun(null);
        // The failed run may have left a partial course behind — re-read the list.
        void refreshCourses();
    };

    // App card surface (the settings Card recipe); muted border stays visible in both themes.
    const rowTone = SETTINGS_CARD;

    // URL input + actions, shared by the empty-state and list-view import forms.
    const importControls = (
        <>
            {/* Only one import form renders at a time, so the static id is safe to share. */}
            <label htmlFor="course-import-url" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-text-secondary">
                {t('Course URL')}
            </label>
            <input
                id="course-import-url"
                type="text"
                inputMode="url"
                value={importUrl}
                onChange={(e) => {
                    setImportUrl(e.target.value);
                    if (formError) setFormError(null);
                }}
                placeholder="https://learn.microsoft.com/en-us/credentials/certifications/..."
                aria-invalid={!!formError}
                aria-describedby={formError ? 'course-import-error' : undefined}
                className={`${SETTINGS_INPUT} placeholder:text-text-secondary`}
            />
            {formError && (
                <p id="course-import-error" role="alert" className={`mt-2 flex items-start gap-1.5 text-xs font-medium ${tones.text.danger}`}>
                    <XCircle size={12} aria-hidden />
                    <span className="min-w-0 break-words">{formError}</span>
                </p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <LiquidGlassButton
                    variant="clear"
                    className="lg-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus"
                    onClick={() => setImportOpen(false)}
                    disabled={submitting || !!run}
                >
                    {t('Cancel')}
                </LiquidGlassButton>
                <LiquidGlassButton
                    type="submit"
                    variant="action"
                    className="lg-sm"
                    disabled={submitting || !!run}
                    icon={submitting ? (
                        <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                    ) : undefined}
                >
                    {t('Start import')}
                </LiquidGlassButton>
            </div>
        </>
    );

    if (openCourseId) return <LessonReader courseId={openCourseId} onBack={() => setOpenCourseId(null)} />;

    return (
        <div className="h-full min-h-0 w-full flex flex-col bg-bg-primary text-text-primary font-sans overflow-hidden selection:bg-accent-subtle">
            {/* Header (back + title) */}
            <section className={`${isLight ? 'bg-bg-secondary' : 'bg-bg-elevated'} px-4 sm:px-8 pt-5 pb-6 border-b border-border-subtle shrink-0`}>
                <div className="max-w-3xl mx-auto">
                    <div className="flex items-center gap-3">
                        {onBack && (
                            <button
                                onClick={onBack}
                                title={t('Back')}
                                aria-label={t('Back')}
                                className="p-2 -ml-2 text-text-secondary hover:text-text-primary rounded-full transition-colors hover:[background-color:var(--bg-row-hover)] focus-visible:ring-2 focus-visible:ring-accent-focus"
                            >
                                <ArrowLeft size={16} />
                            </button>
                        )}
                        <h1 className="font-celeb-light text-xl font-semibold tracking-wide text-text-primary">{t('Courses Studio')}</h1>
                        {!loading && courses.length > 0 && (
                            <span className="text-xs font-medium tabular-nums text-text-secondary">
                                {courses.length} {t(courses.length === 1 ? 'course' : 'courses')}
                            </span>
                        )}
                    </div>
                </div>
            </section>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {listError && (
                    <div className="mx-auto max-w-3xl px-6 pt-4">
                        <SettingsNotice tone={tones.danger} icon={<XCircle size={14} />} alert className="">
                            {listError}
                            <LiquidGlassButton variant="clear" className="lg-sm mt-2 text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus" onClick={() => { void refreshCourses(); }}>{t('Retry')}</LiquidGlassButton>
                        </SettingsNotice>
                    </div>
                )}
                {notice && (
                    <div className="mx-auto max-w-3xl px-6 pt-4">
                        <SettingsNotice tone={tones[notice.tone === 'err' ? 'danger' : notice.tone]} icon={notice.tone === 'ok' ? <CheckCircle2 size={14} /> : notice.tone === 'warn' ? <AlertTriangle size={14} /> : <XCircle size={14} />} alert={notice.tone === 'err'} className="">
                            {notice.text}
                        </SettingsNotice>
                    </div>
                )}
                {loading ? (
                    // Skeleton rows shaped like course cards while the first list fetch is in flight.
                    <div role="status" className="mx-auto w-full max-w-3xl px-8 py-6">
                        <span className="sr-only">{t('Loading')}…</span>
                        <div aria-hidden className="space-y-3">
                            {['w-2/5', 'w-1/2', 'w-3/5'].map((titleW, i) => (
                                <div key={i} className={`flex items-center gap-4 px-4 py-3 ${rowTone}`}>
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <div className={`h-4 animate-pulse motion-reduce:animate-none [background-color:var(--mn-skel-strong)] ${titleW}`} />
                                        <div className="h-3 w-3/5 animate-pulse motion-reduce:animate-none [background-color:var(--mn-skel-base)]" />
                                    </div>
                                    <div className="h-5 w-16 shrink-0 rounded-full animate-pulse motion-reduce:animate-none [background-color:var(--mn-skel-soft)]" />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : disabled && !run ? (
                    /* Premium notice — same pill-button language as the launcher CTAs. */
                    <div className="flex items-center justify-center px-8 pb-10 pt-6 min-h-full">
                        <div className={`w-full max-w-md rounded-2xl border p-8 text-center ${rowTone}`}>
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-subtle">
                                <GraduationCap size={22} className="text-text-primary" />
                            </div>
                            <h2 className="font-celeb text-xl font-medium text-text-primary">{t('Courses unavailable')}</h2>
                            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                                {t('Courses Studio requires Pro or an active trial and available local course storage. Check access or retry.')}
                            </p>
                            <LiquidGlassButton variant="clear" className="lg-sm mx-auto mt-4 text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus" onClick={() => { void refreshCourses(); }}>{t('Retry')}</LiquidGlassButton>
                            {onUpgrade && (
                                <LiquidGlassButton
                                    variant="clear"
                                    onClick={onUpgrade}
                                    className="lg-sm mt-5 text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-focus"
                                >
                                    {t('View plans')}
                                </LiquidGlassButton>
                            )}
                        </div>
                    </div>
                ) : run && courses.length === 0 ? (
                    <div className="flex items-center justify-center px-8 pb-10 pt-6 min-h-full">
                        {/* Centered only in the empty state; the list view below uses the full-width banner. */}
                        <div className="w-full max-w-md">
                            <CourseProgressCard progress={run} isLight={isLight} onRetry={() => retryFailedRun()} onDismiss={() => dismissImportRun()} />
                        </div>
                    </div>
                ) : courses.length === 0 ? (
                    <div className="flex items-center justify-center px-8 pb-10 pt-6 min-h-full">
                        <div className="w-full max-w-sm text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-subtle">
                                <GraduationCap size={22} className="text-text-primary" />
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                                {t('Import your first course to get started.')}
                            </p>
                            {importOpen ? (
                                <form
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void startImport();
                                    }}
                                    className={`mt-5 p-4 text-left ${rowTone}`}
                                >
                                    {importControls}
                                </form>
                            ) : (
                                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                                    <LiquidGlassButton
                                        variant="clear"
                                        className="lg-sm text-text-primary"
                                        onClick={() => { void importBundle(); }}
                                        disabled={busyAction !== null}
                                    >
                                        {t('Import bundle (.zip)')}
                                    </LiquidGlassButton>
                                    <LiquidGlassButton variant="action" className="lg-sm" onClick={() => setImportOpen(true)}>
                                        {t('Import course')}
                                    </LiquidGlassButton>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6">
                        {run && (
                            <div className="mb-4">
                                {/* Full-width banner while courses exist; the card splits stages/meter left, counters right. */}
                                <CourseProgressCard progress={run} isLight={isLight} onRetry={() => retryFailedRun()} onDismiss={() => dismissImportRun()} />
                            </div>
                        )}
                        {!importOpen && !run && (
                            <div className="mb-4 flex flex-wrap items-center gap-2">
                                <div className="mr-auto min-w-0 pr-3">
                                    <p className="text-xs font-semibold uppercase tracking-wider text-text-primary">{t('Your library')}</p>
                                </div>
                                <LiquidGlassButton
                                    variant="clear"
                                    className="lg-sm text-text-primary"
                                    onClick={() => { void importBundle(); }}
                                    disabled={busyAction !== null}
                                >
                                    {t('Import bundle (.zip)')}
                                </LiquidGlassButton>
                                <LiquidGlassButton variant="action" className="lg-sm" onClick={() => setImportOpen(true)}>
                                    {t('Import course')}
                                </LiquidGlassButton>
                            </div>
                        )}
                        {importOpen && (
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void startImport();
                                }}
                                className={`mb-4 p-4 ${rowTone}`}
                            >
                                {importControls}
                            </form>
                        )}
                        <ul className="space-y-3">
                            {courses.map((course) => {
                                const busy = pendingToggles[course.id] === true;
                                const updatedLabel = relativeUpdatedLabel(t, course.updatedAt);
                                // One management action at a time, matching withAction's synchronous lock.
                                const expKey = `exp:${course.id}`;
                                const ridxKey = `ridx:${course.id}`;
                                const delKey = `del:${course.id}`;
                                const rowBusy = busyAction !== null;
                                const statusTone = course.status === 'ready' || course.status === 'complete'
                                    ? tones.ok : course.status === 'partial' ? tones.warn
                                        : course.status === 'importing' ? 'border-accent-border bg-accent-subtle text-text-primary'
                                            : 'border-border-subtle bg-bg-component text-text-secondary';
                                const StatusIcon = course.status === 'ready' || course.status === 'complete'
                                    ? CheckCircle2 : course.status === 'partial' ? AlertTriangle
                                        : course.status === 'importing' ? Loader2 : CircleHelp;
                                // Premium card details, derived once per render of the row.
                                const stats = courseStats(course.stats);
                                const lessonCount = validCount(course.lessonCount);
                                const chunkCount = validCount(course.chunkCount);
                                const timedLessonCount = validCount(course.timedLessonCount);
                                const partialTiming = lessonCount !== null && lessonCount > 0 && timedLessonCount !== null && timedLessonCount < lessonCount;
                                const noLessons = lessonCount === null || lessonCount === 0;
                                const readingMinutes = validCount(course.readingMinutes);
                                const providedMinutes = Math.min(validCount(course.providedMinutes) ?? 0, readingMinutes ?? 0);
                                const estimatedMinutes = (readingMinutes ?? 0) - providedMinutes;
                                const showBar = (course.status === 'importing' || course.status === 'partial')
                                    && validCount(stats.planned) !== null && stats.planned > 0
                                    && validCount(stats.succeeded) !== null
                                    && run?.courseId !== course.id;
                                const importedPages = showBar ? Math.min(stats.succeeded, stats.planned) : 0;
                                const barPct = showBar ? Math.min(100, Math.round((importedPages / stats.planned) * 100)) : 0;
                                // One-line preview of the first failures; the full list lives in the tooltip.
                                const failuresPreview = course.status === 'partial' && stats.failures.length > 0
                                    ? stats.failures.slice(0, 3).join(' · ')
                                    : '';
                                return (
                                    <li
                                        key={course.id}
                                        className={`group min-w-0 p-4 transition-[border-color,box-shadow] hover:border-accent-border ${rowTone}`}
                                    >
                                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <span title={course.name} className="block max-w-full truncate text-sm font-semibold text-text-primary">{course.name}</span>
                                                {updatedLabel !== '' && <p className="mt-0.5 text-xs text-text-secondary">{t('Updated')} {updatedLabel}</p>}
                                            </div>
                                            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone}`}>
                                                <StatusIcon size={13} aria-hidden className={course.status === 'importing' ? 'animate-spin motion-reduce:animate-none' : ''} />
                                                {statusLabel(t, course.status)}
                                            </span>
                                        </div>
                                        <div className="mt-3 flex min-w-0 flex-wrap gap-2 text-xs">
                                            <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 tabular-nums ${lessonCount !== null && lessonCount > 0 ? 'border-accent-border bg-accent-subtle text-text-primary' : 'border-border-subtle bg-bg-component text-text-secondary'}`}>
                                                <BookOpen size={13} aria-hidden className="shrink-0" />
                                                {lessonCount === null ? t('Lessons unavailable') : lessonCount === 0 ? t('No lessons yet') : `${lessonCount} ${t(lessonCount === 1 ? 'lesson' : 'lessons')}`}
                                            </span>
                                            {chunkCount !== null && chunkCount > 0 && (
                                                <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-component px-2.5 py-1.5 tabular-nums text-text-secondary">
                                                    <Layers3 size={13} aria-hidden className="shrink-0" />
                                                    {chunkCount} {t('chunks')}
                                                </span>
                                            )}
                                            <span className="rounded-lg border border-accent-border bg-accent-subtle px-2.5 py-1.5 text-text-primary">
                                                <span className="font-semibold">{t('Reading time')}:</span>{' '}
                                                <span className="tabular-nums">{readingMinutes !== null && readingMinutes > 0 ? `${estimatedMinutes > 0 ? '~' : ''}${readingMinutes} ${t('min')}` : t('Not available')}</span>
                                                {(partialTiming || (readingMinutes !== null && readingMinutes > 0)) && (
                                                    <span className="ml-1 text-text-secondary">
                                                        ({partialTiming && <>{timedLessonCount}/{lessonCount} {t('timed lessons')}{readingMinutes !== null && readingMinutes > 0 ? ' · ' : ''}</>}
                                                        {readingMinutes !== null && readingMinutes > 0 && (providedMinutes > 0 && estimatedMinutes > 0
                                                            ? <>{providedMinutes} {t('min source durations')} · ~{estimatedMinutes} {t('min estimated from lesson content')}</>
                                                            : providedMinutes > 0 ? t('source durations') : t('estimated from lesson content'))})
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                        <div className="min-w-0">
                                            {failuresPreview !== '' && (
                                                <p
                                                    className={`mt-0.5 truncate text-xs ${tones.text.warn}`}
                                                    title={stats.failures.join('\n')}
                                                >
                                                    {failuresPreview}
                                                </p>
                                            )}
                                            {showBar && (
                                                <div className="mt-3">
                                                    <div className="mb-1 flex justify-between gap-2 text-xs text-text-secondary">
                                                        <span>{t('Import progress')}</span>
                                                        <span className="tabular-nums">{importedPages} / {stats.planned} {t('pages')} · {barPct}%</span>
                                                    </div>
                                                    {/* `natively-meter-*` carries the material (see index.css). */}
                                                    <div role="progressbar" aria-label={t('Import progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={barPct} className="h-[4px] natively-meter-track">
                                                        <div className="natively-meter-fill transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${barPct}%` }} />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-3">
                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                <LiquidGlassButton
                                                    variant="clear"
                                                    className="lg-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus"
                                                    onClick={(e) => { e.stopPropagation(); void exportCourseBundle(course.id); }}
                                                    disabled={rowBusy || noLessons}
                                                    aria-busy={busyAction === expKey}
                                                    title={noLessons ? t('No lessons imported yet') : undefined}
                                                    icon={busyAction === expKey ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Download size={14} />}
                                                >
                                                    {t('Export')}
                                                </LiquidGlassButton>
                                                <LiquidGlassButton
                                                    variant="clear"
                                                    className="lg-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus"
                                                    onClick={(e) => { e.stopPropagation(); void reindexCourse(course.id); }}
                                                    disabled={rowBusy || noLessons}
                                                    aria-busy={busyAction === ridxKey}
                                                    title={noLessons ? t('No lessons imported yet') : undefined}
                                                    icon={busyAction === ridxKey ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <RefreshCw size={14} />}
                                                >
                                                    {t('Re-index')}
                                                </LiquidGlassButton>
                                                {confirmDelete === course.id ? (
                                                    <>
                                                        <LiquidGlassButton
                                                            variant="clear"
                                                            className="lg-sm ring-1 ring-red-500/20 focus-visible:ring-2 focus-visible:ring-accent-focus"
                                                            onClick={(e) => { e.stopPropagation(); void deleteCourse(course); }}
                                                            disabled={rowBusy}
                                                            aria-label={`${t('Confirm delete')}: ${course.name}`}
                                                            icon={<AlertTriangle size={14} className={tones.text.danger} />}
                                                        >
                                                            <span className={tones.text.danger}>{t('Confirm')}</span>
                                                        </LiquidGlassButton>
                                                        <LiquidGlassButton
                                                            variant="clear"
                                                            className="lg-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus"
                                                            onClick={(e) => { e.stopPropagation(); cancelDeleteConfirm(); }}
                                                            disabled={rowBusy}
                                                        >
                                                            {t('Cancel')}
                                                        </LiquidGlassButton>
                                                    </>
                                                ) : (
                                                    <LiquidGlassButton
                                                        variant="clear"
                                                        className="lg-sm focus-visible:ring-2 focus-visible:ring-accent-focus"
                                                        onClick={(e) => { e.stopPropagation(); armDeleteConfirm(course.id); }}
                                                        disabled={rowBusy}
                                                        aria-busy={busyAction === delKey}
                                                        aria-label={`${t('Delete')}: ${course.name}`}
                                                        icon={busyAction === delKey ? <Loader2 size={14} className={`animate-spin motion-reduce:animate-none ${tones.text.danger}`} /> : <Trash2 size={14} className={tones.text.danger} />}
                                                    >
                                                        <span className={tones.text.danger}>{t('Delete')}</span>
                                                    </LiquidGlassButton>
                                                )}
                                            </div>
                                            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                                                <span
                                                    title={course.enabled ? t('Disable') : t('Enable')}
                                                    className="shrink-0"
                                                    onClick={(e) => { e.stopPropagation(); }}
                                                >
                                                    <SettingsSwitch
                                                        checked={isCourseGroundingEnabled(course, pins)}
                                                        onChange={() => { void toggleCourseEnabled(course); }}
                                                        label={isCourseGroundingEnabled(course, pins) ? t('Disable') : t('Enable')}
                                                        disabled={busy}
                                                    />
                                                </span>
                                                <LiquidGlassButton
                                                    variant="action"
                                                    className="lg-sm bg-accent-primary focus-visible:ring-2 focus-visible:ring-accent-focus"
                                                    onClick={() => setOpenCourseId(course.id)}
                                                    aria-label={`${t('Open course')}: ${course.name}`}
                                                    icon={<BookOpen size={14} />}
                                                >
                                                    {t('Open course')}
                                                </LiquidGlassButton>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CoursesHome;
