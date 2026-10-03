// electron/utils/__tests__/injectImageIntoMessages.test.mjs
//
// Regression tests for the injectImageIntoMessages utility used by custom
// providers (cURL templates) to auto-upgrade plain text messages to multimodal
// content arrays when images are present.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/utils/curlUtils.js');
const { injectImageIntoMessages } = await import(pathToFileURL(modPath).href);

describe('injectImageIntoMessages', () => {

  test('upgrades plain string content to multimodal array with text + image_url', () => {
    const body = { messages: [{ role: 'user', content: 'Describe this' }] };
    const result = injectImageIntoMessages(body, 'base64data', '/path/to/image.png');

    assert.ok(Array.isArray(result.messages[0].content));
    assert.equal(result.messages[0].content.length, 2);
    assert.deepEqual(result.messages[0].content[0], { type: 'text', text: 'Describe this' });
    const imagePart = result.messages[0].content[1];
    assert.equal(imagePart.type, 'image_url');
    assert.equal(imagePart.image_url.url, 'data:image/png;base64,base64data');
  });

  test('appends image_url to existing multimodal content array', () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
    ] }] };
    const result = injectImageIntoMessages(body, 'base64data', '/path/to/image.jpg');

    assert.equal(result.messages[0].content.length, 2);
    const imagePart = result.messages[0].content[1];
    assert.equal(imagePart.type, 'image_url');
    assert.ok(imagePart.image_url.url.startsWith('data:image/jpeg;base64,'));
  });

  test('does NOT duplicate when content already has an image_url', () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,existing' } },
    ] }] };
    const result = injectImageIntoMessages(body, 'base64data', '/path/to/image.png');

    // Should return body unchanged (not add a second image)
    assert.equal(result.messages[0].content.length, 2);
  });

  test('returns body unchanged when no messages array', () => {
    const body = { prompt: 'hello' };
    const result = injectImageIntoMessages(body, 'base64data', '/path/to/image.png');
    assert.deepEqual(result, body);
  });

  test('returns body unchanged when base64Image is empty', () => {
    const body = { messages: [{ role: 'user', content: 'test' }] };
    const result = injectImageIntoMessages(body, '', '/path/to/image.png');
    assert.deepEqual(result, body);
  });

  test('uses correct MIME type from file extension', () => {
    const makeBody = () => ({ messages: [{ role: 'user', content: 'test' }] });

    const r1 = injectImageIntoMessages(makeBody(), 'b64', '/path/to/image.png');
    assert.ok(r1.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'));

    const r2 = injectImageIntoMessages(makeBody(), 'b64', '/path/to/image.jpg');
    assert.ok(r2.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));

    const r3 = injectImageIntoMessages(makeBody(), 'b64', '/path/to/image.webp');
    assert.ok(r3.messages[0].content[1].image_url.url.startsWith('data:image/webp;base64,'));
  });

  test('targets the LAST user message, not earlier ones', () => {
    const body = { messages: [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Second message' },
    ] };
    const result = injectImageIntoMessages(body, 'b64', '/path/to/img.png');

    // First user message should still be a plain string
    assert.equal(result.messages[0].content, 'First message');
    // Last user message should be upgraded
    assert.ok(Array.isArray(result.messages[2].content));
  });

  test('preserves other body fields (model, stream, etc.)', () => {
    const body = { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const result = injectImageIntoMessages(body, 'b64', '/path/to/img.png');

    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.stream, true);
  });
});
