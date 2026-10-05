import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { StreamingQuestionEchoFilter, MAX_QUESTION_ECHO_CHARS } = require('../../../dist-electron/electron/llm/questionEchoFilter.js');
const { frameCurrentQuestion } = require('../../../dist-electron/electron/llm/localContextTrim.js');
const frame = frameCurrentQuestion('What is 2+3?');
const prompt = `${frame}\n\n# Evidence\nNo evidence.`;
const response = `${frame}\n5\n`;
const filter = (input = prompt, v3 = true, system) => new StreamingQuestionEchoFilter(input, v3, system);

for (let split = 0; split <= response.length; split++) test(`exact prolog across split ${split} preserves answer bytes`, () => {
  const f = filter();
  assert.equal(f.feed(response.slice(0, split)) + f.feed(response.slice(split)) + f.finish(), '5\n');
});

test('ordinary answers stream immediately; no arbitrary prolog scan', () => {
  const f = filter();
  assert.equal(f.feed('5'), '5');
  assert.equal(f.feed(`\n${frame}`), `\n${frame}`, 'after answer text, every tag is content');
});
test('the first mismatch releases the entire candidate immediately', () => {
  const f = filter();
  assert.equal(f.feed('<current_question '), '');
  assert.equal(f.feed('is an XML element.'), '<current_question is an XML element.');
});
test('only one framing newline is removed; answer blank lines and indentation survive', () => {
  const f = filter();
  assert.equal(f.feed(`${frame}\n\n    print(5)\n`) + f.finish(), '\n    print(5)\n');
});
test('fenced and inline tag examples are never scanned', () => {
  for (const example of [`\`\`\`xml\n${frame}\n\`\`\``, `\`${frame}\``, `Example:\n${frame}`, `\n${frame}`]) {
    const f = filter();
    assert.equal([...example].map(c => f.feed(c)).join('') + f.finish(), example);
  }
});
test('requests and standing instructions about literal syntax opt out', () => {
  for (const [question, system] of [
    ['Explain <current_question>.', undefined], ['Show &lt;current_question&gt;.', undefined],
    ['What is 2+3?', 'Return literal current_question markup.'],
  ]) {
    const exact = frameCurrentQuestion(question);
    assert.equal(filter(exact, true, system).feed(exact), exact);
  }
});
test('non-V3 and unframed requests cannot trigger removal', () => {
  assert.equal(filter(prompt, false).feed(response), response);
  assert.equal(filter('What is 2+3?').feed(response), response);
});
test('wrong question or counted framing is left unchanged', () => {
  for (const output of [frameCurrentQuestion('What is 8+9?'), frame.replace('lines="1"', 'lines="2"'), frame.replace('# Question', '# Example')]) {
    const f = filter();
    assert.equal([...output].map(c => f.feed(c)).join('') + f.finish(), output);
  }
  for (const input of [frame.replace('lines="1"', 'lines="2"'), frame.replace('lines="1"', 'lines="9007199254740992"')]) {
    assert.equal(filter(input).feed(response), response);
  }
});
test('incomplete candidates flush losslessly at normal or truncated EOF', () => {
  for (let end = 1; end < frame.length; end++) {
    const f = filter(); const prefix = frame.slice(0, end);
    assert.equal(f.feed(prefix), '');
    assert.equal(f.finish(), prefix);
    assert.equal(f.finish(), '');
  }
});
test('full frame alone is suppressed, not its later answer', () => {
  const f = filter();
  assert.equal(f.feed(frame), '');
  assert.equal(f.feed('5'), '5');
  assert.equal(f.finish(), '');
});
test('the bound accepts a 4 KiB frame but immediately passes through larger requests', () => {
  const overhead = frameCurrentQuestion('').length;
  const exact = frameCurrentQuestion('a'.repeat(MAX_QUESTION_ECHO_CHARS - overhead));
  assert.equal(exact.length, MAX_QUESTION_ECHO_CHARS);
  assert.equal(filter(exact).feed(`${exact}\n5`), '5');
  const huge = frameCurrentQuestion('a'.repeat(1_000_000));
  const f = filter(huge);
  assert.equal(f.feed('<'), '<', 'oversized questions never delay the first provider token');
  assert.equal(f.feed('ordinary answer'), 'ordinary answer');
});
test('multiline question matches the exact recorded count and bytes', () => {
  const multiline = frameCurrentQuestion('Solve:\n```python\nprint(2 + 3)\n```\n# Evidence');
  const f = filter(multiline);
  assert.equal([...`${multiline}\n5`].map(c => f.feed(c)).join('') + f.finish(), '5');
});
