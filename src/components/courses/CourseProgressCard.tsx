import React from 'react';
import { Check } from 'lucide-react';
import { useT } from '../../i18n';
import { AipBadge, type AipTone } from '../settings/AIProvidersSettings';
import { SETTINGS_BTN_BASE, SETTINGS_BTN_NEUTRAL, useSettingsTones } from '../settings/SettingsRow';

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

const STAGE_KEYS = ['Plan', 'Pages', 'Assets', 'Indexing'] as const;

interface CourseProgressCardProps {
    progress: CourseImportProgress;
    isLight?: boolean;
    // Terminal-failure recovery, wired by the host (CoursesHome). Optional so the card stays standalone-renderable.
    onRetry?: () => void;
    onDismiss?: () => void;
}

const CourseProgressCard: React.FC<CourseProgressCardProps> = ({ progress, onRetry, onDismiss }) => {
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
    // Plan phase has no counts yet — a sweeping bar is the honest indeterminate state.
    const indeterminate = running && progress.total === 0;
    const meterWidth = indeterminate ? 40 : (percent ?? 0);

    // One elevation step up from list rows while work is in flight; terminal states settle back down.
    const cardShell = `w-full rounded-xl border bg-bg-item-surface p-5 transition-[border-color,box-shadow] duration-300 ${running
        ? 'border-accent-border shadow-md ring-1 ring-accent-focus'
        : 'border-border-muted'}`;

    // Drives the badge through its whole lifetime: Importing… → Complete / Failed.
    const badgeLabel = failedState ? t('Failed') : finishedOk ? t('Complete') : running ? `${t('Importing')}…` : t('Import');
    const badgeTone: AipTone = failedState ? 'danger' : finishedOk ? 'ok' : 'info';

    // Screen-reader announcement for the role="status" root.
    const announce = `${phaseLabel(t, progress.phase)}${progress.total > 0 ? `, ${progress.done} of ${progress.total}` : ''}${failedState && detail !== '' ? `: ${detail}` : ''}`;

    const stageState = (index: number): 'done' | 'current' | 'todo' => {
        if (!running) return finishedOk ? 'done' : 'todo';
        const currentStage = stageIndexOf(progress.phase);
        if (currentStage < 0 || index > currentStage) return 'todo';
        if (index === currentStage) return 'current';
        return 'done';
    };

    // Tracker node per state: done carries a real Check glyph, the current one a pulsing core.
    const stageNode = (state: 'done' | 'current' | 'todo') => {
        if (state === 'done') {
            return (
                <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded-full border border-accent-border bg-accent-subtle transition-colors duration-300">
                    <Check size={10} strokeWidth={3} className={`transition-colors duration-300 ${tones.text.ok}`} />
                </span>
            );
        }
        if (state === 'current') {
            return (
                <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded-full border border-accent-border transition-colors duration-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-primary motion-reduce:animate-none" />
                </span>
            );
        }
        return (
            <span aria-hidden className="h-3 w-3 rounded-full border border-border-muted bg-bg-input transition-colors duration-300" />
        );
    };

    return (
        <div role="status" className={cardShell}>
            <span className="sr-only">{announce}</span>

            {/* Status badge + phase, one primitive for the run's whole lifetime. */}
            <div className="flex items-center gap-3">
                <AipBadge tone={badgeTone} busy={running} label={badgeLabel} className="shrink-0" />
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{phaseLabel(t, progress.phase)}</p>
            </div>

            {/* Stages + meter on the left; live counters and terminal lines on the right. */}
            <div className="mt-4 flex flex-col gap-y-3 sm:flex-row sm:items-center sm:gap-x-6">
                <div className="w-full min-w-0 sm:max-w-[62%]">
                    {/* plan → pages → assets → indexing; the connector fills as each stage completes. */}
                    <div className="flex w-full items-start gap-2">
                        {STAGE_KEYS.map((key, i) => {
                            const state = stageState(i);
                            return (
                                <React.Fragment key={key}>
                                    <div
                                        className={`flex min-w-0 max-w-[26%] flex-col items-center gap-1 text-[10px] transition-colors duration-300 ${
                                            state === 'current' ? 'font-semibold text-text-primary'
                                                : state === 'done' ? 'text-text-secondary'
                                                    : 'text-text-tertiary'
                                        }`}
                                    >
                                        {stageNode(state)}
                                        <span className="truncate">{t(key)}</span>
                                    </div>
                                    {i < STAGE_KEYS.length - 1 && (
                                        <div aria-hidden className="mt-[7px] h-[2px] min-w-3 flex-1 overflow-hidden rounded-full bg-bg-input">
                                            <div
                                                className={`h-full w-full transition-[width,background-color] duration-300 motion-reduce:transition-none ${state === 'done' ? 'bg-accent-primary' : 'bg-transparent'}`}
                                                style={{ width: state === 'done' ? '100%' : '0%' }}
                                            />
                                        </div>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>

                    {(percent !== null || indeterminate) && (
                        <div className="mt-3 h-[6px] w-full natively-meter-track">
                            {/* Inner clip: the track itself stays overflow-visible for its inset shadows. */}
                            <div aria-hidden className="relative h-full w-full overflow-hidden rounded-full">
                                {indeterminate ? (
                                    <div className="natively-meter-fill absolute inset-y-0 left-0 w-2/5 [animation:course-meter-sweep_1.6s_ease-in-out_infinite] motion-reduce:[animation:none]" />
                                ) : (
                                    <div
                                        className="natively-meter-fill transition-[width] duration-700 ease-out motion-reduce:transition-none"
                                        style={{ width: `${meterWidth}%` }}
                                    />
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex min-w-0 flex-col gap-2 text-xs sm:flex-1">
                    {running && (progress.total > 0 || detailText !== '') && (
                        <p className="flex min-w-0 items-baseline gap-2">
                            {progress.total > 0 && (
                                <span className="shrink-0 font-medium tabular-nums text-text-secondary">{counters}</span>
                            )}
                            {detailText !== '' && (
                                <span className="min-w-0 truncate text-text-tertiary" title={detail}>{detailText}</span>
                            )}
                        </p>
                    )}

                    {/* Terminal states cross-fade in; the badge swap fades on its own. */}
                    {finishedOk && (
                        <p className={`animate-scale-in font-medium ${tones.text.ok}`}>
                            {progress.total > 0 ? `${progress.done}/${progress.total} ` : ''}{t('Complete')}
                        </p>
                    )}

                    {failedState && (
                        <div className="min-w-0">
                            <p className={`truncate font-medium ${tones.text.danger}`} title={detail !== '' ? detail : undefined}>
                                {detail !== '' ? detail : t('Failed')}
                            </p>
                            {(onRetry || onDismiss) && (
                                <div className="mt-3 flex items-center gap-2">
                                    {onRetry && (
                                        <button type="button" onClick={onRetry} className={`${SETTINGS_BTN_BASE} border-accent-border bg-accent-subtle text-accent-primary`}>
                                            {t('Retry')}
                                        </button>
                                    )}
                                    {onDismiss && (
                                        <button type="button" onClick={onDismiss} className={`${SETTINGS_BTN_BASE} ${SETTINGS_BTN_NEUTRAL}`}>
                                            {t('Dismiss')}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {(progress.failed > 0 || progress.skipped > 0) && (
                        <p className="m-0">
                            {progress.failed > 0 && <span className={tones.text.danger}>{progress.failed} {t('failed')}</span>}
                            {progress.failed > 0 && progress.skipped > 0 ? ' · ' : ''}
                            {progress.skipped > 0 && <span className="text-text-secondary">{progress.skipped} {t('skipped')}</span>}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default CourseProgressCard;
