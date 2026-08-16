import type { Logger, LogSubsystem } from './types.ts';

// A single AS/RS round trip should not be allowed to hang indefinitely: the service worker
// has no wall-clock guarantee, so every network call this module makes carries a bounded
// timeout via AbortSignal.
export const REQUEST_TIMEOUT_MS = 8_000;

export function requestSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
