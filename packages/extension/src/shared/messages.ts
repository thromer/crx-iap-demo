// The message API documented in PROMPT.md — this is also the e2e harness's driving surface,
// so nothing test-specific is added here or anywhere it's handled.

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface LoginOpts {
  interactive?: boolean;
}

export type SwRequest =
  | { type: 'fetch'; resource: string; opts?: FetchOpts }
  | { type: 'login'; resource: string; opts?: LoginOpts }
  | { type: 'logout'; resource: string }
  | { type: 'probe'; resource: string }
  | { type: 'reportRejected'; resource: string; tokenId: string }
  | { type: 'currentTokenId'; resource: string };

// The first four mirror @iap-demo/iap-auth's own FailureClass (including INTERACTION_REQUIRED,
// added in the checkpoint-3 review's Task 3 — see packages/iap-auth/src/types.ts and
// authorize.ts's throwClassifiedAuthorizerRejection() for what it means and how the two
// authorizer-rejection cases Chrome actually produces are told apart). UNKNOWN is this
// message layer's own addition: after Task 3, it is reachable only from a genuinely
// unrecognized authorizer rejection — logged as an anomaly at the point classify() produces
// it (packages/extension/src/service-worker/index.ts) — not a normal outcome.
export type FailureClass =
  | 'FORBIDDEN'
  | 'TRANSPORT'
  | 'MISCONFIGURED'
  | 'INTERACTION_REQUIRED'
  | 'UNKNOWN';

export type FetchOutcome =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: string;
      promptOccurred: boolean;
    }
  | { ok: false; errorClass: FailureClass; message: string; promptOccurred: boolean };

// `revoked` is set only on a 'logout' response (checkpoint-3 review, Task 4) — see
// IapClient#logout's doc comment in packages/iap-auth/src/types.ts for what it distinguishes.
// Absent on 'login'/'reportRejected' responses, which have nothing to report there.
export type ActionOutcome =
  | { ok: true; promptOccurred: boolean; revoked?: boolean }
  | { ok: false; errorClass: FailureClass; message: string; promptOccurred: boolean };

export type ProbeOutcome =
  | { kind: 'unprotected' }
  | { kind: 'oauth'; authorizationServer: string; resource: string }
  | { kind: 'unsupported'; reason: string };

export type CurrentTokenIdOutcome = { tokenId: string | null };

// Broadcast from the service worker to every extension context (popup, offscreen) whenever
// the valid token for a resource changes, per IapClient#onTokenChanged. Not a request/reply —
// no response is expected.
export interface TokenChangedBroadcast {
  type: 'tokenChanged';
  resource: string;
  tokenId: string | null;
}

// Drives the stand-in library's Worker from outside the extension (popup, or the e2e
// harness) via chrome.runtime messaging into the offscreen document — see PROMPT.md's
// "Component D" notes on why this goes through messaging rather than a CDP/worker handle.
export interface StandInFetchRequest {
  type: 'standinFetch';
  resource: string;
  path: string;
  method?: string;
}

// Just the status: whether the right header reached the server is a question for the
// test-server's own request log, not this protocol — see PROMPT.md's preference for
// server-log assertions over anything this message API would have to plumb through itself.
export type StandInFetchOutcome = { ok: true; status: number } | { ok: false; message: string };
