import React, { useEffect, useState } from 'react';
import { ExternalLink, RotateCcw, XCircle } from 'lucide-react';
import QuizPlayer from './QuizPlayer';
import Flashcards from './Flashcards';
import LessonMarkdown from './LessonMarkdown';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { SETTINGS_BTN_BASE, SETTINGS_BTN_NEUTRAL, SettingsNotice, useSettingsTones } from '../settings/SettingsRow';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Transition } from 'framer-motion';

// Courses Studio P3 — study rail for the lesson reader's right pane (xl+ widths): progress, external
// lab links, and four cached LLM study aids. Summary/glossary render inline; quiz/flashcards open in a
// full overlay over the shared player components. Pure presentational — LessonReader computes scope,
// progress and links each render; state here resets when the reader unmounts.

type StudyAidType = 'summary' | 'glossary' | 'quiz' | 'flashcards';

// Local mirrors of the generator contract (QuizPlayer / Flashcards already own these shapes) — no
// electron imports here, matching how every other renderer component in this area is typed.
interface QuizQuestion { q: string; options: string[]; answer: number; explanation?: string }
interface FlashcardPair { front: string; back: string }
interface GlossaryEntry { term: string; definition: string }

// The two aids that render inline, keyed by type: summary is the raw markdown body, glossary a list.
interface StudyAidResults { summary?: string; glossary?: { entries: GlossaryEntry[] } }

interface StudyRailProps {
    courseId: string;
    scopeLessons: Array<{ id: string; title: string }>;
    progress: { done: number; total: number };
    externalLinks: Array<{ title: string; url: string }>;
}

const AID_TYPES: StudyAidType[] = ['summary', 'glossary', 'quiz', 'flashcards'];
const AID_LABELS: Record<StudyAidType, string> = { summary: 'Summary', glossary: 'Glossary', quiz: 'Quiz', flashcards: 'Flashcards' };

// "1 lesson" / "3 lessons" — a bare count reads cheap in pill titles and the scope note.
const lessonCountLabel = (n: number): string => (n === 1 ? '1 lesson' : `${n} lessons`);

// Card-ish section wrapper — every rail block shares the same shape; aid pills reuse the settings button consts.
// Solid item-surface fill + a real edge so each section reads as a distinct panel in both themes.
const CARD = 'rounded-xl border border-border-muted bg-bg-item-surface p-3';

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

// Inline result card — bordered panel with a header row carrying the [↻] fresh-regenerate action.
function ResultCard({ title, onRegenerate, children }: { title: string; onRegenerate: () => void; children: React.ReactNode }) {
    return (
        // Inset one step inside the muted card: a hairline + lighter fill keeps the result distinct from its shell.
        <div className="mt-2 rounded-lg border border-border-subtle bg-bg-elevated p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <p className="truncate text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</p>
                <LiquidGlassButton type="button" variant="clear" className="lg-sm shrink-0 text-text-secondary" onClick={onRegenerate} title="Regenerate with a fresh pass" aria-label={`Regenerate ${title}`}>
                    <RotateCcw size={12} />
                </LiquidGlassButton>
            </div>
            {children}
        </div>
    );
}

const StudyRail: React.FC<StudyRailProps> = ({ courseId, scopeLessons, progress, externalLinks }) => {
    const [busy, setBusy] = useState<StudyAidType | null>(null);
    const [errors, setErrors] = useState<Partial<Record<StudyAidType, string>>>({});
    const [results, setResults] = useState<StudyAidResults>({});
    // Quiz/flashcards payloads stored separately from `results` so the overlay can open straight into a player.
    const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[] | null>(null);
    const [flashCards, setFlashCards] = useState<FlashcardPair[] | null>(null);
    const [panel, setPanel] = useState<'quiz' | 'flashcards' | null>(null);

    // House primitives — semantic tones for errors and the theme-aware overlay scrim + reduced-motion gating.
    const tones = useSettingsTones();
    const isLight = useResolvedTheme() === 'light';
    const reduced = useReducedMotion();
    const overlayTransition: Transition = reduced ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] };

    // Transient overlays own their Escape — one listener for whichever panel is open.
    useEffect(() => {
        if (!panel) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [panel]);

    const { done, total } = progress;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const canGenerate = scopeLessons.length > 0 && busy === null;

    const failAid = (type: StudyAidType, message: string): void => {
        setErrors((prev) => { const next = { ...prev }; next[type] = message; return next; });
    };

    // Apply a successful payload; throws on an unexpected shape so it lands in that aid's error.
    const store = (type: StudyAidType, data: unknown): void => {
        if (type === 'summary') {
            const value = parseSummary(data);
            if (!value) throw new Error('The summary came back in an unexpected shape.');
            setResults((prev) => ({ ...prev, summary: value }));
            return;
        }
        if (type === 'glossary') {
            const entries = parseGlossary(data);
            if (!entries) throw new Error('The glossary came back empty or malformed.');
            setResults((prev) => ({ ...prev, glossary: { entries } }));
            return;
        }
        if (type === 'quiz') {
            const questions = parseQuiz(data);
            if (!questions) throw new Error('The quiz came back with no usable questions.');
            setQuizQuestions(questions); setPanel('quiz');
            return;
        }
        const cards = parseFlashcards(data);
        if (!cards) throw new Error('The flashcards came back empty or malformed.');
        setFlashCards(cards); setPanel('flashcards');
    };

    // One cached LLM pass over the scoped lessons (the main process owns caching; force bypasses it).
    const generate = (type: StudyAidType, force: boolean): void => {
        if (!canGenerate) return;
        setBusy(type);
        setErrors((prev) => { const next = { ...prev }; delete next[type]; return next; });

        const api = window.electronAPI;
        if (!api || typeof api.coursesGenerateStudyAid !== 'function') { failAid(type, 'Study aids are unavailable in this build.'); setBusy(null); return; }

        api.coursesGenerateStudyAid(courseId, type, scopeLessons.map((s) => s.id), force)
            .then((res) => {
                if (!res || res.ok === false) {
                    const msg = !res ? 'The study aid request failed.'
                        : (typeof res.error === 'string' && res.error.trim() !== '' ? res.error : `Could not generate the ${AID_LABELS[type]}.`);
                    throw new Error(msg);
                }
                store(type, res.data);
            })
            .catch((err: unknown) => {
                failAid(type, err instanceof Error && err.message !== '' ? err.message : 'Something went wrong — try again.');
            })
            .finally(() => setBusy(null));
    };

    const openLink = (url: string): void => {
        // Fire-and-forget — main enforces the https allow-list; a failed open must not disturb reading.
        const api = window.electronAPI;
        if (api && typeof api.openExternal === 'function') api.openExternal(url).catch(() => undefined);
    };

    const pillLabel = (type: StudyAidType): string =>
        type === 'quiz' && quizQuestions ? `Quiz · ${quizQuestions.length} Q${quizQuestions.length === 1 ? '' : 's'}` : AID_LABELS[type];

    // An aid that has a payload tints its pill so generated state is visible at a glance.
    const hasResult = (type: StudyAidType): boolean =>
        type === 'summary' ? !!results.summary : type === 'glossary' ? !!results.glossary : type === 'quiz' ? !!quizQuestions : !!flashCards;

    return (
        <div className="flex flex-col gap-3">
            <section className={CARD}>
                {/* Course-wide completion; the only inline style in this file is the dynamic fill width. */}
                <SectionLabel>Progress</SectionLabel>
                <p className="text-xs tabular-nums text-text-secondary">{done} of {total} lessons · {pct}%</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elevated">
                    <div className="h-full rounded-full bg-accent-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
            </section>

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

            {/* Study aids — one cached LLM pass over the scoped lessons, per aid. */}
            <section className={CARD}>
                <SectionLabel>Study aids</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                    {AID_TYPES.map((type) => (
                        <button key={type} type="button" disabled={!canGenerate} onClick={() => generate(type, false)} aria-busy={busy === type}
                            title={`${AID_LABELS[type]} from ${lessonCountLabel(scopeLessons.length)}`}
                            className={`${SETTINGS_BTN_BASE} disabled:cursor-not-allowed ${hasResult(type) && busy !== type ? 'border-accent-secondary bg-accent-subtle text-accent-primary' : SETTINGS_BTN_NEUTRAL}`}>
                            {busy === type ? (
                                <>
                                    {/* House spinner idiom (CoursesHome): a currentColor ring, halted for reduced motion. */}
                                    <span aria-hidden className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                                    {AID_LABELS[type]}…
                                </>
                            ) : pillLabel(type)}
                        </button>
                    ))}
                </div>

                {/* Per-aid errors — one semantic notice per failing aid so each stays identifiable. */}
                {AID_TYPES.some((t) => !!errors[t]) && (
                    <div className="mt-2 space-y-1.5">
                        {AID_TYPES.filter((t) => !!errors[t]).map((t) => (
                            <SettingsNotice key={t} tone={tones.danger} icon={<XCircle size={13} />} alert className="">
                                {errors[t]}
                            </SettingsNotice>
                        ))}
                    </div>
                )}

                {/* Inline results — summary as rendered markdown, glossary as a term/definition list. */}
                {results.summary && (
                    <ResultCard title="Summary" onRegenerate={() => generate('summary', true)}>
                        <LessonMarkdown courseId={courseId} content={results.summary} />
                    </ResultCard>
                )}
                {results.glossary && (
                    <ResultCard title={`Glossary · ${results.glossary.entries.length}`} onRegenerate={() => generate('glossary', true)}>
                        {/* One compact row per term — the rail is too narrow for stacked dt/dd detail. */}
                        <div className="space-y-2">{results.glossary.entries.map((entry) => (
                            <p key={entry.term} className="text-xs leading-relaxed text-text-secondary"><span className="font-medium text-text-primary">{entry.term}</span> — {entry.definition}</p>
                        ))}</div>
                    </ResultCard>
                )}
            </section>

            {/* Scope note — exactly which lessons fed the LLM pass for this aid set. */}
            <p className="px-1 pb-0.5 text-[12px] leading-snug text-text-secondary">Aids generated from {lessonCountLabel(scopeLessons.length)} of this module.</p>

            {/* Quiz overlay — theme-aware scrim + fade/scale entry; Escape or backdrop click closes back to the rail. */}
            <AnimatePresence>
                {panel === 'quiz' && quizQuestions && (
                    <motion.div key="study-aid-overlay-quiz" role="dialog" aria-modal="true" data-study-aid-overlay=""
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={overlayTransition}
                        onClick={(e) => { if (e.target === e.currentTarget) setPanel(null); }}
                        className={`fixed inset-0 z-50 flex items-center justify-center p-6 ${isLight ? 'bg-black/[0.06]' : 'bg-black/40'}`}>
                        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={overlayTransition}
                            className="max-h-[86vh] w-[min(720px,94vw)] overflow-y-auto rounded-xl border border-border-muted bg-bg-elevated p-5">
                            <QuizPlayer questions={quizQuestions} onExit={() => setPanel(null)} />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Flashcards overlay — same treatment, plus an explicit Close under the deck. */}
            <AnimatePresence>
                {panel === 'flashcards' && flashCards && (
                    <motion.div key="study-aid-overlay-flashcards" role="dialog" aria-modal="true" data-study-aid-overlay=""
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={overlayTransition}
                        onClick={(e) => { if (e.target === e.currentTarget) setPanel(null); }}
                        className={`fixed inset-0 z-50 flex items-center justify-center p-6 ${isLight ? 'bg-black/[0.06]' : 'bg-black/40'}`}>
                        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={overlayTransition}
                            className="flex max-h-[86vh] w-[min(560px,94vw)] flex-col overflow-y-auto rounded-xl border border-border-muted bg-bg-elevated p-5">
                            <Flashcards cards={flashCards} />
                            <button type="button" onClick={() => setPanel(null)} title="Close flashcards"
                                className="mt-3 shrink-0 self-center rounded-full border border-border-muted bg-bg-input px-4 py-2 text-xs font-medium text-text-primary transition-all active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-accent-focus">Close</button>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default StudyRail;
