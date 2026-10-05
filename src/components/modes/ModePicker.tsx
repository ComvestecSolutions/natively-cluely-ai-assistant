import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Layers, X } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import type { MeetingInterfaceTheme } from '../../lib/meetingInterfaceTheme';
import type { ElectronAPI } from '../../types/electron';

type VisibleMode = Pick<Awaited<ReturnType<ElectronAPI['modesGetAll']>>[number], 'id' | 'name' | 'templateType'>;
type ActiveMode = { id: string | null; name: string | null };

const isVisibleMode = (mode: VisibleMode): boolean =>
    mode.id !== '__profile_okf__' && mode.templateType !== '__reserved__';

interface ModePickerProps {
    compact?: boolean;
    panelRef?: React.RefObject<HTMLElement | null>;
    interfaceTheme?: MeetingInterfaceTheme;
}

const ModePicker: React.FC<ModePickerProps> = ({ compact = false, panelRef, interfaceTheme = 'default' }) => {
    const [modes, setModes] = useState<VisibleMode[]>([]);
    const [active, setActive] = useState<ActiveMode | null>(null);
    const [activeKnown, setActiveKnown] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [writeError, setWriteError] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [popupOpen, setPopupOpen] = useState(false);
    const alive = useRef(false);
    const readRequest = useRef(0);
    const activeRevision = useRef(0);
    const pendingId = useRef<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const focusOnShow = useRef(!compact);
    const isLight = useResolvedTheme() === 'light';
    const isDarkBg = interfaceTheme !== 'default' || !isLight;

    const refresh = useCallback(async () => {
        const request = ++readRequest.current;
        const revision = activeRevision.current;
        setLoading(true);
        try {
            const api = window.electronAPI;
            if (!api?.modesGetAll || !api.modesGetActive) throw new Error('Modes are unavailable. Please try again.');
            const [list, current] = await Promise.all([api.modesGetAll(), api.modesGetActive()]);
            if (!alive.current || request !== readRequest.current) return;
            if (!Array.isArray(list)) throw new Error('Could not load modes. Please try again.');
            setModes(list.filter(isVisibleMode));
            // A broadcast or write supersedes any active snapshot taken before it.
            if (revision === activeRevision.current) {
                setActive(current && isVisibleMode(current) ? current : null);
                setActiveKnown(true);
            }
            setError(null);
        } catch (failure) {
            if (alive.current && request === readRequest.current) {
                setError(failure instanceof Error ? failure.message : 'Could not load modes. Please try again.');
            }
        } finally {
            if (alive.current && request === readRequest.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        const unsubscribeMode = window.electronAPI?.onModeChanged?.((current) => {
            ++activeRevision.current;
            setActive(current.id === '__profile_okf__' ? null : current);
            setActiveKnown(true);
            void refresh();
        });
        const unsubscribeShown = window.electronAPI?.onSettingsWindowShown?.((panel) => {
            if (panel !== 'modes') return;
            focusOnShow.current = !compact;
            void refresh();
        });
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        void refresh();
        return () => {
            alive.current = false;
            ++readRequest.current;
            ++activeRevision.current;
            unsubscribeMode?.();
            unsubscribeShown?.();
            window.removeEventListener('focus', onFocus);
        };
    }, [compact, refresh]);

    useEffect(() => {
        if (!compact) return;
        let mounted = true;
        let revision = 0;
        const unsubscribe = window.electronAPI?.onSettingsVisibilityChange?.((visible, panel) => {
            ++revision;
            setPopupOpen(visible && panel === 'modes');
        });
        window.electronAPI?.getSettingsPopupState?.().then((state) => {
            if (mounted && revision === 0) setPopupOpen(state.isVisible && state.panel === 'modes');
        }).catch(() => {});
        return () => { mounted = false; unsubscribe?.(); };
    }, [compact]);

    useLayoutEffect(() => {
        if (compact || loading || pending || !focusOnShow.current) return;
        const row = listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')
                    ?? listRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled), [data-mode-retry]');
        if (row) { row.focus(); focusOnShow.current = false; }
    }, [compact, loading, pending, modes]);

    const activate = async (mode: VisibleMode) => {
        if (pendingId.current || mode.id === active?.id) return;
        pendingId.current = mode.id;
        focusOnShow.current = true;
        ++readRequest.current;
        ++activeRevision.current;
        setPending(mode.id);
        setLoading(false);
        setWriteError(null);
        try {
            const result = await window.electronAPI?.modesSetActive?.(mode.id);
            if (!alive.current) return;
            if (result?.success !== true) {
                throw new Error(result?.error === 'pro_required'
                    ? 'This mode requires Pro or an active trial. Choose General or manage your plan in Settings.'
                    : result?.error || 'Could not activate this mode. Please try again.');
            }
            // Stay open like Courses. Re-read instead of assuming the requested
            // mode is still active: another window may have switched it meanwhile.
        } catch (failure) {
            if (alive.current) setWriteError(failure instanceof Error ? failure.message : 'Could not activate this mode. Please try again.');
        } finally {
            if (alive.current) {
                ++activeRevision.current;
                await refresh();
            }
            pendingId.current = null;
            if (alive.current) setPending(null);
        }
    };

    const notice = writeError ?? error;
    if (compact) {
        const label = `Modes, ${activeKnown ? active?.name || 'no active mode' : 'loading active mode'}`;
        const togglePopup = (button: HTMLButtonElement) => {
            if (!panelRef?.current) return;
            const anchor = button.getBoundingClientRect();
            window.electronAPI?.toggleSettingsWindow?.({
                panel: 'modes',
                x: window.screenX + anchor.left,
                y: window.screenY + panelRef.current.getBoundingClientRect().bottom + 8,
            }).catch(() => { if (alive.current) setWriteError('Could not open modes. Please try again.'); });
        };
        return (
            <>
                <button
                    type="button"
                    data-modes-toggle="true"
                    data-stealth-ignore="true"
                    aria-label={label}
                    title={notice ? `${label}. ${notice}` : label}
                    aria-expanded={popupOpen}
                    aria-haspopup="dialog"
                    data-state={popupOpen ? 'open' : undefined}
                    data-active={activeKnown && !!active?.id}
                    onClick={(event) => { setWriteError(null); togglePopup(event.currentTarget); }}
                    onKeyDown={(event) => {
                        if (event.key !== 'ArrowDown' || popupOpen) return;
                        event.preventDefault();
                        togglePopup(event.currentTarget);
                    }}
                    className="relative no-drag w-7 h-7 shrink-0 rounded-[9px] flex items-center justify-center interaction-base interaction-press overlay-bare-icon focus-visible:ring-2 focus-visible:ring-accent-focus"
                >
                    <Layers size={14} aria-hidden="true" />
                    {activeKnown && active?.id && <span aria-hidden="true" className="absolute right-1 top-1 h-1 w-1 rounded-full bg-accent-primary" />}
                </button>
                {notice && <span role="alert" className="sr-only">{notice}</span>}
            </>
        );
    }

    const navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
        if (!rows.length) return;
        event.preventDefault();
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : event.key === 'ArrowDown' ? (index + 1) % rows.length : (index < 0 ? rows.length - 1 : (index + rows.length - 1) % rows.length);
        rows[next].focus();
    };

    return (
        <div ref={listRef} onKeyDown={navigate}>
            <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-0.5">
                <span className="text-[11px] font-medium overlay-text-muted">Chat modes</span>
                <button type="button" aria-label="Close modes" onClick={() => { void window.electronAPI?.closeSettingsWindow?.(); }} className="no-drag flex h-6 w-6 items-center justify-center rounded-lg overlay-bare-icon focus-visible:ring-2 focus-visible:ring-accent-focus">
                    <X size={12} aria-hidden="true" />
                </button>
            </div>
            <p className="px-2 pb-1.5 text-[11px] overlay-text-muted">Choose the mode for your next answer.</p>
            {loading && <p role="status" className="px-2 py-2 text-xs overlay-text-muted">Refreshing modes…</p>}
            {pending && <p role="status" className="px-2 py-2 text-xs overlay-text-muted">Switching mode…</p>}
            {notice && (
                <div className="px-2 py-2 text-xs">
                    <p role="alert">{notice}</p>
                    <button type="button" data-mode-retry="true" disabled={!!pending} onClick={() => { setWriteError(null); void refresh(); }} className="no-drag mt-1 rounded-md px-2 py-1 overlay-control-surface focus-visible:ring-2 focus-visible:ring-accent-focus">Try again</button>
                </div>
            )}
            {!loading && !notice && modes.length === 0 && <p role="status" className="px-2 py-2 text-xs overlay-text-muted">No modes available. Manage modes in the launcher.</p>}
            <div role="menu" aria-label="Chat modes" aria-busy={loading || !!pending}>
                {modes.map((mode) => {
                    const checked = activeKnown && mode.id === active?.id;
                    return (
                        <button
                            key={mode.id}
                            type="button"
                            role="menuitemradio"
                            aria-label={mode.name}
                            title={mode.name}
                            aria-checked={checked}
                            aria-busy={pending === mode.id}
                            disabled={!!pending || loading || !!error}
                            onClick={() => { void activate(mode); }}
                            className={`no-drag h-[30px] shrink-0 w-full px-2 flex items-center gap-2 rounded-[10px] select-none text-left focus-visible:ring-2 focus-visible:ring-accent-focus disabled:opacity-45 transition-colors ${isDarkBg ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'} glass-popup-row`}
                        >
                            <Layers size={14} aria-hidden="true" className={`shrink-0 ${checked ? '' : isDarkBg ? 'text-white/55' : 'text-slate-500'}`} />
                            <span className="flex-1 min-w-0 truncate text-[12px] font-medium">{mode.name}</span>
                            {checked && <Check size={12} aria-hidden="true" className="shrink-0 text-accent-primary" />}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

export default ModePicker;
