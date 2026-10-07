import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadComponent(file, mocks = {}, globals = {}, expose) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    + (expose ? `\nexport { ${expose} as __tested };` : '');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, setTimeout, clearTimeout,
    navigator: { clipboard: undefined }, document: {}, ...globals,
    require: (id) => mocks[id] ?? new Proxy({}, { get: (_, key) => key === '__esModule' ? false : key }),
  }, { filename: file });
  return module.exports;
}

function fallbackDocument(result) {
  let removed = false;
  let selected = false;
  let field;
  const doc = {
    body: { appendChild(node) { field = node; } },
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return { value: '', style: {}, setAttribute() {}, select() { selected = true; }, remove() { removed = true; } };
    },
    execCommand(command) { assert.equal(command, 'copy'); return result; },
  };
  return { doc, state: () => ({ removed, selected, value: field?.value }) };
}

test('copies exact prompt/markdown response text via clipboard API without fallback', async () => {
  const { copyChatText } = loadComponent('MessageCopyButton.tsx');
  const copied = [];
  const { doc, state } = fallbackDocument(true);
  for (const text of ['A prompt with <tags>\nsecond line', '**bold**\n```js\ncode\n```']) {
    assert.equal(await copyChatText(text, { writeText: async (value) => { copied.push(value); } }, doc), true);
  }
  assert.deepEqual(copied, ['A prompt with <tags>\nsecond line', '**bold**\n```js\ncode\n```']);
  assert.equal(state().selected, false);
});

test('clipboard denial or absence falls back to selecting raw text and always cleans up', async () => {
  const { copyChatText } = loadComponent('MessageCopyButton.tsx');
  const { doc, state } = fallbackDocument(true);
  assert.equal(await copyChatText('retry this', { writeText: async () => { throw Error('denied'); } }, doc), true);
  assert.deepEqual(state(), { removed: true, selected: true, value: 'retry this' });
  const failed = fallbackDocument(false);
  assert.equal(await copyChatText('blocked', undefined, failed.doc), false);
  assert.equal(failed.state().removed, true);
});

test('copy button is a keyboard-accessible action with distinct prompt and response labels', () => {
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
  };
  const { MessageCopyButton } = loadComponent('MessageCopyButton.tsx', { react: hooks });
  for (const kind of ['prompt', 'response']) {
    const button = MessageCopyButton({ text: 'hello', kind });
    assert.equal(button.type, 'button');
    assert.equal(button.props.type, 'button');
    assert.equal(button.props['aria-label'], `Copy ${kind}`);
    assert.equal(typeof button.props.onClick, 'function');
  }
});

test('copy action reports success only after writing, and exposes failure to assistive tech', async () => {
  let status = 'ready';
  let canCopy = true;
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [status, (next) => { status = next; }],
    useRef: () => ({ current: null }),
    useEffect: () => {},
  };
  const clipboard = { writeText: async () => { if (!canCopy) throw Error('blocked'); } };
  const failed = fallbackDocument(false);
  const { MessageCopyButton } = loadComponent('MessageCopyButton.tsx', { react: hooks }, {
    navigator: { clipboard }, document: failed.doc,
    setTimeout: () => 1, clearTimeout: () => {},
  });
  const button = () => MessageCopyButton({ text: 'hello', kind: 'response' });
  assert.equal(button().props['aria-label'], 'Copy response');
  await button().props.onClick();
  assert.equal(button().props['aria-label'], 'Copied response');
  canCopy = false;
  await button().props.onClick();
  assert.equal(button().props['aria-label'], "Couldn't copy response; try again");
});

test('global and meeting chats share safe GFM/math/diagram rendering without raw HTML plugin', () => {
  const hooks = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const { ChatResponseMarkdown } = loadComponent('ChatResponseMarkdown.tsx', {
    react: hooks,
    'react-markdown': { default: 'markdown' },
    './diagram/DiagramAwareMarkdown': { DiagramAwareMarkdown: 'diagram' },
    '../utils/registerPrismLanguages': { registerPrismLanguages() {} },
  });
  const wrapper = ChatResponseMarkdown({ text: '**bold**\n- item', streaming: true, isLatest: true });
  const diagram = wrapper.children[0];
  assert.equal(diagram.type, 'diagram');
  assert.equal(diagram.props.text, '**bold**\n- item');
  assert.equal(diagram.props.streaming, true);
  const markdown = diagram.props.renderMarkdown('**bold**\n- item', 'm0');
  assert.equal(markdown.children[0], '**bold**\n- item');
  assert.equal(markdown.props.remarkPlugins.length, 2);
  assert.equal(markdown.props.rehypePlugins.length, 1);
  assert.equal(markdown.props.allowDangerousHtml, undefined);
});

test('global chat copies exact gist-free text and removes an honored gist', async () => {
  const hooks = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const { __tested: AssistantMessage } = loadComponent('GlobalChatOverlay.tsx', {
    react: hooks,
    '../lib/displayMarkup': await import('../../lib/displayMarkup.ts'),
    'framer-motion': { motion: { div: 'motion.div' } },
  }, {}, 'AssistantMessage');
  for (const [content, expectedCopy] of [
    ['  **Bold**\n\n', '  **Bold**\n\n'],
    ['   \n', '   \n'],
    ['Body.\n[[GIST]] Summary', 'Body.'],
    ['You sort them [[GIST]] first, then subtract.', 'You sort them [[GIST]] first, then subtract.'],
  ]) {
    const message = AssistantMessage({ content, isStreaming: false });
    const rendered = message.children[0].children[0];
    const copy = message.children[1];
    assert.equal(rendered.props.text.includes('[[GIST]] Summary'), false);
    assert.equal(copy.props.text, expectedCopy);
    assert.equal(copy.props.kind, 'response');
  }
});

test('chat response renders formatted markdown without executing raw HTML', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ChatResponseMarkdown } = loadComponent('ChatResponseMarkdown.tsx', {
    react: React,
    'react-markdown': { __esModule: true, default: (await import('react-markdown')).default },
    'remark-gfm': { __esModule: true, default: (await import('remark-gfm')).default },
    'remark-math': { __esModule: true, default: (await import('remark-math')).default },
    'rehype-katex': { __esModule: true, default: (await import('rehype-katex')).default },
    'react-syntax-highlighter/dist/esm/prism-light': { __esModule: true, default: () => null },
    'react-syntax-highlighter/dist/esm/styles/prism': { vscDarkPlus: {} },
    '../utils/registerPrismLanguages': { registerPrismLanguages() {} },
    '../utils/prismLanguage': { isBlockCode: () => false, mapLanguageForPrism: () => '' },
    './diagram/DiagramAwareMarkdown': { DiagramAwareMarkdown: ({ text, renderMarkdown }) => renderMarkdown(text, 'm0') },
  });
  const html = renderToStaticMarkup(React.createElement(ChatResponseMarkdown, {
    text: '**Bold**\n\n- one\n- two\n\n<script>alert(1)</script>',
  }));
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<li[^>]*>one<\/li>/);
  assert.doesNotMatch(html, /<script>/);
});

test('chat markdown opens HTTPS links only in the external window handler, never in the renderer', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ChatResponseMarkdown } = loadComponent('ChatResponseMarkdown.tsx', {
    react: React,
    'react-markdown': { __esModule: true, default: (await import('react-markdown')).default },
    'remark-gfm': { __esModule: true, default: (await import('remark-gfm')).default },
    'remark-math': { __esModule: true, default: (await import('remark-math')).default },
    'rehype-katex': { __esModule: true, default: (await import('rehype-katex')).default },
    'react-syntax-highlighter/dist/esm/prism-light': { __esModule: true, default: () => null },
    'react-syntax-highlighter/dist/esm/styles/prism': { vscDarkPlus: {} },
    '../utils/registerPrismLanguages': { registerPrismLanguages() {} },
    '../utils/prismLanguage': { isBlockCode: () => false, mapLanguageForPrism: () => '' },
    './diagram/DiagramAwareMarkdown': { DiagramAwareMarkdown: ({ text, renderMarkdown }) => renderMarkdown(text, 'm0') },
  }, { URL });
  const render = (text) => renderToStaticMarkup(React.createElement(ChatResponseMarkdown, { text }));
  const safe = render('[Docs](https://example.com/docs)');
  assert.match(safe, /<a\b[^>]*href="https:\/\/example\.com\/docs"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  const { shouldOpenExternally } = await import('../../../electron/utils/windowOpenPolicy.ts');
  assert.equal(shouldOpenExternally('https://example.com/docs'), true);
  for (const text of [
    '[HTTP](http://example.com)', '[File](file:///etc/passwd)',
    '[Script](javascript:alert(1))', '[Relative](/settings)', '[Mail](mailto:a@example.com)',
  ]) {
    const html = render(text);
    assert.doesNotMatch(html, /<a\b/, text);
    assert.match(html, /<(?:span|p)[^>]*>/, text);
  }
  for (const url of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', '/settings']) {
    assert.equal(shouldOpenExternally(url), false);
  }
});
