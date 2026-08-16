import * as oauth from 'oauth4webapi';
import { IapError } from './types.ts';

// Distinguishes retryable transport failure from a configuration/protocol problem in an
// oauth4webapi rejection. Used for discovery, DCR, and token-endpoint calls alike.
function classify(err: unknown): 'transport' | 'misconfigured' | 'other' {
  if (err instanceof TypeError) return 'transport'; // fetch-level network failure
  if (err instanceof DOMException && err.name === 'AbortError') return 'transport';
  if (err instanceof oauth.OperationProcessingError) {
    if (err.code === oauth.RESPONSE_IS_NOT_CONFORM && err.cause instanceof Response) {
      const status = err.cause.status;
      if (status === 429 || status >= 500) return 'transport';
    }
    return 'misconfigured';
  }
  if (err instanceof oauth.ResponseBodyError) {
    if (err.status === 429 || err.status >= 500) return 'transport';
    return 'misconfigured';
  }
  return 'other';
}

function describe(err: unknown): string {
  if (err instanceof oauth.ResponseBodyError) {
    return err.error_description ? `${err.error}: ${err.error_description}` : err.error;
  }
  return err instanceof Error ? err.message : String(err);
}

export function toIapError(err: unknown, context: string): IapError {
  if (err instanceof IapError) return err;
  const kind = classify(err);
  const message = describe(err);
  if (kind === 'transport') {
    return new IapError('TRANSPORT', `${context}: transport failure (${message})`, { cause: err });
  }
  return new IapError('MISCONFIGURED', `${context}: ${message}`, { cause: err });
}

export type TokenEndpointOutcome = 'transport' | 'invalid_grant' | 'other';

export function classifyTokenEndpointError(err: unknown): TokenEndpointOutcome {
  if (err instanceof TypeError) return 'transport';
  if (err instanceof DOMException && err.name === 'AbortError') return 'transport';
  if (err instanceof oauth.ResponseBodyError) {
    if (err.error === 'invalid_grant') return 'invalid_grant';
    if (err.status === 429 || err.status >= 500) return 'transport';
    return 'other';
  }
  if (err instanceof oauth.OperationProcessingError) {
    if (err.code === oauth.RESPONSE_IS_NOT_CONFORM && err.cause instanceof Response) {
      const status = err.cause.status;
      if (status === 429 || status >= 500) return 'transport';
    }
    return 'other';
  }
  return 'other';
}
