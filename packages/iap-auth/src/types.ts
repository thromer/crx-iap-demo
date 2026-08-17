// Named KeyValueStore, not Storage — `Storage` collides with the DOM lib global
// and will fail under strict TS in any package that includes lib.dom.
export interface KeyValueStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Authorizer {
  // Single-shot and dumb. Opens the authorization URL, resolves with the redirect URL,
  // or rejects. It does NOT implement the silent-then-interactive ladder — that lives
  // in the module so the retry policy is testable without a browser.
  authorize(url: string, opts: { interactive: boolean }): Promise<string>;
  redirectUri(): string;
}

export interface Clock {
  now(): number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSubsystem =
  | 'discovery'
  | 'dcr'
  | 'pkce'
  | 'token'
  | 'refresh'
  | 'classify'
  | 'storage'
  | 'dnr'
  | 'lock';

export interface Logger {
  debug(subsystem: LogSubsystem, message: string, data?: Record<string, unknown>): void;
  info(subsystem: LogSubsystem, message: string, data?: Record<string, unknown>): void;
  warn(subsystem: LogSubsystem, message: string, data?: Record<string, unknown>): void;
  error(subsystem: LogSubsystem, message: string, data?: Record<string, unknown>): void;
}

// INTERACTION_REQUIRED (checkpoint-3 review, Task 3): a silent authorization attempt found no
// usable session, and the caller explicitly passed `interactive: false` — forbidding the
// module's own silent-to-interactive escalation. This is neither FORBIDDEN (nothing was
// denied — there is simply no session to reuse silently, and interactive authorization would
// likely succeed) nor MISCONFIGURED (nothing is broken). Response policy: surface to the
// caller, do not retry, do not auto-escalate — the caller asked not to, and may deliberately
// call again with `interactive: true` if it wants to prompt the user itself.
export type FailureClass = 'FORBIDDEN' | 'TRANSPORT' | 'MISCONFIGURED' | 'INTERACTION_REQUIRED';

export class IapError extends Error {
  readonly class: FailureClass;
  override readonly cause?: unknown;

  constructor(failureClass: FailureClass, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.class = failureClass;
    this.cause = options?.cause;
    this.name = 'IapError';
  }
}

export type ProbeResult =
  | { kind: 'unprotected' }
  | { kind: 'oauth'; authorizationServer: string; resource: string }
  | { kind: 'unsupported'; reason: string };

export type TokenChangeListener = (
  resource: string,
  token: string | null,
  tokenId: string | null,
) => Promise<void> | void;

export interface CreateIapClientOptions {
  session: KeyValueStore; // volatile: access tokens
  durable: KeyValueStore; // survives restart: client registrations, refresh tokens
  authorizer: Authorizer;
  clock?: Clock;
  logger?: Logger;
  fallbackClientId?: string; // used when the AS has no registration_endpoint
}

export interface IapClient {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  probe(resource: string): Promise<ProbeResult>;
  login(resource: string, opts?: { interactive?: boolean }): Promise<void>;

  /**
   * Clears local state unconditionally and never throws — this holds whether there is no
   * revocation_endpoint to call, or one exists but the revocation attempt itself fails (e.g.
   * a transport failure). `revoked` distinguishes the two: true only when the AS confirmed
   * the revocation; false covers both "nothing to revoke" and "revocation was attempted and
   * failed" (checkpoint-3 review, Task 4 — a failed revocation must be visible to the caller,
   * not indistinguishable from success).
   */
  logout(resource: string): Promise<{ revoked: boolean }>;

  /**
   * Returns a currently-valid token, refreshing or authorizing if needed. Subject to the
   * same single-flight lock, classification, and authorization ladder as `fetch`.
   * `tokenId` is an opaque stable identifier for this token instance — the same 8-char
   * hash used in logs.
   */
  getToken(
    resource: string,
    opts?: { interactive?: boolean },
  ): Promise<{
    token: string;
    tokenId: string;
  }>;

  /**
   * Reports that a token was rejected by the resource server. Idempotent: repeated calls
   * naming the same `tokenId` invalidate once. A call naming an already-superseded tokenId
   * is a no-op, not an error. Resolves once a fresh token is ready, or rejects with a
   * classified error if none is obtainable.
   */
  reportRejected(resource: string, tokenId: string): Promise<void>;

  /**
   * Fires whenever the valid token for a resource changes — initial acquisition, refresh,
   * rotation, re-authorization — and whenever it becomes invalid with no replacement
   * (token === null). This is what keeps the DNR rule in sync.
   *
   * Listeners may be async. The module must await all listeners before resolving the
   * getToken/reportRejected call that triggered the change, so the DNR rule is in place
   * before the caller is told the token is ready.
   */
  onTokenChanged(listener: TokenChangeListener): () => void;
}
