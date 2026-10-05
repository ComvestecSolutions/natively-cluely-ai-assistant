import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { LLMHelper } = require('../../../dist-electron/electron/LLMHelper.js');
let server, endpoint, respond, lastGet;
let posts = [];
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      lastGet = req.url;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'qwen-local' }] }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      posts.push(JSON.parse(body));
      respond(req, res, posts.at(-1));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
function provider(extra = {}) {
  posts = [];
  return {
    id: 'local', name: 'LM Studio', responsePath: 'choices[0].message.content',
    curlCommand: `curl ${endpoint} -H 'Content-Type: application/json' -d '${JSON.stringify({ model: 'qwen-local', messages: [{ role: 'system', content: '{{SYSTEM_PROMPT}}' }, { role: 'user', content: '{{TEXT}}' }], stream: true })}'`,
    ...extra,
  };
}
function helper(p) {
  const h = Object.create(LLMHelper.prototype);
  h.assertOutboundScopes = () => {};
  h.isProviderDisabled = () => false;
  h.customProvider = p;
  h.activeCurlProvider = p;
  return h;
}
async function collect(stream) {
  let text = '';
  for await (const piece of stream) text += piece;
  return text;
}
const delta = content => ({ choices: [{ delta: { content } }] });
const reason = { choices: [{ delta: { reasoning_content: 'PRIVATE_THINKING' } }] };
function sse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(text);
}
for (const lane of ['executeCustomProvider', 'chatWithCurl']) {
  test(`${lane}: saved stream:true must produce a buffered answer, not SSE/JSON failure`, async () => {
    const p = provider();
    respond = (_req, res, body) => {
      if (body.stream) sse(res, `data: ${JSON.stringify(delta('answer'))}\n\ndata: [DONE]\n\n`);
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'answer' } }] })); }
    };
    const h = helper(p);
    const answer = lane === 'chatWithCurl' ? await h.chatWithCurl('question', 'system')
      : await h.executeCustomProvider(p.curlCommand, 'question', 'system', 'question', '', undefined, p.responsePath);
    assert.equal(answer, 'answer');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].stream, false);
  });
}
test('custom cURL templates without a SYSTEM placeholder still carry the request policy as system exactly once', async () => {
  const p = provider({
    curlCommand: `curl ${endpoint} -H 'Content-Type: application/json' -d '${JSON.stringify({
      model: 'qwen-local', messages: [{ role: 'user', content: '{{TEXT}}' }], stream: true,
    })}'`,
  });
  respond = (_req, res) => sse(res, `data: ${JSON.stringify(delta('answer'))}\n\ndata: [DONE]\n\n`);
  const instruction = 'Speak in first person during the interview.';
  assert.equal(await collect(helper(p).streamWithCustom('question', undefined, undefined, instruction)), 'answer');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].messages.filter(m => m.role === 'system').length, 1);
  assert.equal(posts[0].messages[0].role, 'system');
  assert.equal(posts[0].messages[0].content.split(instruction).length - 1, 1);
  assert.equal(posts[0].messages.at(-1).content, 'question');
});

test('streamWithCustom: SSE data without a space, comments, multiline data and split UTF-8', async () => {
  const p = provider();
  respond = async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(`: keepalive\r\nevent: message\r\ndata:${JSON.stringify(reason)}\r\n\r\ndata:{"choices":[\r\ndata:{"delta":{"content":"answer 🧠"}}]}\r\n\r\ndata:[DONE]\r\n\r\n`);
    // Each byte is its own write, including CRLF and the four-byte emoji.
    for (const byte of bytes) { res.write(Buffer.from([byte])); await sleep(1); }
    res.end();
  };
  assert.equal(await collect(helper(p).streamWithCustom('q', undefined, undefined, 'sys')), 'answer 🧠');
  assert.equal(posts.length, 1);
});
test('streamWithCustom: reasoning followed by a dropped socket must not POST again', async () => {
  const p = provider();
  respond = async (_req, res) => {
    if (posts.length > 1) { sse(res, `data: ${JSON.stringify(delta('duplicate'))}\n\ndata: [DONE]\n\n`); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(reason)}\n\n`);
    await sleep(25);
    res.destroy();
  };
  await assert.rejects(collect(helper(p).streamWithCustom('q', undefined, undefined, 'sys')));
  assert.equal(posts.length, 1, 'reasoning proves generation started; a retry duplicates the request');
});
test('reasoning-only completion is a meaningful failure and never leaks reasoning', async () => {
  const p = provider();
  respond = (_req, res) => sse(res, `data: ${JSON.stringify(reason)}\n\ndata: [DONE]\n\n`);
  await assert.rejects(collect(helper(p).streamWithCustom('q', undefined, undefined, 'sys')), e => {
    assert.match(e.message, /no answer|reasoning/i);
    assert.doesNotMatch(e.message, /PRIVATE_THINKING/);
    return true;
  });
  assert.equal(posts.length, 1);
});
test('provider override responsePath is frozen, not taken from a different active provider', async () => {
  const p = provider({ responsePath: 'data.answer' });
  const h = helper({ ...p, responsePath: 'data.wrong' });
  respond = (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { answer: 'frozen', wrong: 'active' } })); };
  assert.equal(await collect(h.streamWithCustom('q', undefined, undefined, 'sys', undefined, p, true)), 'frozen');
});
test('chatWithCurl HTTP failures reject rather than being persisted as answer text', async () => {
  const p = provider();
  respond = (_req, res) => { res.writeHead(401); res.end('secret body'); };
  await assert.rejects(helper(p).chatWithCurl('q'), /HTTP 401/);
});
test('caller cancellation during reasoning closes the request without retry or error prose', async () => {
  const p = provider();
  const ctrl = new AbortController();
  respond = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(reason)}\n\n`);
    setTimeout(() => ctrl.abort(), 15);
  };
  assert.equal(await collect(helper(p).streamWithCustom('q', undefined, undefined, 'sys', ctrl.signal)), '');
  assert.equal(posts.length, 1);
});
test('strict local warmup is not aborted by the 15s cloud connect budget', async t => {
  const p = provider();
  const originalFetch = globalThis.fetch;
  let signal, finish;
  globalThis.fetch = (_url, opts) => {
    signal = opts.signal;
    return new Promise((resolve, reject) => {
      finish = () => resolve(new Response(`data: ${JSON.stringify(delta('warm'))}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ctrl = new AbortController();
    const pending = collect(helper(p).streamWithCustom('q', undefined, undefined, 'sys', ctrl.signal, p, true));
    pending.catch(() => {});
    assert.ok(signal);
    t.mock.timers.tick(30_001);
    const wasAborted = signal.aborted;
    finish();
    if (wasAborted) ctrl.abort();
    const answer = await pending;
    assert.equal(wasAborted, false, 'local model loading is not a cloud connect stall');
    assert.equal(answer, 'warm');
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});
test('selected local custom path does not launch the 9s hedge during model loading', async t => {
  const p = provider();
  const h = helper(p);
  h.answerLatency = new Map();
  h.buildTextSpareRungs = () => [];
  const originalFetch = globalThis.fetch;
  const finishes = [];
  const signals = [];
  const ctrl = new AbortController();
  globalThis.fetch = (_url, opts) => new Promise((resolve, reject) => {
    signals.push(opts.signal);
    finishes.push(() => resolve(new Response(`data: ${JSON.stringify(delta('answer'))}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })));
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    const pending = collect(h.streamSelectedProviderWithFailover({ id: 'custom', name: 'LM Studio', open: sig => h.streamWithCustom('q', undefined, undefined, 'sys', sig), userContent: 'q', finalSystemPrompt: 'sys', thinkingBudget: 0, abortSignal: ctrl.signal }));
    pending.catch(() => {});
    await flush();
    assert.equal(finishes.length, 1);
    t.mock.timers.tick(9_001);
    await flush();
    const requests = finishes.length;
    t.mock.timers.tick(6_000);
    await flush();
    const abortedAt15s = signals.some(signal => signal.aborted);
    for (const finish of finishes) finish();
    const answer = await pending;
    assert.equal(requests, 1, 'old policy launches another POST at 60% of 15s, matching :32/:41');
    assert.equal(abortedAt15s, false, 'local warmup must not hit the shared :47 abort at 15s');
    assert.equal(answer, 'answer');
  } finally { ctrl.abort(); globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});

test('Direct cURL streams final content without double-escaping prompt variables', async () => {
  const p = provider();
  respond = (_req, res) => sse(res, `data: ${JSON.stringify(reason)}\n\ndata: ${JSON.stringify(delta('answer'))}\n\ndata: [DONE]\n\n`);
  const prompt = 'Explain "quotes"\nand backslash \\ with $&';
  const answer = await collect(helper(p).streamWithDirectCurl(p, prompt, 'system', []));
  assert.equal(answer, 'answer');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].messages[0].content, 'system');
  assert.equal(posts[0].messages[1].content, `system\n\n${prompt}`);
});
for (const lane of ['executeCustomProvider', 'chatWithCurl', 'streamWithCustom', 'streamWithDirectCurl']) {
  test(`${lane}: redirects cannot replay credentials or prompts`, async () => {
    const p = provider();
    respond = (_req, res) => {
      if (posts.length === 1) { res.writeHead(307, { Location: endpoint + '/unchecked' }); res.end('PRIVATE'); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'leaked' } }] })); }
    };
    const h = helper(p);
    const call = lane === 'executeCustomProvider' ? h.executeCustomProvider(p.curlCommand, 'q', 's', 'q', '', undefined, p.responsePath)
      : lane === 'chatWithCurl' ? h.chatWithCurl('q')
      : lane === 'streamWithDirectCurl' ? collect(h.streamWithDirectCurl(p, 'q', 's', []))
      : collect(h.streamWithCustom('q', undefined, undefined, 's'));
    await assert.rejects(call, /HTTP 307/);
    assert.equal(posts.length, 1);
  });
  test(`${lane}: metadata hosts remain blocked before network dispatch`, async () => {
    const p = provider();
    p.curlCommand = p.curlCommand.replace(endpoint, 'http://169.254.169.254/latest/meta-data');
    const h = helper(p);
    const call = lane === 'executeCustomProvider' ? h.executeCustomProvider(p.curlCommand, 'q', 's', 'q', '')
      : lane === 'chatWithCurl' ? h.chatWithCurl('q')
      : lane === 'streamWithDirectCurl' ? collect(h.streamWithDirectCurl(p, 'q', 's', []))
      : collect(h.streamWithCustom('q', undefined, undefined, 's'));
    await assert.rejects(call, /refused|metadata/i);
    assert.equal(posts.length, 0);
  });
}
test('GET custom templates do not send an invalid fetch body', async () => {
  const p = provider({ responsePath: 'data[0].id', curlCommand: `curl -X GET '${endpoint}'` });
  const prompt = 'spaces & a newline\nand a # hash';
  const h = helper(p);
  assert.equal(await h.chatWithCurl(prompt), 'qwen-local');
  assert.equal(new URL(lastGet, endpoint).pathname, '/v1/chat/completions');
  assert.equal(await h.executeCustomProvider(p.curlCommand, prompt, '', prompt, '', undefined, p.responsePath), 'qwen-local');
  assert.equal(posts.length, 0);
});
test('buffered calls tolerate an endpoint ignoring stream:false without a second request', async () => {
  const p = provider();
  respond = (_req, res) => sse(res, `data: ${JSON.stringify(reason)}\n\ndata: ${JSON.stringify(delta('buffered'))}\n\ndata: [DONE]\n\n`);
  const h = helper(p);
  assert.equal(await h.executeCustomProvider(p.curlCommand, 'q', 's', 'q', '', undefined, p.responsePath), 'buffered');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].stream, false);
});
test('truncated SSE rejects after content without retrying or returning partial buffered output', async () => {
  const p = provider();
  respond = (_req, res) => sse(res, `data: ${JSON.stringify(delta('partial'))}\n\n`);
  await assert.rejects(helper(p).executeCustomProvider(p.curlCommand, 'q', 's', 'q', ''), /before stream completion/);
  assert.equal(posts.length, 1);
});
test('OpenAI finish_reason permits completion when a server omits [DONE]', async () => {
  const p = provider();
  respond = (_req, res) => sse(res, `data: ${JSON.stringify(delta('answer'))}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`);
  assert.equal(await collect(helper(p).streamWithCustom('q', undefined, undefined, 's')), 'answer');
});
test('reasoning-only JSON cannot be saved as raw JSON or a blank answer', async () => {
  const p = provider();
  respond = (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'PRIVATE' } }] })); };
  await assert.rejects(helper(p).executeCustomProvider(p.curlCommand, 'q', 's', 'q', ''), /no answer content/);
});
test('SSE API errors and malformed events are sanitized and never replayed', async () => {
  for (const packet of ['{"error":{"message":"Authorization Bearer PRIVATE"}}', '{"choices":"PRIVATE"']) {
    const p = provider();
    respond = (_req, res) => sse(res, `data: ${packet}\n\n`);
    await assert.rejects(collect(helper(p).streamWithCustom('q', undefined, undefined, 's')), e => {
      assert.match(e.message, /API error|malformed/i);
      assert.doesNotMatch(e.message, /PRIVATE|127\.0\.0\.1/);
      return true;
    });
    assert.equal(posts.length, 1);
  }
});
test('every possible two-chunk split preserves multiline SSE, CRLF and UTF-8', async () => {
  const { streamCustomTransport } = require('../../../dist-electron/electron/llm/customProviderTransport.js');
  const bytes = Buffer.from(`: ping\r\ndata:${JSON.stringify(reason)}\r\n\r\nevent: message\r\ndata:{"choices":[\r\ndata:{"delta":{"content":"🧠 answer"}}]}\r\n\r\ndata:[DONE]\r\n\r\n`);
  const originalFetch = globalThis.fetch;
  const h = helper(provider());
  try {
    for (let split = 1; split < bytes.length; split++) {
      globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, split)); c.enqueue(bytes.subarray(split)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
      assert.equal(await collect(streamCustomTransport({ url: endpoint, headers: {}, body: {}, method: 'POST', state: { outputStreamed: false }, extractWhole: x => h.extractCustomAnswer(x), extractDelta: x => h.extractFromCommonFormats(x) })), '🧠 answer', `split ${split}`);
    }
  } finally { globalThis.fetch = originalFetch; }
});
test('JSONL, whole pretty JSON, and plain-text custom endpoints retain their contracts', async () => {
  for (const [contentType, data] of [
    ['application/x-ndjson', '{"response":"an"}\n{"response":"swer"}\n'],
    ['application/json', JSON.stringify({ data: { answer: 'answer' } }, null, 2)],
    ['text/plain', 'answer'],
  ]) {
    const p = provider({ responsePath: 'data.answer' });
    respond = (_req, res) => { res.setHeader('Content-Type', contentType); res.end(data); };
    assert.equal(await collect(helper(p).streamWithCustom('q', undefined, undefined, 's')), 'answer');
  }
});
for (const lane of ['streamWithCustom', 'executeCustomProvider', 'chatWithCurl']) {
  test(`${lane}: NDJSON honors configured responsePath before generic fields`, async () => {
    const p = provider({ responsePath: 'data.answer' });
    respond = (_req, res) => {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.end(JSON.stringify({ data: { answer: 'Hello' }, response: 'WRONG_GENERIC_ANSWER' }) + '\n');
    };
    const h = helper(p);
    const answer = lane === 'streamWithCustom' ? await collect(h.streamWithCustom('q', undefined, undefined, 'sys'))
      : lane === 'chatWithCurl' ? await h.chatWithCurl('q', 'sys')
      : await h.executeCustomProvider(p.curlCommand, 'q', 'sys', 'q', '', undefined, p.responsePath);
    assert.equal(answer, 'Hello');
    assert.equal(posts.length, 1);
  });
}
for (const tail of ['\n', '']) {
  test(`NDJSON configured path survives every two-chunk split with ${tail ? 'newline' : 'unterminated tail'}`, async () => {
    const p = provider({ responsePath: 'data.answer' });
    const bytes = Buffer.from(JSON.stringify({ data: { answer: 'Hello 🧠' } }) + '\r\n'
      + JSON.stringify({ data: { answer: ' world' } }) + tail);
    const originalFetch = globalThis.fetch;
    const h = helper(p);
    try {
      for (let split = 1; split < bytes.length; split++) {
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          return new Response(new ReadableStream({ start(c) {
            c.enqueue(bytes.subarray(0, split)); c.enqueue(bytes.subarray(split)); c.close();
          } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
        };
        assert.equal(await collect(h.streamWithCustom('q', undefined, undefined, 'sys')), 'Hello 🧠 world', `split ${split}`);
        assert.equal(requests, 1, `split ${split} must not replay`);
      }
    } finally { globalThis.fetch = originalFetch; }
  });
}
test('NDJSON standard deltas keep reasoning and control packets hidden through a split tail', async () => {
  const p = provider();
  const packets = [reason, delta('Hello 🧠'), { choices: [], usage: { completion_tokens: 10 } },
    { choices: [{ delta: {}, finish_reason: 'stop' }] }];
  const bytes = Buffer.from(packets.map(x => JSON.stringify(x)).join('\n'));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    assert.equal(await collect(helper(p).streamWithCustom('q', undefined, undefined, 'sys')), 'Hello 🧠');
  } finally { globalThis.fetch = originalFetch; }
});
test('Anthropic custom SSE keeps text while hiding thinking and control frames', async () => {
  const p = provider();
  const packets = [
    { type: 'message_start', message: { content: [] } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    { type: 'message_stop' },
  ];
  respond = (_req, res) => sse(res, packets.map(x => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join(''));
  assert.equal(await collect(helper(p).streamWithCustom('q', undefined, undefined, 's')), 'answer');
});
test('remote strict providers retain the 15s connect timeout, not the local warmup budget', async t => {
  const p = provider();
  p.curlCommand = p.curlCommand.replace(endpoint, 'https://provider.example/v1/chat/completions');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('PRIVATE network configuration')), { once: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = collect(helper(p).streamWithCustom('q', undefined, undefined, 's', undefined, p, true));
    const rejected = assert.rejects(pending, e => { assert.equal(e.code, 'CONNECT_TIMEOUT'); assert.doesNotMatch(e.message, /PRIVATE/); return true; });
    t.mock.timers.tick(15_001);
    await rejected;
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});
test('warmup after local headers remains bounded by the existing five-minute total deadline', async t => {
  const p = provider();
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
    start(c) { opts.signal.addEventListener('abort', () => { cancelled = true; c.error(new Error('stopped')); }, { once: true }); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = collect(helper(p).streamWithCustom('q', undefined, undefined, 's'));
    const rejected = assert.rejects(pending, /timed out/);
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(120_001);
    assert.equal(cancelled, false);
    t.mock.timers.tick(180_000);
    await rejected;
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});
test('oversized unterminated SSE frames fail boundedly without exposing the payload', async () => {
  const p = provider();
  respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data:' + 'PRIVATE'.repeat(320_000)); };
  await assert.rejects(collect(helper(p).streamWithCustom('q', undefined, undefined, 's')), e => {
    assert.match(e.message, /size limit/);
    assert.doesNotMatch(e.message, /PRIVATE/);
    return true;
  });
  assert.equal(posts.length, 1);
});
test('idle timeout still covers the body after headers and is not reported as user cancellation', async t => {
  const p = provider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(`data: ${JSON.stringify(reason)}\n\n`));
      opts.signal.addEventListener('abort', () => c.error(new Error('socket stopped PRIVATE')), { once: true });
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = collect(helper(p).streamWithCustom('q', undefined, undefined, 's', undefined, p, true));
    const rejected = assert.rejects(pending, e => {
      assert.equal(e.code, 'STREAM_IDLE_TIMEOUT');
      assert.doesNotMatch(e.message, /PRIVATE/);
      return true;
    });
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(60_001);
    await rejected;
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});
