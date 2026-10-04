// Course study aids — P3: generate a summary, glossary, quiz or flashcards from
// lesson markdown via one LLM call per (type, content), cached on disk as JSON.
// No electron imports: every platform input arrives through parameters so the
// compiled module can be unit-tested under ELECTRON_RUN_AS_NODE.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { safeCourseDirName } from './courseDir';

export type StudyAidType = 'summary' | 'glossary' | 'quiz' | 'flashcards';

export interface QuizQuestion {
  q: string;
  options: string[];
  answer: number;
  explanation?: string;
}

export interface FlashcardPair {
  front: string;
  back: string;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
}

type NormResult<T> = { ok: true; data: T } | { ok: false; error: string };

// --- content prep -----------------------------------------------------------

const MAX_SOURCES = 4;
const PER_SOURCE_CHARS = 5000;
const TOTAL_CHARS = 14000;

export function fnv1aHash(s: string): string {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(s, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function prepareSources(sources: { title: string; md: string }[]): string {
  const parts = (sources ?? [])
    .slice(0, MAX_SOURCES)
    .map((s) => `### ${s.title}\n\n${(s.md ?? '').trim().slice(0, PER_SOURCE_CHARS)}`);
  let out = parts.join('\n\n');
  if (out.length > TOTAL_CHARS) {
    out = `${out.slice(0, TOTAL_CHARS - 1)}…`;
  }
  return out;
}

// --- prompting ---------------------------------------------------------------

const PREAMBLE =
  'You are a course tutor. Generate study material STRICTLY from the provided lesson text(s); do not add facts from memory. ';

const TYPE_BODIES: Record<StudyAidType, string> = {
  summary:
    "Write a concise study summary (max ~250 words) in Markdown with a '## Key points' bullet list, plus one 'Watch out for' line naming common exam traps.",
  glossary:
    'Output ONLY valid JSON, no fences: {"terms":[{"term":"...","definition":"..."}]} with at most 15 entries; definitions <= 25 words each.',
  quiz:
    'Output ONLY valid JSON, no fences: {"questions":[...]} with exactly 6 questions, each {"q": "...", "options": [4 distinct strings], "answer": <index 0-3>, "explanation": "<= 30 words"}. Questions must be answerable from the provided text only.',
  flashcards:
    'Output ONLY valid JSON, no fences: {"cards":[{"front":"...","back":"..."}]} with at most 20 cards; front = term/short question, back <= 40 words.',
};

export function buildPrompt(type: StudyAidType, prepared: string): string {
  return `${PREAMBLE}${TYPE_BODIES[type]}\n\nPROVIDED MATERIAL:\n${prepared}`;
}

// --- JSON extraction ---------------------------------------------------------

// Strip ``` fence markers (keeping the payload), then slice from the first '{' or '['
// to its matching closer, counting brackets and skipping any inside "strings".
export function extractJson(text: string): unknown | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```/g, ' ');
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{' || cleaned[i] === '[') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === open) {
      depth++;
    } else if (c === close && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// --- normalizers ---------------------------------------------------------------

export function normalizeSummary(raw: string): NormResult<string> {
  let t = (raw ?? '').trim();
  t = t.replace(/^\s*```[a-zA-Z]*\r?\n?/, '').replace(/```\s*$/, '').trim();
  if (!t) return { ok: false, error: 'summary is empty' };
  return { ok: true, data: t };
}

export function normalizeGlossary(raw: unknown): NormResult<{ entries: GlossaryEntry[] }> {
  const terms = Array.isArray(raw) ? raw : (raw as { terms?: unknown })?.terms;
  if (!Array.isArray(terms)) {
    return { ok: false, error: 'expected an object with a "terms" array' };
  }
  const entries: GlossaryEntry[] = [];
  for (const item of terms) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const term = typeof o.term === 'string' ? o.term.trim() : '';
    const definition = typeof o.definition === 'string' ? o.definition.trim() : '';
    if (term && definition) entries.push({ term, definition });
    if (entries.length >= 20) break;
  }
  if (entries.length === 0) return { ok: false, error: 'no valid glossary entries' };
  return { ok: true, data: { entries } };
}

export function normalizeQuiz(raw: unknown): NormResult<{ questions: QuizQuestion[] }> {
  const items = Array.isArray(raw) ? raw : (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(items)) {
    return { ok: false, error: 'expected an object with a "questions" array' };
  }
  const questions: QuizQuestion[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const q = typeof o.q === 'string' ? o.q.trim() : '';

    const options: string[] = [];
    if (Array.isArray(o.options)) {
      for (const opt of o.options) {
        const s = String(opt ?? '').trim();
        if (s) options.push(s);
      }
    }
    if (!q || options.length < 2) continue;

    // Answer is a numeric index, or text that matches an option case-insensitively.
    let answer = -1;
    const a = o.answer;
    if (typeof a === 'number' && Number.isInteger(a) && a >= 0 && a < options.length) {
      answer = a;
    } else {
      const needle = String(a ?? '').trim().toLowerCase();
      if (needle) answer = options.findIndex((opt) => opt.toLowerCase() === needle);
    }
    if (answer === -1) continue;

    const question: QuizQuestion = { q, options, answer };
    const explanation = typeof o.explanation === 'string' ? o.explanation.trim() : '';
    if (explanation) question.explanation = explanation;
    questions.push(question);
    if (questions.length >= 15) break;
  }
  if (questions.length === 0) return { ok: false, error: 'no valid quiz questions' };
  return { ok: true, data: { questions } };
}

export function normalizeFlashcards(raw: unknown): NormResult<{ cards: FlashcardPair[] }> {
  const items = Array.isArray(raw) ? raw : (raw as { cards?: unknown })?.cards;
  if (!Array.isArray(items)) return { ok: false, error: 'expected an object with a "cards" array' };
  const cards: FlashcardPair[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const front = typeof o.front === 'string' ? o.front.trim() : '';
    const back = typeof o.back === 'string' ? o.back.trim() : '';
    if (front && back) cards.push({ front, back });
    if (cards.length >= 30) break;
  }
  if (cards.length === 0) return { ok: false, error: 'no valid flashcards' };
  return { ok: true, data: { cards } };
}

// --- cache + generation ----------------------------------------------------------

interface CacheEntry {
  h: string;
  at: string;
  data: unknown;
}
type CacheFile = Record<string, CacheEntry>;

const CACHE_MAX_KEYS = 64;

function readCache(file: string): Promise<CacheFile> {
  return readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .then((parsed: unknown) =>
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as CacheFile)
        : {},
    )
    .catch(() => ({}));
}

async function writeCache(file: string, cache: CacheFile): Promise<void> {
  try {
    if (Object.keys(cache).length > CACHE_MAX_KEYS) {
      // ISO timestamps sort chronologically as plain strings.
      const ordered = Object.entries(cache).sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [key] of ordered.slice(0, ordered.length - CACHE_MAX_KEYS)) delete cache[key];
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache), 'utf8');
  } catch {
    // Best-effort: a failed write must not fail an already-generated aid.
  }
}

export interface StudyAidInput {
  rootDir: string;
  courseId: string;
  type: StudyAidType;
  sources: { title: string; md: string }[];
  force?: boolean;
  llm: (prompt: string) => Promise<string>;
}

export async function generateStudyAid(
  input: StudyAidInput,
): Promise<{ ok: true; cached?: boolean; data: any } | { ok: false; error: string }> {
  const prepared = prepareSources(input.sources ?? []);
  if (!prepared.trim()) return { ok: false, error: 'no lesson material provided' };

  // Key on the PREPARED text so identical content (any titles/layout) is a cache hit.
  const key = `${input.type}:${fnv1aHash(prepared)}`;
  const file = path.join(input.rootDir, safeCourseDirName(input.courseId), 'study-aids.json');
  const cache = await readCache(file);

  if (!input.force) {
    const hit = cache[key];
    if (hit && typeof hit === 'object') return { ok: true, cached: true, data: hit.data };
  }

  let raw: string;
  try {
    raw = await input.llm(buildPrompt(input.type, prepared));
  } catch (e) {
    const reason = e instanceof Error && typeof e.message === 'string' && e.message.trim() !== '' ? e.message : 'unknown model error';
    return { ok: false, error: `model request failed: ${reason}` };
  }

  // Provider failures can still arrive as plain text (the LLM helper yields them as stream
  // content); never report one as bad model output — and never cache it under a summary key.
  const prose = raw.trim();
  if (/^Error: Custom Provider returned HTTP \d{3}\b/.test(prose)) {
    return { ok: false, error: `model request failed: ${prose.replace(/^Error:\s*/, '').toLowerCase()}` };
  }
  if (prose.startsWith('Error streaming from custom provider')) {
    return { ok: false, error: 'model request failed: the model endpoint could not answer' };
  }

  if (input.type === 'summary') {
    const norm = normalizeSummary(raw);
    if (!norm.ok) return { ok: false, error: norm.error };
    cache[key] = { h: fnv1aHash(prepared), at: new Date().toISOString(), data: norm.data };
    await writeCache(file, cache);
    return { ok: true, data: norm.data };
  }

  const parsed = extractJson(raw);
  if (parsed === null) return { ok: false, error: 'model did not return valid JSON' };
  const norm =
    input.type === 'glossary'
      ? normalizeGlossary(parsed)
      : input.type === 'quiz'
        ? normalizeQuiz(parsed)
        : normalizeFlashcards(parsed);
  if (!norm.ok) return { ok: false, error: norm.error };

  cache[key] = { h: fnv1aHash(prepared), at: new Date().toISOString(), data: norm.data };
  await writeCache(file, cache);
  return { ok: true, data: norm.data };
}
