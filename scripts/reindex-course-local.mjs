#!/usr/bin/env node
// Offline, one-course maintenance. Run under Electron's Node ABI after build:electron.
import { readFile, lstat, stat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class CliError extends Error {}

function usage() {
  console.log('Usage: node scripts/run-with-env.mjs --set ELECTRON_RUN_AS_NODE=1 -- electron scripts/reindex-course-local.mjs --db <absolute-db-path> --course-id <id> [--query <terms>] [--apply]');
  console.log('Without --apply: read-only preview. With --apply: back up beside the selected DB, then rebuild this course without embeddings.');
  console.log('Requires npm run build:electron and the project\'s Electron-native better-sqlite3. Only counts and ranked hit numbers are printed.');
}

function argsOf(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  const opts = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply' && !opts.apply) {
      opts.apply = true;
    } else if (['--db', '--course-id', '--query'].includes(arg) && !Object.hasOwn(opts, arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new CliError('Invalid or missing argument. Use --help.');
      opts[arg] = value;
    } else {
      throw new CliError('Invalid or duplicate argument. Use --help.');
    }
  }
  if (!opts['--db'] || !opts['--course-id'] || !path.isAbsolute(opts['--db']) ||
      opts['--course-id'].length > 256 || (opts['--query'] && opts['--query'].length > 120)) {
    throw new CliError('Provide an absolute --db path and --course-id (optional --query max 120 characters).');
  }
  return opts;
}

async function validateDbFile(dbPath) {
  try {
    const info = await lstat(dbPath);
    if (!info.isFile()) throw new Error('not a regular file');
  } catch {
    throw new CliError('Selected database is not an existing regular file.');
  }
}

async function preview(db, courseId, chunkLessonMarkdown) {
  if (!db.prepare('SELECT 1 FROM courses WHERE id = ?').get(courseId)) {
    throw new CliError('Selected course does not exist.');
  }
  const lessons = db.prepare('SELECT local_md_path FROM course_lessons WHERE course_id = ?').all(courseId);
  if (lessons.length === 0) throw new CliError('Selected course has no lessons.');
  let expected = 0;
  for (const { local_md_path: localPath } of lessons) {
    if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
      throw new CliError('A selected lesson has no absolute local markdown file.');
    }
    try {
      if (!(await stat(localPath)).isFile()) throw new Error('not a regular file');
      expected += chunkLessonMarkdown(await readFile(localPath, 'utf8')).length;
    } catch {
      throw new CliError('A selected lesson file cannot be read or chunked.');
    }
  }
  if (expected === 0) throw new CliError('Selected lesson files yielded no indexable chunks.');
  const chunks = Number(db.prepare('SELECT COUNT(*) AS n FROM course_chunks WHERE course_id = ?').get(courseId).n);
  const fts = Number(db.prepare(
    'SELECT COUNT(*) AS n FROM course_chunks_fts f JOIN course_chunks c ON c.id = f.rowid WHERE c.course_id = ?',
  ).get(courseId).n);
  return { lessons: lessons.length, expected, chunks, fts };
}

function show(label, counts) {
  console.log(`${label}: lessons=${counts.lessons} expected_chunks=${counts.expected} chunks=${counts.chunks} fts=${counts.fts}`);
}

async function backup(db, dbPath) {
  // Reserve a unique sibling without overwriting any existing backup. SQLite's
  // online backup API includes committed WAL pages (copying the .db file does not).
  const backupPath = `${dbPath}.course-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.db`;
  const reservation = await open(backupPath, 'wx', 0o600);
  await reservation.close();
  try {
    await db.backup(backupPath);
  } catch {
    await unlink(backupPath).catch(() => {});
    throw new CliError('Online SQLite backup failed; no indexing was attempted.');
  }
  return backupPath;
}

async function main() {
  const opts = argsOf(process.argv.slice(2));
  if (!opts) return usage();
  const dbPath = opts['--db'];
  const courseId = opts['--course-id'];
  await validateDbFile(dbPath);

  // Import only pure course modules, not DatabaseManager (which opens/migrates
  // the app's default DB). The compiled modules are the app's actual indexer.
  const coursesDir = path.join(root, 'dist-electron', 'electron', 'courses');
  const [{ default: Database }, { indexCourseForRetrieval }, { chunkLessonMarkdown }] = await Promise.all([
    import('better-sqlite3'),
    import(pathToFileURL(path.join(coursesDir, 'embeddings.js')).href),
    import(pathToFileURL(path.join(coursesDir, 'chunking.js')).href),
  ]);
  let db;
  try {
    db = new Database(dbPath, { readonly: !opts.apply, fileMustExist: true });
    db.defaultSafeIntegers(true);
    // sqlite-vec must register vec0 before the indexer probes/invalidate existing
    // dimension tables. On databases without vectors no native extension is needed.
    const vecTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name GLOB 'vec_course_chunks_[0-9]*'").get().n;
    if (vecTables > 0n) {
      const sqliteVec = await import('sqlite-vec');
      const extension = sqliteVec.getLoadablePath().replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
      db.loadExtension(extension);
    }
    if (!opts.apply) db.pragma('query_only = ON');
    const before = await preview(db, courseId, chunkLessonMarkdown);
    show('preview', before);
    if (!opts.apply) {
      if (opts['--query']) await showHits(db, courseId, opts['--query']);
      return;
    }

    // No inserts or updates before a completed, adjacent online backup.
    await backup(db, dbPath);
    console.log('backup: created (adjacent SQLite snapshot)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await indexCourseForRetrieval({ db, courseId }); // NO embedder/network
      if (result.error) throw new CliError('Indexer reported unreadable or unindexable lesson files.');
      const after = await preview(db, courseId, chunkLessonMarkdown);
      if (after.chunks < after.expected || after.fts !== after.chunks) {
        throw new CliError('Course index/FTS counts failed validation; changes were rolled back.');
      }
      db.exec('COMMIT');
      show('indexed', { ...after, updated: result.indexed, skipped: result.skipped });
      console.log(`result: updated=${result.indexed} skipped=${result.skipped}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (opts['--query']) await showHits(db, courseId, opts['--query']);
  } finally {
    db?.close();
  }
}

async function showHits(db, courseId, query) {
  const { searchCourses } = await import(pathToFileURL(path.join(root, 'dist-electron', 'electron', 'courses', 'retrieval.js')).href);
  const hits = await searchCourses({ db, courseIds: [courseId], query, limit: 3 });
  // Never print the query, URLs, titles, headings, chunk IDs or evidence text.
  console.log(`search: hits=${hits.length} (max=3)`);
  for (const [i, hit] of hits.entries()) console.log(`hit: rank=${i + 1} score=${hit.score.toFixed(3)}`);
}

main().catch((error) => {
  // Native/SQLite errors may embed absolute paths or SQL values. Never print them.
  console.error(error instanceof CliError ? error.message : 'Local reindex failed (details suppressed to protect private data).');
  process.exitCode = 1;
});
