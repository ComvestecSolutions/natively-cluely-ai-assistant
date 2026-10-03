// Courses Studio — P2 evidence retrieval over ingested course chunks.
// FTS5 MATCH with bm25 ranking on `course_chunks_fts` is the primary path; a
// LIKE '%term%' scan over `course_chunks` is the fallback when SQL errors.
// Optional dense-adapter hits (caller-built query embedding) are fused in via
// Reciprocal Rank Fusion (k = 60); when no vector side contributes, FTS-only
// scores are min-max normalized into (0,1]. The module never throws from
// search: every side degrades gracefully to whatever still succeeded.
// Pure SQL/JS — no platform-specific code, identical on macOS and Windows.
//
// FTS sync convention for the P2 ingest caller inserting into `course_chunks_fts`:
// rows must carry an explicit rowid equal to the corresponding `course_chunks.id`
// (INSERT INTO course_chunks_fts(rowid, ...) VALUES (<chunkId>, ...)) — that is
// what makes the join fts.rowid = cc.id a 1:1 unambiguous mapping.

import BetterSqlite3 from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export interface CourseEvidence {
  courseId: string;
  /** Chunk key following the `${lessonUrl}#${ord}` convention shared with vector adapters. */
  chunkId?: string;
  lessonTitle?: string;
  headingPath: string;
  /** Lesson URL the evidence text belongs to. */
  url?: string;
  text: string;
  /** RRF-normalized rank score in (0,1]; higher is better. */
  score: number;
}

export interface VectorHit {
  /** Chunk key following the `${lessonUrl}#${ord}` convention. */
  chunkKey: string;
  score: number;
}

/** Dense-search adapter; `search` receives an already-built embedding (this module never embeds). */
export interface VectorSearchAdapter {
  search(
    courseIds: string[],
    queryEmbedding: number[] | Float32Array,
    k: number,
  ): Promise<VectorHit[]>;
}

export interface SearchCoursesOptions {
  /** Raw better-sqlite3 handle — the same Database instance passed to `new CourseStore(db)`. */
  db: SqliteDatabase;
  query: string;
  /** Restrict results to these courses; empty/undefined means all. */
  courseIds?: string[];
  /** Max evidence rows (default 8). */
  limit?: number;
  /** Optional dense adapter; used only when `queryEmbedding` is also provided. */
  vectorSearch?: VectorSearchAdapter;
  /** Caller-precomputed query embedding (embedding lives outside this module). */
  queryEmbedding?: number[] | Float32Array;
}

/** Reciprocal Rank Fusion constant: per-list contribution = 1 / (RRF_K + rank), rank 1-based. */
const RRF_K = 60;
export const DEFAULT_LIMIT = 8;

interface RankedHit {
  chunkKey: string;
  courseId: string;
  lessonTitle?: string;
  headingPath: string;
  url?: string;
  text: string;
}

/** Deterministic chunk key: lesson URL + per-lesson ordinal (`course_chunks.ord`). */
export function makeChunkKey(lessonUrl: string, ord: number): string {
  return `${lessonUrl}#${ord}`;
}

function queryTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
}

/**
 * Strip FTS5 metacharacters and turn surviving terms into a safe MATCH expression:
 * each term double-quoted on its own; FTS5 ANDs adjacent quoted phrases.
 * Returns '' when nothing survives, in which case callers skip the FTS path
 * entirely (MATCH '' would error).
 */
export function sanitizeFtsQuery(query: string): string {
  return queryTerms(query)
    .map((term) => `"${term}"`)
    .join(' ');
}

interface ChunkRow {
  course_id: string;
  lesson_title: string | null;
  lesson_url: string | null;
  heading_path: string;
  ord: number;
  text: string;
}

function toHit(row: ChunkRow): RankedHit {
  return {
    chunkKey: makeChunkKey(row.lesson_url ?? '', row.ord),
    courseId: row.course_id,
    lessonTitle: row.lesson_title ?? undefined,
    headingPath: row.heading_path,
    url: row.lesson_url ?? undefined,
    text: row.text,
  };
}

function runFtsSearch(
  db: SqliteDatabase,
  matchExpr: string,
  courseIds: string[] | undefined,
  fetchLimit: number,
): RankedHit[] {
  const filterSql = courseIds?.length
    ? ` AND course_id IN (${courseIds.map(() => '?').join(', ')})`
    : '';
  // Single-table FTS5 statement on purpose: joining this virtual table with the
  // real tables makes column/bm25 name resolution ambiguous ("text") in SQLite.
  // Table-level MATCH (only `text` is indexed) — per-column query forms like
  // tbl(col) are not valid FTS5 SQL and would force the LIKE fallback below.
  const ranked = db.prepare(
    `SELECT rowid AS rid, course_id AS cid, lesson_id AS lid
       FROM course_chunks_fts WHERE course_chunks_fts MATCH ?${filterSql}
      ORDER BY bm25(course_chunks_fts) ASC, rowid ASC LIMIT ?`,
  ).all(matchExpr, ...(courseIds ?? []), fetchLimit) as { rid: number; cid: string; lid: string }[];
  if (ranked.length === 0) return [];
  const ph = ranked.map(() => '?').join(', ');
  const chunks = db
    .prepare(`SELECT id, ord, heading_path, text FROM course_chunks WHERE id IN (${ph})`)
    .all(...ranked.map((r) => r.rid)) as { id: number; ord: number; heading_path: string | null; text: string }[];
  const lessons = db
    .prepare(`SELECT id, title, url FROM course_lessons WHERE id IN (${ph})`)
    .all(...ranked.map((r) => r.lid)) as { id: string; title: string; url: string }[];
  const chunkById = new Map(chunks.map((c) => [c.id, c] as const));
  const lessonById = new Map(lessons.map((ls) => [ls.id, ls] as const));
  // Inner-join semantics preserved: FTS rows without a live chunk/lesson drop.
  const out: RankedHit[] = [];
  for (const { rid, cid, lid } of ranked) {
    const c = chunkById.get(rid);
    const ls = lessonById.get(lid);
    if (!c || !ls) continue;
    out.push(
      toHit({ id: rid, course_id: cid, lesson_title: ls.title, lesson_url: ls.url, heading_path: c.heading_path ?? '', ord: c.ord, text: c.text } as ChunkRow),
    );
  }
  return out;
}

function likeSearch(
  db: SqliteDatabase,
  terms: string[],
  courseIds: string[] | undefined,
  fetchLimit: number,
): RankedHit[] {
  if (terms.length === 0) return [];
  const filterSql = courseIds?.length
    ? ` AND l.course_id IN (${courseIds.map(() => '?').join(', ')})`
    : '';
  const termPredicates = terms.map(() => 'lower(cc.text) LIKE ?').join(' OR ');
  const sql = `SELECT cc.id AS id, cc.course_id AS course_id, l.title AS lesson_title,
                      l.url AS lesson_url, COALESCE(cc.heading_path, '') AS heading_path,
                      cc.ord AS ord, cc.text AS text
               FROM course_chunks AS cc
               JOIN course_lessons AS l ON l.id = cc.lesson_id
               WHERE (${termPredicates})${filterSql}
               ORDER BY cc.id ASC LIMIT ?`;
  const params: unknown[] = [
    ...terms.map((t) => `%${t.toLowerCase()}%`),
    ...(courseIds ?? []),
    fetchLimit,
  ];
  // No ranking signal in a LIKE scan: rank by term-hit density, original row
  // order as deterministic tiebreak.
  const rows = db.prepare(sql).all(...params) as ChunkRow[];
  return rows
    .map((row, index) => {
      const lower = row.text.toLowerCase();
      const hits = terms.reduce(
        (n, t) => n + (lower.includes(t.toLowerCase()) ? 1 : 0),
        0,
      );
      return { hit: toHit(row), density: hits, index };
    })
    .sort((a, b) => b.density - a.density || a.index - b.index)
    .map((entry) => entry.hit);
}

function parseChunkKey(chunkKey: string): { url: string; ord: number } | null {
  const idx = chunkKey.lastIndexOf('#');
  if (idx <= 0) return null;
  const ord = Number(chunkKey.slice(idx + 1));
  if (!Number.isInteger(ord) || ord < 0) return null;
  return { url: chunkKey.slice(0, idx), ord };
}

function mapVectorHits(
  db: SqliteDatabase,
  rawHits: VectorHit[],
  courseIds: string[] | undefined,
): RankedHit[] {
  const filterSql = courseIds?.length
    ? ` AND l.course_id IN (${courseIds.map(() => '?').join(', ')})`
    : '';
  const stmt = db.prepare(
    `SELECT cc.id AS id, cc.course_id AS course_id, l.title AS lesson_title,
            l.url AS lesson_url, COALESCE(cc.heading_path, '') AS heading_path,
            cc.ord AS ord, cc.text AS text
     FROM course_chunks AS cc
     JOIN course_lessons AS l ON l.id = cc.lesson_id
     WHERE l.url = ? AND cc.ord = ?${filterSql}
     LIMIT 1`,
  );
  // Resolvable hits keep adapter order; their resulting positions are the
  // vector-side ranks used by fusion.
  const out: RankedHit[] = [];
  for (const raw of rawHits) {
    const parsed = parseChunkKey(raw?.chunkKey ?? '');
    if (!parsed) continue;
    const row = stmt.get(parsed.url, parsed.ord, ...(courseIds ?? [])) as
      | ChunkRow
      | undefined;
    if (row) out.push(toHit(row));
  }
  return out;
}

function evidenceFromHit(hit: RankedHit): Omit<CourseEvidence, 'score'> {
  return {
    courseId: hit.courseId,
    chunkId: hit.chunkKey,
    lessonTitle: hit.lessonTitle,
    headingPath: hit.headingPath,
    url: hit.url,
    text: hit.text,
  };
}

/** No vector side contributed: min-max normalize the FTS ranking into (0,1]. */
function ftsOnlyEvidence(hits: RankedHit[], limit: number): CourseEvidence[] {
  const total = hits.length;
  // Rank fraction over the full ranked set maps best -> 1 while keeping every
  // surviving hit strictly positive.
  return hits
    .slice(0, limit)
    .map((hit, i) => ({ ...evidenceFromHit(hit), score: (total - i) / total }));
}

function fuseAndCap(ftsHits: RankedHit[], vecHits: RankedHit[], limit: number): CourseEvidence[] {
  const byKey = new Map<
    string,
    { hit: RankedHit; ftsRank: number | null; vecRank: number | null }
  >();
  const upsert = (hit: RankedHit) => {
    let entry = byKey.get(hit.chunkKey);
    if (!entry) {
      entry = { hit, ftsRank: null, vecRank: null };
      byKey.set(hit.chunkKey, entry);
    }
    return entry;
  };
  ftsHits.forEach((hit, i) => {
    upsert(hit).ftsRank = i + 1;
  });
  vecHits.forEach((hit, i) => {
    upsert(hit).vecRank = i + 1;
  });

  const results: CourseEvidence[] = [];
  for (const [chunkId, entry] of byKey.entries()) {
    const ranks: number[] = [];
    if (entry.ftsRank !== null) ranks.push(entry.ftsRank);
    if (entry.vecRank !== null) ranks.push(entry.vecRank);
    if (ranks.length === 0) continue;
    const { hit } = entry;
    results.push({ ...evidenceFromHit(hit), score: ranks.reduce((sum, r) => sum + 1 / (RRF_K + r), 0) });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      ((a.chunkId ?? '') < (b.chunkId ?? '') ? -1 : (a.chunkId ?? '') > (b.chunkId ?? '') ? 1 : 0),
  );
  return results.slice(0, limit);
}

export async function searchCourses(opts: SearchCoursesOptions): Promise<CourseEvidence[]> {
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : DEFAULT_LIMIT;
  const courseIds = opts.courseIds?.length ? opts.courseIds : undefined;

  // Text side: FTS first, LIKE fallback on SQL error. Never throws out.
  let ftsHits: RankedHit[] = [];
  try {
    const terms = queryTerms(opts.query);
    if (terms.length > 0) {
      try {
        ftsHits = runFtsSearch(opts.db, sanitizeFtsQuery(opts.query), courseIds, Math.min(64, limit * 4));
      } catch {
        // FTS index missing or unusable: degrade to a substring scan.
        try {
          ftsHits = likeSearch(opts.db, terms, courseIds, Math.min(200, Math.max(limit * 8, 64)));
        } catch {
          ftsHits = [];
        }
      }
    }
  } catch {
    ftsHits = [];
  }

  // Vector side: only with both an adapter and a caller-built embedding.
  let vecHits: RankedHit[] = [];
  const adapter = opts.vectorSearch;
  const embedding = opts.queryEmbedding;
  if (adapter && embedding) {
    try {
      const raw = await adapter.search(courseIds ?? [], embedding, Math.min(64, Math.max(limit * 3, 16)));
      vecHits = mapVectorHits(opts.db, raw, courseIds);
    } catch {
      // Vector-side failure: keep whatever the text side produced.
      vecHits = [];
    }
  }

  // Vector side contributed -> RRF fusion; otherwise FTS-only scores,
  // min-max normalized into (0,1].
  if (vecHits.length > 0) return fuseAndCap(ftsHits, vecHits, limit);
  return ftsOnlyEvidence(ftsHits, limit);
}
