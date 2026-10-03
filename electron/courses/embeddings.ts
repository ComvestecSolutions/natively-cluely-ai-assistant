// Course retrieval indexing — P2 (retrieval): chunk lesson markdown into course_chunks + FTS5,
// store one vec0 table per embedding dimension. Uses the vec_course_chunks_* namespace
// deliberately (NOT vec_chunks_, which belongs to RAG's id space and would collide).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chunkLessonMarkdown, type CourseChunk } from './chunking';

// Structural handle so this module stays decoupled from a specific driver import.
type DbRow = Record<string, unknown>;
interface DbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): DbRow | undefined;
  all(...params: unknown[]): DbRow[];
}
export interface SqliteDatabaseLike {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CourseEmbedder {
  getEmbeddingWithFallback(
    text: string,
  ): Promise<{
    embedding: number[];
    space?: string;
    provider?: string;
    dimensions?: number;
  }>;
}

// Index (or re-index) one course's lessons for retrieval.
// Idempotent per chunk via sha1(text): unchanged chunks are skipped entirely — we trust that a
// matching content_hash implies its vector already exists, so no per-chunk vector probe is done.
export async function indexCourseForRetrieval(opts: {
  db: SqliteDatabaseLike;
  courseId: string;
  embedder?: CourseEmbedder;
}): Promise<{ indexed: number; skipped: number; error?: string }> {
  const { db, courseId } = opts;
  // Keep it simple: a real index run needs embeddings. (Caller may still pass one later.)
  if (!opts.embedder) throw new Error('embedder required');
  const embedder = opts.embedder;

  const lessons: DbRow[] = db.prepare(
    'SELECT id, title, url, order_no, local_md_path FROM course_lessons WHERE course_id = ?',
  ).all(courseId);

  const getChunk = db.prepare(
    'SELECT id, content_hash FROM course_chunks WHERE lesson_id = ? AND ord = ?',
  );
  const insChunk = db.prepare(
    'INSERT INTO course_chunks (course_id, lesson_id, ord, heading_path, text, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const updChunk = db.prepare(
    'UPDATE course_chunks SET text = ?, heading_path = ?, content_hash = ? WHERE id = ?',
  );
  const delFts = db.prepare('DELETE FROM course_chunks_fts WHERE rowid = ?');
  const insFts = db.prepare(
    'INSERT INTO course_chunks_fts (rowid, course_id, lesson_id, heading_path, text) VALUES (?, ?, ?, ?, ?)',
  );

  // One vec0 table per dimension, created lazily. `dim` comes from embedding.length, never SQL input.
  const vecTables = new Map<number, DbStatement>();
  const vectorInsertFor = (dim: number): DbStatement => {
    let stmt = vecTables.get(dim);
    if (!stmt) {
      if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension: ${String(dim)}`);
      const table = `vec_course_chunks_${dim}`;
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
      );
      stmt = db.prepare(`INSERT OR REPLACE INTO ${table}(chunk_id, embedding) VALUES (?, ?)`);
      vecTables.set(dim, stmt);
    }
    return stmt;
  };

  let indexed = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const lesson of lessons) {
    const lessonKey = String(lesson.id);

    let md: string;
    try {
      md = await readFile(String(lesson.local_md_path), 'utf8');
    } catch (err) {
      problems.push(`lesson ${lessonKey}: could not read local_md_path (${errMsg(err)})`);
      continue;
    }

    let chunks: CourseChunk[];
    try {
      chunks = chunkLessonMarkdown(md);
    } catch (err) {
      problems.push(`lesson ${lessonKey}: failed to chunk markdown (${errMsg(err)})`);
      continue;
    }

    for (let ord = 0; ord < chunks.length; ord++) {
      const ch = chunks[ord];
      const hash = sha1(ch.text);
      const existing = getChunk.get(lessonKey, ord) as DbRow | undefined;

      // Unchanged content → trust that its vector + FTS row already exist. Skip the rest.
      if (existing && String(existing.content_hash ?? null) === hash) {
        skipped++;
        continue;
      }

      let rowId: number;
      if (!existing || existing.id == null) {
        const res = insChunk.run(courseId, lessonKey, ord, ch.headingPath ?? null, ch.text, hash);
        rowId = Number(res.lastInsertRowid);
      } else {
        updChunk.run(ch.text, ch.headingPath ?? null, hash, existing.id);
        rowId = Number(existing.id);
      }

      // Keep the standalone FTS table in lockstep (rowid == course_chunks.id).
      delFts.run(rowId);
      insFts.run(rowId, courseId, lessonKey, ch.headingPath ?? null, ch.text);

      const e = await embedder.getEmbeddingWithFallback(ch.text);
      if (!Array.isArray(e.embedding)) throw new Error('embedder returned no embedding vector');
      const dim = e.embedding.length;
      const insert = vectorInsertFor(dim);
      const blob = Buffer.alloc(dim * 4);
      for (let j = 0; j < dim; j++) {
        // little-endian float32, matching the vec0 `float` column layout.
        blob.writeFloatLE(e.embedding[j], j * 4);
      }
      insert.run(rowId, blob);

      indexed++;
    }
  }

  return problems.length > 0 ? { indexed, skipped, error: problems.join('; ') } : { indexed, skipped };
}
