import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, ExternalLink, PanelRightOpen, X } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import LessonMarkdown from './LessonMarkdown';
import StudyRail from './StudyRail';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { SettingsNotice, useSettingsTones } from '../settings/SettingsRow';

// Courses Studio P3 — single-course reader. Loads the course + its lessons once, then renders one
// lesson's stored markdown in the center with a flat (depth-indented) rail on the left. Completion
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
// Indents step by 16px from a small base so nesting reads as even rails, not an arbitrary ladder.
const DEPTH_PL = ['pl-[8px]', 'pl-[24px]', 'pl-[40px]', 'pl-[56px]', 'pl-[72px]', 'pl-[88px]'];

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
    status: 'loading' | 'ready';
    content: string;
    error: string | null;
}

// Centered fallback card (premium-off / load failure / empty course) — message + Back only.
function Notice({ title, body, onBack }: { title: string; body?: string; onBack: () => void }) {
    return (
        <div className="min-h-full flex items-center justify-center px-6 py-8">
            <div className="w-full max-w-md rounded-2xl border border-border-muted bg-bg-item-surface p-8 text-center">
                <h2 className="text-lg font-medium text-text-primary">{title}</h2>
                {body ? <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{body}</p> : null}
                <button
                    type="button"
                    onClick={onBack}
                    title="Back"
                    className="mt-5 px-4 py-2.5 rounded-full text-[13px] font-medium text-text-primary bg-bg-elevated/80 hover:bg-bg-elevated border border-border-muted backdrop-blur-xl transition-all duration-200 active:scale-[0.98]"
                >
                    ← Back to courses
                </button>
            </div>
        </div>
    );
}

const LessonReader: React.FC<LessonReaderProps> = ({ courseId, initialLessonId, onBack }) => {
    const [course, setCourse] = useState<Course | null>(null);
    const [lessons, setLessons] = useState<Lesson[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [disabled, setDisabled] = useState(false);

    // Shared settings primitives — the degraded-extraction notice tone drives its accent link.
    const tones = useSettingsTones();
    const isLight = useResolvedTheme() === 'light';

    // Sub-xl widths hide the xl+ rail entirely; this drawer re-hosts it from a header trigger. Always
    // mounted (class-toggled, never transformed) so generated aids survive open/close and StudyRail's
    // position:fixed overlays are not trapped by a transformed ancestor.
    const [railOpen, setRailOpen] = useState(false);

    const [activeId, setActiveId] = useState<string | null>(null);
    const [filter, setFilter] = useState('');

    // Content for the active lesson. A request-sequence ref ignores stale responses so a slow fetch
    // never overwrites a newer one (e.g. when prev/next is clicked quickly).
    const [content, setContent] = useState<ContentState>({ status: 'loading', content: '', error: null });
    const contentSeq = useRef(0);

    // Load the course + lessons once; pick which lesson to open from: initialLessonId (if it still
    // exists), else the resume key for this course, else the first lesson.
    useEffect(() => {
        let cancelled = false;
        setLoading(true); setLoadError(null); setDisabled(false);
        setCourse(null); setLessons([]); setActiveId(null); setContent({ status: 'loading', content: '', error: null });

        (async () => {
            const api = window.electronAPI;
            if (!api || typeof api.coursesGet !== 'function') { setLoadError('Courses are unavailable in this build.'); setLoading(false); return; }
            try {
                const res: any = await api.coursesGet(courseId);
                if (cancelled) return;
                if (res?.disabled) { setDisabled(true); setLoading(false); return; }

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
                    const saved = window.localStorage.getItem(resumeKey(courseId));
                    if (saved && list.some((l) => l.id === saved)) chosen = saved;
                }
                setCourse(c); setLessons(list); setActiveId(chosen ?? list[0].id); setLoading(false);
            } catch {
                if (!cancelled) { setLoadError('Could not load this course.'); setLoading(false); }
            }
        })();

        return () => { cancelled = true; };
    }, [courseId, initialLessonId]);

    // Persist the active lesson so closing and reopening the reader resumes in place.
    useEffect(() => {
        if (activeId) window.localStorage.setItem(resumeKey(courseId), activeId);
    }, [courseId, activeId]);

    // Escape closes the sub-xl aids drawer — but an aid overlay open inside it owns Escape first: those
    // roots carry a [data-study-aid-overlay] marker and StudyRail's own listener handles that inner layer.
    useEffect(() => {
        if (!railOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !document.querySelector('[data-study-aid-overlay]')) setRailOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [railOpen]);

    // Fetch markdown for whatever lesson is active; only the newest request may write back.
    useEffect(() => {
        const id = activeId;
        if (!id) return;
        const seq = ++contentSeq.current;
        setContent({ status: 'loading', content: '', error: null });

        (async () => {
            try {
                const res: any = await window.electronAPI.coursesLessonContent(courseId, id);
                if (seq !== contentSeq.current) return; // stale — a newer lesson was selected
                const failed = !res || res.ok === false;
                const msg = (failed && typeof res?.error === 'string' && res.error.trim() !== '')
                    ? res.error : 'This lesson could not be loaded.';
                setContent(failed
                    ? { status: 'ready', content: '', error: msg }
                    : { status: 'ready', content: typeof res?.content === 'string' ? res.content : '', error: null });
            } catch (e) {
                if (seq !== contentSeq.current) return;
                setContent({ status: 'ready', content: '', error: e instanceof Error && e.message ? e.message : 'This lesson could not be loaded.' });
            }
        })();
    }, [courseId, activeId]);

    const goPrevNext = (delta: number) => {
        if (!activeId || lessons.length === 0) return; // bounds + no-op are handled by the disabled buttons
        const idx = lessons.findIndex((l) => l.id === activeId);
        const target = lessons[idx + delta];
        if (target) setActiveId(target.id);
    };

    // Optimistically flip completion, then persist; roll back on IPC failure.
    const toggleComplete = async () => {
        const current = lessons.find((l) => l.id === activeId);
        if (!current) return;
        const done = !current.completedAt;
        const nextCompletedAt: string | null = done ? new Date().toISOString() : null;
        setLessons((prev) => prev.map((l) => (l.id === current.id ? { ...l, completedAt: nextCompletedAt } : l)));
        try { await window.electronAPI.coursesSetLessonCompleted([current.id], done); }
        catch { setLessons((prev) => prev.map((l) => (l.id === current.id ? { ...l, completedAt: current.completedAt } : l))); }
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
            if (canonicalKey(l.url) === key) { setActiveId(l.id); return; }
        }
    };

    // ── Render guards (run before the main JSX so it can assume course + current exist) ────────────
    if (loading) return <Notice title="Opening course…" onBack={onBack} />;
    if (disabled) return <Notice title="Premium required" body="Courses Studio is part of Natively Pro. Upgrade to read imported courses." onBack={onBack} />;
    if (loadError || !course || lessons.length === 0) return <Notice title={!course ? 'Course unavailable' : 'Nothing to read yet'} body={loadError ?? undefined} onBack={onBack} />;

    const current = activeId ? lessons.find((l) => l.id === activeId) ?? null : null;
    if (!current) return <Notice title="Select a lesson" body="Choose a lesson from the list to start reading." onBack={onBack} />;

    const total = lessons.length;
    const doneCount = lessons.filter((l) => !!l.completedAt).length;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    const currentIdx = lessons.findIndex((l) => l.id === activeId);
    const trimmedLen = content.content.trim().length;

    // Degraded extraction: an explicit fetch error, or a suspiciously short body.
    const degraded = (content.status === 'ready' && !!content.error) || (content.status === 'ready' && !content.error && trimmedLen > 0 && trimmedLen < 200);

    const visibleLessons = filter.trim() !== ''
        ? lessons.filter((l) => l.title.toLowerCase().includes(filter.trim().toLowerCase()))
        : lessons;

    // Study rail scope — the current lesson plus its module-mates (same parent), capped at four per
    // LLM pass; falls back to just this lesson when no siblings match. Plus course-wide progress and
    // the module's external (non-lesson) links for the labs section.
    const sameModule = lessons.filter((l) => (l.parent ?? null) === (current.parent ?? null));
    const scopeLessons = ((sameModule.length > 0 && sameModule.some((s) => s.id === current.id) ? sameModule : [current]) as Lesson[])
        .slice(0, 4).map((l) => ({ id: l.id, title: l.title }));
    const progress = { done: doneCount, total };
    const externalLinks = lessons.filter((l) => !!l.kind && l.kind !== 'lesson').map((l) => ({ title: l.title, url: l.url }));

    return (
        <div className="min-h-full w-full flex flex-col bg-bg-primary text-text-primary">
            {/* Header — back / title, prev-next + completion on the right */}
            <div className="shrink-0 border-b border-border-muted bg-bg-secondary/60 px-4 py-2.5">
                <div className="flex items-center gap-3">
                    <LiquidGlassButton type="button" variant="clear" className="-ml-1 lg-sm shrink-0 text-text-secondary" onClick={onBack} title="Back to courses" aria-label="Back to courses">
                        <ArrowLeft size={14} />
                    </LiquidGlassButton>
                    <div className="min-w-0 flex-1 leading-tight">
                        <p className="truncate text-[12px] text-text-secondary">{course.name}</p>
                        <h1 className="truncate text-[15px] font-medium text-text-primary" title={current.title}>{current.title}</h1>
                    </div>

                    <span className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums text-text-secondary sm:inline">
                        {doneCount}/{total} · {pct}%
                    </span>
                    {/* Sub-xl: the xl+ rail is hidden, so surface it as a drawer from here. */}
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary xl:hidden" onClick={() => setRailOpen(true)} title="Open study aids" aria-label="Open study aids">
                        <PanelRightOpen size={14} />
                    </LiquidGlassButton>
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={() => goPrevNext(-1)} disabled={currentIdx <= 0} title="Previous lesson" aria-label="Previous lesson">
                        <ChevronLeft size={14} />
                    </LiquidGlassButton>
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={() => goPrevNext(1)} disabled={currentIdx >= total - 1} title="Next lesson" aria-label="Next lesson">
                        <ChevronRight size={14} />
                    </LiquidGlassButton>
                    <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={openOriginal} icon={<ExternalLink size={12} />} title={`Open ${current.title} in the browser`} aria-label={`Open ${current.title} in the browser`}>
                        Open original
                    </LiquidGlassButton>
                    <button type="button" onClick={toggleComplete} aria-pressed={!!current.completedAt} title={current.completedAt ? 'Mark as not complete' : 'Mark as complete'}
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-accent-primary/40 ${current.completedAt ? 'border-accent-primary bg-accent-primary/15 text-accent-primary' : 'border-border-muted text-text-secondary hover:bg-bg-elevated hover:text-text-primary'}`}>
                        <Check size={13} strokeWidth={2.5} />
                    </button>
                </div>
            </div>

            {/* Body — left rail + center reading column */}
            <div className="flex min-h-0 flex-1">
                <aside className="w-60 shrink-0 border-r border-border-muted bg-bg-secondary/40 overflow-y-auto px-3 py-3">
                    <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lessons…"
                        aria-label="Filter lessons" className="mb-2 w-full rounded-lg border border-border-subtle bg-bg-input px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-secondary outline-none focus:border-accent-secondary" />
                    {visibleLessons.length === 0 ? (
                        <p className="px-1 pb-2 pt-6 text-center text-xs text-text-secondary">No lessons match.</p>
                    ) : visibleLessons.map((l) => {
                        const active = l.id === activeId;
                        return (
                            <button key={l.id} type="button" onClick={() => setActiveId(l.id)} title={l.title}
                                className={`mb-0.5 flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left transition-colors ${DEPTH_PL[depthOf(l.tocPath)]} ${active ? 'bg-bg-elevated/80' : 'hover:bg-bg-elevated/40'}`}>
                                <span className={`flex shrink-0 items-center text-[11px] ${l.completedAt ? 'text-accent-primary' : 'text-transparent select-none'}`}><Check size={12} strokeWidth={3} /></span>
                                <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'font-medium text-text-primary' : 'text-text-secondary'}`}>{l.title}</span>
                                {l.kind !== 'lesson' && (
                                    <span className="shrink-0 rounded-full border border-border-subtle bg-bg-elevated/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide leading-none text-text-secondary">{l.kind}</span>
                                )}
                            </button>
                        );
                    })}
                </aside>

                {/* Study rail — xl+ only; scope, progress and links computed above from the lesson list. */}
                <div className="hidden xl:flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border-muted bg-bg-secondary/40 p-3">
                    <StudyRail courseId={courseId} scopeLessons={scopeLessons} progress={progress} externalLinks={externalLinks} />
                </div>

                {/* Keyed by lesson id: switching lessons remounts the container and drops any mid-scroll. */}
                <div key={current.id} className="flex-1 min-w-0 overflow-y-auto">
                    <article className="mx-auto w-full max-w-3xl px-6 py-5">
                        {content.status === 'loading' && (
                            // Skeleton with a tall min-height so the column doesn't jump when markdown lands.
                            <div role="status" aria-label="Loading lesson" className="flex min-h-[60vh] flex-col pt-2">
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
                        {degraded && current.url && (
                            <SettingsNotice tone={tones.warn} icon={<AlertTriangle size={14} />} className="mb-4">
                                Extraction was partial — open the original for full detail.{' '}
                                <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0" onClick={openOriginal} icon={<ExternalLink size={12} />}>Open original</LiquidGlassButton>
                            </SettingsNotice>
                        )}
                        {content.status === 'ready' && content.content.trim() !== '' ? (
                            <LessonMarkdown courseId={course.id} content={content.content} lessonUrls={lessons.map((l) => l.url)} onNavigateUrl={onNavigateUrl} />
                        ) : null}
                    </article>
                </div>

                {/* Compact study-aid drawer for sub-xl widths — class-toggled on purpose (never transformed), so the
                    position:fixed overlays StudyRail opens inside it are not trapped by a transformed ancestor. */}
                {/* inert (React 19) removes the closed drawer's controls from tab order as well. */}
                <div inert={!railOpen || undefined} onClick={(e) => { if (e.target === e.currentTarget && railOpen) setRailOpen(false); }}
                    className={`fixed inset-0 z-50 transition-opacity duration-200 motion-reduce:transition-none xl:hidden ${isLight ? 'bg-black/[0.06]' : 'bg-black/40'} ${railOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
                    <div role="dialog" aria-label="Study aids" className="absolute inset-y-0 right-0 flex w-[min(20rem,94vw)] flex-col overflow-y-auto border-l border-border-muted bg-bg-secondary p-3">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Study aids</p>
                            <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={() => setRailOpen(false)} title="Close study aids" aria-label="Close study aids">
                                <X size={14} />
                            </LiquidGlassButton>
                        </div>
                        <StudyRail courseId={courseId} scopeLessons={scopeLessons} progress={progress} externalLinks={externalLinks} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LessonReader;
