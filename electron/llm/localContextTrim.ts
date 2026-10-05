// The per-request overflow guard for a model on this device.
//
// A local model has a small context, and a prompt that does not fit it is cut
// here rather than refused. The cut has always been "oldest lines first, never
// the system prompt", and that is still what it is for ordinary content. What
// it could not see was that two things in the user content are not lines:
//
//   - the design on the table (<active_design>): half a diagram's source is
//     worse than none. The model is asked to return the whole diagram with
//     every node kept, and what comes back replaces the one on the table.
//   - what was said in the meeting (<conversation_so_far>): cut from the top it
//     lost its opening tag and the sentence that says what it is, while the
//     contract in the system prompt still pointed at it by name.
//
// Pure: no model, no I/O, so both Ollama entry points share it and it is
// tested under plain Node.

const DESIGN_OPEN = /^\s*<active_design\b/;
const DESIGN_CLOSE = /<\/active_design>/;
const SPEECH_OPEN = /^\s*<conversation_so_far>\s*$/;
const SPEECH_CLOSE = /^\s*<\/conversation_so_far>\s*$/;
// V3 uses <evidence> for every retrieved source; legacy carriers wrap the pool.
const EVIDENCE_OPEN = /^\s*<(evidence|evidence_set|active_mode_retrieved_context|reference_file|candidate_profile|candidate_job_description|course_context)\b[^>]*>/;

/** What takes the place of a design that did not fit. */
export const DESIGN_OMITTED_NOTE =
  '(The drawing on the table is too large for this model and is not shown here. Say that plainly, and do not redraw it from memory.)';

type Segment =
  | { kind: 'plain'; lines: string[] }
  | { kind: 'design'; lines: string[] }
  | { kind: 'evidence'; lines: string[] }
  | { kind: 'question'; lines: string[]; questionText?: string }
  // head: the opening tag and the sentence under it; tail: the closing tag.
  | { kind: 'speech'; head: string[]; body: string[]; tail: string[] };

/** Composer-owned framing: the declared line count, not Markdown headings or
 * XML-looking user text, identifies the question's exact boundary. */
export function frameCurrentQuestion(question: string): string {
  return `<current_question lines="${question.split('\n').length}">\n# Question\n${question}\n</current_question>`;
}

function segmentsOf(lines: string[]): Segment[] {
  const out: Segment[] = [];
  let plain: string[] = [];
  const flush = () => { if (plain.length) { out.push({ kind: 'plain', lines: plain }); plain = []; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const framed = /^<current_question lines="(\d+)">$/.exec(line);
    if (framed && lines[i + 1] === '# Question') {
      const size = Number(framed[1]);
      const end = i + 2 + size;
      if (size > 0 && Number.isSafeInteger(size) && lines[end] === '</current_question>') {
        flush();
        out.push({ kind: 'question', lines: lines.slice(i, end + 1), questionText: lines.slice(i + 2, end).join('\n') });
        i = end;
        continue;
      }
    }
    // Compatibility for old unframed, plain-text question carriers. Modern
    // composer payloads take the structured branch above, including all code.
    if (/^# Question\s*$/.test(line)) {
      flush();
      let end = i + 1;
      while (end < lines.length && !/^#\s/.test(lines[end]) && !EVIDENCE_OPEN.test(lines[end])) end += 1;
      let questionEnd = end;
      while (questionEnd > i + 1 && !lines[questionEnd - 1].trim()) questionEnd -= 1;
      out.push({ kind: 'question', lines: lines.slice(i, questionEnd) });
      // Separators are disposable formatting, not the last line of the question.
      plain.push(...lines.slice(questionEnd, end));
      i = end - 1;
      continue;
    }
    const evidence = EVIDENCE_OPEN.exec(line);
    if (evidence) {
      const close = `</${evidence[1]}>`;
      let end = i;
      while (end < lines.length && !lines[end].includes(close)) end += 1;
      if (end < lines.length) {
        flush();
        out.push({ kind: 'evidence', lines: lines.slice(i, end + 1) });
        i = end;
        continue;
      }
    }
    const design = DESIGN_OPEN.test(line);
    const speech = !design && SPEECH_OPEN.test(line);
    if (design || speech) {
      const close = design ? DESIGN_CLOSE : SPEECH_CLOSE;
      let end = -1;
      for (let j = design ? i : i + 1; j < lines.length; j += 1) {
        if (close.test(lines[j])) { end = j; break; }
      }
      // An opening tag that is never closed is not a block: ordinary lines.
      if (end > i) {
        flush();
        const block = lines.slice(i, end + 1);
        if (design) out.push({ kind: 'design', lines: block });
        else out.push({ kind: 'speech', head: block.slice(0, Math.min(2, block.length - 1)), body: block.slice(Math.min(2, block.length - 1), -1), tail: block.slice(-1) });
        i = end;
        continue;
      }
    }
    plain.push(line);
  }
  flush();
  return out;
}

const linesOf = (segment: Segment): string[] =>
  segment.kind === 'speech' ? [...segment.head, ...segment.body, ...segment.tail] : segment.lines;

/**
 * `userContent` shortened until it is at most `maxChars` long.
 *
 * Order of what goes: the oldest ordinary lines; then the oldest lines of what
 * was said in the meeting (its wrapper and heading stay while any of it does);
 * then the design on the table, whole, with one line in its place; then
 * retrieved evidence, whole blocks only; then remaining ordinary lines.
 * Evidence outlives old speech without losing its provenance/untrusted fence.
 * Ordinary content retains its final line for legacy callers. An explicit V3
 * question is kept whole whenever it fits; otherwise its text (not the heading)
 * is shortened on a code-point boundary to honor even a zero-character budget.
 */
export function trimUserContentToFit(userContent: string, maxChars: number): string {
  const text = String(userContent ?? '');
  if (!(maxChars >= 0) || text.length <= maxChars) return text;

  const segments = segmentsOf(text.split('\n'));
  // Joined length = every line's length + one newline between each pair.
  let length = text.length;
  const fits = () => length <= maxChars;
  const count = () => segments.reduce((n, s) => n + linesOf(s).length, 0);
  /** Remove the first line of `lines`; false when that would leave nothing at all. */
  const shift = (lines: string[]): boolean => {
    if (lines.length === 0 || count() <= 1) return false;
    length -= lines[0].length + 1;
    lines.shift();
    return true;
  };

  const last = segments.length - 1;
  const hasQuestion = segments.some((s) => s.kind === 'question');

  // 1. Ordinary lines above the last segment, or all guidance/separators
  // when an explicit question identifies what must outlive them.
  for (let i = 0; i < (hasQuestion ? segments.length : last) && !fits(); i += 1) {
    const segment = segments[i];
    if (segment.kind !== 'plain') continue;
    while (!fits() && shift(segment.lines)) { /* oldest first */ }
  }

  // Evidence can precede an unfenced transcript and the final USER question in
  // the same ordinary segment. Trim that history too, but never the question.
  const trailing = segments[last];
  if (segments.some((s) => s.kind === 'evidence') && trailing?.kind === 'plain') {
    const questionAt = trailing.lines.findIndex((line) => /^USER:\s*$/.test(line));
    let removable = questionAt >= 0 ? questionAt : Math.max(0, trailing.lines.length - 1);
    while (removable > 0 && !trailing.lines[removable - 1].trim()) removable -= 1;
    for (let n = 0; n < removable && !fits(); n += 1) shift(trailing.lines);
  }

  // 2. The oldest of what was said; a block with nothing left in it goes whole.
  for (let i = 0; i < segments.length && !fits(); i += 1) {
    const segment = segments[i];
    if (segment.kind !== 'speech') continue;
    while (!fits() && shift(segment.body)) { /* oldest first */ }
    if (segment.body.length === 0) {
      while (segment.head.length && shift(segment.head)) { /* the wrapper with it */ }
      while (segment.tail.length && shift(segment.tail)) { /* … */ }
    }
  }

  // 3. The design, whole. Never a part of it.
  for (let i = 0; i < segments.length && !fits(); i += 1) {
    const segment = segments[i];
    if (segment.kind !== 'design') continue;
    const removed = segment.lines.reduce((n, line) => n + line.length + 1, 0);
    length += DESIGN_OMITTED_NOTE.length + 1 - removed;
    segments[i] = { kind: 'plain', lines: [DESIGN_OMITTED_NOTE] };
  }

  // An omitted-design notice is guidance too, below the question and evidence.
  if (hasQuestion) {
    for (const segment of segments) {
      if (segment.kind === 'plain') while (!fits() && shift(segment.lines)) { /* guidance first */ }
    }
  }

  // 4. If evidence itself cannot fit, omit whole blocks, never orphan a tag.
  // The question outlives evidence; legacy final-line behavior is unchanged.
  for (let i = segments.length - 1; i >= 0 && !fits(); i -= 1) {
    const segment = segments[i];
    if (segment.kind !== 'evidence' || count() <= segment.lines.length) continue;
    length -= segment.lines.reduce((n, line) => n + line.length + 1, 0);
    segment.lines = [];
  }

  // 5. Still too long: remaining ordinary lines from the top.
  for (let i = 0; i < segments.length && !fits(); i += 1) {
    const segment = segments[i];
    if (segment.kind === 'plain') while (!fits() && shift(segment.lines)) { /* oldest first */ }
  }

  if (!fits() && hasQuestion) {
    // Nothing lower-priority remains. Drop the heading before shortening the
    // actual question; keep its beginning, including multiline questions.
    const question = segments.filter((s): s is Extract<Segment, { kind: 'question' }> => s.kind === 'question')
      .map(s => s.questionText ?? s.lines.slice(1).join('\n')).join('\n');
    let end = Math.min(question.length, Math.floor(maxChars));
    if (end > 0 && /[\uD800-\uDBFF]/.test(question[end - 1])) end -= 1;
    return question.slice(0, end);
  }

  return segments.flatMap(linesOf).join('\n');
}

/**
 * The room the user content has in a model of `maxContextTokens`, in
 * characters: what the old loop tested line by line
 * (`estimateTokens(sys) + estimateTokens(user) + 2000 > max`, four characters
 * to a token, rounded up), solved for the user content.
 */
export function userContentRoomChars(maxContextTokens: number, systemPrompt: string, reserveTokens = 2000): number {
  const systemTokens = Math.ceil(String(systemPrompt ?? '').length / 4);
  return Math.max(0, (Math.floor(maxContextTokens) - reserveTokens - systemTokens) * 4);
}
