import { customProviderIsLocal } from './visionCapability';

export const CUSTOM_REQUEST_TIMEOUT_MS = 300_000;
export const CUSTOM_LOCAL_IDLE_TIMEOUT_MS = 60_000;
const MAX_FRAME_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

export interface CustomAttemptState {
  outputStreamed: boolean;
  responseStarted?: boolean;
}

export class CustomProviderTransportError extends Error {
  constructor(
    message: string,
    public readonly code: 'PROVIDER_ERROR' | 'CONNECT_TIMEOUT' | 'STREAM_IDLE_TIMEOUT' = 'PROVIDER_ERROR',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CustomProviderTransportError';
  }
}

/** Only known JSON streaming contracts are adjusted; arbitrary templates stay intact. */
export function customRequestBody(body: unknown, streaming: boolean): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const json = body as Record<string, unknown>;
  if (!streaming && (Array.isArray(json.messages) || typeof json.stream === 'boolean')) {
    const { stream_options: _streamOptions, ...rest } = json;
    return { ...rest, stream: false };
  }
  if (streaming && Array.isArray(json.messages) && json.stream === undefined) return { ...json, stream: true };
  return body;
}

function parsePacket(payload: string): unknown {
  try { return JSON.parse(payload); } catch {
    throw new CustomProviderTransportError('Custom provider returned a malformed streaming event.');
  }
}

interface TransportOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  method: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  state: CustomAttemptState;
  extractWhole: (data: unknown) => string;
  extractDelta: (data: unknown) => string;
  /** JSONL packets use the configured answer path, unlike SSE deltas. */
  extractLine?: (data: unknown) => string;
  onHeaders?: () => void;
  onActivity?: () => void;
}

/** Fetch only: never execute the saved cURL in a shell. Errors contain no URL, body or credentials. */
export async function* streamCustomTransport(options: TransportOptions): AsyncGenerator<string> {
  const controller = new AbortController();
  let timeoutCode: 'CONNECT_TIMEOUT' | 'STREAM_IDLE_TIMEOUT' | undefined;
  const abortOnTimeout = (code: 'CONNECT_TIMEOUT' | 'STREAM_IDLE_TIMEOUT') => {
    timeoutCode = code;
    controller.abort();
  };
  const totalTimer = setTimeout(() => abortOnTimeout(options.state.responseStarted ? 'STREAM_IDLE_TIMEOUT' : 'CONNECT_TIMEOUT'), CUSTOM_REQUEST_TIMEOUT_MS);
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const local = customProviderIsLocal({ curlCommand: options.url });
  if (options.connectTimeoutMs && !local) {
    connectTimer = setTimeout(() => abortOnTimeout('CONNECT_TIMEOUT'), options.connectTimeoutMs);
  }
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortOnTimeout('STREAM_IDLE_TIMEOUT'), local ? CUSTOM_LOCAL_IDLE_TIMEOUT_MS : 30_000);
  };
  let response: Response | undefined;
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Cancelled', 'AbortError');
    response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: /^(GET|HEAD)$/i.test(options.method) ? undefined
        : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(connectTimer);
    options.onHeaders?.();
    if (!response.ok) {
      throw new CustomProviderTransportError(`Custom Provider HTTP ${response.status}`, 'PROVIDER_ERROR', response.status);
    }
    // A successful response proves the server accepted the request. Retrying a
    // body read/parse failure can duplicate generation even before answer text.
    options.state.responseStarted = true;
    if (!response.body) throw new CustomProviderTransportError('Custom provider returned no answer body.');
    // Local servers can flush headers before loading / prompt evaluation. The
    // existing five-minute total budget covers that warmup; once bytes arrive,
    // a separate idle budget detects a dead connection even during reasoning.
    if (!local) armIdle();
    yield* decodeCustomResponse(response, options, armIdle);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Cancelled', 'AbortError');
    if (timeoutCode) {
      throw new CustomProviderTransportError(
        timeoutCode === 'CONNECT_TIMEOUT' ? 'Custom provider timed out while connecting.' : 'Custom provider timed out waiting for response data.',
        timeoutCode,
      );
    }
    if (error instanceof CustomProviderTransportError) throw error;
    // Fetch/undici exceptions can embed the URL, credentials, or request config.
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
      ?? (error as { code?: string })?.code;
    const hint = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code ?? '') ? ` (${code})` : '';
    throw new CustomProviderTransportError(`Custom provider ${options.state.responseStarted ? 'connection ended before completion' : 'could not be reached'}${hint}.`);
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', onAbort);
    // Also closes upstream when the consumer stops reading or [DONE] arrives.
    controller.abort();
    try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* already closed */ }
  }
}

async function* decodeCustomResponse(response: Response, options: TransportOptions, onActivity: () => void): AsyncGenerator<string> {
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  let mode: 'sse' | 'json' | 'lines' | 'unknown' = type.includes('text/event-stream') ? 'sse'
    : type.includes('ndjson') || type.includes('jsonl') ? 'lines'
    : type.includes('application/json') ? 'json' : 'unknown';
  let buffer = '';
  let eventData: string[] = [];
  let eventChars = 0;
  let answerSeen = false;
  let done = false;
  let openAiStream = false;
  let finished = false;
  const decoder = new TextDecoder();
  const extract = (packet: any, kind: 'whole' | 'delta' | 'line'): string => {
    if (packet?.error) throw new CustomProviderTransportError('Custom provider reported an API error in the response.');
    if (kind !== 'whole' && Array.isArray(packet?.choices)) {
      if (packet.choices.some((choice: any) => choice?.delta !== undefined)) openAiStream = true;
      if (packet.choices.some((choice: any) => choice?.finish_reason != null)) finished = true;
    }
    const text = kind === 'whole' ? options.extractWhole(packet)
      : kind === 'line' ? (options.extractLine ?? options.extractDelta)(packet)
      : options.extractDelta(packet);
    if (text) { answerSeen = true; options.state.outputStreamed = true; }
    return text;
  };
  const dispatch = (): string => {
    const payload = eventData.join('\n');
    eventData = [];
    eventChars = 0;
    if (!payload) return '';
    if (payload.trim() === '[DONE]') { done = true; return ''; }
    return extract(parsePacket(payload), 'delta');
  };
  const line = (value: string): string => {
    if (mode === 'lines') return value.trim() ? extract(parsePacket(value), 'line') : '';
    if (!value) return dispatch();
    if (value.startsWith(':')) return '';
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let data = colon < 0 ? '' : value.slice(colon + 1);
    if (data.startsWith(' ')) data = data.slice(1);
    if (field === 'data') {
      eventChars += data.length;
      if (eventChars > MAX_FRAME_CHARS) throw new CustomProviderTransportError('Custom provider streaming event exceeded the size limit.');
      eventData.push(data);
    }
    return '';
  };
  const drain = function* (eof: boolean): Generator<string> {
    if (mode === 'unknown') {
      const start = buffer.trimStart();
      if (/^(?:data:|event:|id:|retry:|:)/.test(start)) mode = 'sse';
      else if (start.startsWith('{') || start.startsWith('[')) mode = 'lines';
      else if (!eof) return;
    }
    if (mode !== 'sse' && mode !== 'lines') return;
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const i = match.index;
      // A CR at the chunk boundary may be half of CRLF.
      if (buffer[i] === '\r' && i === buffer.length - 1 && !eof) break;
      const value = buffer.slice(0, i);
      const width = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(i + width);
      const text = line(value);
      if (text) yield text;
      if (done) return;
    }
    if (buffer.length > MAX_FRAME_CHARS) throw new CustomProviderTransportError('Custom provider response frame exceeded the size limit.');
    // Legacy JSONL endpoints sometimes omit newlines. JSON syntax, never a
    // network chunk boundary, determines when a complete object is available.
    if (mode === 'lines' && buffer.trim()) {
      let packet: unknown;
      try { packet = JSON.parse(buffer); } catch { if (!eof) return; throw new CustomProviderTransportError('Custom provider returned malformed JSON.'); }
      buffer = '';
      const text = extract(packet, 'line');
      if (text) yield text;
    }
    if (eof && mode === 'sse') {
      if (buffer) { const text = line(buffer); if (text) yield text; buffer = ''; }
      const text = dispatch();
      if (text) yield text;
    }
  };
  // Web ReadableStream async iteration is shared Node/Electron behavior on both OSes.
  for await (const bytes of response.body!) {
    if (options.signal?.aborted) return;
    onActivity(); // reasoning and keepalives are transport activity, not answer tokens
    options.onActivity?.();
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > MAX_RESPONSE_CHARS) throw new CustomProviderTransportError('Custom provider response exceeded the size limit.');
    yield* drain(false);
    if (done) break;
  }
  buffer += decoder.decode();
  if (!done) yield* drain(true);
  if (mode === 'json') {
    const text = extract(parsePacket(buffer), 'whole');
    if (text) yield text;
  } else if (mode === 'unknown' && buffer.trim()) {
    answerSeen = true;
    options.state.outputStreamed = true;
    yield buffer.trim();
  }
  if (mode === 'sse' && openAiStream && answerSeen && !done && !finished) {
    throw new CustomProviderTransportError('Custom provider connection ended before stream completion.');
  }
  if (!answerSeen && !options.signal?.aborted) {
    throw new CustomProviderTransportError('Custom provider returned no answer content (the response may contain only reasoning).');
  }
}
