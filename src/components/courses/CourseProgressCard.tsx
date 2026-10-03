import React from 'react';
import { useT } from '../../i18n';
import { AipBadge, type AipTone } from '../settings/AIProvidersSettings';
import { useSettingsTones } from '../settings/SettingsRow';

export type CourseImportPhase = 'plan' | 'page' | 'assets' | 'importing' | 'done' | 'failed';

/** Progress model for one import run, as the UI tracks it. */
export interface CourseImportProgress {
    phase: CourseImportPhase;
    done: number;
    total: number;
    current?: string;
    failed: number;
    skipped: number;
}

/** The progress model plus the course id the UI adopted as its active run. */
export interface CourseImportRun extends CourseImportProgress {
    courseId: string;
}

// Stage events arrive under more than one spelling ('page'/'pages', 'importing'/'indexing');
// every mapping below tolerates them all, so a value outside the local union still renders sensibly.
const STAGE_PHASES = ['plan', 'page', 'pages', 'asset', 'assets', 'importing', 'indexing'];

const phaseLabel = (t: (key: string) => string, phase: string): string => {
    if (phase === 'plan') return t('Planning');
    if (phase === 'page' || phase === 'pages') return t('Fetching pages');
    if (phase === 'asset' || phase === 'assets') return t('Downloading assets');
    if (phase === 'done') return t('Complete');
    if (phase === 'failed') return t('Failed');
    if (phase === 'importing' || phase === 'indexing') return t('Indexing');
    return t('Importing');
};

// plan → pages → assets → indexing, regardless of which spelling the wire used.
const stageIndexOf = (phase: string): number => {
    if (phase === 'plan') return 0;
    if (phase === 'page' || phase === 'pages') return 1;
    if (phase === 'asset' || phase === 'assets') return 2;
    if (phase === 'importing' || phase === 'indexing') return 3;
    // done, failed, or an unrecognized spelling — no current stage.
    return -1;
};

interface CourseProgressCardProps {
    progress: CourseImportProgress;
    isLight?: boolean;
}

const CourseProgressCard: React.FC<CourseProgressCardProps> = ({ progress }) => {
    const t = useT();
    const tones = useSettingsTones();
    // 'importing' (P0 stage events) and the phase-level P1 events all count as in flight.
    const running = STAGE_PHASES.includes(progress.phase);
    const failedState = progress.phase === 'failed';
    const finishedOk = progress.phase === 'done';

    // "12/34 Page title" from the pages phase → live counters + truncated page title; anything else is raw.
    const detail = progress.current ?? '';
    const counterMatch = /^(\d+)\s*\/\s*(\d+)(.*)$/.exec(detail);
    const counters = counterMatch ? `${counterMatch[1]}/${counterMatch[2]}` : `${progress.done}/${progress.total}`;
    const detailText = (counterMatch ? counterMatch[3].replace(/^[\s·|:–—-]+/, '') : detail).trim();

    const percent = progress.total > 0
        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
        : null;
    // Plan phase has no counts yet — a pulsing partial fill is the honest indeterminate state.
    const indeterminate = running && progress.total === 0;
    const meterWidth = indeterminate ? 40 : (percent ?? 0);

    // App card surface, same recipe as the Courses Studio rows; tokens track the theme.
    const cardShell = 'w-full max-w-md rounded-xl border bg-bg-item-surface border-border-subtle p-5';
    const badgeTone: AipTone = failedState ? 'danger' : finishedOk ? 'ok' : 'info';

    const stageState = (index: number): 'done' | 'current' | 'todo' => {
        if (!running) return finishedOk ? 'done' : 'todo';
        const currentStage = stageIndexOf(progress.phase);
        if (currentStage < 0 || index > currentStage) return 'todo';
        if (index === currentStage) return 'current';
        return 'done';
    };

    return (
        <div className={cardShell}>
            {/* Status badge + phase, one primitive for the run's whole lifetime. */}
            <div className="flex items-center gap-3">
                <AipBadge tone={badgeTone} busy={running} label={t('Import')} className="shrink-0" />
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{phaseLabel(t, progress.phase)}</p>
            </div>

            {/* plan → pages → assets → indexing: ✓ complete, pulsing current, muted pending. */}
            <div className="mt-4 flex items-start justify-between gap-2">
                {[t('Plan'), t('Pages'), t('Assets'), t('Indexing')].map((label, i) => {
                    const state = stageState(i);
                    return (
                        <div key={i} className="flex min-w-0 flex-col items-center gap-1 text-[10px]">
                            {state === 'done' ? (
                                <span aria-hidden className={`text-[9px] font-bold leading-none ${tones.text.ok}`}>✓</span>
                            ) : state === 'current' ? (
                                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary animate-pulse motion-reduce:animate-none" />
                            ) : (
                                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-bg-input" />
                            )}
                            <span className={`truncate ${state === 'todo' ? 'text-text-tertiary' : 'font-medium text-text-secondary'}`}>
                                {label}
                            </span>
                        </div>
                    );
                })}
            </div>

            {(percent !== null || indeterminate) && (
                <div className="mt-3 h-[6px] w-full natively-meter-track">
                    <div
                        className={`natively-meter-fill transition-[width] duration-700 ease-out motion-reduce:transition-none ${indeterminate ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                        style={{ width: `${meterWidth}%` }}
                    />
                </div>
            )}

            {/* Live counters + current page title; terminal states get their own lines below. */}
            {running && (
                <p className="mt-2 flex min-w-0 items-baseline gap-2 text-xs">
                    <span className="shrink-0 font-medium tabular-nums text-text-secondary">{counters}</span>
                    {detailText !== '' && (
                        <span className="min-w-0 truncate text-text-tertiary" title={detail}>{detailText}</span>
                    )}
                </p>
            )}

            {finishedOk && (
                <p className={`mt-2 text-xs font-medium ${tones.text.ok}`}>
                    {progress.total > 0 ? `${progress.done}/${progress.total} ` : ''}{t('Complete')}
                </p>
            )}
            {failedState && (
                <p className={`mt-2 truncate text-xs font-medium ${tones.text.danger}`} title={detail !== '' ? detail : undefined}>
                    {detail !== '' ? detail : t('Failed')}
                </p>
            )}

            {(progress.failed > 0 || progress.skipped > 0) && (
                <p className="mt-2 text-xs">
                    {progress.failed > 0 && <span className={tones.text.danger}>{progress.failed} {t('failed')}</span>}
                    {progress.failed > 0 && progress.skipped > 0 ? ' · ' : ''}
                    {progress.skipped > 0 && <span className="text-text-secondary">{progress.skipped} {t('skipped')}</span>}
                </p>
            )}
        </div>
    );
};

export default CourseProgressCard;
