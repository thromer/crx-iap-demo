export interface RequestLogEntry {
  seq: number;
  timestamp: number;
  server: 'as' | 'rs-a' | 'rs-b';
  method: string;
  origin: string;
  path: string;
  hadAuthorizationHeader: boolean;
  // The Authorization header's bearer token, hashed the same way IapClient's own tokenId is
  // (see hash.ts) — identity, never the raw value. undefined when hadAuthorizationHeader is
  // false, or the header isn't a well-formed `Bearer <token>` (checkpoint-3 review, Task 13).
  authorizationTokenId: string | undefined;
  // The OAuth `error` field from this request's response body, when it's an error response
  // (RFC 6749 §5.2 shape: `{error: "...", ...}`) — captured generically from whatever actually
  // gets written, whether from this project's own scenario handlers or oidc-provider's native
  // error responses (invalid_client, invalid_grant from PKCE failure, etc.), so a test can
  // assert *which* defense rejected a request instead of only that something did
  // (checkpoint-3 review, Task 20). undefined for non-error responses.
  errorCode: string | undefined;
}

export type AppLevel401Kind = 'basic' | 'bare' | 'json';
export type MalformedMetadataKind = 'html' | 'truncated' | 'oversized';
export type UnreachableEndpoint =
  | 'resourceMetadata'
  | 'asMetadata'
  | 'registration'
  | 'authorization'
  | 'token'
  // Missing from the original registry — needed for the checkpoint-3 review's Task 4
  // (logout must report a failed revocation attempt to the caller, not just clear state).
  | 'revocation'
  // The protected resource itself, distinct from 'resourceMetadata' — needed for the
  // checkpoint-3 review's Task 14 (recovering test 40's 'via: worker' variant server-side,
  // since context.setOffline() doesn't reach the stand-in Worker's own fetch in this
  // environment).
  | 'resource';

export interface ScenarioState {
  shortLivedTokensSeconds: number | undefined;
  rejectNextAccessToken: boolean;
  rotateRefreshTokens: boolean;
  omitRefreshTokenOnRefresh: boolean;
  invalidGrantOnNextRefresh: boolean;
  detectRefreshReplay: boolean;
  revokeGrant: boolean;

  unprotected: boolean;
  appLevel401: AppLevel401Kind | undefined;
  appLevel403: boolean;
  challengeWithoutMetadata: boolean;
  redirectToLoginPage: boolean;
  crossOriginResourceMetadata: boolean;
  issuerMismatch: boolean;
  emptyAuthorizationServers: boolean;
  multipleAuthorizationServers: boolean;
  noRegistrationEndpoint: boolean;
  noRevocationEndpoint: boolean;
  malformedMetadata:
    | { kind: MalformedMetadataKind; target: 'resourceMetadata' | 'asMetadata' }
    | undefined;

  autoApprove: boolean;
  forceLogin: boolean;
  denyAuthorization: boolean;
  stallAuthorizationSeconds: number | undefined;
  injectForeignCode: boolean;
  tamperState: boolean;
  rejectCodeExchange: boolean;
  reissuePreviousCode: boolean;
  // A code correctly bound to the real client_id/redirect_uri but to an AS-chosen
  // code_challenge, not the client's own — isolates a genuine PKCE code_verifier mismatch from
  // the client-identity-binding rejection injectForeignCode exercises (checkpoint-3 review,
  // Task 20, test 34a).
  substituteCodeChallenge: boolean;

  tokenEndpointStatus: { code: number; retryAfter: number | undefined } | undefined;
  tokenEndpointHangSeconds: number | undefined;
  unreachable: Set<UnreachableEndpoint>;
  redirectToForeignOrigin: boolean;
}

export function defaultScenarioState(): ScenarioState {
  return {
    shortLivedTokensSeconds: undefined,
    rejectNextAccessToken: false,
    rotateRefreshTokens: false,
    omitRefreshTokenOnRefresh: false,
    invalidGrantOnNextRefresh: false,
    detectRefreshReplay: false,
    revokeGrant: false,

    unprotected: false,
    appLevel401: undefined,
    appLevel403: false,
    challengeWithoutMetadata: false,
    redirectToLoginPage: false,
    crossOriginResourceMetadata: false,
    issuerMismatch: false,
    emptyAuthorizationServers: false,
    multipleAuthorizationServers: false,
    noRegistrationEndpoint: false,
    noRevocationEndpoint: false,
    malformedMetadata: undefined,

    autoApprove: true,
    forceLogin: false,
    denyAuthorization: false,
    stallAuthorizationSeconds: undefined,
    injectForeignCode: false,
    tamperState: false,
    rejectCodeExchange: false,
    reissuePreviousCode: false,
    substituteCodeChallenge: false,

    tokenEndpointStatus: undefined,
    tokenEndpointHangSeconds: undefined,
    unreachable: new Set(),
    redirectToForeignOrigin: false,
  };
}

class TestServerState {
  scenarios: ScenarioState = defaultScenarioState();
  requestLog: RequestLogEntry[] = [];
  private seq = 0;

  // Captured, not a toggle: the first authorization code minted while `reissuePreviousCode`
  // is armed, replayed for every subsequent interaction under that same scenario (checkpoint-3
  // review, Task 12, test 31).
  reissuedCode: string | undefined;

  reset(): void {
    this.scenarios = defaultScenarioState();
    this.requestLog = [];
    this.seq = 0;
    this.reissuedCode = undefined;
  }

  // Returns the assigned seq so the caller can attach an errorCode later, once the response
  // body is actually known (checkpoint-3 review, Task 20) — logged at request start, same as
  // before, so entry ordering across concurrent requests is unaffected.
  logRequest(entry: Omit<RequestLogEntry, 'seq' | 'timestamp' | 'errorCode'>): number {
    this.seq += 1;
    this.requestLog.push({ ...entry, seq: this.seq, timestamp: Date.now(), errorCode: undefined });
    return this.seq;
  }

  // First-write-wins: a provider error *event* (see as.ts's captureGrantErrorDetail) carries
  // the unstripped detail and fires before the response is written, so it's always tried
  // first; the response-body fallback (captureResponseErrorCode) only fills in when nothing
  // more specific was already captured — e.g. this project's own scenario handlers, which
  // never trigger oidc-provider's own error events at all (checkpoint-3 review, Task 20).
  setRequestErrorCode(seq: number, errorCode: string): void {
    const found = this.requestLog.find((e) => e.seq === seq);
    if (found && found.errorCode === undefined) found.errorCode = errorCode;
  }
}

export const state = new TestServerState();
