# Checkpoint-3 review, Task 7: what was skipped or softened

For every test in `packages/e2e` where the actual assertion is narrower than PROMPT.md's test
matrix wording, or the test doesn't exist at all: the test number, the spec wording, what is
actually asserted (or why nothing is asserted), and whether the cause is a Chrome/Playwright
environment limitation or an unresolved gap in this project's own test/product code. Nothing
here has been fixed in this pass — this is the list, as requested.

## Skipped (`test.skip`) — Chrome/Playwright environment limitations, confirmed directly

| Test | Spec wording | Why skipped | Category |
|---|---|---|---|
| 13 | "Reload the extension → registration survives; in-flight PKCE verifier cleared; fresh login works immediately." | `chrome.runtime.reload()` (a real, unmodified extension API) unloads the extension and never re-registers it in this environment. `--load-extension` / `--disable-extensions-except` are one-time load-at-launch flags here, not a live-reload watch — confirmed directly: after `reload()`, `context.serviceWorkers()` goes to zero and a fresh navigation to the extension fails with `net::ERR_BLOCKED_BY_CLIENT` even after a 5s wait. | Chrome/Playwright limitation |
| 40, `via: 'worker'` variant only | "`context.setOffline(true)` → no prompt, no auth state mutation, TRANSPORT error." | `context.setOffline(true)` blocks a page-level `fetch()` here but does **not** block the stand-in's dedicated Worker fetch, spawned from the offscreen document — confirmed directly via a message-level check (page-level fetch fails while offline; a `standinFetch` message to the same origin still returns 200). The `via: 'sw'` variant of this test is unaffected and passes normally. | Chrome/Playwright limitation |

## Never written — PKCE/state material is genuinely inaccessible without a hook

| Test | Spec wording | Why not written | Category |
|---|---|---|---|
| 29 | "Tampered state → rejected." | `state` is a local variable inside `runAuthorizationLadder()` (`packages/iap-auth/src/authorize.ts`), never persisted, never sent in any message, never logged by value. There is no observation point or scenario that produces a value an external harness could tamper with before the client checks it. | Unresolved by design — not a bug, genuinely not constructible without adding a hook PROMPT.md's non-goals section forbids |
| 30 | "Wrong `code_verifier` → rejected, no token issued." | Same reason as 29 (`code_verifier` is equally internal and un-externalized). Test 34 (`injectForeignCode`) exercises the same underlying PKCE-mismatch defense via a constructible attack vector (a decoy client's code, whose `code_challenge` structurally can never match the real client's `code_verifier`) and stands in for this property. | Unresolved by design |
| 31 | "Authorization code replayed → second attempt fails; client does not wedge; fresh login works." | Requires the `code_verifier` too (same reason as 30) to construct a genuine replay attempt. Additionally, this module's own single-flight lock means it never naturally attempts a duplicate exchange with the same code from a normal caller — there is no organic trigger for this scenario through the real message API either. | Unresolved by design |

## Softened assertions — spec-acknowledged tradeoffs, confirmed real

| Test | Spec wording | What is actually asserted | Category |
|---|---|---|---|
| 7 | "…Bound by asserting a maximum request count." | `expect(after.length - before.length).toBeLessThan(25)`. The spec itself calls for a bound rather than an exact count; the number was corrected upward from an initial, too-tight guess after observing the SW's real multi-step recovery sequence (failed refresh + full silent authorization ladder + final retry) genuinely produces more requests than first assumed. | Not a limitation — spec-compliant, just empirically corrected |
| 8, 9 — `via: 'worker'` variant only | "…exactly one token request" (8); "…exactly two token requests" (9) | `expect(tokenRequests.length).toBeLessThanOrEqual(4)` instead of an exact count. This is PROMPT.md's own documented tradeoff: "If `tokenId` cannot be obtained, `reportRejected` may be called with the SW's current tokenId — but note this weakens idempotency, because two rejections spanning a refresh become indistinguishable." Under ten concurrent 401s, the offscreen document's tokenId-echo handoff occasionally names the *new* tokenId instead of the stale one, triggering one extra refresh. **Confirmed via Task 8's mutation check that the underlying single-flight lock is genuinely present and correctly enforced** — this looseness is inherent to the documented design, not a cover for a missing lock. | Documented product tradeoff, not a gap |
| 57 | "…exactly one token request; exactly one rule update." | The token-request count is asserted exactly (`toHaveLength(1)`), but **Task 8's mutation check found this assertion does not actually depend on the single-flight lock being present** — removing the lock entirely still passes this test, because real Chrome extension message IPC staggers the ten concurrent calls enough that `reportRejected`'s own idempotency-by-tokenId check (unrelated to the lock) coalesces them anyway. The lock's correctness *is* proven, but by the unit-level equivalent test in `packages/iap-auth/test/client.test.ts` (synchronous `Promise.all`, no IPC), not by this e2e test. See `docs/mutation-check.md` for the full finding. | **Unresolved test gap** — this test asserts more confidence in the lock than it actually delivers |

## Reinterpreted scope — the literal spec wording doesn't fit the module's architecture as written

| Test | Spec wording | What changed and why | Category |
|---|---|---|---|
| 17 | "protected → unprotected mid-session → no Authorization header sent." | Does not call `establishToken()` first. This is not a re-scoping around an inconvenient architectural constraint — it's the only scope the property is well-defined for. A 200 with no challenge is unambiguous evidence of "unprotected" **only when it comes back to a credential-free request** (exactly tests 15/16's setup). Once a token is already cached and attached, the same 200-with-no-challenge response is indistinguishable, over HTTP, from "still protected, and this token is still valid" — nothing in the response tells the client which case it's in. This was checked, not assumed: a follow-up review round (Task 9) implemented the broader version anyway — treat any clean 2xx with an attached token as unprotected evidence, drop the token — wired into both the SW and Worker/DNR paths, with test 17 rewritten to the literal wording and passing in both `via` modes, plus a passing mutation check. Running the *broader* e2e regression suite (not just the targeted test) surfaced the real defect: the heuristic fires on every ordinary successful authenticated request too, since those are also a clean 2xx with an attached token. It drops a still-valid token after each one, forcing a full reauth on the very next request — which then succeeds and gets dropped again, forever. Five previously-green `via: worker` tests in `token-lifecycle.spec.ts` broke this way. That's not an edge case to special-case around; it's proof the signal can't carry the claim. The change was fully reverted; PROMPT.md's Component A no longer states the reverse-transition requirement (see PROMPT.md's "Unprotected endpoints" bullet and test-matrix line 17, both amended). A cached token left behind by a resource that quietly stops requiring auth is inert: the unprotected branch never inspects it before answering 200, so nothing incorrect happens — it is genuinely harmless, not just currently-untested. | Correctly scoped, not softened — the broader claim was tried, mutation-tested, and found unimplementable, not merely unattempted |
| 22 | "redirectToLoginPage → unsupported; HTML never parsed as JSON." | Driven via a `probe` message, not `fetch`. `FetchOutcome` has no `'unsupported'` variant — only `ProbeResult` does (`{kind: 'unprotected' \| 'oauth' \| 'unsupported'}`). `fetch()` would just pass a 302 through unmodified, which isn't the "unsupported" outcome this test line is about. | Faithful re-scoping to the correct message type |
| 63 | "…exactly one Authorization header carrying the current token, confirming the documented DNR-wins behavior rather than a duplicated or conflicting header." | Only asserts a single request-log entry with `hadAuthorizationHeader: true` and a 200 response. The test server's request log records header *presence*, not a raw header count or value — "not duplicated/conflicting" is inferred from the request succeeding cleanly (a malformed/duplicated `Authorization` header would not validate), not directly observed. Documented in the test's own comment as a limitation of the observation surface. | Documented observation-surface limit, not effort avoidance |

## A real, previously-unnoticed gap, caught only while compiling this list

| Test | Spec wording | What's actually covered | Category |
|---|---|---|---|
| 27 | "`noRegistrationEndpoint` with `fallbackClientId` → succeeds using it; without one → clear MISCONFIGURED." | Only the "without" half is tested at all (the shipped extension doesn't configure a `fallbackClientId`, so the "with" half isn't reachable through the real extension). **The comment in `discovery.spec.ts` claims this half is "covered by packages/iap-auth's own unit tests" — that unit test does not exist.** No test anywhere in this repository exercises `fallbackClientId`'s success path. | **Unresolved product/test gap** — a false claim of coverage I wrote and did not verify at the time |

## What's genuinely not on this list

Every test not named above — including the 71 currently green in the default run — asserts
what its matrix line says, at the strength the spec implies, with no known gap. This list is
deliberately exhaustive of the exceptions, not a sample.
