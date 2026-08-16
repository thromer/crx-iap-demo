# Task: standards-conformant IAP auth client for Chrome extensions, plus a test harness

## Context

An **identity-aware proxy** (IAP) sits in front of an HTTP endpoint, authenticates the
user, and forwards the request with an identity assertion. Cloudflare Access, Google IAP,
Teleport, and Pomerium are examples. A recent generation of these proxies exposes a
standards-based OAuth path for non-browser clients, built from:

- **RFC 9728** — Protected Resource Metadata. An unauthenticated request gets a `401` with
  `WWW-Authenticate: Bearer ... resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.
- **RFC 8414** — Authorization Server Metadata at `/.well-known/oauth-authorization-server`.
- **RFC 7591** — Dynamic Client Registration, so a client self-registers with no admin step.
- **RFC 7636** — PKCE (S256), because the client is public.
- **RFC 8707** — Resource indicators, so tokens are audience-bound per host.
- **RFC 8252** — the normative guidance for how a client with a custom redirect URI runs the
  flow. An extension using `chrome.identity.launchWebAuthFlow` is structurally a native app,
  *not* a browser-based app, so RFC 8252 governs rather than
  `draft-ietf-oauth-browser-based-apps`.

Build a client that walks that chain generically — with no provider-specific branching in the
happy path — and a test harness that proves it handles the failure modes rather than falling
back on prompting the user.

## Deliverables

1. `packages/iap-auth` — a standalone TypeScript module implementing the client. No Chrome
   APIs imported directly; see the adapter requirement below.
2. `packages/extension` — a thin MV3 Chrome extension that wires the module to
   `chrome.identity` and `chrome.storage`, with the minimum UI the manual tests require.
3. `packages/test-server` — a fake authorization server + resource server with a control
   plane the harness drives.
4. `packages/e2e` — the Playwright suite.
5. `docs/manual-verification.md` — the checklist of things the harness cannot cover.

TypeScript throughout. Chrome only — do not add Firefox or Safari compatibility shims.

## Toolchain

- **pnpm** workspaces. One lockfile at the root, `pnpm-workspace.yaml` covering `packages/*`.
- **Vite with the Rolldown bundler** (`rolldown-vite`) for `packages/extension`.
- **Vitest** for unit tests in `packages/iap-auth` and `packages/test-server`.
- **Playwright** for `packages/e2e`.
- **Biome** for lint and format, and **strict TypeScript**. `biome.json` and `tsconfig.json`
  will be supplied at the repo root — use them as given, extend per-package only if a package
  genuinely needs a different `tsconfig` (e.g. DOM lib for the popup vs. no-DOM for the
  service worker and `iap-auth`). All code must be Biome-clean and typecheck with no errors;
  treat both as part of the checkpoint gate at every step, not a final pass at the end.

**Bundling is required**, contrary to what you might assume from not having a content script.
An MV3 service worker declared `"type": "module"` supports ESM, but bare specifiers like
`import * as oauth from 'oauth4webapi'` do not resolve in the browser and extensions cannot
use import maps. Every npm dependency has to be bundled regardless of where it runs.

Keep the Vite config dumb: plain multi-entry build (service worker, popup), no
`@crxjs/vite-plugin`, no HMR. HMR would inject dev-only code into the artifact, which breaks
the shipped-equals-tested rule below.

**The Playwright suite must run against a production build**, not a dev build. Add a
`pretest` step that runs `pnpm build` and have the harness load the built output directory.

## Non-goals — do not build these

- Do not write tests for coding hygiene: no assertions about logging, `localStorage`,
  `chrome.storage.sync`, or secrets in URLs. Enforce those with lint rules or code review,
  not with the e2e suite.
- Do not test DNS failure as such. In `fetch`, DNS failure, connection refusal, and TLS error
  are indistinguishable — all surface as `TypeError: Failed to fetch` — so there is no
  DNS-specific branch to exercise. The realistic scenario behind the question, partial
  reachability, is covered by the `endpointUnreachable` scenario instead.
- **Do not manipulate the system clock anywhere in the e2e suite.** Every timing condition
  there is reachable through a server-side knob. If you find yourself wanting to skew a clock,
  add a control-plane scenario instead. (A fake `Clock` in Vitest unit tests is fine and
  expected — see the working agreement.)
- No mocks or fakes of the extension runtime. Tests run the real extension in real Chrome.
  The only fake is the *server*, which is on the far side of a real network boundary.
- **No test-only code, hooks, flags, or conditionals in `packages/iap-auth` or
  `packages/extension`.** The shipped artifact must be identical to the tested artifact.
  Coordination happens on the server and through CDP; see "How the harness reaches the
  extension".

---

## Component A — `packages/iap-auth`

Build on **`oauth4webapi`** (panva). It is zero-dependency, Web Crypto based, and runs
unmodified in an MV3 service worker. Use its primitives rather than hand-rolling:
`resourceDiscoveryRequest` / `processResourceDiscoveryResponse` for RFC 9728,
`discoveryRequest` / `processDiscoveryResponse` for RFC 8414,
`dynamicClientRegistrationRequest` / `processDynamicClientRegistrationResponse` for RFC 7591,
the PKCE helpers, `authorizationCodeGrantRequest`, `refreshTokenGrantRequest`, and
`WWWAuthenticateChallengeError` for challenge parsing. Do not hand-parse
`WWW-Authenticate` — quoted strings and multiple challenges are easy to get subtly wrong.

**Do not enable `allowInsecureRequests`.** It is deprecated, and switching it on for tests
would mean the tested configuration differs from the shipped one. The test server serves
HTTPS instead; see Component C.

### Adapter boundary

The module must not import `chrome.*`. Inject these adapters so it is liftable into another
extension, another runtime, or a unit test:

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

interface Clock { now(): number }   // injected for unit tests only; e2e uses the real one
```

The extension supplies `chrome.storage`-backed stores, a `launchWebAuthFlow`-backed
authorizer, and the system clock.

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
}

type ProbeResult =
  | { kind: 'unprotected' }
  | { kind: 'oauth'; authorizationServer: string; resource: string }
  | { kind: 'unsupported'; reason: string };   // e.g. 302 to a login page, or 401 with no metadata
```

### `fetch` is optimistic — it must never pre-probe

This is a correctness requirement, not a performance note. `fetch` sends the request
(attaching a cached token if one exists for that resource), then reacts to the response.
It must **not** call `probe` first, which would double every request and would issue
discovery traffic against endpoints that turn out to be unprotected.

`probe` exists as a standalone diagnostic for the popup and for tests. It is never on the
`fetch` path.

### Replayable request bodies

`fetch` retries once after a refresh. A `RequestInit.body` that is a `ReadableStream` cannot
be re-sent, and a consumed stream will fail silently or throw on retry. Before the first
attempt, either buffer the body (string, `ArrayBuffer`, `Blob`, `FormData`, `URLSearchParams`
are all safely replayable) or, for a stream body, reject with a clear error explaining that
the caller must buffer it. Do not attempt a retry with a consumed stream.

### Failure classification — the core correctness property

Every failure must be sorted into exactly one of these, and each has a distinct response.
Most real bugs in this domain are misclassifications, and the user-visible symptom of a
misclassification is a spurious login prompt.

| Class | Trigger | Response |
|---|---|---|
| `TOKEN_STALE` | local expiry passed, or `401 invalid_token` on a token we believed valid | refresh silently, retry once |
| `GRANT_DEAD` | refresh returns `invalid_grant` | run the authorization ladder below |
| `FORBIDDEN` | `403`, or `error=access_denied` on the redirect | surface to caller, **never** retry, **never** prompt |
| `TRANSPORT` | offline, connection failure, 5xx, 429, timeout | backoff and retry; **never** touch auth state, **never** prompt |
| `MISCONFIGURED` | bad metadata, issuer mismatch, no registration endpoint and no fallback | surface actionable error, do not prompt |

**The authorization ladder** lives in the module, in exactly one place: try
`authorize(url, { interactive: false })` first; on rejection, and only if the caller has not
passed `interactive: false` explicitly, retry with `{ interactive: true }`. The extension's
authorizer adapter is a single-shot wrapper over `launchWebAuthFlow` and contains no ladder
logic of its own.

### Behavioral requirements

- **Trust the server over local arithmetic.** A `401` on a token whose stored `expires_at` is
  in the future is still `TOKEN_STALE`. Local expiry is an optimization to avoid a round trip,
  not the source of truth.
- **No timers.** Refresh lazily on demand, checking `expires_at` with a 60s skew margin.
  `setTimeout` does not survive service worker termination.
- **Single-flight, keyed by resource.** Concurrent callers observing an expired token for the
  same resource must produce exactly one token endpoint request. Under refresh token rotation,
  a lost race replays a consumed refresh token, and a strict AS treats replay as compromise
  and revokes the grant. Requests for *different* resources must not block each other.
- **Interactive authorization coalesces, it does not fail.** A second `login` for the same
  resource while one is pending must await the first and resolve with the same outcome. Do not
  let a raw `launchWebAuthFlow` "already pending" rejection reach the caller.
- **Rotation handling.** If a refresh response contains a new `refresh_token`, persist it. If
  it contains none, keep the existing one. Getting this inverted silently kills the session
  one refresh later.
- **Audience isolation.** Key the token cache by resource, never globally. One AS commonly
  fronts many hosts; a token minted for the wiki must never be attached to a request to
  payroll. Pass `resource` (RFC 8707) at registration, authorization, and token exchange.
- **Redirect safety.** Use `redirect: 'manual'` on protected-resource requests so an
  `Authorization` header is never replayed to a redirect target.
- **Discovery validation.** Reject `resource_metadata` whose origin differs from the resource
  being accessed. Reject AS metadata whose `issuer` does not match the location it was
  fetched from. These are the spoofing defenses; treat them as security-critical.
- **Atomic cache writes.** Cache resource metadata, AS metadata, and the client registration
  in durable storage, keyed by origin — but only write a cache entry once the step it
  represents has fully completed. A partially fetched metadata document or an unconfirmed
  `client_id` must never be persisted, or a transient failure poisons the install
  permanently. Registration runs once per install per AS, not per login.
- **Unprotected endpoints.** A resource that returns 200 with no challenge is unprotected:
  issue a plain request with no `Authorization` header, no discovery traffic, and no prompt.
  Handle the transition in both directions mid-session — a resource that becomes protected
  must run the flow on the next request; one that becomes unprotected must stop sending
  tokens.
- **A 401 is not automatically an IAP challenge.** An unprotected-by-IAP resource may return
  `401` for its own application-level reasons — `WWW-Authenticate: Basic`, a bare 401 with no
  challenge header, or a JSON API error. None of these may trigger discovery or a login
  prompt. Only a `Bearer` challenge carrying a `resource_metadata` parameter starts the flow.
  Anything else is passed through to the caller unchanged.
- **Logout without a revocation endpoint.** If AS metadata has no `revocation_endpoint`,
  `logout` clears local state and resolves successfully. It must not throw and must not be a
  silent no-op.

### Logging

Ship a verbose structured logger, enabled by default in this reference build, so that
misbehavior is obvious at a glance rather than requiring a debugger.

- Levels `debug | info | warn | error`, with a tag per subsystem (`discovery`, `dcr`, `pkce`,
  `token`, `refresh`, `classify`, `storage`). Configurable through the `logger` option so a
  consuming extension can turn it down; default to `debug` here.
- **Log every classification decision explicitly** — the input condition and the resulting
  class from the table above. This is the single most valuable diagnostic, because
  misclassification is the dominant bug and it is otherwise silent.
- Log each step of the discovery chain with the URL fetched and the decision made, every
  cache hit and miss, every acquisition of the single-flight lock and every caller that waits
  on it, and every storage read and write by key.
- Log token *identity*, never token *value*: an 8-character SHA-256 prefix is enough to tell
  "same token" from "different token" in a trace. Same for refresh tokens and codes.
- Include a monotonic sequence number and a correlation id per logical operation, so
  interleaved concurrent flows can be untangled in the console.

---

## Component B — `packages/extension`

MV3. Minimal by design, but not a stub: the manual verification steps need a human to be able
to trigger a login and read the outcome.

- Service worker hosting the `IapClient`.
- Popup with: a target URL field (persisted), a **Fetch** button, a **Login** button, a
  **Logout** button, and a status area showing the last outcome — result class, HTTP status,
  and whether a prompt occurred.
- A `chrome.runtime` message API (`{type: 'fetch'|'login'|'logout'|'probe', resource, opts}`)
  that the popup uses. **This is also the harness's driving surface**, so it must be the real
  interface with nothing test-specific added to it.
- Storage split: access tokens in `chrome.storage.session`; refresh tokens and client
  registrations in `chrome.storage.local`. Document the tradeoff in a comment — session
  storage means re-login on browser restart.
- `identity` and `storage` permissions; `host_permissions` covering the test server origins
  and a wildcard-free production list.
- **Pin `key` in the manifest** so the extension ID, and therefore the DCR `redirect_uri`, is
  deterministic across profiles and between unpacked and packed builds.
- Use `chrome.identity.getRedirectURL('cb')` for the redirect URI.
- The authorizer adapter passes `abortOnLoadForNonInteractive: false` and
  `timeoutMsForNonInteractive: 10000` when called with `interactive: false`. It does not
  decide *whether* to go interactive — the module owns that.

---

## Component C — `packages/test-server`

One Node process, three listeners.

**Everything must be served over HTTPS.** `oauth4webapi` rejects plaintext HTTP for
authorization server and metadata endpoints, and we are not enabling the deprecated
`allowInsecureRequests` escape hatch. Generate a local CA and leaf certificates at setup
(mkcert, or a scripted `node-forge`/`selfsigned` step committed as a fixture), and have the
Playwright harness trust them — either by installing the CA into the browser profile or by
launching Chrome with `--ignore-certificate-errors-spki-list=<base64 SPKI>`. Prefer the SPKI
allowlist over blanket `--ignore-certificate-errors`, which would mask genuine TLS
misconfiguration.

1. **Authorization server** — `node-oidc-provider`, configured for public clients
   (`token_endpoint_auth_method: 'none'`), authorization code + PKCE S256, refresh tokens,
   dynamic client registration enabled, RFC 8707 resource indicators (the `resourceIndicators`
   feature), and a revocation endpoint.
   **Note:** `node-oidc-provider` serves OIDC discovery at `/.well-known/openid-configuration`.
   RFC 8414 clients look for `/.well-known/oauth-authorization-server`. You must explicitly
   serve that path — either mount an alias or serve a tailored OAuth metadata document. Verify
   with curl at checkpoint 1; this is a common source of a confusing first failure.
2. **Resource server** — serves protected endpoints on **two distinct origins** for the
   audience isolation tests. Use two ports on the same host, and make sure both are in the
   extension's `host_permissions` and both are covered by the TLS certificate (SANs).
   Validates bearer tokens; emits RFC 9728 challenges and `/.well-known/oauth-protected-resource`.
3. **Control plane** — a separate port, never touched by the extension. Plain HTTP is fine
   here since only the harness talks to it.

### Control plane API

```
POST /control/reset                    → clear all scenarios and the request log
POST /control/scenario {name, ...args} → arm a scenario
GET  /control/requests                 → the request log
```

The **request log** is the primary behavioral assertion surface. Record method, origin, path,
whether an `Authorization` header was present, and a timestamp, for every AS and RS request.
"Was the token endpoint hit once or ten times?" is how you test single-flight; "did any
request to origin B carry a header?" is how you test audience isolation.

### Scenarios to implement

Token lifecycle:
- `shortLivedTokens(seconds)` — issue `expires_in: N`
- `rejectNextAccessToken` — RS returns `401 invalid_token` for a token the client believes valid
- `rotateRefreshTokens(on)` — return a new `refresh_token` on each refresh
- `omitRefreshTokenOnRefresh` — refresh response carries no `refresh_token`
- `invalidGrantOnNextRefresh` — refresh returns `invalid_grant`
- `detectRefreshReplay` — second use of a consumed refresh token revokes the whole grant
- `revokeGrant` — server-side revocation mid-session

Discovery:
- `unprotected` — RS returns 200 with no challenge
- `appLevel401(kind)` — an unprotected-by-IAP resource returning its own 401:
  `basic` (`WWW-Authenticate: Basic realm="app"`), `bare` (no challenge header), or
  `json` (a JSON error body)
- `appLevel403` — an unprotected-by-IAP resource returning its own 403
- `challengeWithoutMetadata` — 401 with no `resource_metadata` parameter
- `redirectToLoginPage` — 302 to an HTML login page instead of a 401
- `crossOriginResourceMetadata` — `resource_metadata` points at a different origin
- `issuerMismatch` — AS metadata `issuer` does not match its location
- `emptyAuthorizationServers`, `multipleAuthorizationServers`
- `noRegistrationEndpoint`
- `malformedMetadata(kind)` — HTML, truncated JSON, or a 10MB body

Authorization:
- `autoApprove` — no login form; exercises the silent path
- `forceLogin` — always show the form
- `denyAuthorization` — redirect with `error=access_denied`
- `stallAuthorization(seconds)` — hold the authorization endpoint open; drives the long-dwell test
- `injectForeignCode` — return a code minted for a different client

Transport:
- `tokenEndpointStatus(code)` — 500 / 429, with and without `Retry-After`
- `tokenEndpointHang(seconds)`
- `endpointUnreachable(which)` — destroy the socket immediately for one specific endpoint,
  leaving all others healthy. `which` ∈ `resourceMetadata | asMetadata | registration |
  authorization | token`. This simulates partial reachability (split-horizon DNS, a
  disconnected VPN, a firewalled AS) in a way that whole-network offline cannot.
- `redirectToForeignOrigin` — the protected resource 302s to a different origin, to prove the
  `Authorization` header is not replayed
- `offline` — the harness uses Playwright's `context.setOffline(true)` instead

---

## Component D — `packages/e2e`

Playwright, TypeScript, Chrome only.

### How the harness reaches the extension

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
- **Observe state** — `chrome.storage.session.get()` / `chrome.storage.local.get()`. Pure
  observation; requires nothing from the extension.
- **Observe behavior** — `GET /control/requests`.

Prefer server-log assertions over storage assertions where both are possible; they are less
coupled to internal shape.

### Waking a stopped service worker

Once you stop the worker, your `worker` handle is dead and `evaluate` will throw — and you
cannot use `evaluate` to wake it, because there is nothing left to evaluate in. You need an
external event. Build a `wakeWorker()` helper that opens the extension's popup page
(`chrome-extension://<id>/popup.html`) in a tab, which fires an extension event and starts a
fresh worker, then re-acquires the handle via `context.waitForEvent('serviceworker')` and
closes the tab. Every test that stops the worker must go through this helper. Get it working
before writing the lifecycle tests; discovering the problem inside a test is much more
confusing.

### Harness mechanics

- **Fresh `userDataDir` per test** for isolation. For the browser-restart tests, close the
  context and relaunch against the *same* `userDataDir` — this exercises real
  `chrome.storage.session` clearing rather than a simulation of it.
- **Service worker termination** via CDP: `context.newCDPSession(...)` and
  `ServiceWorker.stopAllWorkers`. Verify the worker is actually gone before continuing.
- **Auth tab interaction**: since Chrome 112 `launchWebAuthFlow` opens a real tab in the same
  context, so the login form is reachable with ordinary Playwright selectors. Wait for the
  page via `context.waitForEvent('page')`. Several tests assert that **no** tab opens — assert
  that by racing a short timeout against the `page` event, not by sleeping arbitrarily.
- **Run headful under `xvfb`** in CI. Extension support in headless has been uneven; do not
  assume it works.
- **Capture the service worker console.** Attach to `worker.on('console', ...)` and pipe it
  into the Playwright report via `testInfo.attach`, so a failing test comes with the full
  classification trace from the logger described in Component A. Re-attach after every
  `wakeWorker()`, or you will silently lose the trace for exactly the tests that need it most.
  Also capture the popup page console and any auth-tab page errors.
- Fixtures: `testServer` (spawns and resets the control plane), `extensionContext`,
  `serviceWorker`, `workerConsole`.
- Set generous per-test timeouts for anything involving the authorization endpoint.

---

## Automated test matrix

Write each of these as a distinct test. Where an assertion is on the request log, state the
expected count explicitly. "No prompt" means asserting no page event fires, per above.

**Token lifecycle**
1. Token expires locally → next `fetch` succeeds, exactly one token request, no auth tab.
2. `rejectNextAccessToken` with a locally-valid token → client refreshes and retries, request
   succeeds, no prompt. (Trust the 401 over local arithmetic.)
3. `rotateRefreshTokens` → new refresh token is persisted; a second refresh succeeds.
4. `omitRefreshTokenOnRefresh` → original refresh token retained; a second refresh succeeds.
5. `invalidGrantOnNextRefresh` + `autoApprove` → silent re-authorization, no visible tab.
6. `invalidGrantOnNextRefresh` + `forceLogin` → exactly one interactive prompt, then success.
7. `revokeGrant` mid-session → recovery terminates; no prompt loop. Bound the test by
   asserting a maximum request count.
8. `detectRefreshReplay` + ten parallel `fetch` calls on an expired token → **exactly one**
   token request; all ten resolve successfully; grant not revoked.
9. Ten parallel `fetch` calls across **two different resources**, both expired → exactly two
   token requests, and neither resource's refresh blocks the other's.

**Process lifecycle**
10. Stop the service worker between two `fetch` calls → second succeeds, no prompt.
11. Stop the service worker while the token is expired → cold-start refresh path, no prompt.
12. Relaunch against the same `userDataDir` → access token gone, refresh token and client
    registration present.
13. Reload the extension → client registration survives; any in-flight PKCE verifier is
    cleared and a fresh login works immediately.
14. Two sequential logins reuse one client registration — exactly one DCR request total.

**Discovery**
15. `unprotected` → 200, zero requests to any `.well-known` path, zero AS traffic, no prompt.
16. `unprotected` → `protected` mid-session → next `fetch` runs the flow and succeeds.
17. `protected` → `unprotected` mid-session → no `Authorization` header sent.
18. `appLevel401('basic')` → the 401 is returned to the caller verbatim. Zero `.well-known`
    requests, zero AS traffic, no prompt. A `Basic` challenge must never be mistaken for an
    IAP challenge.
19. `appLevel401('bare')` and `appLevel401('json')` → same, for each variant.
20. `appLevel403` → classified `FORBIDDEN`, returned to the caller, no discovery, no prompt,
    no retry.
21. `challengeWithoutMetadata` → `MISCONFIGURED`, actionable message, no crash, no prompt.
22. `redirectToLoginPage` → `unsupported`; HTML is never parsed as JSON.
23. **`crossOriginResourceMetadata` → rejected.** No request of any kind is made to the
    foreign origin. Security-critical.
24. `issuerMismatch` → rejected.
25. `emptyAuthorizationServers` → `MISCONFIGURED`.
26. `multipleAuthorizationServers` → deterministic, documented selection.
27. `noRegistrationEndpoint` with `fallbackClientId` supplied → succeeds using it; without one
    → clear `MISCONFIGURED`.
28. `malformedMetadata` for each of HTML / truncated / oversized → clean failure, bounded
    memory, no hang.

**Authorization response**
29. Tampered `state` → rejected.
30. Wrong `code_verifier` → rejected, no token issued.
31. Authorization code replayed → second attempt fails; client does not wedge; a fresh login
    works.
32. `denyAuthorization` → classified `FORBIDDEN`, not retried, distinct from an authentication
    failure. This is the "IdP login succeeded but policy denied" case.
33. Redirect with an error and no code → not treated as success.
34. `injectForeignCode` → rejected.

**Audience isolation**
35. Token minted for origin A, `fetch` issued against origin B → assert from the request log
    that **no `Authorization` header reached origin B**, and that the client ran a fresh flow
    for B rather than reusing A's token.
36. Two resources behind one AS → two independent token entries, no crosstalk, exactly one
    client registration.
37. `redirectToForeignOrigin` → `Authorization` is not replayed (`redirect: 'manual'`).

**Interruption**
38. Close the auth tab mid-flow → rejection is handled, the in-flight lock releases, stale
    verifier is cleared, an immediate retry succeeds.
39. Trigger a second `login` for the same resource while one is pending → the second
    **coalesces** into the first and resolves with the same outcome. No raw Chrome error
    surfaces. Assert exactly one auth tab opened.

**Transport vs. auth** — the highest-value group, because false positives here are exactly the
bad UX this project exists to fix
40. `context.setOffline(true)` → **no prompt**, no auth state mutation, `TRANSPORT` error.
    Restore connectivity → next `fetch` succeeds with the original token.
41. `tokenEndpointStatus(500)` → backoff and retry, not re-authorization. Assert no auth tab.
42. `tokenEndpointStatus(429)` with `Retry-After` → honored; and without it → default backoff.
43. `tokenEndpointHang` → `AbortController` fires, classified `TRANSPORT`, no prompt.

**Partial reachability** — the chain fails midway with everything else healthy. Whole-network
offline cannot reach these paths. For every test in this group assert: classified
`TRANSPORT`, **no prompt**, and — critically — **no poisoned cache**, meaning a retry after
`reset` succeeds without needing a fresh install or a manual cache clear.
44. `endpointUnreachable('resourceMetadata')` → the challenge parsed but metadata is
    unreachable; `TRANSPORT`, not `MISCONFIGURED`. These two classes must not be conflated:
    one is retryable, the other is not.
45. `endpointUnreachable('asMetadata')` → the 9728 probe succeeds, then discovery fails. The
    resource metadata may be cached; a half-fetched AS metadata document must not be.
46. `endpointUnreachable('registration')` → discovery is cached and reused on retry; no
    partial `client_id` is persisted. On retry assert exactly one further DCR request and zero
    further discovery requests.
47. `endpointUnreachable('authorization')` → fails before any tab opens; no orphaned PKCE
    verifier is left in storage; an immediate retry after `reset` works.
48. `endpointUnreachable('token')` after a successful authorization → the code is already
    consumed and unrecoverable, so this must degrade to a clean re-authorization rather than a
    stuck state or a retry loop against a dead code.

**Request replay**
49. `fetch` with a buffered POST body (string / `FormData`) that hits `rejectNextAccessToken`
    → refresh happens and the body is resent intact; the RS sees the same body twice.
50. `fetch` with a `ReadableStream` body → rejected up front with a clear error, not silently
    retried with a consumed stream.

**Logout**
51. `logout` calls the revocation endpoint, clears local state, and the next `fetch` prompts.
52. `logout` against an AS with no `revocation_endpoint` → resolves cleanly, clears local
    state, no throw.

### Slow-tagged

53. `stallAuthorization(400)` → the authorization tab sits open for over six minutes and the
    flow still completes. This proves the service worker survives, since
    `identity.launchWebAuthFlow` is exempt from the five-minute timeout. Tag `@slow` and
    exclude from the default run.

---

## `docs/manual-verification.md`

Only for what genuinely cannot be automated. Note explicitly that tab-close, concurrent login,
and long authorization dwell **are** automated above, so the human steps are narrower than
they first appear.

1. **Real IdP conformance.** Point the extension at a live Cloudflare Access application with
   Managed OAuth enabled. Confirm: the 401 carries `resource_metadata`; DCR accepts a
   `https://<extension-id>.chromiumapp.org/cb` redirect URI (every published example uses a
   loopback URI, so this is the highest-risk unknown in the whole project); the 900-second
   token lifetime refreshes cleanly. Record whether `oauth4webapi`'s strict validation accepts
   Cloudflare's `issuer` value, which is served without a scheme and is therefore not a valid
   RFC 8414 issuer identifier. If it rejects, file with Cloudflare rather than loosening the
   library. Note that Cloudflare's tokens carry an `oauth:` prefix — this should require no
   special handling, since the token is opaque to the client; confirm that it in fact doesn't.
2. **Cloudflare's PKCE parsing bug.** Cloudflare documents that a code challenge beginning
   with `-` or `_` corrupts the authorization URL and produces a misleading
   `code_challenge_method must be S256 for public clients` error. Generate challenges until
   one starts with a non-alphanumeric character and confirm whether the bug still reproduces.
   Do **not** add a workaround to the module preemptively — if it reproduces, it belongs in a
   documented provider quirk table, not in the generic path.
3. **SSO carry-over.** With a live IdP session already established in the profile, confirm the
   silent path completes with no visible UI. This depends on `launchWebAuthFlow` sharing the
   profile's cookie jar, which it does since Chrome 112 via the browser-tab flow, but real
   IdPs add conditional access and device posture on top.
4. **Real MFA.** Confirm a hardware key or push prompt completes without the flow aborting.
5. **Policy denial with a real IdP.** Authenticate as a user the Access policy excludes;
   confirm the message distinguishes "we don't know who you are" from "we know, and no."
6. **Packed build.** Load the packed `.crx` / store build and confirm the extension ID matches
   the unpacked one, so the registered `redirect_uri` is valid for both.
7. **Comprehensibility.** Watch someone unfamiliar with the project hit an expired session.
   The auth tab should be self-evidently a login, and the status area should say something a
   non-developer can act on.

---

## Working agreement

Build in this order, and stop for review at each checkpoint:

1. `test-server` with the control plane and working HTTPS, plus a curl-level smoke script
   proving the happy path and three or four scenarios. Explicitly verify that
   `/.well-known/oauth-authorization-server` returns a valid RFC 8414 document. **Checkpoint.**
2. `iap-auth` with Vitest unit tests against in-memory adapters (no browser). This is the one
   place a fake `Clock` is legitimate — use it for skew-margin and expiry-arithmetic tests
   that would be wasteful to run through a real browser. Cover the authorization ladder and
   the single-flight lock here too, since both are testable without Chrome. **Checkpoint.**
3. `extension` shell, manually verified against the test server. **Checkpoint.**
4. Playwright fixtures, the `wakeWorker()` helper, and tests 1, 8, 10, 15, 23, 40 — one from
   each group, chosen to prove the harness can reach everything it needs to before you invest
   in the other forty. **Checkpoint.**
5. The remaining tests.
6. `docs/manual-verification.md`.

Do not proceed past a checkpoint without confirmation. Each checkpoint includes `pnpm biome
check` and `pnpm tsc --noEmit` passing clean across all touched packages — treat a lint or
type error the same as a failing test, not something to defer.

`biome.json` and `tsconfig.json` will be supplied at the repo root before or at checkpoint 1;
if they aren't present yet, stop and ask rather than inventing placeholder configs that will
need to be reconciled later.

If a test cannot be written without adding a hook to the extension, stop and say so rather
than adding the hook — that constraint is the point of the exercise, and a missing test is a
better outcome than a divergent artifact.
