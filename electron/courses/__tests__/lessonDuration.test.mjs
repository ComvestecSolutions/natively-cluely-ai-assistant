import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/courses');
const { getLessonDuration } = await import(pathToFileURL(path.join(distRoot, 'lessonDuration.js')).href);

const unit = (fields, body = '# Introduction\nHello, learner.') => [
  '---',
  'title: "Introduction"',
  'kind: lesson',
  'url: https://learn.microsoft.com/en-us/training/modules/azure-basics/1-introduction',
  ...fields,
  '---',
  body,
].join('\n');

test('reads explicitly scoped Markdown front matter and unit callouts', () => {
  assert.deepEqual(getLessonDuration(unit(['lessonDurationMinutes: 7'])), { minutes: 7, source: 'provided' });
  assert.deepEqual(getLessonDuration(unit(['duration: "5 min"'])), { minutes: 5, source: 'provided' });
  assert.deepEqual(getLessonDuration(unit([], '**Unit duration:** 4 minutes')), { minutes: 4, source: 'provided' });
  assert.deepEqual(getLessonDuration(unit(['unit_duration: PT6M'])), { minutes: 6, source: 'provided' });
});

test('does not mistake fenced examples of duration callouts for lesson metadata', () => {
  const code = '# Lesson\n\n```markdown\nUnit duration: 40 minutes\n```\n\nA short explanation.';
  assert.deepEqual(getLessonDuration(unit([], code)), { minutes: 1, source: 'estimated' });
  const visible = '# Summary\n\n```markdown\nCompleted\n- 12 minutes\n```\n\nA short explanation.';
  assert.deepEqual(getLessonDuration(unit([], visible)), { minutes: 1, source: 'estimated' });
  const tilde = '# Lesson\n\n~~~markdown\nLesson duration: 25 minutes\n~~~\n\nA short explanation.';
  assert.deepEqual(getLessonDuration(unit([], tilde)), { minutes: 1, source: 'estimated' });
});

test('reads lesson-scoped HTML metadata and time elements when Markdown has no duration', () => {
  const md = unit([]);
  const meta = '<head><meta content="9 min" name="unit-duration"></head>';
  assert.deepEqual(getLessonDuration(md, meta), { minutes: 9, source: 'provided' });
  const time = '<span>Module: 45 min</span><time class="lesson-duration" datetime="PT3M">3 min</time>';
  assert.deepEqual(getLessonDuration(md, time), { minutes: 3, source: 'provided' });
  assert.deepEqual(getLessonDuration(unit(['lessonDurationMinutes: 2']), meta), { minutes: 2, source: 'provided' });
});

test('recognizes a Learn unit header with Completed and an exact duration bullet', () => {
  const body = '# Summary\n\nCompleted\n\n- 3 minutes\n\nThis unit introduces Azure.';
  assert.deepEqual(getLessonDuration(unit([], body)), { minutes: 3, source: 'provided' });
  assert.deepEqual(getLessonDuration(unit([], body.replace('- 3 minutes', '• 3 minutes').replace(/\n/g, '\r\n'))), { minutes: 3, source: 'provided' });
});

test('does not interpret module overviews, other hosts or non-lesson pages as unit duration', () => {
  const header = '# Summary\n\nCompleted\n\n- 3 minutes';
  assert.deepEqual(getLessonDuration(unit([], header).replace('/azure-basics/1-introduction', '/azure-basics/')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], header).replace('learn.microsoft.com', 'example.com')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], header).replace('kind: lesson', 'kind: reference')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(header), { minutes: 1, source: 'estimated' });
});

test('ignores distant, prose and non-exact minute bullets', () => {
  const distant = `# Summary\n${Array(12).fill('Overview').join('\n')}\nCompleted\n- 3 minutes`;
  assert.deepEqual(getLessonDuration(unit([], distant)), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], '# Summary\nCompleted this unit in 3 minutes\n- 3 minutes')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], '# Summary\nCompleted\nThe module lasts 3 minutes.\n- 3 minutes')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], '# Summary\nCompleted\n- 3 minutes to review the course')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], '# Summary\nCompleted\n- 90 minutes')), { minutes: 1, source: 'estimated' });
});

test('labelled Markdown and HTML durations take precedence over the visible bullet', () => {
  const header = '# Summary\nCompleted\n- 3 minutes';
  assert.deepEqual(getLessonDuration(unit(['lessonDurationMinutes: 6'], header)), { minutes: 6, source: 'provided' });
  assert.deepEqual(getLessonDuration(unit([], header), '<meta name="unit-duration" content="5 min">'), { minutes: 5, source: 'provided' });
});

test('falls back to readable word count, ignoring front matter and non-prose Markdown', () => {
  const prose = Array(401).fill('word').join(' ');
  const md = unit([], `${prose}\n\n![diagram](https://example.com/1000-words.png)\n\n\`\`\`ts\n${Array(1000).fill('code').join(' ')}\n\`\`\``);
  assert.deepEqual(getLessonDuration(md), { minutes: 3, source: 'estimated' });
  assert.deepEqual(getLessonDuration('Read the [guide](https://example.com) and continue.'), { minutes: 1, source: 'estimated' });
});

test('empty input and very long content always have bounded estimated minutes', () => {
  assert.deepEqual(getLessonDuration(''), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit([], '')), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(Array(13_000).fill('word').join(' ')), { minutes: 60, source: 'estimated' });
});

test('module and course totals, body mentions, and invalid explicit values are not lesson durations', () => {
  const modulePage = [
    '---',
    'kind: lesson',
    'url: https://learn.microsoft.com/en-us/training/modules/azure-basics/',
    'duration: 45 min',
    '---',
    '# Module overview',
    'This unit is part of a 45 min module.',
  ].join('\r\n');
  const html = '<meta name="duration" content="40 min"><meta name="module-duration" content="30 min"><div>5 min remaining</div>';
  assert.deepEqual(getLessonDuration(modulePage, html), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit(['moduleDurationMinutes: 45'], '# Lesson\nThis module takes 45 min.'), html), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit(['unitDurationMinutes: 999'], '# Lesson'), html), { minutes: 1, source: 'estimated' });
  assert.deepEqual(getLessonDuration(unit(['lessonDurationMinutes: 0'], '# Lesson')), { minutes: 1, source: 'estimated' });
});
