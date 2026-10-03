// Courses Studio — P5 assessment capture (discovery-settled best effort).
//
// Live Microsoft Learn certification pages generally have NO machine-readable practice
// questions ("practice assessment is currently not available") and no question-serving
// endpoint exists. So ingestion ships two things: an optimistic extractor for any JSON a
// page does embed, and a guaranteed external-link card appended to every assessment
// lesson's markdown so the learner always has a way out of the app.
//
// Dependency-free on purpose (pure string/regex/JSON logic — no cheerio), and HTTP goes
// through an injected client (same shape as profiles/microsoftLearn.ts CourseHttpClient)
// so the compiled module stays unit-testable under ELECTRON_RUN_AS_NODE.

/** One normalized practice-assessment question extracted from embedded page JSON. */
export interface NormalizedQuestion {
  q: string;
  /** Option texts, when present (at least one). */
  options?: string[];
  /** 0-based index into `options` for the correct choice, when determinable. */
  answer?: number;
}

/** Outcome of the single polite GET an assessment capture performs. */
export type AssessmentFetchResult =
  | { ok: true; questions: NormalizedQuestion[] }
  | { ok: false; error: string };

interface TextHttpClientLike {
  get(url: string): Promise<{ status: number; body: string }>;
}

const MAX_QUESTIONS = 200;
const FETCH_TIMEOUT_MS = 25000;
/** Keys that may carry the question's text. */
const QUESTION_TEXT_KEYS = ["text", "questionText", "prompt"] as const;
/** Keys that may carry an options/choices list (any one of them is shape evidence). */
const OPTION_LIST_KEYS = ["options", "choices", "answers"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first non-empty question-text value found (in key preference order). */
function questionTextOf(item: Record<string, unknown>): string | undefined {
  for (const key of QUESTION_TEXT_KEYS) {
    const raw = item[key];
    if (typeof raw === "string" && raw.trim().length > 0) return raw;
  }
  return undefined;
}

/** An option list spelled as objects carrying a correctness flag. */
function isFlaggedOptionList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((el) => isPlainObject(el) && ("isCorrect" in el || "correct" in el))
  );
}

/** Question-shaped item: a text key plus at least one structural answer signal. */
function looksLikeQuestion(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (questionTextOf(value) === undefined) return false;
  for (const key of OPTION_LIST_KEYS) {
    const list = value[key];
    if (Array.isArray(list) && list.length > 0) return true;
  }
  const index = value.correctAnswer ?? value.answerIndex;
  if (typeof index === "number" && Number.isInteger(index) && index >= 0) return true;
  return Object.values(value).some(isFlaggedOptionList);
}

/** First array in document order (depth-first) holding at least one question-shaped item. */
function firstQuestionArray(root: unknown): unknown[] | null {
  let found: unknown[] | null = null;
  const visit = (value: unknown): void => {
    if (found !== null) return; // a qualifying array already wins — stop walking
    if (Array.isArray(value)) {
      if (value.length > 0 && value.some(looksLikeQuestion)) {
        found = value;
        return;
      }
      for (const el of value) visit(el);
    } else if (isPlainObject(value)) {
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(root);
  return found;
}

/** Coerce one raw option entry to display text. */
function optionTextOf(entry: unknown): string {
  if (isPlainObject(entry)) {
    const raw = entry.text ?? entry.label ?? entry.content;
    if (raw !== undefined && raw !== null) return String(raw);
    return JSON.stringify(entry); // keep objects informative rather than "[object Object]"
  }
  return String(entry);
}

/** Normalize one question-shaped object; null when it yields no usable text. */
function normalizeQuestion(item: Record<string, unknown>): NormalizedQuestion | null {
  const q = questionTextOf(item);
  if (q === undefined) return null;

  let rawOptions: unknown = item.options ?? item.choices;
  if (!Array.isArray(rawOptions)) {
    // Shape evidence may live in a custom-named flagged list — still best-effort usable.
    rawOptions = Object.values(item).find(isFlaggedOptionList);
  }
  const options: string[] | undefined =
    Array.isArray(rawOptions) && rawOptions.length > 0 ? rawOptions.map(optionTextOf) : undefined;

  let answer: number | undefined;
  const indexRaw = item.correctAnswer ?? item.answerIndex;
  if (typeof indexRaw === "number" && Number.isInteger(indexRaw) && indexRaw >= 0) {
    answer = indexRaw;
  } else if (Array.isArray(rawOptions)) {
    const flagged = rawOptions.findIndex(
      (el) => isPlainObject(el) && (Boolean(el.isCorrect) || Boolean(el.correct)),
    );
    if (flagged >= 0) answer = flagged;
  }

  const out: NormalizedQuestion = { q };
  if (options !== undefined) out.options = options;
  if (answer !== undefined) out.answer = answer;
  return out;
}

/**
 * Extract embedded practice questions from a page body. Plain HTML pages — the common
 * real-world case — yield []. The first question-bearing script wins, capped at 200 items.
 */
export function extractEmbeddedQuestions(html: string): NormalizedQuestion[] {
  if (typeof html !== "string" || html.length === 0) return [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const body = match[1].trim();
    if (body.length === 0 || !(body.startsWith("{") || body.startsWith("["))) continue;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      continue; // inline JS or broken embed — not JSON.
    }
    const array = firstQuestionArray(value);
    if (array === null) continue;
    const questions: NormalizedQuestion[] = [];
    for (const el of array.filter(looksLikeQuestion).slice(0, MAX_QUESTIONS)) {
      if (!isPlainObject(el)) continue;
      const normalized = normalizeQuestion(el);
      if (normalized !== null) questions.push(normalized);
    }
    if (questions.length > 0) return questions;
  }
  return [];
}

/** The guaranteed fallback card — last line of every rendered assessment section. */
function assessmentCardLine(url: string): string {
  return `> **Official practice assessment (external):** [Take it on Microsoft Learn ↗](${url})`;
}

/**
 * Markdown for the appended assessment section. Always begins with "\n\n" (appendable to
 * an existing lesson file) and ends with EXACTLY the external link card line — with or
 * without extracted questions. `title` is reserved for future labeling; the output shape
 * is fixed by the P5 contract and does not vary with it.
 */
export function renderAssessmentMarkdown(
  title: string,
  url: string,
  questions: NormalizedQuestion[],
): string {
  void title; // referenced so strict unused-parameter checks stay quiet across configs
  const blocks: string[] = [];
  if (questions.length > 0) {
    blocks.push(`## Practice assessment — extracted questions (${questions.length})`);
    for (let i = 0; i < questions.length; i += 1) {
      const item = questions[i];
      const lines: string[] = [`**${i + 1}. ${item.q}**`];
      if (item.options !== undefined) {
        for (let j = 0; j < item.options.length; j += 1) {
          lines.push(`- ${String.fromCharCode(65 + j)}. ${item.options[j]}`);
        }
      }
      if (item.answer !== undefined && item.answer >= 0) {
        lines.push(`- Answer: ${String.fromCharCode(65 + item.answer)}`);
      }
      blocks.push(lines.join("\n"));
    }
  } else {
    blocks.push("## Practice assessment");
    blocks.push("No machine-readable practice questions were found on this page.");
  }
  blocks.push(assessmentCardLine(url));
  return `\n\n${blocks.join("\n\n")}`;
}

/**
 * Fetch one assessment page through the injected client (one polite GET, 25 s timeout) and
 * extract its embedded questions. Never throws: every failure becomes { ok:false }.
 */
export async function fetchAssessmentQuestions(
  assessmentPageUrl: string,
  http: TextHttpClientLike,
): Promise<AssessmentFetchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), FETCH_TIMEOUT_MS);
  });
  try {
    const settled = await Promise.race([http.get(assessmentPageUrl), timeout]);
    if (settled === "timeout") {
      return { ok: false, error: "assessment fetch timed out after 25s" };
    }
    if (settled.status < 200 || settled.status >= 300) {
      return { ok: false, error: `assessment page returned HTTP ${settled.status}` };
    }
    const questions = extractEmbeddedQuestions(settled.body);
    if (questions.length === 0) {
      return { ok: false, error: "no machine-readable questions found — link card fallback" };
    }
    return { ok: true, questions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `assessment fetch failed (${message})` };
  } finally {
    if (timer !== undefined) clearTimeout(timer); // no dangling timer on any path
  }
}
