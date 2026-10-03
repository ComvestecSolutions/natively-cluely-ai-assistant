// Courses Studio persistence (P0 batch 1, COURSES_FEATURE_PLAN §7).
// Pure SQL logic over a caller-provided better-sqlite3 handle so this module
// stays unit-testable against an in-memory database and cross-platform safe.

import BetterSqlite3 from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

/** DDL for the Courses Studio tables; executed once by DatabaseManager v32. */
export const COURSES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL DEFAULT 'generic',
  exam_codes TEXT,
  status TEXT NOT NULL DEFAULT 'importing',
  enabled INTEGER NOT NULL DEFAULT 1,
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_courses_source_url ON courses(source_url);

CREATE TABLE IF NOT EXISTS course_lessons (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'lesson',
  parent TEXT,
  order_no INTEGER NOT NULL DEFAULT 0,
  toc_path TEXT,
  local_md_path TEXT,
  content_hash TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_course_lessons ON course_lessons(course_id, order_no);

CREATE TABLE IF NOT EXISTS course_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  heading_path TEXT,
  kind TEXT,
  text TEXT NOT NULL,
  content_hash TEXT
);

-- Standalone FTS5 index; rows are synced by the caller (P2 adds inserts).
CREATE VIRTUAL TABLE IF NOT EXISTS course_chunks_fts USING fts5(
  course_id UNINDEXED,
  lesson_id UNINDEXED,
  heading_path UNINDEXED,
  text
);
`;

export interface CourseSummary {
  id: string;
  name: string;
  profile: string;
  sourceUrl: string;
  status: string;
  enabled: boolean;
  stats: Record<string, unknown>;
  updatedAt: string;
  // Attached per row by the courses:list IPC layer via countCourseStats(); store-internal
  // producers (toSummary/toCourse) predate it and may omit both.
  lessonCount?: number;
  chunkCount?: number;
}

export interface Course extends CourseSummary {
  examCodes: string | null;
  createdAt: string;
}

/** Caller-chosen id lets upserts be deterministic; conflicts key on source_url. */
export interface CourseInput {
  id: string;
  name: string;
  sourceUrl: string;
  profile?: string | null;
  examCodes?: string | null;
  status?: string | null;
  enabled?: boolean | number | null;
  stats?: Record<string, unknown> | null;
}

export interface CourseLesson {
  id: string;
  courseId: string;
  title: string;
  url: string;
  kind: string;
  parent: string | null;
  orderNo: number;
  tocPath: string | null;
  localMdPath: string | null;
  contentHash: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface LessonInput {
  id: string;
  title: string;
  url: string;
  kind?: string | null;
  parent?: string | null;
  orderNo?: number | null;
  tocPath?: string | null;
  localMdPath?: string | null;
}

interface CourseRow {
  id: string;
  name: string;
  source_url: string;
  profile: string;
  exam_codes: string | null;
  status: string;
  enabled: number;
  stats_json: string;
  created_at: string;
  updated_at: string;
}

interface LessonRow {
  id: string;
  course_id: string;
  title: string;
  url: string;
  kind: string;
  parent: string | null;
  order_no: number;
  toc_path: string | null;
  local_md_path: string | null;
  content_hash: string | null;
  completed_at: string | null;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toEnabledBit(value?: boolean | number | null): number {
  if (value === undefined || value === null) return 1;
  return value ? 1 : 0;
}

function parseStats(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt stats_json degrades to empty rather than failing reads.
  }
  return {};
}

function toSummary(row: CourseRow): CourseSummary {
  return {
    id: row.id,
    name: row.name,
    profile: row.profile,
    sourceUrl: row.source_url,
    status: row.status,
    enabled: row.enabled === 1,
    stats: parseStats(row.stats_json),
    updatedAt: row.updated_at,
  };
}

function toCourse(row: CourseRow): Course {
  return {
    ...toSummary(row),
    examCodes: row.exam_codes ?? null,
    createdAt: row.created_at,
  };
}

function toLesson(row: LessonRow): CourseLesson {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    url: row.url,
    kind: row.kind,
    parent: row.parent ?? null,
    orderNo: row.order_no,
    tocPath: row.toc_path ?? null,
    localMdPath: row.local_md_path ?? null,
    contentHash: row.content_hash ?? null,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at,
  };
}

export class CourseStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  listCourses(): CourseSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM courses ORDER BY updated_at DESC, id ASC')
      .all() as CourseRow[];
    return rows.map(toSummary);
  }

  getCourse(id: string): Course | undefined {
    const row = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as
      | CourseRow
      | undefined;
    return row ? toCourse(row) : undefined;
  }

  upsertCourse(input: CourseInput): Course {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO courses (id, name, source_url, profile, exam_codes, status, enabled, stats_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_url) DO UPDATE SET
           name = excluded.name,
           profile = excluded.profile,
           exam_codes = excluded.exam_codes,
           status = excluded.status,
           enabled = excluded.enabled,
           stats_json = excluded.stats_json,
           updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.name,
        input.sourceUrl,
        input.profile ?? 'generic',
        input.examCodes ?? null,
        input.status ?? 'importing',
        toEnabledBit(input.enabled),
        JSON.stringify(input.stats ?? {}),
        now,
        now
      );

    const row = this.db
      .prepare('SELECT * FROM courses WHERE source_url = ?')
      .get(input.sourceUrl) as CourseRow | undefined;
    if (!row) {
      throw new Error(`Course not found after upsert: ${input.sourceUrl}`);
    }
    return toCourse(row);
  }

  setCourseEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE courses SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowIso(), id);
  }

  addLessons(courseId: string, lessons: LessonInput[]): void {
    if (lessons.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO course_lessons (id, course_id, title, url, kind, parent, order_no, toc_path, local_md_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = excluded.title,
         kind = excluded.kind,
         order_no = excluded.order_no,
         toc_path = excluded.toc_path,
         local_md_path = COALESCE(excluded.local_md_path, course_lessons.local_md_path),
         updated_at = excluded.updated_at`
    );
    const applyAll = this.db.transaction((items: LessonInput[]) => {
      for (const lesson of items) {
        insert.run(
          lesson.id,
          courseId,
          lesson.title,
          lesson.url,
          lesson.kind ?? 'lesson',
          lesson.parent ?? null,
          lesson.orderNo ?? 0,
          lesson.tocPath ?? null,
          lesson.localMdPath ?? null,
          nowIso()
        );
      }
    });
    applyAll(lessons);
  }

  listLessons(courseId: string): CourseLesson[] {
    const rows = this.db
      .prepare('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY order_no ASC, id ASC')
      .all(courseId) as LessonRow[];
    return rows.map(toLesson);
  }

  markLessonsCompleted(ids: string[], done: boolean): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE course_lessons SET completed_at = ? WHERE id IN (${placeholders})`)
      .run(done ? nowIso() : null, ...ids);
  }

  countCourseStats(courseId: string): { lessons: number; chunks: number } {
    const lessonRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM course_lessons WHERE course_id = ?')
      .get(courseId) as { count: number };
    const chunkRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM course_chunks WHERE course_id = ?')
      .get(courseId) as { count: number };
    return { lessons: lessonRow.count, chunks: chunkRow.count };
  }

  deleteCourseCascade(id: string): void {
    const runAll = this.db.transaction(() => {
      this.db.prepare('DELETE FROM course_chunks_fts WHERE course_id = ?').run(id);
      this.db.prepare('DELETE FROM course_chunks WHERE course_id = ?').run(id);
      this.db.prepare('DELETE FROM course_lessons WHERE course_id = ?').run(id);
      this.db.prepare('DELETE FROM courses WHERE id = ?').run(id);
    });
    runAll();
  }
}
