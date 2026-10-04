// electron/llm/localProviderReadiness.ts
//
// Cold-start support for LOOPBACK custom endpoints (LM Studio, llama.cpp's
// llama-server, vLLM...). A local server that is still loading its model
// refuses the chat connection outright (ECONNREFUSED) or answers 408/502/503/
// 504 — and GET {origin}/models is what tells us when it has come up. This
// module decides which failures mean "not ready yet" rather than a real
// error, then polls for readiness so LLMHelper can wait once and retry the
// same request instead of surfacing the error on the first message to a cold
// server. Remote endpoints never reach this: loopback-ness is decided per URL.

/** Hostnames that mean "a process on THIS machine" — bracketed and IPv4-mapped forms included; the port never matters for this purpose. */
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '::ffff:127.0.0.1',
]);

/** Statuses a cold local server answers with while it is still coming up; anything else (401/404/500/...) is a real error and must fail as fast as before. */
const NOT_READY_HTTP_STATUSES = new Set([408, 502, 503, 504]);

/** Budget per /models probe — small on purpose: this runs inside the user's live chat turn. */
const READINESS_PROBE_TIMEOUT_MS = 2_500;
/** Cadence between probes. */
const READINESS_POLL_INTERVAL_MS = 1_500;

/**
 * The origin of `inputUrl` when it points at loopback, otherwise null — the
 * "remote endpoint" signal meaning keep today's behavior byte-for-byte.
 */
export function resolveLoopbackOrigin(inputUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed.origin;
}

/**
 * True when the failure looks like "the server is not up yet" rather than a
 * real error: either fetch got NO HTTP status (connection refused/reset, or
 * our own connect-timeout abort) or it answered one of the cold-start
 * statuses. The numeric-status test matches how _streamChatInner shapes its
 * user-facing error sentence, so both layers classify identically.
 */
export function isNotReadyProviderFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return NOT_READY_HTTP_STATUSES.has(status);
  // No HTTP status means fetch never got a response: the transport itself failed.
  return true;
}

export interface LocalProviderReadinessOptions {
  /** e.g. `http://localhost:1234` — must be loopback (see resolveLoopbackOrigin). */
  origin: string;
  /** Model id from the chat request body, when available. Empty = skip the match check: any non-empty model list counts as ready. */
  modelId?: string;
  /** The same headers the chat request carries — some gateways require auth for /models too. */
  headers?: Record<string, string>;
  /** The caller's turn signal — an aborted turn stops polling promptly. */
  abortSignal?: AbortSignal;
  /** Total wait budget in ms. Exhausting it is NOT a failure: the caller makes one final attempt anyway. */
  waitBudgetMs: number;
}

/** One GET {origin}/models probe. Never throws — unreachable and slow servers both just read as "not ready yet". */
async function probeForReadiness(
  origin: string,
  modelId: string,
  headers: Record<string, string> | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<boolean> {
  if (abortSignal?.aborted) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READINESS_PROBE_TIMEOUT_MS);
  // Bind the probe to the caller's turn signal too, so a cancelled turn stops
  // probing without waiting out this request's own deadline.
  const onCallerAbort = () => controller.abort();
  abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    const res = await fetch(`${origin}/models`, { headers, signal: controller.signal });
    if (!res.ok) return false; // not up yet (or an auth wall): keep polling until the budget elapses.
    let payload: unknown;
    try {
      payload = await res.json(); // an HTML error page is "not ready" too — keep polling.
    } catch {
      return false;
    }
    const candidate = payload as { data?: unknown; models?: unknown };
    const rows = Array.isArray(candidate.data) ? candidate.data : Array.isArray(candidate.models) ? candidate.models : null;
    if (!rows || rows.length === 0) return false; // empty list: the model is not loaded yet.
    // A non-empty catalogue means UP whether or not our exact id is listed —
    // unknown server semantics get assumed ready rather than waited out (only
    // an EMPTY list above keeps us waiting). The distinction still deserves one log line.
    if (modelId) {
      const wanted = modelId.toLowerCase();
      const hasRequestedModel = rows.some((m) => typeof m?.id === 'string' && (m.id as string).toLowerCase() === wanted);
      console.log(
        `[localProviderReadiness] ${origin} ready${hasRequestedModel ? ` with ${modelId}` : ` without ${modelId} listed yet — proceeding anyway`}`,
      );
    }
    return true;
  } catch {
    // Connection refused / probe timeout — exactly the state this wait exists for. Keep polling.
    return false;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Poll GET {origin}/models until it is ready or `waitBudgetMs` elapses, then
 * report whether readiness was reached. The caller makes its one final attempt
 * in EITHER outcome — budget exhaustion is a "try once anyway" signal, not an
 * error. An aborted turn returns false promptly.
 */
export async function waitForLocalProviderReady(options: LocalProviderReadinessOptions): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, options.waitBudgetMs);
  for (;;) {
    if (options.abortSignal?.aborted) return false;
    if (await probeForReadiness(options.origin, options.modelId ?? '', options.headers, options.abortSignal)) return true;
    if (Date.now() >= deadline) break; // budget exhausted — the caller makes one final attempt anyway.
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
  }
  return false;
}
