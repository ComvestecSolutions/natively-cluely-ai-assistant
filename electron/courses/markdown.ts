// Courses Studio P1 — lesson-page HTML → clean markdown for storage/retrieval (INGEST phase).
// Pure function over an already-fetched Microsoft Learn page: no I/O, no state, and it never
// throws on bad HTML (cheerio's lenient parser + defensive walks). Ingest later rewrites the
// successfully-downloaded image URLs to a course-media scheme; here images stay `![alt](url)`.
//
// Output invariants (enforced by post-processing):
//   * no raw '<' anywhere — any stray one is re-escaped as &lt; (pages may render "<" literally)
//   * HTML entities decoded (&amp; → &) — the parser decodes them into text nodes and attribs
//   * runs of 3+ newlines collapse to two; result trimmed

import * as cheerio from 'cheerio';

/**
 * Strip the importer's plan §7 front-matter header from a raw on-disk lesson file:
 * an opening `---` line, `key: value` lines, and a closing `---` within the first 30
 * physical lines. Handles LF and CRLF. Returns everything after the closer's newline,
 * dropping one leading blank line when present. Anything not matching (no header,
 * unterminated header) is returned unchanged — no deps, plain string walking.
 */
export function stripCourseFrontmatter(raw: string): string {
  const firstNl = raw.indexOf('\n');
  if (firstNl === -1) return raw; // one physical line cannot be a complete header
  const firstLine = raw.slice(0, firstNl);
  if (firstLine !== '---' && firstLine !== '---\r') return raw;

  let start = firstNl + 1;
  for (let lineNo = 2; lineNo <= 30; lineNo += 1) {
    const nextNl = raw.indexOf('\n', start);
    if (nextNl === -1) {
      // Final physical line carries no trailing newline: it closes only when exact.
      return /^---\r?$/.test(raw.slice(start)) ? '' : raw;
    }
    const line = raw.slice(start, nextNl);
    if (line === '---' || line === '---\r') {
      let body = raw.slice(nextNl + 1);
      if (body.startsWith('\r\n')) return body.slice(2); // one leading blank CRLF line
      if (body.startsWith('\n')) return body.slice(1);   // …or LF line
      return body;
    }
    start = nextNl + 1;
  }
  return raw; // closer not found within the first 30 lines — leave untouched
}

/** One converted page: markdown body plus every image source found (document order). */
export interface CourseMarkdown {
  markdown: string;
  images: string[]; // img srcs, made absolute against `baseUrl` when possible
}

// --------------------------------------------------------------------------- minimal DOM view
// We walk the raw parsed nodes instead of building many cheerio selections; only these fields
// are read (shapes verified against the domhandler version shipped with cheerio ^1.2.0).

interface RawNode {
  type?: string; // 'tag' | 'text' | 'comment' | …
  name?: string; // element tag name, lowercased
  data?: string; // text-node content, entities already decoded by the parser
  attribs?: Record<string, string>; // attribute values, likewise entity-decoded
}

function kids(node: RawNode): RawNode[] {
  return ((node as unknown as { children?: readonly unknown[] }).children ?? []) as RawNode[];
}

function tagName(node: RawNode): string {
  return typeof node.name === 'string' ? node.name.toLowerCase() : '';
}

/** Tags whose entire subtree is dropped from the output. */
const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'button',
]);

/** Inline tags that flatten into surrounding text instead of recursing as containers. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'ins', 'kbd',
  'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var', 'wbr',
]);

/** Block tags rendered by their own dedicated markdown rules. */
const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'table', 'pre', 'blockquote',
  'img', 'iframe',
]);

const FENCE = '```';
const ALLOWED_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

interface RenderCtx {
  blocks: string[]; // finished block markdowns, document order
  images: string[]; // every img src kept, document order (shared across nested contexts)
  baseUrl?: string;
}

// --------------------------------------------------------------------------- small utilities

const collapseWs = (text: string): string => text.replace(/\s+/g, ' ');

/** Resolve a relative/absolute source against `baseUrl` when safe. Without a base, relative
 * values are preserved as-is so the ingest phase can still rewrite them later. */
function toAbsoluteUrl(rawSrc: unknown, baseUrl?: string): string | undefined {
  const src = typeof rawSrc === 'string' ? rawSrc.trim() : '';
  if (!src || src === '#') return undefined;
  try {
    if (baseUrl) {
      const url = new URL(src, baseUrl);
      return ALLOWED_IMAGE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) {
      const url = new URL(src);
      return ALLOWED_IMAGE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
    }
    return src; // relative and no base given — keep for ingest to handle
  } catch {
    return undefined;
  }
}

/** All descendant text of a node, whitespace-collapsed (entities already decoded). */
function textOnly(node: RawNode): string {
  let out = '';
  const walk = (n: RawNode): void => {
    if (n.type === 'text') { out += n.data ?? ''; return; }
    for (const c of kids(n)) walk(c);
  };
  walk(node);
  return collapseWs(out).trim();
}

/** Language hint for fenced code, e.g. `language-typescript` or `lang-js` in a class attr. */
function fenceLanguage(pre: RawNode): string | undefined {
  const classes: string[] = [];
  if (pre.attribs?.class) classes.push(pre.attribs.class);
  for (const c of kids(pre)) {
    if (tagName(c) === 'code' && c.attribs?.class) classes.push(c.attribs.class);
  }
  for (const cls of classes) {
    const match = /\b(?:language|lang)-([a-z0-9][a-z0-9+#.-]*)/i.exec(cls);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

/** Raw code text for a `<pre>`: descendant text in order, CR normalized, ends trimmed. */
function codeBlockText(node: RawNode): string {
  let out = '';
  const walk = (n: RawNode): void => {
    if (n.type === 'text') { out += n.data ?? ''; return; }
    for (const c of kids(n)) walk(c);
  };
  walk(node);
  return out.replace(/\r\n?/g, '\n').trim();
}

// --------------------------------------------------------------------------- inline level

/** `![alt](url)` for one image; records the url in ctx.images (document order). */
function imageMarkdown(img: RawNode, ctx: RenderCtx): string {
  const url = toAbsoluteUrl(img.attribs?.src, ctx.baseUrl);
  if (!url) return '';
  ctx.images.push(url);
  const alt = collapseWs(img.attribs?.alt ?? '').trim();
  return `![${alt}](${url})`;
}

/** Markdown for one inline-level child node (text or element). */
function inlineChild(node: RawNode, ctx: RenderCtx): string {
  if (node.type === 'text') return collapseWs(node.data ?? '');
  const name = tagName(node);
  if (!name) return '';
  if (STRIP_TAGS.has(name)) return '';
  if (name === 'strong' || name === 'b') {
    const inner = inline(node, ctx).trim();
    return inner ? `**${inner}**` : '';
  }
  if (name === 'em' || name === 'i') {
    const inner = inline(node, ctx).trim();
    return inner ? `*${inner}*` : '';
  }
  if (name === 'code' || name === 'samp' || name === 'kbd') {
    const inner = textOnly(node);
    return inner ? `\`${inner}\`` : '';
  }
  if (name === 'img') return imageMarkdown(node, ctx);
  // everything else (<a>, <span>, …) flattens to its content — link URLs are dropped on purpose
  return inline(node, ctx);
}

/** Markdown for an element's inline content; text runs collapse whitespace. */
function inline(node: RawNode, ctx: RenderCtx): string {
  if (node.type === 'text') return collapseWs(node.data ?? '');
  let out = '';
  for (const c of kids(node)) out += inlineChild(c, ctx);
  return out;
}

// --------------------------------------------------------------------------- block level

function renderList(list: RawNode, ordered: boolean, ctx: RenderCtx, depth: number): string | undefined {
  const pad = '  '.repeat(depth);
  const lines: string[] = [];
  let index = 0;
  for (const li of kids(list)) {
    if (tagName(li) !== 'li') continue;
    index += 1;
    let text = '';
    const nestedLists: RawNode[] = [];
    for (const c of kids(li)) {
      if (c.type === 'text') { text += c.data ?? ''; continue; }
      const name = tagName(c);
      if (!name || STRIP_TAGS.has(name)) continue;
      if (name === 'ul' || name === 'ol') { nestedLists.push(c); continue; }
      text += ` ${inlineChild(c, ctx)}`;
    }
    const trimmed = collapseWs(text).trim();
    lines.push(trimmed ? `${pad}${ordered ? `${index}.` : '-'} ${trimmed}` : `${pad}${ordered ? `${index}.` : '-'}`);
    for (const nested of nestedLists) {
      const sub = renderList(nested, tagName(nested) === 'ol', ctx, depth + 1);
      if (sub) lines.push(sub);
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}

function findDescendants(root: RawNode, wanted: string[]): RawNode[] {
  const out: RawNode[] = [];
  const walk = (node: RawNode): void => {
    for (const c of kids(node)) {
      if (wanted.includes(tagName(c))) out.push(c);
      // never cross into nested tables — their <tr>s are not rows of this one
      if (tagName(c) !== 'table') walk(c);
    }
  };
  walk(root);
  return out;
}

function renderTable(table: RawNode, ctx: RenderCtx): string | undefined {
  const rows = findDescendants(table, ['tr']);
  const cellMatrix: string[][] = [];
  let width = 0;
  for (const tr of rows) {
    const row: string[] = [];
    for (const c of kids(tr)) {
      const name = tagName(c);
      if (name !== 'td' && name !== 'th') continue;
      const cell = inline(c, ctx).replace(/\|/g, '\\|').trim();
      row.push(cell);
    }
    if (row.length) {
      cellMatrix.push(row);
      width = Math.max(width, row.length);
    }
  }
  if (!cellMatrix.length) return undefined;
  const padRow = (row: string[]): string[] => [
    ...row,
    ...Array(Math.max(0, width - row.length)).fill(''),
  ];
  const [header, ...body] = cellMatrix;
  const lines = [
    `| ${padRow(header).join(' | ')} |`,
    `| ${padRow([]).map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${padRow(row).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function renderBlock(node: RawNode, name: string, ctx: RenderCtx): string | undefined {
  if (/^h[1-6]$/.test(name)) {
    const text = inline(node, ctx).trim();
    return text ? `${'#'.repeat(Number(name.charAt(1)))} ${text}` : undefined;
  }
  if (name === 'p') {
    const text = inline(node, ctx).trim();
    return text || undefined;
  }
  if (name === 'ul' || name === 'ol') return renderList(node, name === 'ol', ctx, 0);
  if (name === 'table') return renderTable(node, ctx);
  if (name === 'pre') {
    const codeChild = kids(node).find((c) => tagName(c) === 'code');
    const content = codeBlockText(codeChild ?? node);
    if (!content) return undefined;
    const lang = fenceLanguage(node);
    return `${FENCE}${lang ?? ''}\n${content}\n${FENCE}`;
  }
  if (name === 'blockquote') {
    // Re-render the quote's own children, then prefix every line so nested blocks stay valid.
    const inner: RenderCtx = { blocks: [], images: ctx.images, baseUrl: ctx.baseUrl };
    renderBlocksInto(node, inner);
    const body = inner.blocks.join('\n').trim();
    return body ? body.split('\n').map((line) => `> ${line}`).join('\n') : undefined;
  }
  if (name === 'img') {
    const md = imageMarkdown(node, ctx);
    return md || undefined;
  }
  if (name === 'iframe') {
    // Assessment embeds: keep only a plain pointer line instead of the iframe itself.
    const url = toAbsoluteUrl(node.attribs?.['data-url'], ctx.baseUrl);
    return url ? `[external] ${url}` : undefined;
  }
  return undefined;
}

/** Walk one container node (body, div, section, …), pushing finished blocks into ctx. */
function renderBlocksInto(node: RawNode, ctx: RenderCtx): void {
  let loose = ''; // text accumulated between block elements at this nesting level
  const flushLoose = (): void => {
    const text = collapseWs(loose).trim();
    if (text) ctx.blocks.push(text);
    loose = '';
  };

  for (const c of kids(node)) {
    if (c.type === 'text') { loose += c.data ?? ''; continue; } // comments/directives drop out here
    const name = tagName(c);
    if (!name || STRIP_TAGS.has(name)) continue;
    if (name === 'input' && (c.attribs?.type ?? '').toLowerCase() === 'hidden') continue;

    if (BLOCK_TAGS.has(name)) {
      flushLoose();
      const block = renderBlock(c, name, ctx);
      if (block) ctx.blocks.push(block);
      continue;
    }
    if (INLINE_TAGS.has(name)) { loose += ` ${inlineChild(c, ctx)}`; continue; }
    // Anything else (div/section/details/figure/unknown) recurses as a plain container.
    renderBlocksInto(c, ctx);
  }
  flushLoose();
}

// --------------------------------------------------------------------------- entry point

export function htmlToCourseMarkdown(html: string, baseUrl?: string): CourseMarkdown {
  if (!html || !html.trim()) return { markdown: '', images: [] };
  const $ = cheerio.load(html);
  const start = $('body').get(0) ?? $('html').get(0);
  if (!start) return { markdown: '', images: [] };

  const ctx: RenderCtx = { blocks: [], images: [], baseUrl };
  renderBlocksInto(start as unknown as RawNode, ctx);

  let markdown = ctx.blocks.map((block) => block.trim()).filter(Boolean).join('\n\n');
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
  if (markdown.includes('<')) markdown = markdown.replace(/</g, '&lt;'); // hard invariant: no raw '<'
  return { markdown, images: ctx.images };
}
