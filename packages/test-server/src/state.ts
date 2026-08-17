export interface RequestLogEntry {
  seq: number;
  timestamp: number;
  server: 'as' | 'rs-a' | 'rs-b';
  method: string;
  origin: string;
  path: string;
  hadAuthorizationHeader: boolean;
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
  | 'revocation';

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

  reset(): void {
    this.scenarios = defaultScenarioState();
    this.requestLog = [];
    this.seq = 0;
  }

  logRequest(entry: Omit<RequestLogEntry, 'seq' | 'timestamp'>): void {
    this.seq += 1;
    this.requestLog.push({ ...entry, seq: this.seq, timestamp: Date.now() });
  }
}

export const state = new TestServerState();
