/** Out-of-band provider timing, never an answer chunk or a request payload.
 * Symbol.for is intentional: Electron's independently bundled entry points must
 * read the same key (a module-local WeakMap would not survive that boundary).
 */
const POLICY = Symbol.for('natively.provider-stream-policy');
export interface ProviderStreamPolicy {
  readonly firstUsefulDeadlineMs: number;
  readonly interTokenStallMs: number;
  readonly signal?: AbortSignal;
  lastActivityAt?: number;
}
export function withProviderStreamPolicy<T extends AsyncIterable<string>>(stream: T, policy: ProviderStreamPolicy): T {
  Object.defineProperty(stream, POLICY, { value: policy });
  return stream;
}
export function providerStreamPolicy(stream: AsyncIterable<string>): ProviderStreamPolicy | undefined {
  return (stream as AsyncIterable<string> & { [POLICY]?: ProviderStreamPolicy })[POLICY];
}
