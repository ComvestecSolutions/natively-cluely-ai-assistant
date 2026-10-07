// A pure estimate over the on-disk lesson Markdown and, when available, its fetched HTML.
export interface LessonDuration {
  minutes: number;
  source: 'provided' | 'estimated';
}

const MIN_MINUTES = 1;
const MAX_MINUTES = 60;
const WORDS_PER_MINUTE = 200;

function explicitMinutes(value: string): number | null {
  const text = value.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  const match = /^(?:(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?)?|PT(\d+)M)$/i.exec(text);
  if (!match) return null;
  const minutes = Number(match[1] ?? match[2]);
  // Discard implausible totals rather than presenting a capped module duration as a lesson.
  return Number.isFinite(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES
    ? Math.ceil(minutes) : null;
}

function frontmatterAndBody(markdown: string): { fields: Map<string, string>; body: string } {
  const lines = markdown.split(/\r?\n/);
  const fields = new Map<string, string>();
  if (lines[0] !== '---') return { fields, body: markdown };
  const end = lines.slice(1, 30).indexOf('---') + 1;
  if (end === 0) return { fields, body: markdown };
  for (const line of lines.slice(1, end)) {
    const match = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(match[1].replace(/[-_]/g, '').toLowerCase(), match[2]);
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

function isUnitUrl(fields: Map<string, string>): boolean {
  if (fields.get('kind') !== 'lesson') return false;
  const url = (fields.get('url') ?? '').replace(/^['"]|['"]$/g, '');
  try {
    const path = new URL(url).pathname;
    return /\/units?\/[^/]+\/?$/i.test(path) || /\/modules\/[^/]+\/[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
}

const SCOPED_DURATION = /^(?:unit|lesson)duration(?:in)?(?:minutes?|mins?)?$/;

function withoutCodeFences(body: string): string[] {
  let fence: string | null = null;
  return body.split(/\r?\n/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  });
}

function markdownMinutes(fields: Map<string, string>, body: string): number | null {
  for (const [key, value] of fields) {
    if (SCOPED_DURATION.test(key) || (key === 'duration' && isUnitUrl(fields))) {
      const minutes = explicitMinutes(value);
      if (minutes !== null) return minutes;
    }
  }
  // A duration callout must identify the unit/lesson, not an entire module or course.
  for (const line of withoutCodeFences(body).slice(0, 30)) {
    const match = /^\s*(?:>\s*)?(?:\*\*)?(?:unit|lesson) duration(?:(?:\*\*)?:|:(?:\*\*)?)\s*(\d+(?:\.\d+)?\s*(?:min(?:ute)?s?)|PT\d+M)\s*$/i.exec(line);
    if (match) {
      const minutes = explicitMinutes(match[1]);
      if (minutes !== null) return minutes;
    }
  }
  return null;
}

function visibleUnitMinutes(fields: Map<string, string>, body: string): number | null {
  if (fields.get('kind') !== 'lesson') return null;
  try {
    const url = new URL((fields.get('url') ?? '').replace(/^['"]|['"]$/g, ''));
    if (url.hostname !== 'learn.microsoft.com' ||
        !/^\/(?:[a-z]{2}-[a-z]{2}\/)?training\/modules\/[^/]+\/[^/]+\/?$/i.test(url.pathname)) return null;
  } catch {
    return null;
  }

  // The Learn unit header shows a standalone "Completed" followed by its duration bullet.
  // Keep the window tight so prose, a later list, or a module overview cannot supply it.
  const lines = withoutCodeFences(body).slice(0, 12);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*(?:\*\*)?Completed(?:\*\*)?\s*$/i.test(lines[i])) continue;
    const next = lines.slice(i + 1, i + 4).find((line) => line.trim());
    const match = next && /^\s*(?:[-*+]|•)\s+(\d{1,2}) minutes?\s*$/i.exec(next);
    if (match) return explicitMinutes(`${match[1]} minutes`);
  }
  return null;
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const attribute = /\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attribute)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function htmlMinutes(html: string): number | null {
  // Only page metadata or <time> elements explicitly labelled as a *unit/lesson*
  // duration qualify. Generic "duration" metadata can describe the parent module.
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const label = (attrs.get('name') ?? attrs.get('property') ?? attrs.get('itemprop') ?? '')
      .replace(/[-_:\s]/g, '').toLowerCase();
    if (SCOPED_DURATION.test(label)) {
      const minutes = explicitMinutes(attrs.get('content') ?? '');
      if (minutes !== null) return minutes;
    }
  }
  for (const match of html.matchAll(/<time\b([^>]*)>([^<]*)<\/time\s*>/gi)) {
    const attrs = attributes(match[1]);
    const label = `${attrs.get('class') ?? ''} ${attrs.get('data-bi-name') ?? ''}`;
    if (/\b(?:unit|lesson)[-_ ]duration\b/i.test(label)) {
      const minutes = explicitMinutes(attrs.get('datetime') ?? match[2]);
      if (minutes !== null) return minutes;
    }
  }
  return null;
}

function readableWordCount(body: string): number {
  const text = body
    .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/gm, ' ');
  return (text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

export function getLessonDuration(markdown: string, html?: string): LessonDuration {
  const { fields, body } = frontmatterAndBody(markdown);
  const provided = markdownMinutes(fields, body) ?? (html ? htmlMinutes(html) : null) ?? visibleUnitMinutes(fields, body);
  if (provided !== null) return { minutes: provided, source: 'provided' };
  const minutes = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.ceil(readableWordCount(body) / WORDS_PER_MINUTE)));
  return { minutes, source: 'estimated' };
}
