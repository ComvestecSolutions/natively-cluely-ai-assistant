import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Clipboard API first; the selected-text fallback also works in older Electron contexts. */
export async function copyChatText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard,
  doc: Document = document,
): Promise<boolean> {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch { /* The clipboard API may be denied; try the DOM fallback. */ }
  }
  const field = doc.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  doc.body.appendChild(field);
  try {
    field.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export function MessageCopyButton({ text, kind, className = '' }: {
  text: string;
  kind: 'prompt' | 'response';
  className?: string;
}) {
  const [status, setStatus] = useState<'ready' | 'copied' | 'failed'>('ready');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const label = status === 'copied' ? `Copied ${kind}` : status === 'failed' ? `Couldn't copy ${kind}; try again` : `Copy ${kind}`;

  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        const ok = await copyChatText(text);
        setStatus(ok ? 'copied' : 'failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus('ready'), 2000);
      }}
      className={`inline-flex items-center gap-1.5 text-[12px] text-text-tertiary hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary transition-colors ${className}`}
    >
      {status === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
