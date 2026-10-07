import React, { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, ChevronDown, CircleHelp, ExternalLink, Info, Layers3, List, LoaderCircle, RotateCcw, Settings2, Sparkles, XCircle } from 'lucide-react';
import QuizPlayer from './QuizPlayer';
import Flashcards from './Flashcards';
import LessonMarkdown from './LessonMarkdown';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { SETTINGS_CARD, SettingsNotice, useSettingsTones } from '../settings/SettingsRow';

// The reader supplies scope, progress, and links; saved aids belong to that exact course/lesson scope.

type StudyAidType = 'summary' | 'glossary' | 'quiz' | 'flashcards';

// Local mirrors of the generator contract (QuizPlayer / Flashcards already own these shapes) — no
// electron imports here, matching how every other renderer component in this area is typed.
interface QuizQuestion { q: string; options: string[]; answer: number; explanation?: string }
interface FlashcardPair { front: string; back: string }
interface GlossaryEntry { term: string; definition: string }

interface StudyAidResults {
    summary?: string;
    glossary?: { entries: GlossaryEntry[] };
    quiz?: QuizQuestion[];
    flashcards?: FlashcardPair[];
}

interface StudyRailProps {
    courseId: string;
    scopeLessons: Array<{ id: string; title: string }>;

    externalLinks: Array<{ title: string; url: string }>;
    moduleLabel?: string;
}

const AID_TYPES: StudyAidType[] = ['summary', 'glossary', 'quiz', 'flashcards'];
const AID_LABELS: Record<StudyAidType, string> = { summary: 'Summary', glossary: 'Glossary', quiz: 'Quiz', flashcards: 'Flashcards' };
const AID_ICONS = { summary: BookOpen, glossary: List, quiz: CircleHelp, flashcards: Layers3 };

// "1 lesson" / "3 lessons" — a bare count reads cheap in pill titles and the scope note.
const lessonCountLabel = (n: number): string => (n === 1 ? '1 lesson' : `${n} lessons`);

// Card-ish section wrapper — every rail block shares the same shape.
// Solid item-surface fill + a real edge so each section reads as a distinct panel in both themes.
const CARD = `${SETTINGS_CARD} p-3`;

// Titled section header — the small uppercase muted label above every rail block.
function SectionLabel({ children }: { children: React.ReactNode }) {
    return <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">{children}</p>;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Main owns these payload shapes — validate enough to render safely, surfacing a per-aid error on drift.
const parseSummary = (data: unknown): string | null => (isStr(data) && data.trim() !== '' ? data : null);

function parseGlossary(data: unknown): GlossaryEntry[] | null {
    if (!isRecord(data)) return null;
    const out: GlossaryEntry[] = [];
    for (const item of Array.isArray(data.entries) ? data.entries : []) {
        if (!isRecord(item)) continue;
        const term = item.term, definition = item.definition;
        if (!isStr(term) || term.trim() === '' || !isStr(definition)) continue;
        out.push({ term, definition });
    }
    return out.length > 0 ? out : null;
}

function parseQuiz(data: unknown): QuizQuestion[] | null {
    if (!isRecord(data)) return null;
    const out: QuizQuestion[] = [];
    for (const item of Array.isArray(data.questions) ? data.questions : []) {
        if (!isRecord(item)) continue;
        const options = item.options;
        if (!isStr(item.q) || item.q.trim() === '' || !Array.isArray(options) || options.length === 0 || !options.every(isStr)) continue;
        const answer = item.answer;
        if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
        out.push({ q: item.q, options, answer, ...(isStr(item.explanation) ? { explanation: item.explanation } : {}) });
    }
    return out.length > 0 ? out : null;
}

function parseFlashcards(data: unknown): FlashcardPair[] | null {
    if (!isRecord(data)) return null;
    const out: FlashcardPair[] = [];
    for (const item of Array.isArray(data.cards) ? data.cards : []) {
        if (!isRecord(item) || !isStr(item.front) || !isStr(item.back)) continue;
        out.push({ front: item.front, back: item.back });
    }
    return out.length > 0 ? out : null;
}

const StudyRail: React.FC<StudyRailProps> = ({ courseId, scopeLessons, externalLinks, moduleLabel }) => {
    const [active, setActive] = useState<StudyAidType>('summary');
    const [busy, setBusy] = useState<StudyAidType | null>(null);
    const [loading, setLoading] = useState<Partial<Record<StudyAidType, boolean>>>({});
    const [errors, setErrors] = useState<Partial<Record<StudyAidType, string>>>({});
    const [results, setResults] = useState<StudyAidResults>({});
    const [resultScope, setResultScope] = useState('');
    const [playerVersion, setPlayerVersion] = useState({ quiz: 0, flashcards: 0 });
    const tabId = useId();
    const aidButtons = useRef<Partial<Record<StudyAidType, HTMLButtonElement>>>({});
    const scopeEpoch = useRef(0);
    const revisions = useRef<Record<StudyAidType, number>>({ summary: 0, glossary: 0, quiz: 0, flashcards: 0 });
    const busyRef = useRef(false);
    const scopeKey = JSON.stringify([courseId, scopeLessons.map((lesson) => lesson.id)]);
    const visible = resultScope === scopeKey ? results : {};
    const tones = useSettingsTones();

    useEffect(() => {
        const epoch = ++scopeEpoch.current;
        busyRef.current = false;
        setBusy(null); setErrors({}); setResults({}); setResultScope(scopeKey); setLoading({});
        const api = window.electronAPI;
        if (scopeLessons.length && typeof api?.coursesLookupStudyAid === 'function') {
            setLoading({ summary: true, glossary: true, quiz: true, flashcards: true });
            for (const type of AID_TYPES) {
                const revision = revisions.current[type];
                void (async () => {
                    try {
                        const res = await api.coursesLookupStudyAid(courseId, type, scopeLessons.map((s) => s.id));
                        if (scopeEpoch.current !== epoch || revisions.current[type] !== revision) return;
                        if (!res || res.disabled || res.ok === false || res.error) {
                            throw new Error(typeof res?.error === 'string' && res.error.trim() ? res.error : `Could not load the saved ${AID_LABELS[type]}.`);
                        }
                        if (res.cached) store(type, res.data);
                    } catch (err) {
                        if (scopeEpoch.current === epoch && revisions.current[type] === revision) {
                            failAid(type, err instanceof Error && err.message ? err.message : 'Could not load saved study aids.');
                        }
                    } finally {
                        if (scopeEpoch.current === epoch) setLoading((prev) => ({ ...prev, [type]: false }));
                    }
                })();
            }
        }
        return () => { ++scopeEpoch.current; busyRef.current = false; };
    }, [scopeKey]);


    const hasResult = (type: StudyAidType): boolean => !!visible[type];
    const canGenerate = scopeLessons.length > 0 && busy === null && !loading[active];

    const failAid = (type: StudyAidType, message: string): void => {
        setErrors((prev) => ({ ...prev, [type]: message }));
    };

    // Validate both persisted and newly generated payloads before rendering them.
    const store = (type: StudyAidType, data: unknown): void => {
        if (type === 'summary') {
            const value = parseSummary(data);
            if (!value) throw new Error('The summary came back in an unexpected shape.');
            setResults((prev) => ({ ...prev, summary: value }));
        } else if (type === 'glossary') {
            const entries = parseGlossary(data);
            if (!entries) throw new Error('The glossary came back empty or malformed.');
            setResults((prev) => ({ ...prev, glossary: { entries } }));
        } else if (type === 'quiz') {
            const questions = parseQuiz(data);
            if (!questions) throw new Error('The quiz came back with no usable questions.');
            setResults((prev) => ({ ...prev, quiz: questions }));
        } else {
            const cards = parseFlashcards(data);
            if (!cards) throw new Error('The flashcards came back empty or malformed.');
            setResults((prev) => ({ ...prev, flashcards: cards }));
        }
    };

    const generate = async (type: StudyAidType, force: boolean): Promise<void> => {
        if (type !== active || !canGenerate || busyRef.current) return;
        busyRef.current = true;
        const epoch = scopeEpoch.current;
        const revision = ++revisions.current[type];
        setBusy(type);
        setErrors((prev) => ({ ...prev, [type]: undefined }));
        try {
            const api = window.electronAPI;
            if (!api || typeof api.coursesGenerateStudyAid !== 'function') throw new Error('Study aids are unavailable in this build.');
            const res = await api.coursesGenerateStudyAid(courseId, type, scopeLessons.map((s) => s.id), force) as
                { ok?: boolean; disabled?: boolean; error?: string; data?: unknown } | null;
            if (epoch !== scopeEpoch.current || revision !== revisions.current[type]) return;
            if (!res || res.disabled || res.ok === false || res.error) {
                throw new Error(typeof res?.error === 'string' && res.error.trim() ? res.error
                    : res?.disabled ? 'Study aids are disabled or local course storage is unavailable. Check access and retry.'
                        : `Could not generate the ${AID_LABELS[type]}.`);
            }
            store(type, res.data);
            if (type === 'quiz' || type === 'flashcards') setPlayerVersion((prev) => ({ ...prev, [type]: prev[type] + 1 }));
        } catch (err) {
            if (epoch === scopeEpoch.current) failAid(type, err instanceof Error && err.message ? err.message : 'Something went wrong — try again.');
        } finally {
            if (epoch === scopeEpoch.current) { busyRef.current = false; setBusy(null); }
        }
    };

    const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, type: StudyAidType): void => {
        const index = AID_TYPES.indexOf(type);
        const next = event.key === 'ArrowRight' ? AID_TYPES[(index + 1) % AID_TYPES.length]
            : event.key === 'ArrowLeft' ? AID_TYPES[(index + AID_TYPES.length - 1) % AID_TYPES.length]
                : event.key === 'Home' ? AID_TYPES[0] : event.key === 'End' ? AID_TYPES[AID_TYPES.length - 1] : null;
        if (!next) return;
        event.preventDefault();
        setActive(next);
        aidButtons.current[next]?.focus();
    };

    const leavePractice = (): void => { setActive('summary'); aidButtons.current.summary?.focus(); };
    useEffect(() => {
        if (active !== 'quiz' && active !== 'flashcards') return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leavePractice(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [active]);

    const openLink = (url: string): void => {
        // Main enforces the https allow-list; a failed open must not disturb reading.
        const api = window.electronAPI;
        if (api && typeof api.openExternal === 'function') api.openExternal(url).catch(() => undefined);
    };

    return (
        <div className="flex flex-col gap-3">

            {/* Labs & practice — external links out of the module; the whole section hides when empty. */}
            {externalLinks.length > 0 && (
                <section className={CARD}>
                    <SectionLabel>Labs &amp; practice</SectionLabel>
                    <div className="space-y-1.5">
                        {externalLinks.map((link, i) => (
                            <div key={`${link.url}-${i}`} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:[background-color:var(--bg-row-hover)]">
                                <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={link.title}>{link.title}</span>
                                <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={() => openLink(link.url)} title={`Open ${link.title} in the browser`} aria-label={`Open ${link.title} in the browser`}>
                                    <ExternalLink size={12} />
                                </LiquidGlassButton>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <section className={CARD} aria-label="Study aids">
                <div role="tablist" aria-label="Study aid type" className="grid grid-cols-2 gap-1 rounded-lg border border-border-subtle bg-bg-secondary p-1">
                    {AID_TYPES.map((type) => {
                        const Icon = AID_ICONS[type];
                        return (
                            <div key={type} role="presentation" className="relative min-w-0">
                                <button id={`${tabId}-${type}`} ref={(node) => { if (node) aidButtons.current[type] = node; else delete aidButtons.current[type]; }}
                                    type="button" role="tab" aria-selected={active === type} aria-controls={`${tabId}-panel`}
                                    tabIndex={active === type ? 0 : -1} onClick={() => setActive(type)} onKeyDown={(event) => onTabKeyDown(event, type)}
                                    className={`w-full truncate rounded-md border px-6 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent-focus ${active === type ? 'border-border-subtle bg-bg-elevated text-text-primary shadow-sm' : 'border-transparent text-text-secondary hover:bg-bg-item-surface hover:text-text-primary'}`}>
                                    {AID_LABELS[type]}
                                </button>
                                <Icon size={13} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary" />
                                {hasResult(type) && <CheckCircle2 size={11} aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-accent-primary" />}
                            </div>
                        );
                    })}
                </div>
                <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${active}`} tabIndex={0} className="mt-2 min-w-0 rounded-lg border border-border-subtle bg-bg-elevated p-3">
                    <details key={scopeKey} className="group mb-3 text-xs text-text-secondary">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md focus-visible:ring-2 focus-visible:ring-accent-focus [&::-webkit-details-marker]:hidden">
                            <ChevronDown size={13} aria-hidden="true" className="shrink-0 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
                            <span className="min-w-0 break-words">Scope: {moduleLabel ? `${moduleLabel} · ` : ''}{lessonCountLabel(scopeLessons.length)}</span>
                        </summary>
                        <ul className="mt-2 list-outside list-disc space-y-1 pl-6 leading-relaxed marker:text-text-tertiary">
                            {scopeLessons.map((lesson) => <li key={lesson.id} className="break-words pl-0.5">{lesson.title}</li>)}
                        </ul>
                    </details>
                    <LiquidGlassButton type="button" variant={hasResult(active) ? 'clear' : 'action'} className={`lg-sm max-w-full focus-visible:ring-2 focus-visible:ring-accent-focus ${hasResult(active) ? 'text-text-primary' : ''}`} disabled={!canGenerate} aria-busy={busy === active}
                        icon={busy === active ? <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" /> : hasResult(active) ? <RotateCcw size={13} /> : <Sparkles size={13} />}
                        onClick={() => { void generate(active, hasResult(active)); }}>
                        {busy === active ? `Generating ${AID_LABELS[active]}…` : `${hasResult(active) ? 'Regenerate' : 'Generate'} ${AID_LABELS[active]}`}
                    </LiquidGlassButton>
                    {errors[active] && (
                        <SettingsNotice tone={tones.danger} icon={<XCircle size={13} />} alert className="mt-2">
                            <span className="font-medium">{AID_LABELS[active]}: </span>{errors[active]}
                            <div className="mt-2 flex flex-wrap gap-2">
                                <LiquidGlassButton type="button" variant="action" className="lg-sm" icon={<RotateCcw size={13} />} disabled={!canGenerate} onClick={() => { void generate(active, true); }}>Retry {active}</LiquidGlassButton>
                                <LiquidGlassButton type="button" variant="clear" className="lg-sm text-text-primary" icon={<Settings2 size={13} />} onClick={() => { void window.electronAPI?.openSettingsTab?.('ai-providers'); }}>AI provider settings</LiquidGlassButton>
                            </div>
                        </SettingsNotice>
                    )}
                    {loading[active] && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-text-secondary"><LoaderCircle size={13} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />Checking saved {AID_LABELS[active].toLowerCase()}…</p>}
                    {!loading[active] && !hasResult(active) && !errors[active] && (
                        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-text-secondary"><Info size={13} aria-hidden="true" className="mt-0.5 shrink-0" />No saved {AID_LABELS[active].toLowerCase()} for this scope yet.</p>
                    )}
                    {active === 'summary' && visible.summary && (
                        <div className="mt-3 min-w-0 border-t border-border-subtle pt-3 [&>div]:!space-y-2 [&>div]:!text-[13px] [&_h1]:!pt-2 [&_h1]:!text-[15px] [&_h2]:!pt-2 [&_h2]:!text-[14px] [&_h3]:!pt-2 [&_h3]:!text-[13px] [&_ul]:!space-y-1">
                            <LessonMarkdown courseId={courseId} content={visible.summary} />
                        </div>
                    )}
                    {active === 'glossary' && visible.glossary && (
                        <dl className="mt-3 min-w-0 divide-y divide-border-subtle border-t border-border-subtle">{visible.glossary.entries.map((entry) => (
                            <div key={entry.term} className="min-w-0 break-words py-2 first:pt-3 last:pb-0">
                                <dt className="text-[13px] font-semibold leading-snug text-text-primary">{entry.term}</dt>
                                <dd className="mt-0.5 text-xs leading-relaxed text-text-secondary">{entry.definition}</dd>
                            </div>
                        ))}</dl>
                    )}
                    {visible.quiz && <div className="mt-3" hidden={active !== 'quiz'} aria-hidden={active !== 'quiz'} inert={active !== 'quiz'} data-study-aid-player={active === 'quiz' ? '' : undefined}><QuizPlayer key={`${scopeKey}-${playerVersion.quiz}`} questions={visible.quiz} onExit={leavePractice} /></div>}
                    {visible.flashcards && <div className="mt-3" hidden={active !== 'flashcards'} aria-hidden={active !== 'flashcards'} inert={active !== 'flashcards'} data-study-aid-player={active === 'flashcards' ? '' : undefined}><Flashcards key={`${scopeKey}-${playerVersion.flashcards}`} cards={visible.flashcards} /></div>}
                </div>
            </section>
        </div>
    );
};

export default StudyRail;
