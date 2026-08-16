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

// IapClient's classify() only ever throws these three, but an Authorizer rejection (e.g. the
// user closed the auth tab, or a silent attempt was refused with interactive:false) isn't a
// classify() outcome at all — it's propagated unchanged. UNKNOWN covers that case for callers
// of this message API, which don't get IapClient's typed errors directly.
export type FailureClass = 'FORBIDDEN' | 'TRANSPORT' | 'MISCONFIGURED' | 'UNKNOWN';

export type FetchOutcome =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: string;
      promptOccurred: boolean;
    }
  | { ok: false; errorClass: FailureClass; message: string; promptOccurred: boolean };

export type ActionOutcome =
  | { ok: true; promptOccurred: boolean }
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
