// P2 auto-grounding for course chat — vec0 KNN adapter over `vec_course_chunks_*` plus the
// grounded prompt-block builder. Pure SQL/JS, no platform-specific code (macOS + Windows).

import { estimateTokens } from '../llm/modelCapabilities';
import { COURSE_GROUNDED_TOKEN_BUDGET } from '../services/ModeContextRetriever';
import { searchCourses, type CourseEvidence, type SearchCoursesOptions } from './retrieval';

/** Structural view of the embedding pipeline; EmbeddingPipeline satisfies it. */
export interface PipelineLike {
  getEmbeddingForQuery(text: string, opts?: { retryBudgetMs?: number }): Promise<number[]>;
}

interface SqlStatementLike {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

/** Minimal structural db handle — callers pass the shared better-sqlite3 instance. */
export interface CourseSqlDb {
  prepare(sql: string): SqlStatementLike;
}

/** Structural view of CourseStore — only what candidate selection reads. */
export interface CourseStoreLike {
  listCourses(): Array<{ id: string; enabled: boolean; name?: string; sourceUrl?: string; status?: string }>;
}

// vector floor; see plan §auto-grounding
const MIN_VECTOR_SIMILARITY = 0.3;

export function createCourseVectorSearch(
  db: CourseSqlDb,
): {
  search(
    courseIds: readonly string[],
    // Widen to what VectorSearchAdapter hands over (retrieval.ts may pass a
    // Float32Array); both index/length identically, so the body is unchanged.
    embedding: number[] | Float32Array<ArrayBufferLike> | null,
    k?: number,
  ): Promise<Array<{ chunkKey: string; score: number }>>;
} {
  return {
    async search(courseIds, embedding, k) {
      if (!embedding || embedding.length === 0) return [];
      try {
        const dim = embedding.length;
        const table = `vec_course_chunks_${dim}`; // built from a numeric dim only — never user input.
        const exists = db
          .prepare("SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')")
          .get(table);
        if (!exists) return [];

        // LE float32 packing identical to the insert side in embeddings.ts.
        const blob = Buffer.alloc(dim * 4);
        for (let j = 0; j < dim; j++) {
          blob.writeFloatLE(embedding[j], j * 4);
        }
        const topK = typeof k === 'number' && Number.isFinite(k) && k > 0 ? Math.floor(k) : 16;

        // Same vec0 KNN form as VectorStore.searchSimilarNative (MATCH + distance LIMIT).
        const vecRows = db
          .prepare(
            `SELECT chunk_id, distance FROM ${table}
             WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
          )
          .all(blob, topK) as Array<{ chunk_id: number; distance: number }>;
        if (vecRows.length === 0) return [];

        const kept = vecRows.filter((row) => {
          const similarity = 1 - row.distance; // cosine metric on these tables → 1 - d is similarity.
          return similarity >= MIN_VECTOR_SIMILARITY;
        });
        if (kept.length === 0) return [];

        // Lesson-join columns mirror retrieval.ts so chunkKeys match its FTS side byte-for-byte.
        const placeholders = kept.map(() => '?').join(', ');
        const courseFilter = courseIds?.length
          ? ` AND cc.course_id IN (${courseIds.map(() => '?').join(', ')})`
          : '';
        const lessons = db
          .prepare(
            `SELECT cc.id AS id, l.url AS url, cc.ord AS ord
             FROM course_chunks AS cc
             JOIN course_lessons AS l ON l.id = cc.lesson_id
             WHERE cc.id IN (${placeholders})${courseFilter}`,
          )
          .all(...kept.map((row) => row.chunk_id), ...(courseIds ?? [])) as Array<{
            id: number;
            url: string | null;
            ord: number;
          }>;
        const lessonById = new Map(lessons.map((row) => [row.id, row] as const));

        const out: Array<{ chunkKey: string; score: number }> = [];
        for (const hit of kept) {
          const lesson = lessonById.get(hit.chunk_id);
          if (!lesson) continue; // unresolvable vec rows drop — inner-join semantics like retrieval.ts.
          out.push({ chunkKey: `${lesson.url ?? ''}#${lesson.ord}`, score: 1 - hit.distance });
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

/** Use the existing reference-file privacy/scrubbing contract on every chat path. */
export function courseGroundingAsReference(block: string | null): string | null {
  if (!block) return null;
  const escaped = block.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<reference_file source="courses">\n${escaped}\n</reference_file>`;
}

const GROUNDING_HEADER =
  'RELATED COURSE MATERIAL — ground truth for this conversation (prefer these over model memory; cite the Source URLs when answering)';

export async function buildCourseGroundedBlock(opts: {
  message: string;
  pinnedCourseIds?: readonly string[] | null;
  storeLike: CourseStoreLike;
  db: CourseSqlDb;
  pipeline?: PipelineLike | null;
}): Promise<string | null> {
  try {
    const courses = opts.storeLike.listCourses();
    const byId = new Map(courses.map((course) => [course.id, course]));
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const id of [
      ...(opts.pinnedCourseIds ?? []),
      ...courses.filter((course) => course.enabled).map((course) => course.id),
    ]) {
      if (byId.has(id) && !seen.has(id)) {
        seen.add(id);
        candidates.push(id);
      }
    }
    if (candidates.length === 0) return null;

    const embedding = opts.pipeline
      ? await opts.pipeline.getEmbeddingForQuery(opts.message, { retryBudgetMs: 250 }).catch(() => null)
      : null;

    let rows: CourseEvidence[] = [];
    try {
      const searchOptions: SearchCoursesOptions = {
        db: opts.db as SearchCoursesOptions['db'], // structural handle; runtime value is the real Database.
        query: opts.message,
        courseIds: candidates,
        limit: 6,
      };
      if (embedding !== null && embedding.length > 0) {
        searchOptions.vectorSearch = createCourseVectorSearch(opts.db);
        searchOptions.queryEmbedding = embedding;
      }
      rows = await searchCourses(searchOptions);
    } catch {
      // A missing/broken index must not make a pinned course disappear.
    }

    // Reserve identity for each candidate BEFORE excerpts can consume the budget.
    // No lexical/vector hit is not evidence of an empty course. Keep its citation
    // and explicitly name the gap instead of dumping unrelated lesson bodies.
    const withinBudget = (text: string): boolean =>
      estimateTokens(courseGroundingAsReference(text) ?? '') <= COURSE_GROUNDED_TOKEN_BUDGET;
    let acc = GROUNDING_HEADER;
    for (const id of candidates) {
      const course = byId.get(id)!;
      const metadata = [
        `### Course: ${(course.name || id).slice(0, 160)}`,
        ...(course.sourceUrl && course.sourceUrl.length <= 2048
          ? [`Source URL: ${course.sourceUrl}`]
          : course.sourceUrl ? ['Source URL omitted: exceeds context budget.'] : []),
        ...(course.status ? [`Import status: ${course.status.slice(0, 40)}`] : []),
        ...(!rows.some((row) => row.courseId === id)
          ? ['No matching lesson excerpt for this question; do not infer lesson facts from course metadata.']
          : []),
      ].join('\n');
      const next = `${acc}\n\n${metadata}`;
      if (!withinBudget(next)) break;
      acc = next;
    }

    // Prioritize pinned courses while retaining query-ranked excerpts within each course.
    rows.sort((a, b) => candidates.indexOf(a.courseId) - candidates.indexOf(b.courseId));
    // CourseEvidence carries no course title (retrieval.ts), so headings use lesson + path only.
    const sections: Array<{ head: string; bodyLines: string[] }> = rows.map((row) => ({
      head: [
        `### ${row.lessonTitle || 'Lesson'} (${row.headingPath || 'overview'})`,
        ...(row.url ? [`Source URL: ${row.url}`] : []),
      ].join('\n'),
      bodyLines: row.text.split('\n'),
    }));

    // Include whole relevant sections where possible. Fit even a single long line
    // on overflow, reserving the ellipsis inside the same strict token ceiling.
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const fullBody = section.bodyLines.join('\n');
      const candidate = `${acc}\n\n${section.head}\n${fullBody}`;
      if (withinBudget(candidate)) {
        acc = candidate;
        continue;
      }

      const prefix = `${acc}\n\n${section.head}\n`;
      if (!withinBudget(`${prefix}…`)) break;
      let low = 0;
      let high = fullBody.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (withinBudget(`${prefix}${fullBody.slice(0, mid)}…`)) low = mid;
        else high = mid - 1;
      }
      acc = `${prefix}${fullBody.slice(0, low)}…`;
      break;
    }

    return acc === GROUNDING_HEADER ? null : acc;
  } catch (error) {
    console.warn('[courses] grounding skipped', error);
    return null;
  }
}
