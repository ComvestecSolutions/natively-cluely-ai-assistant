import React, { useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';
import { useSettingsTones } from '../settings/SettingsRow';

// Courses Studio P3 — quiz player over a fixed question set. Pure presentational: the parent owns
// authoring/refresh; this tracks picked / revealed / history only, and retry rebuilds the run from
// the original questions via ref so repeated retries still map back to the caller's first input.

interface QuizQuestion {
    q: string;
    options: string[];
    answer: number;
    explanation?: string;
}

interface QuizPlayerProps {
    questions: QuizQuestion[];
    onExit?: () => void;
}

// One answered question. `q` is the picked option index, or null if revealed without a pick.
interface HistoryEntry {
    q: number | null;
    correct: boolean;
}

// Structural only — each state branch below contributes exactly one border/fill/text set, so a
// tone can never lose a class-conflict against the base (Tailwind resolves conflicts by
// stylesheet order, not by class-list order).
const OPTION_BASE = 'flex w-full items-center gap-2 rounded-lg border p-2.5 text-left text-[13px] transition-all duration-150 active:scale-[0.985] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-accent-focus';

function QuizPlayer({ questions, onExit }: QuizPlayerProps) {
    const originalRef = useRef(questions);
    // Indices into originalRef.current — retry rebuilds the run from the originals at these indices.
    const [order, setOrder] = useState<number[]>(() => questions.map((_, i) => i));
    const [idx, setIdx] = useState(0);
    const [picked, setPicked] = useState<number | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [finished, setFinished] = useState(false);
    // Semantic ok/danger fills for the revealed rows — the settings tone idiom, never raw palette.
    const tones = useSettingsTones();

    // pos always wraps into the run bounds, so this resolves for any live screen.
    const question = originalRef.current[order[idx]];
    const isLast = idx >= order.length - 1;

    // ── Actions ────────────────────────────────────────────────────────────
    const checkAnswer = () => {
        if (revealed || picked === null) return;
        setHistory((h) => [...h, { q: picked, correct: picked === question.answer }]);
        setRevealed(true);
    };

    const goNext = () => {
        if (isLast) { setFinished(true); return; }
        setIdx(idx + 1);
        setPicked(null);
        setRevealed(false);
    };

    // Map this run's misses back to original indices, rebuild the run from the original questions.
    const retryWrongsOnly = () => {
        const missed = order.filter((_, pos) => !(history[pos] && history[pos].correct));
        if (missed.length === 0) return;
        setOrder(missed);
        setIdx(0);
        setPicked(null);
        setRevealed(false);
        setHistory([]);
        setFinished(false);
    };

    // ── Render guards (all hooks run above, so early returns are safe) ─────
    if (originalRef.current.length === 0) {
        return (
            <div className="min-h-full flex items-center justify-center px-6 py-8">
                <div className="w-full max-w-md rounded-2xl border border-border-muted bg-bg-item-surface p-8 text-center">
                    <h2 className="text-lg font-medium text-text-primary">No questions yet</h2>
                    <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">This study set has no quiz questions.</p>
                    <LiquidGlassButton variant="clear" className="mt-5 lg-sm text-text-primary" onClick={onExit} title="Close">
                        Close
                    </LiquidGlassButton>
                </div>
            </div>
        );
    }

    // ── Results screen ─────────────────────────────────────────────────────
    if (finished) {
        const runTotal = order.length;
        const correctCount = history.filter((h) => h.correct).length;
        const pct = runTotal > 0 ? Math.round((correctCount / runTotal) * 100) : 0;
        // `order` holds original indices, so misses keep pointing at the original questions.
        const missedEntries = order.map((origIdx, pos) => ({ origIdx, entry: history[pos] }))
            .filter((m) => m.entry && !m.entry.correct);
        return (
            <div className="flex min-h-full w-full animate-fade-in-up motion-reduce:animate-none flex-col bg-bg-primary text-text-primary">
                <div className="flex-1 overflow-y-auto px-5 py-6">
                    <h2 className="text-[15px] font-medium text-text-primary">Quiz results</h2>
                    <p className="mt-3 text-[30px] font-semibold leading-none tabular-nums text-text-primary">{correctCount}/{runTotal} · {pct}%</p>

                    {missedEntries.length > 0 ? (
                        <div className="mt-5 space-y-2">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Missed questions</p>
                            {missedEntries.map(({ origIdx }) => {
                                const q = originalRef.current[origIdx];
                                return (
                                    <div key={origIdx} className="rounded-lg border border-border-muted bg-bg-elevated px-3 py-2.5">
                                        <p className="text-[13px] font-medium text-text-primary">{q.q}</p>
                                        <p className={`mt-1 text-[12px] ${tones.text.ok}`}>Correct: {q.options[q.answer]}</p>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="mt-4 text-[13px] text-text-secondary">Nothing to review — every question was answered correctly.</p>
                    )}
                </div>

                {/* Footer — retry the missed subset, or close back out */}
                <div className="flex shrink-0 items-center gap-2 border-t border-border-muted bg-bg-secondary px-4 py-3">
                    {missedEntries.length > 0 ? (
                        <LiquidGlassButton variant="action" className="lg-sm" onClick={retryWrongsOnly} title="Replay only the questions you missed">
                            Retry wrongs only
                        </LiquidGlassButton>
                    ) : null}
                    <span className="flex-1" />
                    <LiquidGlassButton variant="clear" className="lg-sm text-text-primary" onClick={onExit} title="Close quiz">
                        Close
                    </LiquidGlassButton>
                </div>
            </div>
        );
    }

    // ── Question screen (question is defined here by construction) ─────────
    return (
        <div className="flex min-h-full w-full flex-col bg-bg-primary text-text-primary">
            {/* Top row — position + exit, with an answered/total progress strip under it */}
            <div className="shrink-0 border-b border-border-muted bg-bg-secondary">
                <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-[12px] tabular-nums text-text-secondary">Question {idx + 1}/{order.length}</span>
                    <LiquidGlassButton variant="clear" className="lg-sm text-text-secondary" onClick={onExit} title="Exit quiz">
                        Exit
                    </LiquidGlassButton>
                </div>
                <div role="progressbar" aria-label="Questions answered" aria-valuemin={0} aria-valuemax={order.length} aria-valuenow={history.length}
                    className="h-[3px] w-full bg-bg-input">
                    <div
                        className="h-full bg-accent-primary transition-[width] duration-300 motion-reduce:transition-none"
                        style={{ width: `${order.length > 0 ? Math.round((history.length / order.length) * 100) : 0}%` }}
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
                {/* Keyed by position so advancing a question re-runs the house fade-in */}
                <div key={idx} className="animate-fade-in-up motion-reduce:animate-none">
                {/* Prompt */}
                <p className="text-[14px] font-medium leading-relaxed text-text-primary">{question.q}</p>

                {/* Options — reveal coloring only after checking */}
                <div className="mt-3 space-y-2">
                    {question.options.map((opt, i) => {
                        const isCorrect = revealed && i === question.answer;
                        const isWrongPick = revealed && picked === i && i !== question.answer;
                        const dimmed = revealed && !isCorrect && !isWrongPick;
                        return (
                            <button key={i} type="button" disabled={revealed} onClick={() => setPicked(i)}
                                className={`${OPTION_BASE} ${dimmed ? 'border-border-muted text-text-secondary opacity-60' : isCorrect ? `${tones.ok} cursor-default` : isWrongPick ? `${tones.danger} cursor-default` : picked === i ? 'border-accent-primary bg-bg-input text-text-primary' : 'border-border-muted text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}>
                                {/* The slot stays put in every state so option text never shifts on reveal */}
                                <span aria-hidden className="flex h-4 w-3.5 shrink-0 items-center">
                                    {isCorrect ? <Check size={13} /> : isWrongPick ? <X size={13} /> : null}
                                </span>
                                <span>{opt}</span>
                            </button>
                        );
                    })}
                </div>
                </div>

                {/* Explanation card after reveal — its own fade so it lands on check, not with the question */}
                {revealed && question.explanation ? (
                    <div role="note" className="mt-3 animate-fade-in-up motion-reduce:animate-none rounded-lg border border-border-muted bg-bg-secondary px-3 py-2.5 text-[12px] leading-relaxed text-text-secondary">
                        {question.explanation}
                    </div>
                ) : null}
            </div>

            {/* Action row — the hint doubles as an accessible name extension for the initially-disabled button */}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-muted bg-bg-secondary px-4 py-3">
                {!revealed && picked === null ? (
                    <p id="quiz-check-hint" className="text-[11px] text-text-tertiary">Select an answer first</p>
                ) : null}
                {revealed ? (
                    <LiquidGlassButton variant="action" className="lg-sm" onClick={goNext} title={isLast ? 'See results' : 'Next question'}>
                        {isLast ? 'See results' : 'Next question'}
                    </LiquidGlassButton>
                ) : (
                    <LiquidGlassButton
                        variant="action"
                        className="lg-sm"
                        onClick={checkAnswer}
                        disabled={picked === null}
                        aria-describedby={picked === null ? 'quiz-check-hint' : undefined}
                    >
                        Check answer
                    </LiquidGlassButton>
                )}
            </div>
        </div>
    );
};

export default QuizPlayer;
