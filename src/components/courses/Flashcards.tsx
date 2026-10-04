import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { SETTINGS_BTN_BASE, SETTINGS_BTN_NEUTRAL, useSettingsTones } from '../settings/SettingsRow';

// Courses Studio P3 — flashcard drill over a fixed card set. Pure presentational: the parent owns
// the cards; this component tracks deck order (Shuffle = Fisher-Yates on a copy of the index list),
// position (advancing past the end just wraps to 0 — no hard stop) and the session's known/unknown
// tallies. Local type mirrors the study-tools contract instead of importing electron internals.

interface FlashcardPair {
    front: string;
    back: string;
}

interface FlashcardsProps {
    cards: FlashcardPair[];
}


function Flashcards({ cards }: FlashcardsProps) {
    const [order, setOrder] = useState<number[]>(() => cards.map((_, i) => i));
    const [pos, setPos] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [session, setSession] = useState({ known: 0, unknown: 0 });

    // Fisher-Yates on a copy so the stored order is never mutated in place.
    const shuffleDeck = () => {
        const next = [...order];
        for (let i = next.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [next[i], next[j]] = [next[j], next[i]];
        }
        setOrder(next);
    };

    // Grade the visible card, then advance — wrapping past the end back to the start.
    const gradeCard = (result: 'known' | 'unknown') => {
        setSession((s) => ({ known: s.known + (result === 'known' ? 1 : 0), unknown: s.unknown + (result === 'unknown' ? 1 : 0) }));
        setFlipped(false);
        if (cards.length > 0) setPos((p) => (p + 1) % cards.length);
    };

    const resetSession = () => setSession({ known: 0, unknown: 0 });

    // Semantic tones for counters + grade buttons (theme-aware) and reduced-motion gating for the flip.
    const tones = useSettingsTones();
    const reduced = useReducedMotion();

    // Shared settings button consts — the ghost deck controls in the header row.
    const headerBtnClass = `${SETTINGS_BTN_BASE} ${SETTINGS_BTN_NEUTRAL}`;

    // ── Render guard (all hooks run above, so an early return is safe) ─────
    if (cards.length === 0) {
        return (
            <div className="flex min-h-full items-center justify-center px-6 py-8">
                <div className="w-full max-w-md rounded-2xl border border-border-muted bg-bg-item-surface p-8 text-center">
                    <h2 className="text-lg font-medium text-text-primary">No flashcards yet</h2>
                    <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">Add some terms to this study set to start drilling.</p>
                </div>
            </div>
        );
    }

    // pos always wraps into [0, cards.length), so this resolves for any live render.
    const card = cards[order[pos]];

    return (
        <div className="flex min-h-full w-full flex-col bg-bg-primary text-text-primary">
            {/* Header — position counter + deck controls */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-muted bg-bg-secondary px-4 py-2.5">
                <span className="min-w-0 truncate text-[12px] tabular-nums text-text-secondary">
                    Card {pos + 1}/{cards.length} ·{' '}
                    <span className={`inline-flex items-center gap-0.5 ${tones.text.ok}`}><Check size={11} />{session.known}</span> ·{' '}
                    <span className={`inline-flex items-center gap-0.5 ${tones.text.danger}`}><X size={11} />{session.unknown}</span>
                </span>
                <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={shuffleDeck} title="Shuffle deck order" className={headerBtnClass}>Shuffle</button>
                    <button type="button" onClick={resetSession} title="Reset the known/unknown tally (not the deck)" className={headerBtnClass}>Reset tally</button>
                </div>
            </div>

            {/* Card — a real 3D flip (preserve-3d container, backface-hidden faces); reduced motion flips instantly. */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
                <button type="button" onClick={() => setFlipped((f) => !f)} aria-label={flipped ? 'Flip back to the term' : 'Reveal the answer'}
                    className="group relative block h-[240px] w-full rounded-xl [perspective:1200px] focus-visible:ring-2 focus-visible:ring-accent-focus">
                    <motion.div initial={false} animate={{ rotateY: flipped ? 180 : 0 }}
                        transition={reduced ? { duration: 0 } : { duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                        style={{ transformStyle: 'preserve-3d' }} className="absolute inset-0">
                        <div className="flex h-full flex-col items-center justify-center overflow-y-auto rounded-xl border border-border-muted bg-bg-item-surface p-5 text-center transition-colors group-hover:border-accent-secondary [backface-visibility:hidden]">
                            <p className="text-[14px] font-medium leading-relaxed text-text-primary">{card.front}</p>
                            <span className="mt-3 shrink-0 text-[11px] uppercase tracking-wide text-text-secondary">Tap to flip</span>
                        </div>
                        {/* The answer face also steps down in type (smaller, lighter ink) so front/back differ beyond color. */}
                        <div className="absolute inset-0 flex h-full w-full flex-col items-center justify-center overflow-y-auto rounded-xl border border-border-muted bg-bg-item-surface p-5 text-center [transform:rotateY(180deg)] [backface-visibility:hidden]">
                            <p className="text-[13px] leading-relaxed text-text-secondary">{card.back}</p>
                            <span className="mt-3 shrink-0 text-[11px] uppercase tracking-wide text-text-secondary">Tap to flip</span>
                        </div>
                    </motion.div>
                </button>
            </div>

            {/* Grading — mark the card, keep drilling (the deck wraps) */}
            <div className="flex shrink-0 items-center gap-2 border-t border-border-muted bg-bg-secondary px-4 py-3">
                {/* Semantic tones carry the theme-aware fill/border/text; glyphs mark the outcome beyond color. */}
                <button type="button" onClick={() => gradeCard('known')}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-lg border py-2 text-xs font-medium transition-colors active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-accent-focus ${tones.ok}`}>
                    <Check size={14} />Got it
                </button>
                <button type="button" onClick={() => gradeCard('unknown')}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-lg border py-2 text-xs font-medium transition-colors active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-accent-focus ${tones.danger}`}>
                    <X size={14} />Still learning
                </button>
            </div>
        </div>
    );
};

export default Flashcards;
