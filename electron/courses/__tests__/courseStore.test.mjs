import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.resolve(__dirname, '../../../dist-electron/electron/courses/courseStore.js');
const { COURSES_SCHEMA_SQL, CourseStore } = await import(pathToFileURL(storePath).href);

describe('CourseStore (P0 batch 1)', () => {
    let db;
    let store;

    beforeEach(() => {
        db = new Database(':memory:');
        db.exec(COURSES_SCHEMA_SQL);
        store = new CourseStore(db);
    });

    afterEach(() => {
        db.close();
    });

    it('round-trips upsert, list and get with schema defaults', () => {
        const created = store.upsertCourse({ id: 'c1', name: 'SQL Crash Course', sourceUrl: 'https://example.com/sql' });

        assert.equal(created.enabled, true);
        assert.equal(created.profile, 'generic');
        assert.equal(created.status, 'importing');
        assert.deepEqual(created.stats, {});
        assert.ok(Date.parse(created.createdAt) > 0);

        const listed = store.listCourses();
        assert.equal(listed.length, 1);
        assert.deepEqual(listed[0], {
            id: 'c1',
            name: 'SQL Crash Course',
            profile: 'generic',
            sourceUrl: 'https://example.com/sql',
            status: 'importing',
            enabled: true,
            stats: {},
            updatedAt: created.updatedAt,
        });

        const fetched = store.getCourse('c1');
        assert.ok(fetched);
        assert.deepEqual(fetched.stats, {});

        // Conflict on source_url updates in place and preserves created_at.
        const updated = store.upsertCourse({
            id: 'c1',
            name: 'SQL Pro',
            sourceUrl: 'https://example.com/sql',
            status: 'ready',
            stats: { lessons: 3 },
        });
        assert.equal(store.listCourses().length, 1);
        assert.equal(updated.name, 'SQL Pro');
        assert.equal(updated.status, 'ready');
        assert.deepEqual(updated.stats, { lessons: 3 });
        assert.equal(updated.createdAt, created.createdAt);

        store.setCourseEnabled('c1', false);
        assert.equal(store.getCourse('c1').enabled, false);
    });

    it('addLessons upserts on url conflict keeping one row per url', () => {
        store.upsertCourse({ id: 'c1', name: 'C', sourceUrl: 'https://example.com/c' });
        store.addLessons('c1', [
            { id: 'l1', title: 'Intro', url: 'https://site/a', orderNo: 0 },
            { id: 'l2', title: 'Joins', url: 'https://site/b', orderNo: 1 },
        ]);

        // Re-adding url /a under a different row id must not duplicate it.
        store.addLessons('c1', [{ id: 'l1b', title: 'Intro (revised)', url: 'https://site/a', orderNo: 5 }]);

        const lessons = store.listLessons('c1');
        assert.equal(lessons.length, 2);
        // /b (order_no 1) now sorts before the updated /a (order_no 5).
        assert.deepEqual(
            lessons.map((l) => l.url),
            ['https://site/b', 'https://site/a']
        );
        const a = lessons.find((l) => l.url === 'https://site/a');
        assert.equal(a.title, 'Intro (revised)');
        assert.equal(a.orderNo, 5);
    });

    it('markLessonsCompleted toggles completed_at', () => {
        store.upsertCourse({ id: 'c1', name: 'C', sourceUrl: 'https://example.com/c' });
        store.addLessons('c1', [{ id: 'l1', title: 'Intro', url: 'https://site/a' }]);

        const before = store.listLessons('c1')[0];
        assert.equal(before.completedAt, null);

        store.markLessonsCompleted(['l1'], true);
        const marked = store.listLessons('c1')[0];
        assert.equal(typeof marked.completedAt, 'string');
        assert.ok(Date.parse(marked.completedAt) > 0);

        store.markLessonsCompleted(['l1'], false);
        const cleared = store.listLessons('c1')[0];
        assert.equal(cleared.completedAt, null);
    });

    it('countCourseStats counts lessons and chunks', () => {
        store.upsertCourse({ id: 'c1', name: 'C', sourceUrl: 'https://example.com/c' });
        store.addLessons('c1', [
            { id: 'l1', title: 'A', url: 'https://site/a' },
            { id: 'l2', title: 'B', url: 'https://site/b' },
        ]);
        const insertChunk = db.prepare('INSERT INTO course_chunks (course_id, lesson_id, text) VALUES (?, ?, ?)');
        insertChunk.run('c1', 'l1', 'chunk one');
        insertChunk.run('c1', 'l2', 'chunk two');

        assert.deepEqual(store.countCourseStats('c1'), { lessons: 2, chunks: 2 });
        assert.deepEqual(store.countCourseStats('missing'), { lessons: 0, chunks: 0 });
    });

    it('deleteCourseCascade removes course, lessons, chunks and FTS rows', () => {
        store.upsertCourse({ id: 'c1', name: 'C', sourceUrl: 'https://example.com/c' });
        store.addLessons('c1', [{ id: 'l1', title: 'A', url: 'https://site/a' }]);
        db.prepare('INSERT INTO course_chunks (course_id, lesson_id, text) VALUES (?, ?, ?)').run('c1', 'l1', 'chunk');
        db.prepare("INSERT INTO course_chunks_fts (course_id, lesson_id, heading_path, text) VALUES ('c1', 'l1', 'H1', 'full-text chunk')").run();

        const ftsBefore = db.prepare('SELECT COUNT(*) AS count FROM course_chunks_fts WHERE course_id = ?').get('c1');
        assert.equal(ftsBefore.count, 1);

        store.deleteCourseCascade('c1');

        assert.equal(store.getCourse('c1'), undefined);
        assert.deepEqual(store.listLessons('c1'), []);
        const chunksAfter = db.prepare('SELECT COUNT(*) AS count FROM course_chunks WHERE course_id = ?').get('c1');
        assert.equal(chunksAfter.count, 0);
        const ftsAfter = db.prepare('SELECT COUNT(*) AS count FROM course_chunks_fts WHERE course_id = ?').get('c1');
        assert.equal(ftsAfter.count, 0);
    });
});
