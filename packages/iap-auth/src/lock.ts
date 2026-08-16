import type { Logger } from './types.ts';

// Single-flight, keyed by resource. Concurrent callers for the same key coalesce onto the
// same in-flight promise instead of each re-running `fn`. Callers for different keys never
// block each other.
export class KeyedSingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly logger: Logger) {}

  run<T>(key: string, correlationId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.logger.debug('lock', 'waiting on in-flight operation', { key, correlationId });
      return existing as Promise<T>;
    }

    this.logger.debug('lock', 'acquired', { key, correlationId });
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
      this.logger.debug('lock', 'released', { key, correlationId });
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
