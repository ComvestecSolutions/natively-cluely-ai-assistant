/** Bound first-token delay to a small, exact request prolog, never arbitrary XML. */
export const MAX_QUESTION_ECHO_CHARS = 4096;

function echoedFrame(userPrompt: string, v3Owned: boolean, systemPrompt?: string): string {
  if (!v3Owned || /current_question/i.test(systemPrompt ?? '')) return '';
  const lines = userPrompt.slice(0, MAX_QUESTION_ECHO_CHARS + 1).split('\n');
  const header = /^<current_question lines="([1-9]\d*)">$/.exec(lines[0]);
  if (!header || lines[1] !== '# Question') return '';
  const count = Number(header[1]);
  if (!Number.isSafeInteger(count) || count + 2 >= lines.length || lines[count + 2] !== '</current_question>') return '';
  const question = lines.slice(2, count + 2).join('\n');
  // A request to show/explain this literal syntax is content, not a leak.
  if (/current_question/i.test(question)) return '';
  const frame = lines.slice(0, count + 3).join('\n');
  return frame.length <= MAX_QUESTION_ECHO_CHARS ? frame : '';
}

/** Removes only a complete, leading copy of THIS composed question frame.
 * Fenced/inline examples, mismatches and incomplete prefixes are untouched.
 */
export class StreamingQuestionEchoFilter {
  private readonly frame: string;
  private pending = '';
  private state: 'matching' | 'separator' | 'passthrough';

  constructor(userPrompt: string, v3Owned = false, systemPrompt?: string) {
    this.frame = echoedFrame(userPrompt, v3Owned, systemPrompt);
    this.state = this.frame ? 'matching' : 'passthrough';
  }

  feed(chunk: string): string {
    if (!chunk || this.state === 'passthrough') return chunk;
    if (this.state === 'separator') {
      this.state = 'passthrough';
      // Consume one framing newline, not answer indentation or blank lines.
      return chunk.startsWith('\n') ? chunk.slice(1) : chunk;
    }
    const size = Math.min(this.frame.length - this.pending.length, chunk.length);
    const part = chunk.slice(0, size);
    if (this.frame.slice(this.pending.length, this.pending.length + size) !== part) {
      const out = this.pending + chunk;
      this.pending = '';
      this.state = 'passthrough';
      return out;
    }
    this.pending += part;
    if (this.pending.length < this.frame.length) return '';
    this.pending = '';
    this.state = 'separator';
    return this.feed(chunk.slice(size));
  }

  finish(): string {
    const out = this.pending;
    this.pending = '';
    this.state = 'passthrough';
    return out;
  }
}
