import type { Logger, LogSubsystem } from './types.ts';
import { IapError } from './types.ts';

// A single AS/RS round trip should not be allowed to hang indefinitely: the service worker
// has no wall-clock guarantee, so every network call this module makes carries a bounded
// timeout via AbortSignal.
export const REQUEST_TIMEOUT_MS = 8_000;

export function requestSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

// The single chokepoint for network I/O in this module. Every fetch this module issues —
// directly, or as oauth4webapi's `[customFetch]` override — must go through this, so a raw
// fetch-level rejection (offline, connection refused, DNS, TLS, or our own AbortSignal timeout
// firing) is classified as TRANSPORT in exactly one place rather than at each call site
// individually. `context` labels the resulting error message with which stage failed (e.g.
// "AS metadata fetch"), matching the granularity call sites previously got from their own
// local try/catch.
//
// oauth4webapi does not wrap fetch failures itself — its request-issuing primitives
// (discoveryRequest, authorizationCodeGrantRequest, etc.) just `return fetch(...)` directly, so
// whatever this throws propagates unmodified back to the caller. See
// node_modules/oauth4webapi/build/index.js's performDiscovery/protectedResourceRequest/etc.
async function classifiedFetch(
  context: string,
  input: string | URL,
  init: unknown,
): Promise<Response> {
  try {
    return await fetch(input, init as RequestInit);
  } catch (err) {
    throw new IapError(
      'TRANSPORT',
      `${context}: transport failure (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

// For this module's own direct fetch() calls (currently just the RFC 9728 resource metadata
// request — see discovery.ts's doc comment on why it doesn't go through oauth4webapi's
// resourceDiscoveryRequest primitive).
export function transportFetch(
  context: string,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => classifiedFetch(context, input, init);
}

// For oauth4webapi's `[customFetch]` slot. Typed with `options: unknown` rather than the
// library's own `CustomFetchOptions<Method, BodyType>` deliberately: that type doesn't
// structurally match plain `RequestInit` under `exactOptionalPropertyTypes` (its `body` field
// isn't optional the same way), and it differs per call site's Method/BodyType generics. A
// function parameter typed `unknown` is a valid supertype of any of those, so this satisfies
// oauth4webapi's expected signature at every call site without fighting that variance.
export function transportCustomFetch(
  context: string,
): (input: string, init: unknown) => Promise<Response> {
  return (input, init) => classifiedFetch(context, input, init);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_TRANSPORT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

// Backs off and retries a bounded number of times on transport-classified failures only.
// Auth state (refresh tokens, cached metadata) must never be touched here — the caller's
// `attempt` closure owns that, and this helper only decides whether to try again.
export async function withTransportRetry<T>(
  logger: Logger,
  subsystem: LogSubsystem,
  correlationId: string,
  isTransportError: (err: unknown) => boolean,
  retryAfterMs: (err: unknown) => number | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_TRANSPORT_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (!isTransportError(err)) throw err;
      if (i === MAX_TRANSPORT_ATTEMPTS - 1) break;
      const backoffMs = retryAfterMs(err) ?? BASE_BACKOFF_MS * 2 ** i;
      logger.warn(subsystem, 'transport failure, backing off and retrying', {
        attempt: i + 1,
        maxAttempts: MAX_TRANSPORT_ATTEMPTS,
        backoffMs,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}
