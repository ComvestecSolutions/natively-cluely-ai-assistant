import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, GraduationCap, XCircle } from 'lucide-react';
import { useT } from '../../i18n';
import CourseProgressCard, { type CourseImportRun } from './CourseProgressCard';
import LessonReader from './LessonReader';
import { AipBadge } from '../settings/AIProvidersSettings';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { SETTINGS_BTN_BASE, SETTINGS_BTN_NEUTRAL, SettingsNotice, SettingsSwitch, useSettingsTones } from '../settings/SettingsRow';

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
    // Course ids with an in-flight enable/disable toggle (guards double-clicks).
    const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});

    // The course the P3 reader is open for; null shows the course list.
    const [openCourseId, setOpenCourseId] = useState<string | null>(null);

    // ── Management actions (P4) — export / re-index / delete / import-bundle ─────
    // Non-null while one action's IPC round-trip is in flight; keyed per row+action.
    const [busyAction, setBusyAction] = useState<string | null>(null);
    // Transient result line rendered under the toolbar until a later action replaces it.
    const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);

    const refreshCourses = useCallback(async () => {
        if (!window.electronAPI || !window.electronAPI.coursesList) return;
        try {
            const res = await window.electronAPI.coursesList();
            setCourses(Array.isArray(res) ? (res as CourseSummary[]) : []);
            setDisabled(!Array.isArray(res) && !!(res as { disabled?: boolean })?.disabled);
        } catch {
            setDisabled(true);
            setCourses([]);
        }
    }, []);

    // Terminal 'done' for a run: the list fetch doubles as the refresh, and we read the
    // finished course's fresh stats off the refreshed row for the completion notice.
    const finishImportRun = useCallback(async (courseId: string) => {
        const api = window.electronAPI;
        if (!api || typeof api.coursesList !== 'function') return;
        try {
            const res = await api.coursesList();
            if (!Array.isArray(res)) {
                setCourses([]);
                setDisabled(true);
                return;
            }
            setCourses(res as CourseSummary[]);
            setDisabled(false);
            const fresh = (res as CourseSummary[]).find((c) => c.id === courseId);
            if (!fresh) return;
            const st = courseStats(fresh.stats);
            if (!(st.planned > 0)) return; // row has no stats yet — nothing to summarize
            setNotice(st.failed === 0
                ? { tone: 'ok', text: `Imported ${st.succeeded} of ${st.planned} pages` }
                : { tone: 'warn', text: `${st.succeeded} of ${st.planned} pages imported · ${st.failed} failed` });
        } catch {
            setDisabled(true);
            setCourses([]);
        }
    }, []);

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
            const active = runRef.current;
            if (!active || !raw || typeof raw !== 'object') return;
            const event = raw as CoursesProgressEvent;

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

            const terminal = event.phase === 'done' || event.stage === 'done' || event.stage === 'failed';
            if (terminal) {
                window.clearTimeout(runEndTimer.current);
                // Brief beat so the final state is visible, then drop the run and refresh.
                const detailId = typeof event.detail === 'string' && event.detail !== '' ? event.detail : active.courseId;
                runEndTimer.current = window.setTimeout(() => {
                    setRun(null);
                    if (event.stage === 'failed') void refreshCourses();
                    // Terminal 'done': finishImportRun performs the same refresh and, in
                    // passing, posts the fresh-stats completion notice.
                    else void finishImportRun(detailId);
                }, 800);
            }
        });
    }, [refreshCourses, finishImportRun]);

    useEffect(() => () => window.clearTimeout(runEndTimer.current), []);

    // One-shot import submit: validate the URL, ask main to start the run, adopt its
    // course id as the active one. The UI never starts a second run; main guards it too.
    const startImport = async () => {
        if (submitting || runRef.current) return;
        const url = importUrl.trim();
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
            if (importError.ok === false && typeof importError.error === 'string' && importError.error !== '') {
                // Zero-lesson guard from main ({ok:false,error}) — surface the reason in the shared notice slot.
                setNotice({ tone: 'err', text: importError.error });
                return;
            }
            const courseId = pickImportedCourseId(res);
            if (!courseId) return;
            window.clearTimeout(runEndTimer.current);
            setRun({ courseId, phase: 'importing', done: 0, total: 0, failed: 0, skipped: 0 });
            setImportOpen(false);
        } catch {
            // IPC-level failure degrades to the same premium-off notice surface.
            setDisabled(true);
        } finally {
            setSubmitting(false);
        }
    };

    const toggleCourseEnabled = async (course: CourseSummary) => {
        if (pendingToggles[course.id]) return;
        const api = window.electronAPI;
        if (!api || typeof api.coursesSetEnabled !== 'function') return;
        const next = !course.enabled;
        setPendingToggles((prev) => ({ ...prev, [course.id]: true }));
        // Optimistic flip…
        setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, enabled: next } : c)));
        try {
            // Preload exposes this positionally: coursesSetEnabled(id, enabled).
            const res = (await api.coursesSetEnabled(course.id, next)) as
                | { disabled?: boolean; course?: CourseSummary | null }
                | null;
            if (!res) return;
            if (res.disabled) {
                // Premium flipped off mid-flight — the list view goes away with it.
                setDisabled(true);
                return;
            }
            const fresh = res.course;
            if (fresh && fresh.id === course.id) {
                setCourses((prev) => prev.map((c) => (c.id === course.id
                    ? { ...c, enabled: fresh.enabled ?? next, status: fresh.status || c.status, updatedAt: fresh.updatedAt || c.updatedAt }
                    : c)));
            }
        } catch {
            // …and roll back on error.
            setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, enabled: !next } : c)));
        } finally {
            setPendingToggles((prev) => {
                const copy = { ...prev };
                delete copy[course.id];
                return copy;
            });
        }
    };

    // P4 management actions. Busy keys are '<action>:<courseId>' per row plus 'imp' for the
    // toolbar bundle import; results flow through the shared notice slot under the toolbar.
    const withAction = async (key: string, fn: () => Promise<void>) => {
        setBusyAction(key);
        try {
            await fn();
        } finally {
            setBusyAction(null);
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
        else setNotice({ tone: 'ok', text: t('Course re-indexed for AI grounding') });
    });

    const deleteCourse = (course: CourseSummary) => {
        if (!window.confirm(`Delete "${course.name}" and all its lessons, assets and progress? This cannot be undone.`)) return;
        void withAction(`del:${course.id}`, async () => {
            const api = window.electronAPI;
            if (!api || typeof api.coursesDeleteCourse !== 'function') return;
            const res = (await api.coursesDeleteCourse(course.id)) as
                | { ok?: boolean; error?: string; disabled?: boolean }
                | null;
            if (!res) return;
            if (res.disabled) setNotice({ tone: 'err', text: t('Courses Studio is disabled') });
            else if (res.ok) {
                setNotice({ tone: 'ok', text: t('Course deleted') });
                void refreshCourses(); // re-read the list so the row disappears
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
            void refreshCourses();
        } else setNotice({ tone: 'err', text: res.error ?? t('Import failed') });
    });

    // App card surface (the settings Card recipe); the tokens track the theme, so no light/dark split.
    const rowTone = 'bg-bg-item-surface rounded-xl border border-border-subtle';
    // Ghost styling shared by the per-row P4 management buttons (settings button consts).
    const actionBtnClass = `${SETTINGS_BTN_BASE} ${SETTINGS_BTN_NEUTRAL}`;

    // URL input + actions, shared by the empty-state and list-view import forms.
    const importControls = (
        <>
            <input
                type="text"
                inputMode="url"
                value={importUrl}
                onChange={(e) => {
                    setImportUrl(e.target.value);
                    if (formError) setFormError(null);
                }}
                placeholder="https://learn.microsoft.com/en-us/credentials/certifications/..."
                className={`w-full rounded-full bg-bg-input border border-border-subtle px-4 py-2 text-[13px] text-text-primary placeholder:text-text-secondary outline-none transition-colors focus:border-accent-secondary`}
            />
            {formError && <p className="text-xs text-text-secondary">{formError}</p>}
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={() => setImportOpen(false)}
                    disabled={submitting || !!run}
                    className={actionBtnClass}
                >
                    {t('Cancel')}
                </button>
                <LiquidGlassButton
                    type="submit"
                    variant="action"
                    className="lg-sm"
                    disabled={submitting || !!run}
                    icon={submitting ? (
                        <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    ) : undefined}
                >
                    {t('Start import')}
                </LiquidGlassButton>
            </div>
        </>
    );

    return (
        <div className="h-full w-full flex flex-col bg-bg-primary text-text-primary font-sans overflow-hidden selection:bg-accent-secondary/30">
            {/* Header (back + title) */}
            <section className={`${isLight ? 'bg-bg-secondary' : 'bg-bg-elevated'} px-8 pt-5 pb-6 border-b border-border-subtle shrink-0`}>
                <div className="max-w-3xl mx-auto">
                    <div className="flex items-center gap-3">
                        {onBack && (
                            <button
                                onClick={onBack}
                                title={t('Back')}
                                className={`p-2 -ml-2 text-text-secondary hover:text-text-primary rounded-full transition-colors ${isLight ? 'hover:bg-black/8' : 'hover:bg-white/10'}`}
                            >
                                <ArrowLeft size={16} />
                            </button>
                        )}
                        <h1 className="text-3xl font-celeb-light font-medium text-text-primary tracking-wide drop-shadow-sm">{t('Courses Studio')}</h1>
                    </div>
                </div>
            </section>

            <div className="flex-1 overflow-y-auto">
                {openCourseId ? (
                    // Full-height chain: the wrapper is a flex item with resolved height, so the reader's
                    // root `min-h-full` fills it and its inner columns own their scrolling.
                    <LessonReader courseId={openCourseId} onBack={() => setOpenCourseId(null)} />
                ) : loading ? (
                    <div className="px-8 py-10 text-center text-sm text-text-secondary">
                        {t('Loading')}…
                    </div>
                ) : disabled && !run ? (
                    /* Premium notice — same pill-button language as the launcher CTAs. */
                    <div className="flex items-center justify-center px-8 pb-10 pt-6 min-h-full">
                        <div className={`w-full max-w-md rounded-2xl border p-8 text-center ${rowTone}`}>
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-secondary/20">
                                <GraduationCap size={22} className="text-text-primary" />
                            </div>
                            <h2 className="font-celeb text-xl font-medium text-text-primary">{t('Premium required')}</h2>
                            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                                {t('Courses Studio is part of Natively Pro. Upgrade to import courses and build interview-ready material from them.')}
                            </p>
                            {onUpgrade && (
                                <button
                                    onClick={onUpgrade}
                                    title={t('Plans & Billing')}
                                    className="mt-5 px-4 py-2.5 rounded-full text-[13px] font-medium text-text-primary bg-bg-elevated/80 hover:bg-bg-elevated border border-border-muted backdrop-blur-xl transition-all duration-200 active:scale-[0.98]"
                                >
                                    {t('View plans')}
                                </button>
                            )}
                        </div>
                    </div>
                ) : run && courses.length === 0 ? (
                    <div className="flex items-center justify-center px-8 pb-10 pt-6 min-h-full">
                        <CourseProgressCard progress={run} isLight={isLight} />
                    </div>
                ) : courses.length === 0 ? (
                    <div className="flex items-center justify-center px-8 pb-10 pt-6 min-h-full">
                        <div className="w-full max-w-sm text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-secondary/20">
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
                                <div className="mt-5 flex items-center justify-center gap-2">
                                    <LiquidGlassButton
                                        variant="clear"
                                        className="lg-sm text-text-primary"
                                        onClick={() => { void importBundle(); }}
                                        disabled={busyAction === 'imp'}
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
                    <div className="max-w-3xl mx-auto px-8 py-6">
                        {run && (
                            <div className="mb-4 flex justify-center">
                                <CourseProgressCard progress={run} isLight={isLight} />
                            </div>
                        )}
                        {!importOpen && !run && (
                            <div className="mb-4 flex items-center justify-end gap-2">
                                <LiquidGlassButton
                                    variant="clear"
                                    className="lg-sm text-text-primary"
                                    onClick={() => { void importBundle(); }}
                                    disabled={busyAction === 'imp'}
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
                        {/* The shared settings notice; tones resolve per theme via useSettingsTones. */}
                        {notice && (
                            <SettingsNotice
                                tone={tones[notice.tone === 'err' ? 'danger' : notice.tone]}
                                icon={notice.tone === 'ok'
                                    ? <CheckCircle2 size={14} />
                                    : notice.tone === 'warn' ? <AlertTriangle size={14} /> : <XCircle size={14} />}
                                className="mb-4"
                            >
                                {notice.text}
                            </SettingsNotice>
                        )}
                        <ul className="space-y-3">
                            {courses.map((course) => {
                                const busy = pendingToggles[course.id] === true;
                                const updatedLabel = relativeUpdatedLabel(t, course.updatedAt);
                                // Busy keys for this row's P4 actions; any in-flight one disables all three.
                                const expKey = `exp:${course.id}`;
                                const ridxKey = `ridx:${course.id}`;
                                const delKey = `del:${course.id}`;
                                const rowBusy = busyAction === expKey || busyAction === ridxKey || busyAction === delKey;
                                // Premium card details, derived once per render of the row.
                                const stats = courseStats(course.stats);
                                const lessonCount = course.lessonCount ?? 0;
                                const noLessons = lessonCount === 0;
                                const showBar = stats.planned > 0 && (course.status === 'importing' || course.status === 'partial');
                                const barPct = showBar ? Math.min(100, Math.round((stats.succeeded / stats.planned) * 100)) : 0;
                                // One-line preview of the first failures; the full list lives in the tooltip.
                                const failuresPreview = course.status === 'partial' && stats.failures.length > 0
                                    ? stats.failures.slice(0, 3).join(' · ')
                                    : '';
                                return (
                                    <li
                                        key={course.id}
                                        onClick={() => setOpenCourseId(course.id)}
                                        className={`flex cursor-pointer select-none items-center gap-4 rounded-xl border px-4 py-3 ${rowTone}`}
                                    >
                                        {/* Clicking the row opens the single-course reader (P3). */}
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium text-text-primary">{course.name}</p>
                                            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                                                {updatedLabel !== '' && (
                                                    <span className="truncate text-text-secondary">{t('Updated')} {updatedLabel}</span>
                                                )}
                                                {!noLessons ? (
                                                    <span className="shrink-0 tabular-nums text-text-secondary">{lessonCount} {t('lessons')} · {course.chunkCount ?? 0} {t('chunks')}</span>
                                                ) : (
                                                    <span className="shrink-0 text-text-tertiary">{t('No lessons yet')}</span>
                                                )}
                                            </div>
                                            {failuresPreview !== '' && (
                                                <p
                                                    className="mt-0.5 truncate text-[11px] text-amber-400/80"
                                                    title={stats.failures.join('\n')}
                                                >
                                                    {failuresPreview}
                                                </p>
                                            )}
                                            {showBar && (
                                                <div className="mt-1.5 flex items-center gap-2">
                                                    {/* `natively-meter-*` carries the material (see index.css). */}
                                                    <div className="h-[4px] flex-1 natively-meter-track">
                                                        <div
                                                            className="natively-meter-fill transition-[width] duration-700 ease-out motion-reduce:transition-none"
                                                            style={{ width: `${barPct}%` }}
                                                        />
                                                    </div>
                                                    <span className="shrink-0 text-[11px] tabular-nums text-text-secondary">{barPct}%</span>
                                                </div>
                                            )}
                                        </div>
                                        {/* One status primitive per row: the settings badge language. */}
                                        {course.status === 'ready' || course.status === 'complete' ? (
                                            <AipBadge tone="ok" label={t('Complete')} className="shrink-0" />
                                        ) : course.status === 'partial' ? (
                                            <AipBadge tone="warn" label={t('Partial')} className="shrink-0" />
                                        ) : course.status === 'importing' ? (
                                            <AipBadge tone="info" busy label={t('Importing')} className="shrink-0" />
                                        ) : (
                                            <span className="shrink-0 text-xs font-medium text-text-secondary">{statusLabel(t, course.status)}</span>
                                        )}
                                        {/* P4 management actions — ghost buttons that never open the reader. */}
                                        <div className="flex shrink-0 items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); void exportCourseBundle(course.id); }}
                                                disabled={rowBusy || noLessons}
                                                title={noLessons ? t('No lessons imported yet') : undefined}
                                                className={actionBtnClass}
                                            >
                                                {busyAction === expKey ? '…' : t('Export')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); void reindexCourse(course.id); }}
                                                disabled={rowBusy || noLessons}
                                                title={noLessons ? t('No lessons imported yet') : undefined}
                                                className={actionBtnClass}
                                            >
                                                {busyAction === ridxKey ? '…' : t('Re-index')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); void deleteCourse(course); }}
                                                className={actionBtnClass}
                                            >
                                                {busyAction === delKey ? '…' : t('Delete')}
                                            </button>
                                        </div>
                                        {/* The settings switch; the span keeps a toggle click from opening the reader. */}
                                        <span
                                            title={course.enabled ? t('Disable') : t('Enable')}
                                            className="shrink-0"
                                            onClick={(e) => { e.stopPropagation(); }}
                                        >
                                            <SettingsSwitch
                                                checked={course.enabled}
                                                onChange={() => { void toggleCourseEnabled(course); }}
                                                label={course.enabled ? t('Disable') : t('Enable')}
                                                disabled={busy}
                                            />
                                        </span>
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
