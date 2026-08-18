# Build: standards-conformant IAP auth for a Chrome extension, with an e2e harness

You are joining a repo mid-build. The toolchain and the test server already exist. Read the
"What already exists" section before opening any files — it should save you a full audit.

---

## Situation

We are building a Chrome extension that talks to an HTTP endpoint sitting behind an
**identity-aware proxy** (IAP) — a reverse proxy that authenticates the user and forwards the
request with an identity assertion. Cloudflare Access is the target deployment; Google IAP,
Teleport, and Pomerium are the same family. The client must be **generic**: no
provider-specific branching on the happy path.

The extension must also work correctly when the endpoint is **not** behind an IAP at all.

The project's real purpose is not the happy path — it is proving the client handles failure
without falling back on prompting the user. A network blip that produces a login prompt is the
bug we are hunting.

---

## What already exists

### Toolchain (do not change)

- **yarn** workspaces, one root lockfile, `packages/*`
- **Vite + Rolldown** (`rolldown-vite`) for the extension build
- **Vitest** for unit tests
- **Playwright** for e2e
- **Biome** and **strict TypeScript**, configured at the repo root

All code must be Biome-clean and typecheck with no errors. `pnpm biome check` and
`pnpm tsc --noEmit` are part of every checkpoint gate — treat a lint or type error like a
failing test, not something to defer.

### `packages/test-server` — complete, do not rebuild

One Node process, three listeners, serving **HTTPS** (a local CA and leaf certs are generated
at setup; the Playwright harness trusts them via `--ignore-certificate-errors-spki-list`).

1. **Authorization server** — `node-oidc-provider`: public clients
   (`token_endpoint_auth_method: 'none'`), authorization code + PKCE S256, refresh tokens,
   dynamic client registration, RFC 8707 resource indicators, revocation endpoint. Serves RFC
   8414 metadata at `/.well-known/oauth-authorization-server` (note: `node-oidc-provider`'s
   native path is `/.well-known/openid-configuration`, so this is an explicit alias).
2. **Resource server** — protected endpoints on **two distinct origins** (two ports, both in
   the cert SANs). Validates bearer tokens, emits RFC 9728 challenges and
   `/.well-known/oauth-protected-resource`.
3. **Control plane** — separate port, plain HTTP, never touched by the extension.

Control plane API:

```
POST /control/reset                    → clear all scenarios and the request log
POST /control/scenario {name, ...args} → arm a scenario
GET  /control/requests                 → the request log
```

The request log records method, origin, path, whether an `Authorization` header was present,
and a timestamp, for every AS and RS request. It is the primary behavioral assertion surface.

Scenarios:

*Token lifecycle* — `shortLivedTokens(seconds)`, `rejectNextAccessToken`,
`rotateRefreshTokens(on)`, `omitRefreshTokenOnRefresh`, `invalidGrantOnNextRefresh`,
`detectRefreshReplay`, `revokeGrant`

*Discovery* — `unprotected`, `appLevel401(kind)` (`basic` | `bare` | `json`), `appLevel403`,
`challengeWithoutMetadata`, `redirectToLoginPage`, `crossOriginResourceMetadata`,
`issuerMismatch`, `emptyAuthorizationServers`, `multipleAuthorizationServers`,
`noRegistrationEndpoint`, `malformedMetadata(kind)` (HTML | truncated | 10MB)

*Authorization* — `autoApprove`, `forceLogin`, `denyAuthorization`,
`stallAuthorization(seconds)`, `injectForeignCode`

*Transport* — `tokenEndpointStatus(code)`, `tokenEndpointHang(seconds)`,
`endpointUnreachable(which)` (`resourceMetadata` | `asMetadata` | `registration` |
`authorization` | `token`), `redirectToForeignOrigin`

### Orientation, not audit

Spend a few minutes confirming the above matches reality: read the control plane's route
definitions and the scenario registry. I've confirmed the smoke script succeeds. Do not read the
whole package. **If what you find diverges from this description, the code is the truth and
this description is the intent — surface the discrepancy and STOP rather than silently reconciling it.**

If a scenario listed above turns out to be missing, add it; that is a small gap, not a reason
to revisit the entire test server.

---

## The standards this is built on

- **RFC 9728** — Protected Resource Metadata. An unauthenticated request gets a `401` with
  `WWW-Authenticate: Bearer ... resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.
- **RFC 8414** — Authorization Server Metadata.
- **RFC 7591** — Dynamic Client Registration, so the client self-registers with no admin step.
- **RFC 7636** — PKCE (S256); the client is public.
- **RFC 8707** — Resource indicators, so tokens are audience-bound per host.
- **RFC 8252** — normative for a client using a custom redirect URI. An extension using
  `chrome.identity.launchWebAuthFlow` is structurally a **native app**, not a browser-based
  app, so RFC 8252 governs rather than `draft-ietf-oauth-browser-based-apps`.

---

## Architecture

Three extension contexts, with a deliberate split between token custody and token use.

**Service worker** — hosts the auth client, owns all token state, runs the authorization
dance, owns the DNR rules. `chrome.identity` is only available here.

**Offscreen document** — hosts a third-party library (partly WASM, partly transpiled TS) that
makes the actual requests to the resource server. `chrome.runtime` is the only extension API
available in an offscreen document, so the auth dance cannot live here. The library is **not
modified** and we install no fetch patch of our own.

**Popup** — minimal UI, needed for manual verification.

### Attaching the token: `declarativeNetRequest`

The library's bundled worker does its own fetch patching:

```ts
const realFetch = self.fetch.bind(self);
self.fetch = function patchedFetch(input, fetchInit) { ... return realFetch(input, fetchInit); }
```

`self` there is the global of a Worker — a dedicated Web Worker or a registered Service
Worker — not the offscreen document's `window`.

**Do not attempt to patch `globalThis.fetch` in the offscreen document.** A Worker has its own
global scope, entirely separate from the document that spawned it; there is no shared object
between the two. A document-level patch is not in the request path at all, regardless of load
order. And do not work around this by intercepting the `Worker` constructor to prepend a
script via `importScripts` — it is fragile, breaks for `type: 'module'` workers, and
reintroduces the load-order dependency this design exists to eliminate.

Use `declarativeNetRequest` instead. It operates on requests once they reach the network
stack, below any JS execution context, so whether `fetch()` was called from the document, a
dedicated Worker, or a chain of `importScripts` is invisible to it. This is also why no
library modification is needed.

**Two things DNR does not do:**

*It cannot see responses.* DNR is request-side only, so it cannot detect a `401` or trigger a
refresh. Something else must notice failure — see Component B.

*It may not cover a request-absorbing Service Worker.* If the library's worker is a registered
Service Worker that answers matching requests from its own `fetch` handler rather than
forwarding them, those responses never reach the network stack DNR operates on. Determine
which kind of worker the library uses and confirm empirically. If it is a request-absorbing
Service Worker, **stop and escalate** rather than reaching for a patch-based fallback.

**Verify the primitive first.** At checkpoint 2, before building anything on top, confirm with
a real request against the test server that a DNR `modifyHeaders` rule can `set` the
`Authorization` header and that the value reaches the server. Header-modification restrictions
have shifted across Chrome versions and differ by operation (`set` vs `append`). A five-minute
check that invalidates the whole design if it fails.

---

## Non-goals — do not build these

- **No test-only code, hooks, flags, or conditionals in `packages/iap-auth` or
  `packages/extension`.** The shipped artifact must be identical to the tested artifact.
  Coordination happens on the server and through CDP.
- No mocks or fakes of the extension runtime. Tests run the real extension in real Chrome. The
  only fake is the *server*, across a real network boundary.
- **No clock manipulation in the e2e suite.** Every timing condition there is reachable
  through a server-side scenario. A fake `Clock` in Vitest unit tests is fine and expected.
- No tests for coding hygiene — no assertions about logging, `localStorage`,
  `chrome.storage.sync`, or secrets in URLs. Lint rules and review cover those.
- No DNS-failure tests. In `fetch`, DNS failure, connection refusal, and TLS error are
  indistinguishable — all surface as `TypeError: Failed to fetch` — so there is no
  DNS-specific branch to exercise. Partial reachability is covered by `endpointUnreachable`.
- Do not enable `oauth4webapi`'s `allowInsecureRequests`. It is deprecated, and switching it on
  for tests would make the tested configuration differ from the shipped one. The test server
  serves HTTPS precisely so this isn't needed.

---

## Component A — `packages/iap-auth`

A standalone TypeScript module. **No `chrome.*` imports** — it must be liftable into another
extension, another runtime, or a unit test.

Build on **`oauth4webapi`** (panva): zero-dependency, Web Crypto based, runs unmodified in an
MV3 service worker. Use its primitives rather than hand-rolling —
`resourceDiscoveryRequest` / `processResourceDiscoveryResponse` (RFC 9728),
`discoveryRequest` / `processDiscoveryResponse` (RFC 8414),
`dynamicClientRegistrationRequest` / `processDynamicClientRegistrationResponse` (RFC 7591),
the PKCE helpers, `authorizationCodeGrantRequest`, `refreshTokenGrantRequest`, and
`WWWAuthenticateChallengeError`. Do not hand-parse `WWW-Authenticate`; quoted strings and
multiple challenges are easy to get subtly wrong.

### Adapters

```ts
// Named KeyValueStore, not Storage — `Storage` collides with the DOM lib global
// and will fail under strict TS in any package that includes lib.dom.
interface KeyValueStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Authorizer {
  // Single-shot and dumb. Opens the authorization URL, resolves with the redirect URL,
  // or rejects. It does NOT implement the silent-then-interactive ladder — that lives
  // in the module so the retry policy is testable without a browser.
  authorize(url: string, opts: { interactive: boolean }): Promise<string>;
  redirectUri(): string;
}

interface Clock { now(): number }
```

### Public API

```ts
createIapClient(opts: {
  session: KeyValueStore;   // volatile: access tokens
  durable: KeyValueStore;   // survives restart: client registrations, refresh tokens
  authorizer: Authorizer;
  clock?: Clock;
  logger?: Logger;
  fallbackClientId?: string;   // used when the AS has no registration_endpoint
}): IapClient

interface IapClient {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  probe(resource: string): Promise<ProbeResult>;
  login(resource: string, opts?: { interactive?: boolean }): Promise<void>;
  logout(resource: string): Promise<void>;

  /**
   * Returns a currently-valid token, refreshing or authorizing if needed. Subject to the
   * same single-flight lock, classification, and authorization ladder as `fetch`.
   * `tokenId` is an opaque stable identifier for this token instance — the same 8-char
   * hash used in logs.
   */
  getToken(resource: string, opts?: { interactive?: boolean }):
    Promise<{ token: string; tokenId: string }>;

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
  onTokenChanged(
    listener: (resource: string, token: string | null, tokenId: string | null) => Promise<void> | void
  ): () => void;   // returns an unsubscribe function
}

type ProbeResult =
  | { kind: 'unprotected' }
  | { kind: 'oauth'; authorizationServer: string; resource: string }
  | { kind: 'unsupported'; reason: string };
```

### `fetch` is optimistic — it must never pre-probe

A correctness requirement, not a performance note. `fetch` sends the request (attaching a
cached token if one exists for that resource), then reacts to the response. It must **not**
call `probe` first, which would double every request and issue discovery traffic against
endpoints that turn out to be unprotected.

`probe` is a standalone diagnostic for the popup and for tests. It is never on the `fetch`
path.

### Replayable request bodies

`fetch` retries once after a refresh. A `RequestInit.body` that is a `ReadableStream` cannot be
re-sent, and a consumed stream will fail silently or throw. Before the first attempt, either
buffer the body (string, `ArrayBuffer`, `Blob`, `FormData`, `URLSearchParams` are all safely
replayable) or, for a stream body, reject with a clear error telling the caller to buffer it.
Never retry with a consumed stream.

### Failure classification — the core correctness property

Every failure sorts into exactly one class with a distinct response. Most real bugs in this
domain are misclassifications, and the user-visible symptom is a spurious login prompt.

| Class | Trigger | Response |
|---|---|---|
| `TOKEN_STALE` | local expiry passed, or `401 invalid_token` on a token we believed valid | refresh silently, retry once |
| `GRANT_DEAD` | refresh returns `invalid_grant` | run the authorization ladder |
| `FORBIDDEN` | `403`, or `error=access_denied` on the redirect | surface to caller, **never** retry, **never** prompt |
| `TRANSPORT` | offline, connection failure, 5xx, 429, timeout | backoff and retry; **never** touch auth state, **never** prompt |
| `MISCONFIGURED` | bad metadata, issuer mismatch, no registration endpoint and no fallback | surface actionable error, do not prompt |

**The authorization ladder** lives in the module, in exactly one place: try
`authorize(url, { interactive: false })` first; on rejection, and only if the caller has not
passed `interactive: false` explicitly, retry with `{ interactive: true }`. The extension's
authorizer adapter is a single-shot wrapper over `launchWebAuthFlow` with no ladder logic.

### Behavioral requirements

- **Trust the server over local arithmetic.** A `401` on a token whose stored `expires_at` is
  in the future is still `TOKEN_STALE`. Local expiry is an optimization to avoid a round trip,
  not the source of truth.
- **No timers.** Refresh lazily on demand, checking `expires_at` with a 60s skew margin.
  `setTimeout` does not survive service worker termination.
- **Single-flight, keyed by resource.** Concurrent callers observing an expired token for the
  same resource must produce exactly one token endpoint request. Under refresh token rotation,
  a lost race replays a consumed refresh token, and a strict AS treats replay as compromise
  and revokes the grant. Different resources must not block each other.
- **`reportRejected` is idempotent by `tokenId`.** Several reports naming the same token
  produce **one** refresh. Reports arrive from request-handling code with no shared call stack,
  so this is easier to get wrong than `fetch`'s own lock. `getToken` must not return a token
  that `reportRejected` has already invalidated.
- **Await `onTokenChanged` listeners before resolving.** `updateSessionRules` is asynchronous;
  resolving before the rule is installed lets callers issue requests carrying a stale token.
  This closes the window for anything that waits on the module. It does **not** close it for
  the library, which issues requests on its own schedule — see Component B.
- **Interactive authorization coalesces, it does not fail.** A second `login` or
  `reportRejected` for the same resource while one is pending must await the first and resolve
  with the same outcome. Never let a raw `launchWebAuthFlow` "already pending" rejection reach
  the caller.
- **Rotation handling.** If a refresh response contains a new `refresh_token`, persist it. If
  it contains none, keep the existing one. Inverting this silently kills the session one
  refresh later.
- **Audience isolation.** Key the token cache by resource, never globally. One AS commonly
  fronts many hosts; a token minted for the wiki must never be attached to a request to
  payroll. Pass `resource` (RFC 8707) at registration, authorization, and token exchange.
- **Redirect safety.** Use `redirect: 'manual'` on protected-resource requests the module
  issues itself, so an `Authorization` header is never replayed to a redirect target.
- **Discovery validation.** Reject `resource_metadata` whose origin differs from the resource
  being accessed. Reject AS metadata whose `issuer` does not match the location it was fetched
  from. These are the spoofing defenses; treat them as security-critical.
- **Atomic cache writes.** Cache resource metadata, AS metadata, and the client registration in
  durable storage keyed by origin — but write only once the step it represents has fully
  completed. A partially fetched metadata document or unconfirmed `client_id` must never be
  persisted, or a transient failure poisons the install permanently. Registration runs once per
  install per AS, not per login.
- **Unprotected endpoints.** A resource returning 200 with no challenge to a credential-free
  request is unprotected: plain request, no `Authorization`, no discovery traffic, no prompt.
  Handle the unprotected → protected transition mid-session (the next `fetch` simply runs the
  flow). The reverse transition is not handleable the same way: once a token is already cached
  and attached, a 200 with no challenge is indistinguishable from "still protected, and this
  token is still valid" — nothing in the response tells you which. Don't attempt to detect it
  from response shape; a cached token left behind by a resource that quietly stopped requiring
  auth is inert, never consulted by anything the unprotected path does.
- **A 401 is not automatically an IAP challenge.** An unprotected-by-IAP resource may return
  `401` for its own reasons — `WWW-Authenticate: Basic`, a bare 401, a JSON API error. None
  may trigger discovery or a prompt. Only a `Bearer` challenge carrying `resource_metadata`
  starts the flow. Everything else passes through unchanged.
- **Logout without a revocation endpoint.** If AS metadata has no `revocation_endpoint`,
  `logout` clears local state and resolves successfully. It must not throw and must not be a
  silent no-op.

### Logging

Ship a verbose structured logger, enabled by default in this build, so misbehavior is obvious
at a glance rather than requiring a debugger.

- Levels `debug | info | warn | error`, tagged per subsystem (`discovery`, `dcr`, `pkce`,
  `token`, `refresh`, `classify`, `storage`, `dnr`). Configurable via the `logger` option;
  default `debug` here.
- **Log every classification decision explicitly** — input condition and resulting class. This
  is the single most valuable diagnostic, because misclassification is the dominant bug and it
  is otherwise silent.
- Log each discovery step with URL and decision, every cache hit and miss, every acquisition
  of the single-flight lock and every caller that waits on it, every storage read and write by
  key, and every `onTokenChanged` fire.
- Log token *identity*, never token *value*: an 8-character SHA-256 prefix suffices to tell
  "same token" from "different token" in a trace. Same for refresh tokens and codes.
- Include a monotonic sequence number and a correlation id per logical operation, so
  interleaved concurrent flows can be untangled.

---

## Component B — `packages/extension`

MV3. Minimal by design but not a stub: manual verification needs a human to trigger a login
and read the outcome.

### Manifest and permissions

- `identity`, `storage`, `offscreen`, `declarativeNetRequestWithHostAccess`
- `host_permissions` covering the test server origins and a wildcard-free production list.
  Host permissions are required for header modification, not just for `chrome.identity`.
- **Pin `key`** so the extension ID — and therefore the DCR `redirect_uri` — is deterministic
  across profiles and between unpacked and packed builds.

### Service worker

Hosts `IapClient`. Supplies `chrome.storage`-backed stores (access tokens in
`chrome.storage.session`; refresh tokens and client registrations in `chrome.storage.local` —
document the tradeoff in a comment) and a `launchWebAuthFlow`-backed authorizer using
`chrome.identity.getRedirectURL('cb')`.

The authorizer adapter passes `abortOnLoadForNonInteractive: false` and
`timeoutMsForNonInteractive: 10000` when called with `interactive: false`. It does not decide
*whether* to go interactive — the module owns that.

### DNR rule management

- Subscribe to `onTokenChanged`; call `chrome.declarativeNetRequest.updateSessionRules` to
  `set` `Authorization: Bearer <token>` for requests matching that resource's origin,
  replacing the prior rule for that origin by ID. **`await` the update inside the listener.**
- Use **session rules**, not dynamic rules — they need not survive a browser restart, matching
  where the access token itself lives.
- When a token is invalidated with no replacement (`token === null`), **remove** the rule
  rather than leaving a stale header in place. Library requests in that gap get a plain 401,
  which is correct and unavoidable.
- **Scope each rule to the resource origin only.** A rule scoped this way will not match a
  redirect to a different origin, so the header is not replayed — this is how the
  `redirect: 'manual'` guarantee is satisfied for library traffic, since you cannot set fetch
  options on requests you don't issue.
- One rule per resource origin. DNR holds only "attach this header to requests matching this
  origin" — no discovery or refresh policy in rule conditions.

**Header conflict with the module's own `fetch`:** DNR applies to `fetch()` in the extension
service worker too, so the module's own requests will have their `Authorization` header
**overwritten** by the rule's `set`. Normally both carry the same value; during a refresh
window they can diverge and DNR wins. Since the rule is only ever updated to the current
token, DNR winning is the safe outcome. Document it in a comment where the rule is installed
and note it in the module's `fetch`. Do not add rule conditions attempting to exclude
SW-initiated requests — SW and Worker traffic are not reliably distinguishable by
`resourceTypes`.

### Offscreen document

- Created from the service worker with `chrome.offscreen.createDocument`. Only one may exist
  per extension at a time — treat `hasDocument()` plus creation as a single-flight operation
  in the SW, or concurrent triggers race and throw.
- Hosts the library unmodified. **No fetch patch of our own.**

### Detecting failure

Something must notice a `401` and call `reportRejected`. Which depends on what the library
exposes. **Determine which applies and document the choice before proceeding past checkpoint
2:**

- **The library surfaces failed responses or throws a typed error.** Wrap that public error or
  response path — not `fetch` — to send `{type: 'reportRejected', resource, tokenId}` over
  `chrome.runtime`. A far narrower integration point than a network primitive: you are reading
  an outcome the library already exposes.
- **The library exposes nothing usable.** The SW polls a lightweight WS endpoint on its own
  (its own `fetch`, unrelated to the library) frequently enough to catch a revocation before
  the user notices broken syncs, treating a `401` there as the rejection signal. This is a
  genuine downgrade from per-request detection — document it as a known limitation, do not
  present it as equivalent.

To pass `tokenId` back, the SW exposes the current `tokenId` to the offscreen document over
`chrome.runtime` whenever it changes; the offscreen document echoes it in the report. If
`tokenId` cannot be obtained, `reportRejected` may be called with the SW's current tokenId —
but note this weakens idempotency, because two rejections spanning a refresh become
indistinguishable.

### Known limitation: the rule-update window

Between a token changing and `updateSessionRules` completing, a request the library issues on
its own schedule will carry the old token or none. Awaiting listeners closes this window for
anything that waits on the module; nothing can hold back the library.

The result is a request that 401s and is recovered by the normal rejection path — correct, but
one round trip slower. **Do not try to eliminate this by blocking library traffic during
updates.** Document it and make sure the rejection path handles it.

### Message protocol

```
{ type: 'fetch' | 'login' | 'logout' | 'probe', resource, opts }
{ type: 'reportRejected', resource, tokenId }  → { ok: true }
{ type: 'currentTokenId', resource }           → { tokenId }
```

`getToken` need not be exposed to the offscreen document — it no longer attaches tokens
itself. Keep it SW-internal, used by the polling fallback if that path applies.

**This message API is also the harness's driving surface**, so it must be the real interface
with nothing test-specific added.

### Popup

Target URL field (persisted), **Fetch** / **Login** / **Logout** buttons, and a status area
showing the last outcome — result class, HTTP status, and whether a prompt occurred.

---

## Component D — `packages/e2e`

Playwright, TypeScript, Chrome only. Must run against a **production build** — add a `pretest`
step running `pnpm build` and load the built output directory.

### Launch and reach

```ts
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    `--ignore-certificate-errors-spki-list=${testCaSpki}`,
  ],
});
let worker = context.serviceWorkers()[0]
  ?? await context.waitForEvent('serviceworker');
```

`worker.evaluate()` runs code **inside the real service worker**. That is how you observe and
drive without shipping test code:

- **Drive** — `chrome.runtime.sendMessage(...)` from the evaluate context, using the same
  message API the popup uses.
- **Observe state** — `chrome.storage.session.get()` / `.local.get()`. Pure observation.
- **Observe behavior** — `GET /control/requests`.

Prefer server-log assertions over storage assertions where both are possible; they are less
coupled to internal shape.

Because DNR operates at the network layer, verifying token attachment does **not** require a
handle on the offscreen document's internal execution context — the request log shows directly
whether a request carried the right header, regardless of which JS context issued it. To
*trigger* offscreen activity, use `chrome.runtime` messaging into the offscreen document (it
can receive messages even though `runtime` is the only API it exposes), not `worker.evaluate()`
or a CDP target handle.

### Waking a stopped service worker

Once you stop the worker your handle is dead and `evaluate` throws — and you cannot use
`evaluate` to wake it, because there is nothing left to evaluate in. Build a `wakeWorker()`
helper that opens `chrome-extension://<id>/popup.html` in a tab, which fires an extension event
and starts a fresh worker, then re-acquires the handle via
`context.waitForEvent('serviceworker')` and closes the tab. Every test that stops the worker
goes through this helper. **Get it working before writing the lifecycle tests**; discovering
the problem inside a test is much more confusing.

### Stand-in for the library

Do not vendor the real WASM library into the test build. Build a stand-in matching the
library's actual worker shape:

- **Dedicated Worker** (expected case): the stand-in's worker does its own
  `self.fetch = patchedFetch` at load, exactly like the real snippet, then calls `realFetch`
  from inside that Worker on command via a message relayed through the offscreen document.
  This is what proves DNR reaches Worker-issued requests.

**The stand-in must actually issue requests from inside the stand-in library's Worker.** A same-document `fetch`
would pass the attachment test while proving nothing.

This is not a mock of the extension runtime — it stands in for third-party code we don't own,
and lives in the extension package as a real module.

### Harness mechanics

- **Fresh `userDataDir` per test** for isolation. For browser-restart tests, close the context
  and relaunch against the *same* `userDataDir` — real `chrome.storage.session` clearing, not
  a simulation.
- **Service worker termination** via CDP: `context.newCDPSession(...)` and
  `ServiceWorker.stopAllWorkers`. Verify the worker is gone before continuing.
- **Auth tab interaction**: since Chrome 112, `launchWebAuthFlow` opens a real tab in the same
  context, so the login form is reachable with ordinary Playwright selectors. Wait via
  `context.waitForEvent('page')`. Many tests assert that **no** tab opens — assert that by
  racing a short timeout against the `page` event, not by sleeping arbitrarily.
- **Run headful under `xvfb`** in CI. Extension support in headless has been uneven.
- **Capture the service worker console** via `worker.on('console', ...)`, piped into the
  report with `testInfo.attach`, so a failure arrives with the full classification trace.
  **Re-attach after every `wakeWorker()`**, or you silently lose the trace for exactly the
  tests that need it most. Also capture the popup page console and auth-tab page errors.
- Fixtures: `testServer`, `extensionContext`, `serviceWorker`, `workerConsole`,
  `standIn` (relays commands into the stand-in Worker).
- Generous per-test timeouts for anything involving the authorization endpoint.

### Parameterization

The token lifecycle group (1–9) and the transport group (40–43) run **twice**: once driven
through the SW's `fetch` message, once through the stand-in Worker with DNR attachment. Add a
fixture parameter `via: 'sw' | 'worker'`. Discovery, authorization-response, and
partial-reachability groups stay SW-driven — those paths are identical in both modes.

---

## Test matrix

Each is a distinct test. Where an assertion is on the request log, state the expected count
explicitly. "No prompt" means asserting no page event fires.

**Token lifecycle**
1. Token expires locally → next `fetch` succeeds, exactly one token request, no auth tab.
2. `rejectNextAccessToken` with a locally-valid token → refresh and retry, success, no prompt.
3. `rotateRefreshTokens` → new refresh token persisted; a second refresh succeeds.
4. `omitRefreshTokenOnRefresh` → original retained; a second refresh succeeds.
5. `invalidGrantOnNextRefresh` + `autoApprove` → silent re-authorization, no visible tab.
6. `invalidGrantOnNextRefresh` + `forceLogin` → exactly one interactive prompt, then success.
7. `revokeGrant` mid-session → recovery terminates; no prompt loop. Bound by asserting a
   maximum request count.
8. `detectRefreshReplay` + ten parallel calls on an expired token → **exactly one** token
   request; all ten resolve; grant not revoked.
9. Ten parallel calls across **two different resources**, both expired → exactly two token
   requests, and neither resource's refresh blocks the other's.

**Process lifecycle**
10. Stop the service worker between two `fetch` calls → second succeeds, no prompt.
11. Stop the service worker while the token is expired → cold-start refresh path, no prompt.
12. Relaunch against the same `userDataDir` → access token gone, refresh token and client
    registration present.
13. Reload the extension → registration survives; in-flight PKCE verifier cleared; fresh login
    works immediately.
14. Two sequential logins reuse one client registration — exactly one DCR request total.

**Discovery**
15. `unprotected` → 200, zero `.well-known` requests, zero AS traffic, no prompt.
16. `unprotected` → `protected` mid-session → next `fetch` runs the flow and succeeds.
17. `protected` → `unprotected` mid-session, no prior cached token for this resource → no
    `Authorization` header sent.
18. `appLevel401('basic')` → 401 returned verbatim. Zero `.well-known` requests, zero AS
    traffic, no prompt. A `Basic` challenge must never be mistaken for an IAP challenge.
19. `appLevel401('bare')` and `appLevel401('json')` → same, per variant.
20. `appLevel403` → `FORBIDDEN`, returned to caller, no discovery, no prompt, no retry.
21. `challengeWithoutMetadata` → `MISCONFIGURED`, actionable message, no crash, no prompt.
22. `redirectToLoginPage` → `unsupported`; HTML never parsed as JSON.
23. **`crossOriginResourceMetadata` → rejected.** No request of any kind to the foreign origin.
    Security-critical.
24. `issuerMismatch` → rejected.
25. `emptyAuthorizationServers` → `MISCONFIGURED`.
26. `multipleAuthorizationServers` → deterministic, documented selection.
27. `noRegistrationEndpoint` with `fallbackClientId` → succeeds using it; without one → clear
    `MISCONFIGURED`.
28. `malformedMetadata` for HTML / truncated / oversized → clean failure, bounded memory, no
    hang.

**Authorization response**
29. Tampered `state` → rejected.
30. Wrong `code_verifier` → rejected, no token issued.
31. Authorization code replayed → second attempt fails; client does not wedge; fresh login
    works.
32. `denyAuthorization` → `FORBIDDEN`, not retried, distinct from an authentication failure.
    The "IdP login succeeded but policy denied" case.
33. Redirect with an error and no code → not treated as success.
34. `injectForeignCode` → rejected.

**Audience isolation**
35. Token minted for origin A, request issued against origin B → **no `Authorization` header
    reached origin B**, and a fresh flow ran for B rather than reusing A's token.
36. Two resources behind one AS → two independent token entries, no crosstalk, exactly one
    client registration.
37. `redirectToForeignOrigin` → `Authorization` not replayed. Run in both `via` modes: under
    `sw` this holds because of `redirect: 'manual'`; under `worker` because the DNR rule is
    origin-scoped.

**Interruption**
38. Close the auth tab mid-flow → rejection handled, lock releases, stale verifier cleared,
    immediate retry succeeds.
39. Second `login` for the same resource while one is pending → **coalesces** into the first
    and resolves with the same outcome. Exactly one auth tab opened.

**Transport vs. auth** — highest-value group, because false positives here are the bad UX this
project exists to fix
40. `context.setOffline(true)` → **no prompt**, no auth state mutation, `TRANSPORT` error.
    Restore connectivity → next request succeeds with the original token.
41. `tokenEndpointStatus(500)` → backoff and retry, not re-authorization. No auth tab.
42. `tokenEndpointStatus(429)` with `Retry-After` → honored; without it → default backoff.
43. `tokenEndpointHang` → `AbortController` fires, `TRANSPORT`, no prompt.

**Partial reachability** — the chain fails midway with everything else healthy. Whole-network
offline cannot reach these. For each: classified `TRANSPORT`, **no prompt**, and **no poisoned
cache** — a retry after `reset` succeeds without a fresh install or manual cache clear.
44. `endpointUnreachable('resourceMetadata')` → challenge parsed, metadata unreachable;
    `TRANSPORT`, **not** `MISCONFIGURED`. These must not be conflated: one is retryable, the
    other is not.
45. `endpointUnreachable('asMetadata')` → 9728 probe succeeds, discovery fails. Resource
    metadata may be cached; a half-fetched AS metadata document must not be.
46. `endpointUnreachable('registration')` → discovery cached and reused on retry; no partial
    `client_id` persisted. On retry, exactly one further DCR request and zero further discovery
    requests.
47. `endpointUnreachable('authorization')` → fails before any tab opens; no orphaned PKCE
    verifier; immediate retry after `reset` works.
48. `endpointUnreachable('token')` after a successful authorization → the code is consumed and
    unrecoverable, so this must degrade to a clean re-authorization rather than a stuck state
    or a retry loop against a dead code.

**Request replay** (SW `fetch` only — the library owns its own bodies)
49. Buffered POST body (string / `FormData`) hitting `rejectNextAccessToken` → refresh happens
    and the body is resent intact; the RS sees the same body twice.
50. `ReadableStream` body → rejected up front with a clear error, not silently retried with a
    consumed stream.

**Logout**
51. `logout` calls the revocation endpoint, clears local state, next request prompts.
52. `logout` against an AS with no `revocation_endpoint` → resolves cleanly, clears state, no
    throw.

**DNR attachment**
53. Stand-in **Worker's** requests reach the RS with an `Authorization` header, asserted from
    the request log. Confirm the request genuinely originated in the Worker.
54. `onTokenChanged` completes and the session rule is installed before `getToken` resolves; a
    request issued immediately after resolution carries the new token.
55. Token refreshes mid-session (`shortLivedTokens`) → the rule updates; a Worker request
    issued during the update window that carries a stale token 401s and is recovered on retry
    without a prompt.
56. Worker request while the rule is temporarily absent (invalidated, no replacement yet) →
    401, recovered via the rejection path, no prompt.
57. Ten concurrent `reportRejected` calls naming the same `tokenId` → exactly one token
    endpoint request, exactly one rule update.
58. `reportRejected` naming an already-superseded `tokenId` → no-op, no second refresh.
59. Worker request to a **non-protected** origin → no rule matches, no `Authorization` header,
    confirmed from the request log.
60. `forceLogin` + ten concurrent `reportRejected` calls → exactly **one** auth tab; the rule
    updates once, after login completes.
61. `logout` → the session rule is removed; a subsequent Worker request reaches the RS with no
    `Authorization` header.
62. `appLevel403` reached through the Worker → not reported as a rejection, no refresh, no rule
    change. The detection mechanism must distinguish this from a real 401.
63. The module's own SW `fetch` while a rule is active → exactly one `Authorization` header
    carrying the current token, confirming the documented DNR-wins behavior rather than a
    duplicated or conflicting header.
64. Test removed, ignore.

**Slow-tagged**
65. `stallAuthorization(400)` → the authorization tab sits open for over six minutes and the
    flow still completes, proving the service worker survives, since
    `identity.launchWebAuthFlow` is exempt from the five-minute timeout. Tag `@slow`, exclude
    from the default run.

---

## `docs/manual-verification.md`

Only for what genuinely cannot be automated. Note that tab-close, concurrent login, and long
authorization dwell **are** automated, so the human steps are narrower than they first appear.

1. **Real library.** Confirm its requests carry the `Authorization` header the DNR rule
   attached.
2. **Real IdP conformance.** Point the extension at a live Cloudflare Access application with
   Managed OAuth enabled. Confirm: the 401 carries `resource_metadata`; DCR accepts a
   `https://<extension-id>.chromiumapp.org/cb` redirect URI (every published example uses a
   loopback URI, so this is the highest-risk unknown in the project); the 900-second lifetime
   refreshes cleanly. Record whether `oauth4webapi`'s strict validation accepts Cloudflare's
   `issuer`, which is served without a scheme and is therefore not a valid RFC 8414 issuer
   identifier. If it rejects, file with Cloudflare rather than loosening the library. Note that
   Cloudflare's tokens carry an `oauth:` prefix — this should require no special handling since
   the token is opaque to the client; confirm it in fact doesn't.
3. **Cloudflare's PKCE parsing bug.** Cloudflare documents that a code challenge beginning with
   `-` or `_` corrupts the authorization URL and produces a misleading
   `code_challenge_method must be S256 for public clients` error. Generate challenges until one
   starts with a non-alphanumeric character and confirm whether it still reproduces. Do **not**
   add a workaround preemptively — if it reproduces, it belongs in a documented provider quirk
   table, not the generic path.
4. **SSO carry-over.** With a live IdP session already in the profile, confirm the silent path
   completes with no visible UI. This depends on `launchWebAuthFlow` sharing the profile's
   cookie jar, which it does since Chrome 112 via the browser-tab flow, but real IdPs add
   conditional access and device posture on top.
5. **Real MFA.** Confirm a hardware key or push prompt completes without the flow aborting.
6. **Policy denial with a real IdP.** Authenticate as a user the Access policy excludes; confirm
   the message distinguishes "we don't know who you are" from "we know, and no."
7. **Packed build.** Load the packed `.crx` / store build and confirm the extension ID matches
   the unpacked one, so the registered `redirect_uri` is valid for both.
8. **Comprehensibility.** Watch someone unfamiliar with the project hit an expired session. The
   auth tab should be self-evidently a login, and the status area should say something a
   non-developer can act on.

---

## Working agreement

Build in this order and **stop for review at each checkpoint**:

1. `packages/iap-auth`, with Vitest unit tests against in-memory adapters (no browser). This is
   the one place a fake `Clock` is legitimate — use it for skew-margin and expiry arithmetic.
   Cover the authorization ladder, the single-flight lock, idempotent invalidation, and the
   await-listeners-before-resolving ordering here, since none of them need Chrome.
   **Checkpoint.**
2. `packages/extension`: service worker, DNR rule management, popup, offscreen document hosting
   the stand-in with no fetch patch of our own. **First**, verify the DNR `set`-`Authorization`
   primitive works at all against the test server. **Then** determine and document which
   failure-detection path applies (typed library errors vs. SW polling). Manually verify a
   stand-in Worker request reaches the test server with a bearer token attached. **Checkpoint.**
3. Playwright fixtures, `wakeWorker()`, the stand-in relay, and tests 1, 8, 10, 15, 23, 40, 53,
   57 — one from each group, chosen to prove the harness can reach everything it needs before
   you invest in the other fifty. **Checkpoint.**
4. The remaining tests, including the `via: 'sw' | 'worker'` parameterization.
5. Review `docs/mutation-check.md` for completeness. Comply with the project-level memory
   `project-mutation-check-requirement` -- in brief, for each test not covered in the matrix in the
   doc, devise a mutation to prove that it is not vacuous and add a row to the matrix. If the
   mutation revealed a test gap, both fix the gap *and* document the discovery and fix in
   `docs/mutation-check.md`.
6. `docs/manual-verification.md` (currently some manual verification steps are above and need to be moved into that file).

Each checkpoint includes `pnpm biome check` and `pnpm tsc --noEmit` passing clean across all
touched packages.

If a test cannot be written without adding a hook to the extension, **stop and say so** rather
than adding the hook — that constraint is the point of the exercise, and a missing test is a
better outcome than a divergent artifact.
