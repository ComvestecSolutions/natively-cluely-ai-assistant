import React, { useRef, useState } from 'react';
import LiquidGlassButton from '../../ui-components/LiquidGlassButton';

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

const OPTION_BASE = 'w-full rounded-lg border p-2.5 text-left text-[13px] transition-colors';

function QuizPlayer({ questions, onExit }: QuizPlayerProps) {
    const originalRef = useRef(questions);
    // Indices into originalRef.current — retry rebuilds the run from the originals at these indices.
    const [order, setOrder] = useState<number[]>(() => questions.map((_, i) => i));
    const [idx, setIdx] = useState(0);
    const [picked, setPicked] = useState<number | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [finished, setFinished] = useState(false);

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
                <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-item-surface p-8 text-center">
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
            <div className="flex min-h-full w-full flex-col bg-bg-primary text-text-primary">
                <div className="flex-1 overflow-y-auto px-5 py-6">
                    <h2 className="text-[15px] font-medium text-text-primary">Quiz results</h2>
                    <p className="mt-3 text-[30px] font-semibold leading-none tabular-nums text-text-primary">{correctCount}/{runTotal} · {pct}%</p>

                    {missedEntries.length > 0 ? (
                        <div className="mt-5 space-y-2">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Missed questions</p>
                            {missedEntries.map(({ origIdx }) => {
                                const q = originalRef.current[origIdx];
                                return (
                                    <div key={origIdx} className="rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2.5">
                                        <p className="text-[13px] font-medium text-text-primary">{q.q}</p>
                                        <p className="mt-1 text-[12px] text-green-500">Correct: {q.options[q.answer]}</p>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="mt-4 text-[13px] text-text-secondary">Nothing to review — every question was answered correctly.</p>
                    )}
                </div>

                {/* Footer — retry the missed subset, or close back out */}
                <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-bg-secondary/60 px-4 py-3">
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
            {/* Top row — position + exit */}
            <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-bg-secondary/60 px-4 py-2.5">
                <span className="text-[12px] tabular-nums text-text-secondary">Question {idx + 1}/{order.length}</span>
                <LiquidGlassButton variant="clear" className="lg-sm text-text-secondary" onClick={onExit} title="Exit quiz">
                    Exit
                </LiquidGlassButton>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
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
                                className={`${OPTION_BASE} ${dimmed ? 'border-border-subtle text-text-secondary opacity-50' : isCorrect ? 'border-green-500 bg-green-500/10 text-green-500 ring-1 ring-green-500' : isWrongPick ? 'border-red-500 bg-red-500/10 text-red-500' : picked === i ? 'border-accent-primary bg-bg-elevated/60 text-text-primary' : 'border-border-subtle text-text-secondary hover:bg-bg-elevated/40 hover:text-text-primary'} ${revealed ? 'cursor-default' : ''}`}>
                                {opt}
                            </button>
                        );
                    })}
                </div>

                {/* Explanation card after reveal */}
                {revealed && question.explanation ? (
                    <div role="note" className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary/60 px-3 py-2.5 text-[12px] leading-relaxed text-text-secondary">
                        {question.explanation}
                    </div>
                ) : null}
            </div>

            {/* Action row */}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle bg-bg-secondary/60 px-4 py-3">
                {revealed ? (
                    <LiquidGlassButton variant="action" className="lg-sm" onClick={goNext} title={isLast ? 'See results' : 'Next question'}>
                        {isLast ? 'See results' : 'Next question'}
                    </LiquidGlassButton>
                ) : (
                    <LiquidGlassButton variant="action" className="lg-sm" onClick={checkAnswer} disabled={picked === null}>
                        Check answer
                    </LiquidGlassButton>
                )}
            </div>
        </div>
    );
};

export default QuizPlayer;
