# `oidc-client-ts` Architectural Audit & Edge Case Analysis

This document audits `authts/oidc-client-ts` (and its predecessor `oidc-client-js`) against the design of `packages/iap-auth`. The goal is to determine whether real bugs and failure modes documented in that library's issue history represent vulnerabilities or gaps in `packages/iap-auth`.

---

## Architectural Context: Why the Two Designs Differ

| Dimension | `oidc-client-ts` | `packages/iap-auth` |
|---|---|---|
| **Target Runtime** | Single-Page Applications (DOM / Browser Tabs) | Chrome MV3 Extension Service Worker |
| **Token Lifecycle** | **Eager & Timer-Driven:** Sets `setInterval` / `setTimeout` timers to refresh tokens before expiry. | **Lazy & On-Demand:** Zero timers. Evaluates freshness on demand (`fetch` / `getToken`) with a 60s clock skew margin. |
| **Silent Renew Mechanism** | Hidden `<iframe>` prompt=none or token endpoint via `fetch`. | Direct token endpoint refresh (`grant_type=refresh_token`) or `chrome.identity.launchWebAuthFlow` (silent-then-interactive ladder). |
| **Process Model** | Long-lived page session; timers run until tab is closed or navigated. | Ephemeral Service Worker; can be terminated at any time by Chrome when idle or during sleep. |
| **Header Attachment** | Application code attaches headers manually or via fetch interceptors. | Declarative Net Request (DNR) session rules attached to resource origins, synced via `onTokenChanged`. |

---

## Detailed Findings on the Four Confirmed Issue Areas

### 1. Stale-but-not-yet-expired tokens / Cold-start with expired tokens (Issues #1601, #2012)

#### `oidc-client-ts` Behavior & Bug
In `AccessTokenEvents.ts`:
```ts
if (container.access_token && container.expires_in !== undefined) {
    const duration = container.expires_in;
    if (duration > 0) {
        let expiring = duration - this._expiringNotificationTimeInSeconds;
        if (expiring <= 0) expiring = 1;
        this._expiringTimer.init(expiring);
    } else {
        // Access token is already expired at load time!
        this._expiringTimer.cancel();
    }
    const expired = duration + 1;
    this._expiredTimer.init(expired);
}
```
In `SilentRenewService.ts`, the renewal service only registers for `addAccessTokenExpiring` (not `addAccessTokenExpired`). When a user starts the application with an access token that is already expired in storage, `_expiringTimer` is canceled, and silent renewal **never triggers**. The application is left holding a dead token until a user interaction fails or manual renewal is called.

#### `packages/iap-auth` Design
`packages/iap-auth` uses **no timers**. Token validity is evaluated lazily when a request is made:
1. When `getToken(resource)` or `fetch(url)` is invoked:
   ```ts
   const cached = await readAccessEntry(resource);
   if (cached && isFresh(cached)) {
     return { token: cached.token, tokenId: cached.tokenId };
   }
   // Missing or local expiry passed (expiresAt - SKEW_MARGIN_MS <= clock.now())
   logger.info('classify', 'TOKEN_STALE: no fresh cached token', { resource, correlationId });
   ```
2. If `cached` is expired or absent (e.g., cold start, browser restart where `chrome.storage.session` was cleared), it classifies the condition as `TOKEN_STALE` and calls `acquireToken()`.
3. `acquireToken()` checks durable storage for `refresh:${resource}` and uses it to silently mint a new access token via `refreshTokenGrantRequest`.
4. If a cached token was locally believed valid but the Resource Server rejects it with a `401 Unauthorized` (`WWW-Authenticate: Bearer ...`), `fetch` and `reportRejected` classify the response as `TOKEN_STALE: 401 invalid_token on a token we believed valid` and immediately refresh.

#### Verdict
- **Design Status:** **Already Handled.** The lazy on-demand model is fundamentally immune to timer-initialization misses on startup.
- **Covered Test Numbers:**
  - **Test 1:** Token expires locally → next `fetch` succeeds, exactly one token request, no auth tab.
  - **Test 11:** Stop the service worker while the token is expired → cold-start refresh path, no prompt.
  - **Test 12:** Relaunch against the same `userDataDir` → access token gone, refresh token present → silent refresh on first request.
- **Gap:** None.

---

### 2. Sleep / Suspend Recovery (Issue #251)

#### `oidc-client-ts` Behavior & Bug
When a device wakes from system sleep:
1. `Timer.ts` detects that `diff <= 0` and fires the expiring timer immediately.
2. `SilentRenewService` initiates `signinSilent()`.
3. Because the OS network interfaces (Wi-Fi, DNS, DHCP) often take several seconds to reconnect after waking from sleep, the renewal request fails (either timing out or throwing a network `TypeError`).
4. In earlier versions of `oidc-client-ts` (issue #251), this failure raised `silentRenewError` and permanently stopped silent renewals. Later patches added an `AbortController` timeout and a 5-second retry loop (`_retryTimer.init(5)`), but non-timeout network errors still broke the session.

#### `packages/iap-auth` Design
`packages/iap-auth` protects against sleep/suspend without relying on background timer loops:
1. **Bounded Request Timeouts:** Every network call to the AS or RS uses `requestSignal()` with an explicit `AbortSignal.timeout(8_000)` (`REQUEST_TIMEOUT_MS = 8000`). If a request hangs due to suspended sockets during sleep, the abort signal fires upon wake and cleanly terminates the in-flight request with an `AbortError`.
2. **Strict Failure Classification (`TRANSPORT`):**
   - Network errors (`TypeError`, `AbortError`), HTTP 5xx, and HTTP 429 are classified as `TRANSPORT`.
   - `withTransportRetry()` performs exponential backoff retries (200ms, 400ms, 800ms) with `Retry-After` support.
   - **Critical Rule:** Auth state (refresh tokens, cached metadata, client registrations) is **never modified** on `TRANSPORT` failures, and no user-visible auth tabs are ever opened.
3. **Recovery on Reconnect:** Once network connectivity is restored, subsequent caller requests find the stored refresh token intact and succeed.
4. **Service Worker Lifecycle:** If Chrome terminates the idle service worker during sleep, the worker restarts cleanly from durable storage on the next incoming request (tested via SW termination).

#### Verdict
- **Design Status:** **Already Handled.**
- **Covered Test Numbers:**
  - **Test 10 & 11:** Service worker termination between calls / while token is expired.
  - **Test 40:** `context.setOffline(true)` → `TRANSPORT`, no prompt, no auth state mutation; restoring connectivity allows immediate success.
  - **Test 43:** `tokenEndpointHang` → `AbortController` fires, `TRANSPORT`, no prompt.
  - **Tests 44–48:** Partial reachability / unreachable endpoints → classified as `TRANSPORT`, no poisoned cache, no auth tab.
- **Gap:** None.

---

### 3. Single-Flight and Stuck-State Bugs (Issues #432, Refresh-in-Flight Races)

#### `oidc-client-ts` / Predecessor Behavior & Bug
In older implementations of `oidc-client-js` and related libraries:
1. Silent renewal flags (e.g., `_silent_renew_running = true`) or request state were stored in shared web storage (`localStorage` / `sessionStorage`) to coordinate across tabs.
2. If the browser tab was refreshed, closed, or crashed while renewal was in flight, the stored flag remained `true` indefinitely.
3. Subsequent page loads saw the flag, assumed a renewal was already running, and entered a permanently stuck/deadlocked state.
4. Conversely, if multiple tabs refreshed simultaneously without shared coordination, they replayed the same refresh token, triggering refresh token rotation replay detection and revoking the user's grant.

#### `packages/iap-auth` Design
1. **In-Memory-Only Single-Flight Lock:**
   - In `lock.ts`, `KeyedSingleFlight` stores in-flight operations in an in-memory `Map<string, Promise<unknown>>`.
   - Lock state is **never written to disk or storage** (`chrome.storage.session` or `chrome.storage.local`).
   - If the service worker is terminated or reloaded mid-refresh, the entire JavaScript heap is recycled. Upon restart, the lock map is completely empty. No persisted "stuck lock" state is reachable.
2. **Atomic Cache Writes:**
   - Storage writes for `refresh:${resource}` and `access:${resource}` occur only in `finalizeToken()` after the token response is fully received and validated.
   - If the worker dies mid-flight, the previously stored refresh token remains valid on disk.
3. **Concurrency Coalescing:**
   - Concurrent calls to `getToken`, `fetch`, `login`, or `reportRejected` for the same resource coalesce onto the active single-flight promise.
   - Under refresh token rotation, exactly one token request reaches the AS, preventing token replay revocations.
   - Distinct resources are keyed independently and do not block each other.

#### Verdict
- **Design Status:** **Already Handled.**
- **Covered Test Numbers:**
  - **Test 8:** `detectRefreshReplay` + 10 parallel calls on expired token → exactly one token request, grant not revoked.
  - **Test 9:** 10 parallel calls across two different resources → exactly two token requests, independent execution.
  - **Test 13:** Reload extension mid-flow → in-flight verifiers cleared, fresh login works immediately.
  - **Test 38:** Close auth tab mid-flow → lock releases, stale verifier cleared, immediate retry succeeds.
  - **Test 39:** Second `login` while one is pending → coalesces into the first.
  - **Test 57:** 10 concurrent `reportRejected` calls naming the same `tokenId` → exactly one token request.
- **Gap:** None.

---

### 4. Refresh-Token Expiry Distinct from Access-Token Expiry (`refresh_expires_in`, Issue #644)

#### `oidc-client-ts` Behavior & Bug
In `oidc-client-ts` (issue #644):
- The library calculates `User.expires_at` strictly from `expires_in` (the access token's lifetime).
- Non-standard parameters like `refresh_expires_in` (returned by identity providers like Keycloak) are ignored by default.
- `User.expired` indicates only whether the *access token* has expired. When silent renew attempts to use an expired refresh token, the AS rejects the call with `invalid_grant`.
- The library raises `silentRenewError`, but because access token expiration and refresh token expiration are conflated in client state, the app often struggles to distinguish whether a silent refresh is possible or if full re-authentication is required.

#### `packages/iap-auth` Design
`packages/iap-auth` explicitly decouples access token expiration from refresh token expiration in both storage and failure classification:

1. **Decoupled Storage & Lifetimes:**
   - **Access Token:** Stored in volatile `session` storage (`access:${resource}`) with `expiresAt = now + expiresIn * 1000`.
   - **Refresh Token:** Stored in `durable` storage (`refresh:${resource}`) without local expiration arithmetic. Refresh token validity is determined authoritatively by the authorization server.
2. **Distinct Failure Classification:**
   - **Access Token Expired (`TOKEN_STALE`):**
     - Triggered by local expiry check (`!isFresh(cached)`) or RS returning `401 Unauthorized` with a Bearer challenge.
     - **Response:** Silently execute `refreshAccessToken` using the stored refresh token. Never prompt the user.
   - **Refresh Token Dead / Revoked / Expired (`GRANT_DEAD`):**
     - When `refreshAccessToken` is sent to the AS token endpoint, an expired or revoked refresh token returns HTTP 400 with `error: "invalid_grant"`.
     - In `client.ts`:
       ```ts
       const kind = classifyTokenEndpointError(err);
       if (kind !== 'invalid_grant') {
         // 5xx, 429, timeout -> TRANSPORT failure (backoff & retry, do not delete refresh token)
         throw toIapError(err, 'token refresh');
       }
       logger.info('classify', 'GRANT_DEAD: refresh returned invalid_grant', { resource, correlationId });
       // Delete the dead refresh token immediately
       await durable.delete(refreshKey(resource));
       // Escalate to the authorization ladder (silent iframe first, then interactive prompt if permitted)
       const result = await runAuthorizationLadder(...);
       ```
3. **Clean Degradation:**
   - When the refresh token dies (`GRANT_DEAD`), the dead token is purged from durable storage so subsequent calls do not get stuck in a failing refresh loop.
   - The authorization ladder runs: first attempting silent authorization (`prompt=none` via `launchWebAuthFlow`), escalating to an interactive prompt only if silent fails and `interactive !== false`.

#### Verdict
- **Design Status:** **Already Handled.** Access token expiration (`TOKEN_STALE`) and refresh token expiration (`GRANT_DEAD`) are cleanly partitioned into separate failure classes with distinct recovery workflows.
- **Covered Test Numbers:**
  - **Test 1 & 2:** `TOKEN_STALE` (local expiry and RS 401) → refresh silently, no prompt.
  - **Test 5:** `invalidGrantOnNextRefresh` + `autoApprove` (`GRANT_DEAD`) → silent re-authorization via ladder, no visible tab.
  - **Test 6:** `invalidGrantOnNextRefresh` + `forceLogin` (`GRANT_DEAD`) → exactly one interactive prompt, then success.
  - **Test 7:** `revokeGrant` mid-session → terminates cleanly without infinite prompt loops.
- **Gap:** None.

---

## Summary Matrix

| Issue Area | `oidc-client-ts` Root Cause | `packages/iap-auth` Design Solution | Classification | Test Matrix Coverage | Status |
|---|---|---|---|---|---|
| **1. Already-expired token at startup** (#1601, #2012) | Timers only register for expiring tokens; `expiringTimer` canceled if token already expired at startup. | Lazy on-demand evaluation on `fetch`/`getToken`. Expired or missing session entry triggers refresh automatically. | `TOKEN_STALE` | Tests 1, 11, 12 | **Handled** |
| **2. Sleep/Suspend Recovery** (#251) | Fired timers time out during network reconnection on wake, permanently terminating silent renew. | No timers; all network requests have 8s `AbortSignal.timeout`; network failures classified as `TRANSPORT` with retries; auth state preserved. | `TRANSPORT` | Tests 10, 11, 40, 43, 44–48 | **Handled** |
| **3. Stuck Single-Flight State** (#432) | In-flight locks/flags saved to `localStorage` become permanently stuck if tab closes or reloads mid-flight. | `KeyedSingleFlight` lock is purely in-memory. Terminating/restarting the service worker resets lock state cleanly. | N/A (Lock primitive) | Tests 8, 9, 10, 11, 13, 38, 39, 57 | **Handled** |
| **4. Refresh Token Expiry vs Access Expiry** (#644) | Conflates token status in `User.expired`; fails during silent renew without clean classification. | Decouples volatile access token from durable refresh token. `invalid_grant` triggers `GRANT_DEAD`, deletes dead token, and runs auth ladder. | `TOKEN_STALE` vs `GRANT_DEAD` | Tests 1, 2, 5, 6, 7 | **Handled** |

---

## Conclusion

The architecture of `packages/iap-auth` inherently avoids the failure modes seen in `oidc-client-ts`. Because `packages/iap-auth` relies on **lazy on-demand evaluation, stateless in-memory locking, explicit failure classification (`TOKEN_STALE`, `GRANT_DEAD`, `TRANSPORT`, `FORBIDDEN`, `MISCONFIGURED`), and zero timers**, it does not suffer from the timer drift, startup misses, stuck persistent lock flags, or conflated token expiry issues documented in `oidc-client-ts`.

No code modifications to `packages/iap-auth` are required.
