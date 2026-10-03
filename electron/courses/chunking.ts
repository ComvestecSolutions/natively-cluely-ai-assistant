// Lesson chunking — P2 (retrieval): pure, deterministic split of a stored lesson markdown into CourseChunk units.
// No deps, no IO: same input always yields the same chunks.

export interface CourseChunk {
  text: string;
  headingPath: string; // "H1 > H2" path of the chunk's first block ("" when outside any heading); a chunk may straddle sections
  index: number; // sequential per lesson, from 0
}

interface ChunkingOptions {
  maxCharsPerChunk?: number; // soft target size per chunk, default 3600
  hardMaxChars?: number; // absolute cap; indivisible blocks are line-split at this, default 7200
}

const DEFAULT_MAX_CHARS = 3600;
const DEFAULT_HARD_MAX_CHARS = 7200;
const TRIVIAL_CHUNK_CHARS = 40; // chunks smaller than this merge into a neighbor or drop
const BLOCK_SEPARATOR = "\n\n";

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const BACKTICK_FENCE_CLOSE_RE = /^ {0,3}`{3,}\s*$/; // closing backtick fence carries no info string
const TILDE_FENCE_CLOSE_RE = /^ {0,3}~{3,}\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(\s+.*)?$/; // ATX heading: space (or EOL) after the hashes

interface HeadingRef {
  level: number;
  text: string;
}

function headingPathOf(stack: HeadingRef[]): string {
  return stack.map((h) => h.text).filter((t) => t !== "").join(" > ");
}

/** One unsplittable unit: a paragraph (heading line + following non-blank lines) or a whole fenced block. */
interface Block {
  text: string;
  path: string; // heading path active over the entire block
}

function markdownToBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let stack: HeadingRef[] = [];
  let paraLines: string[] | null = null;
  let fenceCloseRe: RegExp | null = null; // non-null while inside a fenced block
  let fenceLines: string[] = [];
  let fencePath = "";

  const flushParagraph = (): void => {
    if (paraLines !== null && paraLines.length > 0) {
      blocks.push({ text: paraLines.join("\n"), path: headingPathOf(stack) });
    }
    paraLines = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (fenceCloseRe !== null) {
      fenceLines.push(line); // never split or re-interpret inside a fenced block
      if (fenceCloseRe.test(line)) {
        blocks.push({ text: fenceLines.join("\n"), path: fencePath });
        fenceCloseRe = null;
        fenceLines = [];
      }
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    const hashRun = headingMatch === null ? undefined : headingMatch[1];
    if (hashRun !== undefined) {
      flushParagraph(); // a heading always starts a fresh block under the new path
      const level = hashRun.length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      const title = ((headingMatch === null ? undefined : headingMatch[2]) ?? "").trim().replace(/\s+#+\s*$/, "");
      if (title !== "") stack.push({ level, text: title });
      paraLines = [line];
      continue;
    }

    const fenceOpenMatch = FENCE_OPEN_RE.exec(line);
    const fenceMarker = fenceOpenMatch === null ? undefined : fenceOpenMatch[1];
    if (fenceMarker !== undefined) {
      flushParagraph();
      fencePath = headingPathOf(stack);
      fenceCloseRe = fenceMarker.startsWith("`") ? BACKTICK_FENCE_CLOSE_RE : TILDE_FENCE_CLOSE_RE;
      fenceLines = [line];
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(); // blank line is the paragraph boundary where chunks may break
      continue;
    }

    paraLines = paraLines === null ? [line] : [...paraLines, line];
  }

  flushParagraph();
  if (fenceCloseRe !== null && fenceLines.length > 0) {
    blocks.push({ text: fenceLines.join("\n"), path: fencePath }); // unclosed fence runs to EOF
  }
  return blocks;
}

/** Greedy line-packing at `limit`; a single longer line is sliced. Every piece is ≤ limit chars. */
function splitOversizedBlock(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.length <= limit) {
      if (buf === "") buf = line;
      else if (buf.length + 1 + line.length <= limit) buf += "\n" + line;
      else {
        pieces.push(buf);
        buf = line;
      }
    } else {
      if (buf !== "") {
        pieces.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += limit) pieces.push(line.slice(i, i + limit));
    }
  }
  if (buf !== "") pieces.push(buf);
  return pieces;
}

/** Pack blocks into chunks of ≤ maxChars, breaking only between blocks (never inside a fence). */
function groupBlocksIntoChunks(blocks: Block[], maxChars: number, hardMax: number): Array<{ text: string; path: string }> {
  const chunks: Array<{ text: string; path: string }> = [];
  let curText = "";
  let curPath = "";

  const commit = (): void => {
    if (curText !== "") {
      chunks.push({ text: curText, path: curPath });
      curText = "";
    }
  };

  for (const block of blocks) {
    // An indivisible block past the hard cap is line-split so no chunk can exceed it.
    const pieces = block.text.length > hardMax ? splitOversizedBlock(block.text, hardMax) : [block.text];
    for (const piece of pieces) {
      if (curText === "" || curText.length + BLOCK_SEPARATOR.length + piece.length <= maxChars) {
        if (curText === "") curPath = block.path; // a chunk carries the path of its first block
        curText = curText === "" ? piece : curText + BLOCK_SEPARATOR + piece;
      } else {
        commit();
        curPath = block.path;
        curText = piece;
      }
    }
  }
  commit();
  return chunks;
}

/** Merge <40-char chunks into a neighbor (previous first, then next) or drop them. Mutates nothing. */
function mergeOrDropTrivial(
  chunks: Array<{ text: string; path: string }>,
  hardMax: number,
): Array<{ text: string; path: string }> {
  const out: Array<{ text: string; path: string }> = [];
  let pendingText = "";
  let pendingPath = "";

  const attachToPrevious = (text: string, fallbackPath: string): boolean => {
    if (out.length === 0) return false;
    const last = out[out.length - 1];
    if (last.text.length + BLOCK_SEPARATOR.length + text.length > hardMax) return false;
    last.text += BLOCK_SEPARATOR + text;
    if (last.path === "") last.path = fallbackPath;
    return true;
  };

  for (const chunk of chunks) {
    if (chunk.text.trim().length >= TRIVIAL_CHUNK_CHARS) {
      let text = chunk.text;
      let path = chunk.path;
      if (pendingText !== "" && pendingText.length + BLOCK_SEPARATOR.length + chunk.text.length <= hardMax) {
        text = pendingText + BLOCK_SEPARATOR + chunk.text;
        path = chunk.path !== "" ? chunk.path : pendingPath; // the substantial content owns the path
        pendingText = "";
        pendingPath = "";
      }
      out.push({ text, path });
      continue;
    }
    if (!attachToPrevious(chunk.text, chunk.path)) {
      // Hold for the next substantive chunk; still-pending at EOF is dropped (see below).
      pendingText = pendingText === "" ? chunk.text : pendingText + BLOCK_SEPARATOR + chunk.text;
      if (pendingPath === "") pendingPath = chunk.path;
    }
  }

  if (pendingText !== "") {
    void attachToPrevious(pendingText, pendingPath); // trailing fragment: fold in when it fits, else drop
  }
  return out;
}

/** Split a lesson's stored markdown into deterministic retrieval chunks. */
export function chunkLessonMarkdown(markdown: string, opts?: ChunkingOptions): CourseChunk[] {
  if (typeof markdown !== "string" || markdown.length === 0) return [];
  const maxChars = opts?.maxCharsPerChunk ?? DEFAULT_MAX_CHARS;
  const hardMaxChars = opts?.hardMaxChars ?? DEFAULT_HARD_MAX_CHARS;
  const grouped = groupBlocksIntoChunks(markdownToBlocks(markdown), maxChars, hardMaxChars);
  return mergeOrDropTrivial(grouped, hardMaxChars).map((chunk, index) => ({
    text: chunk.text,
    headingPath: chunk.path,
    index,
  }));
}
