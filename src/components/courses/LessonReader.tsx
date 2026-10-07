import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, BookOpen, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, ExternalLink, PanelRightOpen, Search, X, XCircle } from 'lucide-react';
import LessonMarkdown from './LessonMarkdown';
import StudyRail from './StudyRail';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { SETTINGS_CARD, SETTINGS_INPUT, SettingsNotice, useSettingsTones } from '../settings/SettingsRow';

// Courses Studio P3 — single-course reader. Loads the course + its lessons once, then renders one
// lesson's stored markdown in the center with a module-grouped rail on the left. Completion
// is optimistic; internal links resolve back to a lesson so reading stays inside the app. Self-
// contained: local type shapes mirror the preload contract (coursesGet / coursesLessonContent)
// instead of importing electron internals into the renderer.

interface Course {
    id: string;
    name: string;
    profile: string;
    sourceUrl: string;
    status: string;
    enabled: boolean;
    stats: Record<string, unknown>;
    updatedAt: string;
}

interface Lesson {
    id: string;
    courseId?: string | null;
    title: string;
    url: string;
    kind: string;
    parent: string | null;
    orderNo: number;
    tocPath: string | null;
    localMdPath: string;
    completedAt: string | null;
    durationMinutes?: number | null;
    durationSource?: 'provided' | 'estimated' | null;
}

interface LessonReaderProps {
    courseId: string;
    initialLessonId?: string | null;
    onBack: () => void;
}

// Per-course "last read" lesson, used to resume where the user left off.
const resumeKey = (courseId: string): string => `natively_course_resume:${courseId}`;

// Rail indentation depth from a tocPath such as "Module 2 / Topic 3". Clamped so long paths stay tidy.
const depthOf = (tocPath: string | null): number => {
    if (!tocPath) return 0;
    const parts = tocPath.split('/').map((p) => p.trim()).filter(Boolean);
    return Math.min(parts.length, DEPTH_PL.length - 1);
};

// Per-depth left padding for the rail (literal classes so Tailwind keeps them; avoids inline styles).
// Clamp deep nesting so lesson titles still fit the compact launcher sidebar.
const DEPTH_PL = ['pl-2', 'pl-4', 'pl-6', 'pl-8'];

// Canonical key for matching a markdown href to one of the course's lesson URLs. Both sides pass
// through here so an https vs protocol-less link, a leading slash, and a trailing "/" collapse — e.g.
// "/en-us/azure/x" matches "https://learn.microsoft.com/en-us/azure/x". Only invoked for links the
// markdown component already classified as internal, so a broader key than its own matcher is safe.
const canonicalKey = (href: string): string => {
    let v = (href ?? '').trim();
    v = v.replace(/^[a-z][\w+.-]*:/i, '');                    // drop scheme
    v = v.replace(/^\/{2}/, '');                              // drop protocol-relative marker
    v = v.toLowerCase().replace(/\?.*$/, '').replace(/#.*$/, '');  // strip query + fragment
    v = v.replace(/^https?:\/\/learn\.microsoft\.com/i, '');   // optional host
    return v.replace(/^\/+|\/+$/g, '');                       // trim outer slashes
};

interface ContentState {
    key: string;
    status: 'loading' | 'ready';
    content: string;
    error: string | null;
}

interface CourseSearchHit {
    lessonId: string;
    title: string;
    snippet: string;
    parent: string | null;
}

interface SearchState {
    key: string;
    status: 'loading' | 'ready';
    hits: CourseSearchHit[];
    error: string | null;
}

const moduleKeysForOverview = (lesson: Lesson): { direct: string; hashed: string } | null => {
    try {
        const pathname = new URL(lesson.url).pathname.replace(/\/+$/, '');
        if (!/\/modules\/[^/]+$/i.test(pathname)) return null;
        const segment = decodeURIComponent(pathname.split('/').pop() ?? '');
        const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        // Detail-feed parents store the raw slug (60 chars); TOC parents use makeId's
        // 48-character slug followed by a hash, then normalize the whole ID.
        const direct = normalize(segment).slice(0, 60);
        const hashed = normalize(segment.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48));
        return direct && hashed ? { direct: `modules/${direct}`, hashed: `modules/${hashed}` } : null;
    } catch { return null; }
};
const moduleTitle = (key: string, overviews: Map<string, string>): string =>
    overviews.get(key) || key.replace(/^modules\//, '').replace(/-[a-f\d]{8}$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Module';

function Notice({ title, body, onBack, onRetry }: { title: string; body?: string; onBack: () => void; onRetry?: () => void }) {
    return (
        <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-6 text-text-primary">
            <div className={`mx-auto w-full max-w-md p-6 text-center ${SETTINGS_CARD}`}>
                <h2 className="text-lg font-medium text-text-primary">{title}</h2>
                {body ? <p className="mt-2 text-xs leading-relaxed text-text-secondary">{body}</p> : null}
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm text-text-primary" onClick={onBack} icon={<ArrowLeft size={14} aria-hidden />}>Back to courses</LiquidGlassButton>
                    {onRetry && <LiquidGlassButton type="button" variant="action" className="lg-sm" onClick={onRetry}>Retry</LiquidGlassButton>}
                </div>
            </div>
        </div>
    );
}

const LessonReader: React.FC<LessonReaderProps> = ({ courseId, initialLessonId, onBack }) => {
    const [course, setCourse] = useState<Course | null>(null);
    const [lessons, setLessons] = useState<Lesson[]>([]);
    const { groups, groupById, overviews } = useMemo(() => {
        const parentKeys = new Set(lessons.map((lesson) => lesson.parent).filter((key): key is string => !!key));
        const groups = new Map<string, Lesson[]>();
        const groupById = new Map<string, string>();
        const overviews = new Map<string, string>();
        for (const lesson of lessons) {
            const overviewKeys = lesson.parent ? null : moduleKeysForOverview(lesson);
            const overviewGroup = overviewKeys && [...parentKeys].find((parent) =>
                parent === overviewKeys.direct || (parent.startsWith(`${overviewKeys.hashed}-`) && /^[a-f0-9]{8}$/i.test(parent.slice(overviewKeys.hashed.length + 1))));
            const key = lesson.parent ?? overviewGroup ?? '';
            if (overviewGroup && lesson.title) overviews.set(key, lesson.title);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(lesson);
            groupById.set(lesson.id, key);
        }
        return { groups, groupById, overviews };
    }, [lessons]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [disabled, setDisabled] = useState(false);

    const tones = useSettingsTones();
    // At compact launcher sizes, aids replace the reading column rather than floating over it.
    const [railOpen, setRailOpen] = useState(false);
    const studyTrigger = useRef<HTMLButtonElement>(null);
    const studyPane = useRef<HTMLElement>(null);
    const closeStudyPane = () => { setRailOpen(false); studyTrigger.current?.focus(); };
    useEffect(() => { if (railOpen) studyPane.current?.focus(); }, [railOpen]);

    const [activeId, setActiveId] = useState<string | null>(null);
    const [expandedModules, setExpandedModules] = useState<string[]>([]);
    const [searchCollapsedModules, setSearchCollapsedModules] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchState, setSearchState] = useState<SearchState>({ key: '', status: 'ready', hits: [], error: null });
    const searchSeq = useRef(0);

    // Content for the active lesson. A request-sequence ref ignores stale responses so a slow fetch
    // never overwrites a newer one (e.g. when prev/next is clicked quickly).
    const [loadedContent, setContent] = useState<ContentState>({ key: '', status: 'loading', content: '', error: null });
    const contentSeq = useRef(0);
    const [courseRetry, setCourseRetry] = useState(0);
    const [contentRetry, setContentRetry] = useState(0);
    const completionEpoch = useRef(0);
    const pendingCompletion = useRef(new Set<string>());
    const [savingLessons, setSavingLessons] = useState<string[]>([]);
    const [completionErrors, setCompletionErrors] = useState<Record<string, string>>({});
    const contentKey = JSON.stringify([courseId, activeId]);
    const content: ContentState = loadedContent.key === contentKey
        ? loadedContent : { key: contentKey, status: 'loading', content: '', error: null };

    // Load the course + lessons once; pick which lesson to open from: initialLessonId (if it still
    // exists), else the resume key for this course, else the first lesson.
    useEffect(() => {
        let cancelled = false;
        setLoading(true); setLoadError(null); setDisabled(false);
        setCourse(null); setLessons([]); setActiveId(null); setContent({ key: '', status: 'loading', content: '', error: null });
        setExpandedModules([]); setSearchCollapsedModules([]); setSearchQuery(''); setRailOpen(false); setCompletionErrors({}); setSavingLessons([]);
        pendingCompletion.current.clear();
        ++completionEpoch.current;

        (async () => {
            const api = window.electronAPI;
            if (!api || typeof api.coursesGet !== 'function') { setLoadError('Courses are unavailable in this build.'); setLoading(false); return; }
            try {
                const res: any = await api.coursesGet(courseId);
                if (cancelled) return;
                if (res?.disabled) { setDisabled(true); setLoading(false); return; }
                if (res?.error || res?.ok === false) throw new Error(typeof res.error === 'string' ? res.error : 'Could not load this course.');

                const c: Course | null = res?.course ?? null;
                const list: Lesson[] = Array.isArray(res?.lessons) ? res.lessons : [];
                if (!c || list.length === 0) {
                    setCourse(c); setLessons(list); setLoading(false);
                    setLoadError(!c ? 'This course is not available anymore.' : 'No lessons have been imported for this course yet.');
                    return;
                }

                let chosen: string | null = null;
                if (initialLessonId && list.some((l) => l.id === initialLessonId)) {
                    chosen = initialLessonId;
                } else {
                    try {
                        const saved = window.localStorage.getItem(resumeKey(courseId));
                        if (saved && list.some((l) => l.id === saved)) chosen = saved;
                    } catch { /* Resume storage is optional; reading must still work. */ }
                }
                setCourse(c); setLessons(list); setActiveId(chosen ?? list[0].id); setLoading(false);
            } catch (e) {
                if (!cancelled) { setLoadError(e instanceof Error && e.message ? e.message : 'Could not load this course.'); setLoading(false); }
            }
        })();

        return () => { cancelled = true; ++completionEpoch.current; };
    }, [courseId, initialLessonId, courseRetry]);

    // Search only the loaded course. Clearing the timer and sequence-checking the response
    // prevents an old query (or an old course) from replacing newer results.
    useEffect(() => {
        const query = searchQuery.trim();
        const key = JSON.stringify([courseId, query]);
        const seq = ++searchSeq.current;
        if (!query || course?.id !== courseId) {
            setSearchState({ key, status: 'ready', hits: [], error: null });
            return;
        }
        setSearchState({ key, status: 'loading', hits: [], error: null });
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    const api = window.electronAPI;
                    if (typeof api?.coursesSearch !== 'function') throw new Error('Course search is unavailable in this build.');
                    const res = await api.coursesSearch(courseId, query) as Awaited<ReturnType<typeof api.coursesSearch>> & { hits?: CourseSearchHit[] };
                    if (seq !== searchSeq.current) return;
                    if (!res || res.disabled || res.ok === false || res.error) {
                        throw new Error(typeof res?.error === 'string' && res.error.trim() ? res.error
                            : res?.disabled ? 'Course search is disabled or local storage is unavailable.' : 'Course search failed. Try again.');
                    }
                    const hits = Array.isArray(res.results) ? res.results : Array.isArray(res.hits) ? res.hits : [];
                    setSearchState({ key, status: 'ready', hits: hits.filter((hit) => lessons.some((lesson) => lesson.id === hit.lessonId)), error: null });
                } catch (err) {
                    if (seq === searchSeq.current) setSearchState({ key, status: 'ready', hits: [], error: err instanceof Error ? err.message : 'Course search failed. Try again.' });
                }
            })();
        }, 250);
        return () => { window.clearTimeout(timer); ++searchSeq.current; };
    }, [courseId, course?.id, lessons, searchQuery]);

    // Persist the active lesson so closing and reopening the reader resumes in place.
    useEffect(() => {
        if (!activeId || course?.id !== courseId) return;
        try { window.localStorage.setItem(resumeKey(courseId), activeId); }
        catch { /* Resume storage is optional. */ }
    }, [courseId, course?.id, activeId]);

    // A drill owns Escape before the compact study pane does.
    useEffect(() => {
        if (!railOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !document.querySelector('[data-study-aid-player]')) closeStudyPane();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [railOpen]);

    // Fetch markdown for whatever lesson is active; only the newest request may write back.
    useEffect(() => {
        const id = activeId;
        if (!id || course?.id !== courseId) return;
        let cancelled = false;
        const seq = ++contentSeq.current;
        const key = JSON.stringify([courseId, id]);
        setContent({ key, status: 'loading', content: '', error: null });

        (async () => {
            try {
                const res: any = await window.electronAPI.coursesLessonContent(courseId, id);
                if (cancelled || seq !== contentSeq.current) return;
                const body = typeof res?.content === 'string' ? res.content : '';
                const failed = !res || res.disabled || res.ok === false || res.error || !body.trim();
                const msg = typeof res?.error === 'string' && res.error.trim() !== '' ? res.error
                    : res?.disabled ? 'Courses Studio is disabled or local course storage is unavailable. Check access and retry.'
                        : 'No readable content is available for this lesson. Retry or open the original.';
                setContent({ key, status: 'ready', content: failed ? '' : body, error: failed ? msg : null });
            } catch (e) {
                if (cancelled || seq !== contentSeq.current) return;
                setContent({ key, status: 'ready', content: '', error: e instanceof Error && e.message ? e.message : 'This lesson could not be loaded.' });
            }
        })();
        return () => { cancelled = true; };
    }, [courseId, course?.id, activeId, contentRetry]);

    const goPrevNext = (delta: number) => {
        if (!activeId || lessons.length === 0) return; // bounds + no-op are handled by the disabled buttons
        const idx = lessons.findIndex((l) => l.id === activeId);
        const target = lessons[idx + delta];
        if (target) openLesson(target.id);
    };

    // Optimistically flip completion, then persist; roll back on IPC failure.
    const toggleComplete = async () => {
        const current = lessons.find((l) => l.id === activeId);
        if (!current || current.kind !== 'lesson' || pendingCompletion.current.has(current.id)) return;
        const epoch = completionEpoch.current;
        const done = !current.completedAt;
        pendingCompletion.current.add(current.id);
        setSavingLessons((prev) => [...prev, current.id]);
        setCompletionErrors((prev) => { const next = { ...prev }; delete next[current.id]; return next; });
        const nextCompletedAt: string | null = done ? new Date().toISOString() : null;
        setLessons((prev) => prev.map((l) => (l.id === current.id ? { ...l, completedAt: nextCompletedAt } : l)));
        try {
            const res = await window.electronAPI.coursesSetLessonCompleted([current.id], done);
            if (!res || res.disabled || res.error || res.ok !== true) {
                throw new Error(typeof res?.error === 'string' && res.error.trim() ? res.error
                    : res?.disabled ? 'Completion could not be saved: Courses Studio is disabled or local storage is unavailable.'
                        : 'Completion could not be saved. Try again.');
            }
        } catch (e) {
            if (epoch !== completionEpoch.current) return;
            setLessons((prev) => prev.map((l) => (l.id === current.id ? { ...l, completedAt: current.completedAt } : l)));
            setCompletionErrors((prev) => ({ ...prev, [current.id]: e instanceof Error && e.message ? e.message : 'Completion could not be saved.' }));
        } finally {
            if (epoch === completionEpoch.current) {
                pendingCompletion.current.delete(current.id);
                setSavingLessons((prev) => prev.filter((id) => id !== current.id));
            }
        }
    };

    const openOriginal = () => {
        const lesson = lessons.find((l) => l.id === activeId);
        if (!lesson?.url) return;
        const api = window.electronAPI;
        // Fire-and-forget — a failed external open must not disturb reading (main enforces the https allow-list).
        if (api && typeof api.openExternal === 'function') Promise.resolve(api.openExternal(lesson.url)).catch(() => { });
    };

    // Resolve an internal markdown link back to its lesson and jump to it.
    const onNavigateUrl = (href: string) => {
        const key = canonicalKey(href);
        if (!key) return;
        for (const l of lessons) {
            if (!l.url) continue;
            if (canonicalKey(l.url) === key) { openLesson(l.id); return; }
        }
    };

    // ── Render guards (run before the main JSX so it can assume course + current exist) ────────────
    if (loading || (course && course.id !== courseId)) return <Notice title="Opening course…" onBack={onBack} />;
    if (disabled) return <Notice title="Courses unavailable" body="Courses Studio requires Pro or an active trial and available local course storage. Check access and try again." onBack={onBack} onRetry={() => setCourseRetry((n) => n + 1)} />;
    if (loadError || !course || lessons.length === 0) return <Notice title={!course ? 'Course unavailable' : 'Nothing to read yet'} body={loadError ?? undefined} onBack={onBack} onRetry={() => setCourseRetry((n) => n + 1)} />;

    const current = activeId ? lessons.find((l) => l.id === activeId) ?? null : null;
    if (!current) return <Notice title="Select a lesson" body="Choose a lesson from the list to start reading." onBack={onBack} />;

    const total = lessons.length;
    const courseLessonCount = lessons.filter((l) => l.kind === 'lesson').length;
    const doneCount = lessons.filter((l) => l.kind === 'lesson' && !!l.completedAt).length;

    const currentIdx = lessons.findIndex((l) => l.id === activeId);
    const trimmedLen = content.content.trim().length;

    // A short successful extraction is distinct from a read failure.
    const degraded = content.status === 'ready' && !content.error && trimmedLen > 0 && trimmedLen < 200;

    const activeModule = groupById.get(current.id) ?? '';
    const sameModule = groups.get(activeModule) ?? [current];
    const label = activeModule ? moduleTitle(activeModule, overviews) : 'Course lessons (ungrouped)';
    const scopeLessons = sameModule.filter((l) => l.kind === 'lesson').map((l) => ({ id: l.id, title: l.title }));

    const externalLinks = sameModule.filter((l) => !!l.kind && l.kind !== 'lesson' && !!l.url).map((l) => ({ title: l.title, url: l.url }));
    const moduleLessonCount = scopeLessons.length;
    const courseMinutes = lessons.reduce((minutes, lesson) => minutes + (lesson.kind === 'lesson' && Number.isFinite(lesson.durationMinutes) ? lesson.durationMinutes! : 0), 0);
    const moduleMinutes = sameModule.reduce((minutes, lesson) => minutes + (lesson.kind === 'lesson' && Number.isFinite(lesson.durationMinutes) ? lesson.durationMinutes! : 0), 0);
    const timedCourseLessons = lessons.filter((lesson) => lesson.kind === 'lesson' && Number.isFinite(lesson.durationMinutes)).length;
    const timedModuleLessons = sameModule.filter((lesson) => lesson.kind === 'lesson' && Number.isFinite(lesson.durationMinutes)).length;
    const query = searchQuery.trim();
    const titleMatches = query && lessons.some((lesson) => lesson.title.toLowerCase().includes(query.toLowerCase()));
    const search = searchState.key === JSON.stringify([courseId, query]) ? searchState : { key: '', status: 'loading', hits: [], error: null };
    const openLesson = (id: string) => {
        if (!groupById.has(id)) return;
        setActiveId(id); setRailOpen(false);
        const moduleKey = groupById.get(id)!;
        setExpandedModules((prev) => prev.includes(moduleKey) ? prev : [...prev, moduleKey]);
        setSearchCollapsedModules((prev) => prev.filter((key) => key !== moduleKey));
    };

    return (
        <div className="h-full min-h-0 w-full flex flex-col overflow-hidden bg-bg-primary text-text-primary selection:bg-accent-subtle">
            {/* Header — back / title, prev-next + completion on the right */}
            <header className="shrink-0 border-b border-border-subtle bg-bg-elevated px-4 py-3">
                <div className="flex items-center gap-3">
                    <LiquidGlassButton type="button" variant="clear" className="-ml-1 lg-sm shrink-0 text-text-secondary" onClick={onBack} title="Back to courses" aria-label="Back to courses">
                        <ArrowLeft size={14} />
                    </LiquidGlassButton>
                    <div className="min-w-0 flex-1 leading-tight">
                        <p className="truncate text-[12px] text-text-secondary">{course.name}</p>
                        <h1 className="truncate text-sm font-semibold text-text-primary" title={current.title}>{current.title}</h1>
                    </div>

                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="mr-auto inline-flex items-center gap-1.5 text-xs tabular-nums text-text-secondary"><BookOpen size={13} aria-hidden />{current.kind === 'lesson' ? 'Lesson' : 'Resource'} {currentIdx + 1}/{total}{current.kind === 'lesson' && current.durationMinutes ? ` · ${current.durationSource === 'provided' ? '' : '~'}${current.durationMinutes} min` : ''}</span>
                    <button ref={studyTrigger} type="button" className="lg-button lg-clear lg-sm xl:hidden text-text-primary focus-visible:ring-2 focus-visible:ring-accent-focus" onClick={() => setRailOpen((open) => !open)} aria-expanded={railOpen} aria-controls="course-study-pane">
                        <span className="lg-content"><span className="lg-icon" aria-hidden="true"><PanelRightOpen size={14} /></span><span className="lg-label">Study aids</span></span>
                    </button>
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={() => goPrevNext(-1)} disabled={currentIdx <= 0} title="Previous lesson" aria-label="Previous lesson">
                        <ChevronLeft size={14} />
                    </LiquidGlassButton>
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={() => goPrevNext(1)} disabled={currentIdx >= total - 1} title="Next lesson" aria-label="Next lesson">
                        <ChevronRight size={14} />
                    </LiquidGlassButton>
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={openOriginal} icon={<ExternalLink size={12} />} title={`Open ${current.title} in the browser`} aria-label={`Open ${current.title} in the browser`}>
                        Open original
                    </LiquidGlassButton>
                    {current.kind === 'lesson' && <button type="button" onClick={toggleComplete} disabled={savingLessons.includes(current.id)} aria-busy={savingLessons.includes(current.id)} aria-pressed={!!current.completedAt} aria-label={current.completedAt ? 'Mark as not complete' : 'Mark as complete'} title={current.completedAt ? 'Mark as not complete' : 'Mark as complete'}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent-focus disabled:opacity-60 ${current.completedAt ? tones.ok : 'border-accent-secondary bg-accent-subtle text-accent-primary hover:bg-bg-item-surface'}`}>
                        {current.completedAt ? <CheckCircle2 size={13} aria-hidden /> : <Check size={13} strokeWidth={2.5} aria-hidden />}{savingLessons.includes(current.id) ? 'Saving…' : current.completedAt ? 'Completed' : 'Complete'}
                    </button>}
                </div>
                {completionErrors[current.id] && (
                    <SettingsNotice tone={tones.danger} icon={<XCircle size={14} />} alert className="mt-2">
                        {completionErrors[current.id]}
                        <LiquidGlassButton type="button" variant="clear" className="lg-sm mt-2 text-text-primary" onClick={toggleComplete}>Retry save</LiquidGlassButton>
                    </SettingsNotice>
                )}
            </header>

            {/* Percentage-based columns expand with the available launcher width; the study pane replaces the reader below xl. */}
            <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden [grid-template-columns:minmax(11rem,24%)_minmax(0,1fr)] xl:[grid-template-columns:minmax(12rem,20%)_minmax(0,1fr)_minmax(19rem,28%)]">
                <aside aria-label="Course lessons" className="flex min-h-0 min-w-0 flex-col border-r border-border-subtle bg-bg-secondary px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Lessons</h2>
                        <span aria-label={`${doneCount} of ${courseLessonCount} lessons complete`} className="rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] tabular-nums text-accent-primary">{doneCount}/{courseLessonCount}</span>
                    </div>
                    <div className="mb-3 grid gap-1 rounded-lg border border-border-subtle bg-bg-elevated px-2.5 py-2 text-[11px] leading-snug text-text-secondary">
                        <span className="flex items-center gap-1.5"><Clock3 size={12} aria-hidden className="shrink-0 text-accent-primary" />Course · {courseMinutes ? `~${courseMinutes} min${timedCourseLessons < courseLessonCount ? ` (${timedCourseLessons}/${courseLessonCount} lessons)` : ''}` : 'Time unavailable'}</span>
                        <span className="pl-[18px]">This module · {moduleMinutes ? `~${moduleMinutes} min${timedModuleLessons < moduleLessonCount ? ` (${timedModuleLessons}/${moduleLessonCount} timed)` : ''}` : 'Time unavailable'}</span>
                    </div>
                    <label htmlFor="course-full-text-search" className="sr-only">Search lesson titles and content</label>
                    <div className="relative mb-2 shrink-0">
                        <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary" />
                        <input id="course-full-text-search" type="search" value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setSearchCollapsedModules([]); }}
                            aria-label="Search lessons" aria-controls={query ? 'course-search-results' : undefined} aria-busy={!!query && search.status === 'loading'}
                            placeholder="Search lessons…" className={`${SETTINGS_INPUT} w-full pl-8 placeholder:text-text-secondary`} />
                    </div>
                    {query && <section id="course-search-results" aria-label="Course search results" className="mb-2 max-h-36 shrink-0 overflow-y-auto border-b border-border-subtle pb-2" aria-live="polite">
                        {search.status === 'loading' ? <p role="status" className="text-xs text-text-secondary">Searching course…</p>
                            : search.error ? <p role="alert" className="text-xs text-text-secondary">{search.error}</p>
                                : search.hits.length === 0 ? <p className="text-xs text-text-secondary">{titleMatches ? 'Title matches below.' : 'No content matches.'}</p>
                                    : search.hits.map((hit) => <button key={hit.lessonId} type="button" onClick={() => openLesson(hit.lessonId)}
                                        className="mb-1 block w-full rounded-lg px-2 py-1 text-left hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-accent-focus">
                                        <span className="block break-words text-xs font-medium text-text-primary">{hit.title}</span>
                                        <span className="block break-words text-[11px] text-text-secondary">{hit.snippet}</span>
                                    </button>)}
                    </section>}
                    <nav aria-label="Lesson navigation" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        {[...groups].map(([key, items], index) => {
                            const matching = query ? items.filter((l) => l.title.toLowerCase().includes(query.toLowerCase()) || search.hits.some((hit) => hit.lessonId === l.id)) : items;
                            if (!matching.length) return null;
                            const count = items.filter((l) => l.kind === 'lesson').length;
                            const done = items.filter((l) => l.kind === 'lesson' && !!l.completedAt).length;
                            const expanded = query ? !searchCollapsedModules.includes(key) : expandedModules.includes(key);
                            const panelId = `course-module-${index}`;
                            const heading = key ? moduleTitle(key, overviews) : 'Course lessons (ungrouped)';
                            return <section key={key} className="mb-2">
                                <h3><button type="button" aria-expanded={expanded} aria-controls={panelId}
                                    onClick={() => {
                                        const toggle = (prev: string[]) => prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key];
                                        if (query) setSearchCollapsedModules(toggle);
                                        else setExpandedModules(toggle);
                                    }}
                                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-2 text-left text-xs font-semibold text-text-primary hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-accent-focus">
                                    <ChevronRight size={13} aria-hidden className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                                    <span className="min-w-0 flex-1 break-words leading-snug">{heading}</span>
                                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${done === count && count > 0 ? tones.ok : 'bg-bg-item-surface text-text-secondary'}`}>{done}/{count}</span>
                                </button></h3>
                                <div id={panelId} hidden={!expanded}>{matching.map((l) => {
                                    const active = l.id === activeId;
                                    return <button key={l.id} type="button" onClick={() => openLesson(l.id)} title={l.title} aria-current={active ? 'page' : undefined}
                                        className={`mb-0.5 flex w-full items-center gap-1.5 rounded-lg py-2 pr-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-focus ${DEPTH_PL[depthOf(l.tocPath)]} ${active ? 'bg-accent-subtle' : 'hover:bg-bg-elevated'}`}>
                                        <span className={`flex shrink-0 items-center ${l.completedAt ? tones.text.ok : 'text-text-tertiary'}`}>{l.completedAt ? <CheckCircle2 size={13} aria-hidden /> : <BookOpen size={12} aria-hidden />}</span>
                                        <span className={`min-w-0 flex-1 truncate text-xs ${active ? 'font-medium text-text-primary' : 'text-text-secondary'}`}>{l.title}</span>
                                        {l.kind !== 'lesson' && <span className="shrink-0 rounded-full border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wide leading-none text-text-secondary">{l.kind}</span>}
                                    </button>;
                                })}</div>
                            </section>;
                        })}
                        {!!query && search.status !== 'loading' && ![...groups.values()].some((items) => items.some((l) => l.title.toLowerCase().includes(query.toLowerCase()) || search.hits.some((hit) => hit.lessonId === l.id))) &&
                            <p className="px-1 pb-2 pt-6 text-center text-xs text-text-secondary">No lessons match your search.</p>}
                    </nav>
                </aside>

                {/* Keyed by lesson id: switching lessons remounts the container and drops any mid-scroll. */}
                <main key={current.id} aria-label="Lesson content" className={`${railOpen ? 'hidden xl:block' : 'block'} flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain`}>
                    <article className="mx-auto w-full max-w-3xl px-4 py-4 lg:px-6">
                        <p className="mb-1 text-xs text-text-secondary">{current.tocPath || 'Lesson'}</p>
                        <h2 className="mb-4 break-words text-lg font-semibold text-text-primary">{current.title}</h2>
                        {content.status === 'loading' && (
                            // Skeleton with a tall min-height so the column doesn't jump when markdown lands.
                            <div role="status" aria-label="Loading lesson" className="flex min-h-40 flex-col pt-2">
                                <div className="h-6 w-2/5 animate-pulse rounded-md [background-color:var(--mn-skel-strong)] motion-reduce:animate-none" />
                                <div className="mt-4 flex flex-col gap-3">
                                    <div className="h-4 w-full animate-pulse rounded [background-color:var(--mn-skel-base)] motion-reduce:animate-none" />
                                    <div className="h-4 w-11/12 animate-pulse rounded [background-color:var(--mn-skel-base)] motion-reduce:animate-none" />
                                    <div className="h-4 w-4/5 animate-pulse rounded [background-color:var(--mn-skel-soft)] motion-reduce:animate-none" />
                                    <div className="h-4 w-full animate-pulse rounded [background-color:var(--mn-skel-base)] motion-reduce:animate-none" />
                                    <div className="h-4 w-3/5 animate-pulse rounded [background-color:var(--mn-skel-soft)] motion-reduce:animate-none" />
                                    <div className="h-4 w-5/6 animate-pulse rounded [background-color:var(--mn-skel-base)] motion-reduce:animate-none" />
                                    <div className="h-4 w-1/2 animate-pulse rounded [background-color:var(--mn-skel-base)] motion-reduce:animate-none" />
                                </div>
                            </div>
                        )}
                        {content.error && (
                            <SettingsNotice tone={tones.danger} icon={<XCircle size={14} />} alert className="mb-4">
                                {content.error}
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <LiquidGlassButton type="button" variant="action" className="lg-sm" onClick={() => setContentRetry((n) => n + 1)}>Retry lesson</LiquidGlassButton>
                                    {current.url && <LiquidGlassButton type="button" variant="clear" className="lg-sm" onClick={openOriginal} icon={<ExternalLink size={12} />}>Open original</LiquidGlassButton>}
                                </div>
                            </SettingsNotice>
                        )}
                        {degraded && current.url && (
                            <SettingsNotice tone={tones.warn} icon={<AlertTriangle size={14} />} className="mb-4">
                                Extraction was partial — open the original for full detail.{' '}
                                <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0" onClick={openOriginal} icon={<ExternalLink size={12} />}>Open original</LiquidGlassButton>
                            </SettingsNotice>
                        )}
                        {content.status === 'ready' && content.content.trim() !== '' ? (
                            <LessonMarkdown key={current.id} courseId={course.id} content={content.content} lessonUrls={lessons.map((l) => l.url)} onNavigateUrl={onNavigateUrl} />
                        ) : null}
                    </article>
                </main>

                <aside ref={studyPane} tabIndex={-1} id="course-study-pane" aria-label="Study aids" className={`${railOpen ? 'flex' : 'hidden xl:flex'} min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain border-l border-border-subtle bg-bg-secondary p-3`}>
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <h2 className="text-xs font-semibold text-text-secondary">Study aids</h2>
                        <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary xl:hidden" onClick={closeStudyPane} title="Close study aids" aria-label="Close study aids">
                            <X size={14} />
                        </LiquidGlassButton>
                    </div>
                    <StudyRail key={JSON.stringify([courseId, scopeLessons.map((l) => l.id)])} courseId={courseId} scopeLessons={scopeLessons} externalLinks={externalLinks} moduleLabel={label} />
                </aside>
            </div>
        </div>
    );
};

export default LessonReader;
