import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImageOff } from 'lucide-react';

// LessonMarkdown — renders a single lesson's stored markdown inside the app (Courses Studio P3).
// Pure presentation: all cross-component wiring is injected by the parent.
//   • courseId              -> rewrites relative asset paths to the registered course-media:// scheme.
//   • lessonUrls + onNavigateUrl -> intercept internal course links for in-app navigation.
// Deliberately NO syntax highlighting / KaTeX: plain styled <pre> blocks are the P3 choice, and we
// keep this component free of react-syntax-highlighter/rehype-katex to avoid theme/API surface risk.

export interface LessonMarkdownProps {
  courseId: string;
  content: string;
  lessonUrls?: string[] | null;
  onNavigateUrl?: (href: string) => void;
}

// Trim + drop a leading slash run and any trailing #fragment so relative-ish hrefs written by the
// importer still match their canonical lesson URL. Query strings are preserved to avoid false hits.
function normalizeUrlKey(url: string): string {
  return url.trim().replace(/^\/+/, '').split('#')[0];
}

// Does this link target point at one of the known in-app lessons? "equals/strips-to" means we accept
// an exact match or a normalized (trim / leading-slash / fragment) match.
function matchesLessonUrl(href: string, lessonUrls?: string[] | null): boolean {
  if (!lessonUrls || lessonUrls.length === 0) return false;
  const h = href.trim();
  for (const raw of lessonUrls) {
    if (typeof raw !== 'string') continue;
    if (raw === href || raw === h) return true;
    const key = normalizeUrlKey(raw);
    if (key && key === normalizeUrlKey(href)) return true;
  }
  return false;
}

// Rewrite an <img> src onto the course-media scheme. The ingest pipeline already rewrites most assets
// to absolute `course-media://<courseId>/assets/...` URLs — those, and any URL carrying a scheme
// (http(s) / data: / blob:) or protocol-relative (//cdn.x/a.png), pass through untouched. Only truly
// relative paths get the courseId prefix + leading-slash strip.
function resolveMediaSrc(src: string | undefined, courseId: string): string {
  const value = (src ?? '').trim();
  if (!value || /^[a-z][\w+.-]*:/i.test(value) || value.startsWith('//')) return src ?? '';
  return `course-media://${courseId}/${value.replace(/^\/+/, '')}`;
}

// Short label for the failed-image fallback pill: prefer alt text (truncated), then the URL host,
// then a truncated raw src. Keeps 404'd remote images readable without broken-glyph noise.
function mediaFallbackLabel(alt: string | undefined, src: string): string {
  const fromAlt = (alt ?? '').trim();
  if (fromAlt) return fromAlt.length > 48 ? `${fromAlt.slice(0, 45)}…` : fromAlt;
  try {
    const host = new URL(src).host; // course-media://<id>/... -> "<id>", https URLs -> hostname
    if (host) return host;
  } catch {
    // Not an absolute URL — fall through to the raw source.
  }
  return src.length > 48 ? `${src.slice(0, 45)}…` : src || 'Image unavailable';
}

// Shared link styling for both the in-app lesson <button> and external <a>. Full accent on a dark UI:
// per the note in tailwind.config.js a `/NN` opacity modifier cannot be chained onto var() accent
// tokens (it compiles to nothing), so visibility comes from full-strength color + hover white tint.
const LINK_CLASSES =
  'align-baseline text-accent-primary underline decoration-accent-primary underline-offset-2 rounded-[3px] -mx-0.5 px-0.5 hover:bg-white/5 cursor-pointer break-words';

// Open a URL in the OS browser through the preload bridge. The main process enforces an https
// allow-list before actually opening, so forwarding any non-internal href is safe — it's ignored there.
function openInBrowser(href: string): void {
  try {
    const api = window.electronAPI;
    if (api && typeof api.openExternal === 'function') {
      Promise.resolve(api.openExternal(href)).catch(() => {
        // Non-fatal — a failed external open must not break the reading surface.
      });
    }
  } catch {
    // Running outside Electron (e.g. an isolated unit test) — nothing to do.
  }
}

export default function LessonMarkdown({ courseId, content, lessonUrls, onNavigateUrl }: LessonMarkdownProps) {
  // Sources whose <img> has failed to load (dead remote URLs etc.) — render a fallback pill instead
  // of the browser's broken-image glyph. Client-only renderer component; no SSR concerns.
  const [failedMediaSrcs, setFailedMediaSrcs] = useState<ReadonlySet<string>>(() => new Set());
  const markMediaFailed = (src: string): void => {
    if (!src || failedMediaSrcs.has(src)) return;
    setFailedMediaSrcs((prev) => {
      if (prev.has(src)) return prev;
      const next = new Set(prev);
      next.add(src);
      return next;
    });
  };

  const trimmed = (content ?? '').trim();
  if (!trimmed) {
    return <p className="text-[14px] leading-relaxed text-text-secondary">No content available for this lesson yet.</p>;
  }

  return (
    <div className="text-[14px] leading-relaxed text-text-primary space-y-3 break-words max-w-3xl">
      {/* GFM gives us the tables/checkboxes present in course docs. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const resolved = resolveMediaSrc(src, courseId);
            if (!resolved) return null;
            if (failedMediaSrcs.has(resolved)) {
              // Leftover absolute https URLs can 404 — an understated pill instead of a broken glyph.
              return (
                // Bracket alphas on purpose: TW 3.x drops off-scale /NN modifiers (house style elsewhere too).
                <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] text-zinc-500">
                  <ImageOff size={14} aria-hidden />
                  {mediaFallbackLabel(alt, resolved)}
                </span>
              );
            }
            return (
              <img
                src={resolved}
                alt={alt ?? ''}
                loading="lazy"
                decoding="async"
                onError={() => markMediaFailed(resolved)}
                className="max-w-full rounded-lg border border-border-subtle my-3"
              />
            );
          },

          a: ({ href, children }) => {
            const target = (href ?? '').trim();
            if (!target) return <span>{children}</span>;

            // Internal course link -> route in-app via the parent's navigation callback. A real <button>
            // is used so there is no anchor default-navigation to suppress, and it stays keyboard-operable.
            if (matchesLessonUrl(target, lessonUrls) && onNavigateUrl) {
              return (
                <button
                  type="button"
                  onClick={() => onNavigateUrl(target)}
                  className={LINK_CLASSES}
                >
                  {children}
                </button>
              );
            }

            // Anything else (external docs, references) opens in the OS browser. In Electron a plain
            // target=_blank is ignored, so we intercept the click and forward it to openExternal.
            return (
              <a
                href={target}
                target="_blank"
                rel="noreferrer noopener nofollow"
                onClick={(e) => {
                  e.preventDefault();
                  openInBrowser(target);
                }}
                className={LINK_CLASSES}
              >
                {children}
              </a>
            );
          },

          // Block code: the container keeps space-y-3 as the base rhythm, so my-* only needs to win
          // where it matters (bottom breathing); inner <code> is reset because the `code` override
          // below styles inline chips.
          pre: ({ children }) => (
            <pre className="my-4 overflow-x-auto rounded-md border border-white/[0.06] bg-black/40 p-3 font-mono text-[12.5px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[12.5px]">
              {children}
            </pre>
          ),

          code: ({ children }) => (
            <code className="rounded bg-white/[0.08] px-1 py-px font-mono text-[0.92em] text-zinc-200">{children}</code>
          ),

          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border-subtle">
              <table className="w-full border-collapse align-top text-[13px]">{children}</table>
            </div>
          ),

          th: ({ children }) => (
            <th className="border border-border-subtle px-3 py-1.5 text-left align-top font-medium text-text-primary">
              {children}
            </th>
          ),

          td: ({ children }) => (
            <td className="border border-border-subtle px-3 py-1.5 align-top text-text-primary">{children}</td>
          ),

          blockquote: ({ children }) => (
            // accent-primary cannot take a /NN alpha modifier (var() token — see tailwind.config.js),
            // so the accent-border token carries the tinted bar.
            <blockquote className="my-4 border-l-2 border-accent-border pl-3 text-zinc-400 not-italic">
              {children}
            </blockquote>
          ),

          p: ({ children }) => <p className="leading-relaxed">{children}</p>,

          // Section rhythm: pt-* (padding is not overridden by the container's space-y) plus the base
          // 12px gap; sizes/weights keep this file's existing scale, h1 sits one step above it.
          h1: ({ children }) => (
            <h1 className="scroll-mt-24 pt-6 text-[19px] font-semibold leading-snug text-text-primary">{children}</h1>
          ),

          h2: ({ children }) => (
            <h2 className="scroll-mt-24 pt-6 text-[17px] font-semibold leading-snug text-text-primary">{children}</h2>
          ),

          h3: ({ children }) => (
            <h3 className="scroll-mt-24 pt-4 text-[15.5px] font-medium leading-snug text-text-primary">{children}</h3>
          ),

          hr: () => <hr className="my-6 border-white/[0.08]" />,

          ul: ({ children }) => (
            <ul className="space-y-1.5 pl-5 list-disc leading-relaxed marker:text-zinc-500">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="space-y-1.5 pl-5 list-decimal leading-relaxed marker:text-zinc-500">{children}</ol>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
