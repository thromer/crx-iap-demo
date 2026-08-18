# Mutation check

Checkpoint-3 review, Task 8 (mutations 1–7); Task 10 adds mutation 8; Task 12 adds mutations
10–13; Task 13 adds mutation 14; Task 14 adds mutation 15; Task 15 adds mutation 16. For each
mutation below: the change
was applied to the real source (test-server mutations don't need an extension rebuild;
extension/iap-auth mutations do), the named test(s) were run against the mutated build, the
result was recorded, and the mutation was reverted (`git checkout --` or a manual revert,
confirmed clean via `git status`/`grep MUTATION` before moving to the next row — none
compounded). Every mutation was exercised individually, never combined. This document is kept
current across review rounds, not treated as a one-off — a standing project working agreement
(`project_mutation_check_requirement` memory): every new or materially modified test gets a
mutation proving it non-vacuous, logged here honestly, including when a mutation doesn't fail
as predicted.

## Results

| # | Mutation | Must fail | Result |
|---|---|---|---|
| 1 | Revert Task 1's `TRANSPORT` classification (`net.ts`'s `classifiedFetch` stops catching/wrapping) | 40 | ✅ Failed as expected — `errorClass` was `UNKNOWN` instead of `TRANSPORT` |
| 2 | Make the single-flight lock global instead of per-resource (`lock.ts`'s `run()` uses a fixed key) | 9 | ✅ Failed as expected — one resource's refresh blocked the other's; only 1 token request instead of 2 |
| 3 | Remove the single-flight lock entirely (`lock.ts`'s `run()` calls `fn()` directly) | 8, 57 | ⚠️ **8 failed as expected** (20 token requests instead of 1). **57 did NOT fail** — see finding below |
| 3 (re-verified) | Same mutation, re-run after Task 11's rewrite of test 57 to force overlap via `tokenEndpointHang` (the version that replaced the one mutation 3 originally ran against) | 57, plus 8/9's `via: 'sw'` variants | ✅ **57 now fails** (10 token requests instead of 1) — the original gap is closed. 8/9 `sw` still fail as before |
| 9a | Remove offscreen suppression alone (`offscreen.ts`'s `tokenChanged` listener ignores `tokenId: null` broadcasts) — Task 11a, stage 1 of 2 | 8, 9 (`via: 'worker'`, with `tokenEndpointHang` forcing overlap) | ✅ Neither failed — the lock alone still coalesces correctly. See finding below |
| 9b | Same as 9a, combined with mutation 3 (lock also removed) — Task 11a, stage 2 of 2 | 8, 9 (`via: 'worker'`) | ⚠️ **8 failed, but with 2 token requests, not the ~10 mutation 3 alone produces on `sw`. 9 did NOT fail at all** (still exactly 2) — see finding below |
| 4 | Skip the cross-origin `resource_metadata` origin check (`discovery.ts`'s `discoverResource`) | 23 | ✅ Failed as expected — client attempted the foreign origin, got `TRANSPORT` (unreachable) instead of the expected `MISCONFIGURED` from the (skipped) validation |
| 5 | Never update the DNR rule after a refresh (`service-worker/index.ts`'s `onTokenChanged` listener, install-once-per-resource) | 55 | ✅ Failed as expected — the stand-in Worker's requests kept 401ing against the stale rule, exhausted the retry bound, `outcome.ok` was `false` |
| 6 | Return a stale token from `getToken` after `reportRejected` (`client.ts`'s `readAccessEntry` memoizes the first read per resource, ignores later writes) | 58 | ✅ Failed as expected — the second, already-superseded `reportRejected` call triggered a second refresh instead of no-op'ing |
| 7 | Make `stopAllWorkers` a no-op (`fixtures.ts`'s `stopServiceWorker`, post-Task-5) | 10, 11 | ✅ Both failed as expected — `service worker did not stop within 3000ms (Target.getTargets still lists ...)` |
| 8a | Fire-and-forget the DNR update in `onTokenChanged` (`service-worker/index.ts`, before the `syncToken()` extraction) | 54 (e2e) | ❌ **Did NOT fail** — see finding below |
| 8b | Fire-and-forget `updateRules` inside `syncToken()` itself (`token-sync.ts`, `await effects.updateRules(...)` → `void effects.updateRules(...)`) | `syncToken()` unit tests (`token-sync.test.ts`) | ✅ Failed as expected — `publishTokenId` observed `rulesUpdated === false` |
| 8c | Fire-and-forget the listener loop in `writeAccessEntry` (`client.ts`, `await listener(...)` → `void listener(...)`) | `client.test.ts`'s "onTokenChanged ordering > awaits listeners before getToken resolves" (pre-existing, from Tasks 1–4) | ✅ Failed as expected — `listenerFinished` was still `false` when `getToken` resolved |
| 10 | `tamperState` echoes the real `state` instead of tampering it (`as.ts`) | 29 | ✅ Failed as expected — `outcome.ok` was `true` (untampered flow succeeds normally) |
| 11 | `rejectCodeExchange`'s branch never fires (`as.ts`'s token endpoint handler) | 30 | ✅ Failed as expected — `outcome.ok` was `true` on the first exchange |
| 12 | `reissuePreviousCode` always mints fresh instead of reusing the captured code (`as.ts`) | 31 | ✅ Failed as expected — the second login's replayed-code attempt succeeded instead of failing |
| 13 | `injectForeignCode`'s branch never fires (`as.ts`) | 34 | ✅ Failed as expected — `outcome.ok` was `true` (the real client's own normal login succeeds when nothing is injected) |
| 14 | `bearerTokenId` (`test-server/src/hash.ts`) always returns a fixed, wrong value when a header is present | 63, 35 | ✅ Both failed as expected — `authorizationTokenId` was `"deadbeef"` instead of the real tokenId, at the new identity assertion specifically (presence assertions above it still passed) |
| 15 | Offscreen document misreads a transport failure (Worker `fetch()` throws) as a token rejection, firing `reportRejected` (`offscreen.ts`'s `handleStandInFetch`) | 40 (`via: 'worker'`) | ✅ Failed as expected — a spurious `/token` request appeared where the test asserts none |
| 16 | `fallbackClientId` branch never used, even when configured (`discovery.ts`'s `registerOrGetClient`) | `client.test.ts`'s "fallbackClientId > succeeds using the configured fallback client id..." | ✅ Failed as expected — same `MISCONFIGURED` error the "without a fallbackClientId" half already covers |

**15 of 17 mutation attempts produced the predicted failure, for the predicted reason** (2, 3, 4, 5, 6, 7, 8b, 8c, 10, 11, 12, 13, 14, 15, 16 fired correctly; 3/57 and 8a did not, both resolved by moving the observation point rather than the assertion — see below).

## The one that didn't: mutation 3, test 57

Removing the single-flight lock entirely correctly fails test 8 (token-lifecycle group) but
does **not** fail test 57 (DNR-attachment group), even though both are nominally "ten
concurrent calls on the same tokenId must coalesce into one refresh" tests and both are
supposed to depend on the same lock.

**Root cause, confirmed by comparison, not guessed:** test 8 drives ten concurrent calls
in-process via the SW's own `fetch()` — all ten `chrome.runtime.sendMessage` calls fire from
`Promise.all` in the same microtask tick from the driver page, arrive at the SW close enough
together that the lock's absence is directly observable (20 token requests, no coalescing at
all). Test 57 drives ten concurrent `reportRejected` messages the same way, but
`reportRejected`'s own idempotency check (`current.tokenId !== tokenId` — a no-op if the
token was already superseded, unrelated to the lock) is enough, in practice, to still collapse
most of the ten calls to a single refresh: real Chrome extension message IPC introduces just
enough scheduling stagger between arrivals that by the time the 2nd–10th messages are
processed, the first one has frequently *already* completed its whole
invalidate-then-reacquire cycle, so the idempotency check alone catches them — without ever
needing the lock to arbitrate a true simultaneous race.

This was checked directly, not inferred: `packages/iap-auth/test/client.test.ts`'s own unit
test for the same property (`idempotent reportRejected > ten concurrent reports of the same
tokenId produce exactly one refresh`) drives the ten calls via a real, synchronous
`Promise.all()` **in-process**, with no IPC in between. Run against the same lock-removed
mutation, **that test does fail** (10 refreshes instead of 1) — confirming the underlying
single-flight logic is correctly exercised at the unit level. The gap is specifically that
e2e test 57, as currently written, cannot distinguish "has a lock" from "doesn't have a lock,
but IPC latency happens to serialize the calls anyway" — it asserts less than its own comment
claims.

**Not fixed in this pass**, per Task 8's framing (report, don't yet remediate). Two options for
follow-up, not chosen yet:
- Tighten test 57 further (e.g. assert the DNR session-rule snapshot more precisely, or add
  a timing-based assertion) — fragile, and still ultimately bounded by the same real-IPC
  scheduling that let this slip through.
- Accept that test 57's true job is proving the *DNR-attachment path specifically* coalesces
  in practice (which it does, faithfully, via real Chrome IPC — a legitimate and non-trivial
  thing to prove), and treat the *lock itself* as a Component-A concern already covered
  decisively by the unit test above, documenting that division of labor explicitly in test
  57's own comment instead of implying it independently proves the lock exists.

**Resolved, Task 11.** Neither option above was taken — instead, the IPC-latency dependency was
removed entirely rather than worked around: `tokenEndpointHang` now stalls the first refresh's
`/token` request for ~1s before the ten concurrent calls fire, guaranteeing the other nine's
idempotency checks still see the not-yet-superseded tokenId (the exact condition idempotency
alone cannot resolve). Mutation 3, re-run against this rewrite, now fails test 57 directly (see
the "3 (re-verified)" row above) — the lock is proven at the e2e level, not just the unit level.

## The other that didn't: mutation 8, test 54

`index.ts`'s `onTokenChanged` listener used to set `currentTokenIds` (the map the offscreen
document's `'currentTokenId'` query reads directly) *before* awaiting the DNR rule update, not
after — a real ordering violation against Component A's documented contract ("listeners are
awaited before the triggering call resolves, so the DNR rule is in place before the caller is
told the token is ready"). Fixed by reordering: DNR sync now happens first, `currentTokenIds`
is set after.

Before landing that fix, Task 10 called for verifying test 54 actually depends on the ordering,
by mutating the listener to fire-and-forget the DNR call and confirming test 54 goes red. It
does not — not with a single immediate follow-up request, and not under thirty concurrent
`standInFetch` calls fired immediately after `establishToken()` resolves (a diagnostic-only
probe, never committed to the suite). `chrome.declarativeNetRequest.updateSessionRules()`
apparently completes fast enough, even un-awaited, that it wins the race against the multi-hop
round trip (extension message → offscreen document → dedicated Worker → real HTTPS request to
the resource server) every time it was tried in this environment.

**Why this isn't fixable the way mutation 3/test 57 was:** test 57's equivalent problem was
solved by arming `tokenEndpointHang` — a stall on a server *this project controls*, forcing
real overlap deterministically. There is no equivalent lever here. The race is entirely
internal to the browser extension process (a native `chrome.declarativeNetRequest` call versus
a `chrome.runtime.sendMessage` round trip), with no test-server-observable or
test-server-controllable step in between. The only way to force this window open
deterministically would be an extension-side hook (e.g., an artificial delay gated behind a
test flag) — and PROMPT.md's non-goals explicitly forbid test-only code, hooks, flags, or
conditionals in `packages/extension`: "The shipped artifact must be identical to the tested
artifact." Concurrency alone (the thirty-call probe) is exactly the anti-pattern flagged in the
[[feedback_deterministic_concurrency_tests]] memory — a negative result from it proves nothing
except that this particular attempt didn't land in the window, not that the window is
unreachable — so it isn't used as evidence here, only as a diagnostic that didn't pan out.

**Resolution — move the observation point, not the assertion.** The property is deterministic
at the unit level: a fake can be arbitrarily slow even where a native browser API can't be
forced to be. The listener body was split into `syncToken()`
(`packages/extension/src/service-worker/token-sync.ts`), a plain function taking its two
effects (`updateRules`, `publishTokenId`) as parameters, making no `chrome.*` calls itself.
This is not a hook: no test flag, no conditional, no behavioral difference — the shipped SW
calls `syncToken()` with the real `setAuthorizationRule`/`removeAuthorizationRule` and the real
`currentTokenIds.set`, and behaves identically to before the extraction. It's the same
dependency-parameterization already used throughout this codebase (`createIapClient`'s
`session`/`durable`/`authorizer`), just applied one level down.

Two unit tests now prove Component A's ordering contract in full, matched to mutations 8b/8c
above:
- `packages/extension/test/token-sync.test.ts` — `syncToken()` with a fake `updateRules` that
  delays 20ms; `publishTokenId` asserts the delay's own flag is already `true` when it runs.
  Mutation 8b (fire-and-forget `updateRules` inside `syncToken()`) fails it, for the right
  reason (the assertion inside `publishTokenId` trips, not a timeout).
- `packages/iap-auth/test/client.test.ts`'s pre-existing "onTokenChanged ordering > awaits
  listeners before getToken resolves" (added in the Tasks 1–4 round, already covering the
  client-side half of the same contract — checked, not assumed, before writing a duplicate).
  Mutation 8c (fire-and-forget the listener loop in `writeAccessEntry`) fails it too.

**Test 54's disposition:** downgraded honestly rather than left claiming more than it proves.
It no longer asserts first-attempt success (`toHaveLength(1)`) — that was never something it
could verify independent of real-world timing luck, mutation 8a's finding notwithstanding — and
now asserts eventual success within `performFetch`'s own retry bound, with its header comment
pointing at the two unit tests above as where the ordering is actually verified. Same
division of labor as test 57/mutation 3: e2e proves the wiring is genuinely connected
end-to-end (SW → real `chrome.declarativeNetRequest` → real browser network stack), the unit
tests prove the ordering guarantee that makes it reliable.

`dnr-attachment.spec.ts` and `token-lifecycle.spec.ts` both pass in full against the fix and
the rewritten test 54 (29 tests, clean run), and `packages/extension`'s and
`packages/iap-auth`'s unit suites pass with the two new/verified tests included.

## Not a gap: mutations 9a/9b, tests 8 and 9's `via: 'worker'` variants

With overlap forced (`tokenEndpointHang`, per Task 11), tests 8 and 9's `via: 'worker'`
variants assert exact token-request counts (1 and 2) matching their `via: 'sw'` counterparts.
Task 11a asked whether that count is proof of the single-flight lock on the worker path the
way it is on `sw` — it isn't, and the two-stage mutation below shows why, without that being a
coverage gap.

**Stage 1 (mutation 9a) — remove offscreen suppression alone.** `client.ts`'s `reportRejected`
clears the cached token (`writeAccessEntry(resource, null, ...)`, broadcast immediately)
*before* calling `acquireToken` (the step `tokenEndpointHang` stalls). The offscreen document's
`tokenChanged` listener normally caches that `null` right away, and any of the other nine
callers whose `tokenIdFor()` read happens afterward see `null` and never send `reportRejected`
at all (the `if (tokenId)` guard in `offscreen.ts`) — a real, independent coalescing mechanism,
not the lock. Mutating the listener to ignore `null` broadcasts (so the stale tokenId stays
cached and all ten callers still report it) left both tests passing unchanged: the lock alone
still coalesces correctly. Expected, and confirms the lock genuinely engages on this path.

**Stage 2 (mutation 9b) — also remove the lock.** With suppression *and* the lock both gone,
token requests did not climb to ~10 (what mutation 3 alone produces on `sw`, which has no
suppression to begin with). Test 8 failed, but with exactly 2 token requests. Test 9 did not
fail at all — still exactly 2. Un-smoothed: this is the actual result, not the predicted one.

**Why this isn't a gap:** `reportRejected`'s idempotency check is `await readAccessEntry(...)`
followed by a comparison — and `readAccessEntry` is `chrome.storage.session` IPC, not an
in-memory read. With both deliberate mechanisms removed, most (but, on this evidence, not
reliably all) of the ten concurrent calls' reads still land after the first call's write has
already cleared the entry, so they no-op anyway — coalescing by accident of storage-IPC timing,
the same *class* of problem the original test 57 had (real IPC latency masking a missing
safeguard), just one layer deeper (`chrome.storage.session` instead of
`chrome.runtime.sendMessage`) and with no `tokenEndpointHang`-equivalent lever available to
force it open (nothing server-controlled sits on that path). The 2-vs-10 result is the finding,
not a defect: it demonstrates three independent, stacked coalescing mechanisms on the worker
path — offscreen suppression (stage 1's evidence), this storage-read timing accident (stage 2's
evidence), and the lock (test 57 and `client.test.ts`'s unit equivalent, decisively) — not the
absence of one. See `packages/iap-auth/src/client.ts`'s comment at this `readAccessEntry` call
for the standing note that this third mechanism is accidental, not designed, and could
disappear if that read is ever made synchronous or cached in memory.

**General lesson, worth keeping since this is the second time it applied:** when a mutation
fails to produce the predicted failure, the first question is whether another layer is
legitimately doing the work, not whether the test is broken. Test 57's original finding
(mutation 3, above) was a genuine gap — no other mechanism was catching it, IPC latency was
just accidentally serializing the calls closely enough, often enough, to hide that. This one
isn't — tracing the actual mechanism (offscreen suppression, then storage-read timing) showed
real, if partly accidental, protection actually present. Distinguishing "another layer is
doing the work" from "nothing is doing the work and I got lucky" is the actual skill mutation
testing is for; it means reading the code path each time a mutation surprises you, not
adjusting the assertion to match whatever number came out.

## Tests 29-31 (Task 12) and a pre-existing mislabel found while building them: test 34

Tests 29 (`tamperState`), 30 (`rejectCodeExchange`), and 31 (`reissuePreviousCode`) are new
this round, constructed server-side per Task 12 — the client's own `state`/`code_verifier`
are internal and un-externalized, but the authorization server is a fake this project controls
entirely, so all three attacks are constructible from the control plane with zero client or
extension changes. All three are mutation-proven above (rows 10-12): tampering removed, code
exchange rejection removed, and code reuse removed each independently break the corresponding
test.

Building `tamperState` and `reissuePreviousCode` required minting a real, correctly-bound
authorization code server-side (`mintRealCode` in `as.ts`) — and getting this working exposed
two things a manually-minted `AuthorizationCode` needs that `provider.interactionFinished()`'s
normal path supplies implicitly and easily go unnoticed:
- `expiresWithSession: true` requires a resolvable `sessionUid`; a manually-minted code never
  has one, so the code fails to be *found at all* at exchange time (`invalid_grant`), before
  any of the property actually being tested is reached. Fixed by not setting it (these codes
  don't need session-expiry semantics).
- The code needs its own `resource` field set explicitly (RFC 8707) — a grant-level
  `addResourceScope()` alone isn't enough. Without it, exchange fails with `invalid_target`,
  again before the property under test is reached.

**This directly implicated test 34** (`injectForeignCode`, pre-existing from an earlier round,
not previously mutation-checked — a genuine gap `project_mutation_check_requirement` exists to
close): it uses the same manual-mint pattern and had neither fix. Verifying it (Task 12's
explicit follow-up, not assumed) found two layered problems, not one:

1. **The construction bug applied here too.** `injectForeignCode`'s decoy code also had
   `expiresWithSession: true` and no `resource` field, so — before this pass — it was very
   likely being rejected for the *same* not-found/no-resource reason as 29/31 initially were,
   not the PKCE mismatch its comment claimed. Fixed identically (dropped `expiresWithSession`,
   added `resource`).
2. **Even with the construction bug fixed, the test still doesn't exercise PKCE.** The decoy
   code is deliberately bound to *this interaction's own* `code_challenge` (the real client's
   own PKCE value for this attempt) — so if PKCE verification were what ran, it would actually
   *match*. Tracing `node-oidc-provider`'s token-endpoint handler
   (`node_modules/oidc-provider/lib/actions/grants/authorization_code.js` and
   `helpers/grant_common.js`) shows `findGrantSource()` and `validateGrant()` both check the
   code/grant's client identity against the client presenting it, and both run *before*
   `checkPKCE()`. A decoy-client code is rejected on client-identity binding — PKCE is
   structurally unreachable in this scenario, by code order, not by observation. This is a
   real, correct RFC 9700 defense (binding a code to the client that requested it) — just not
   the one the test's comment claimed.

**Disposition:** fixed the construction bug, corrected the comments in both `as.ts` and the
test itself to describe client-identity binding accurately, and noted the resulting gap this
exposes (no test here isolates genuine PKCE `code_verifier` mismatch in isolation — a scenario
with correct client identity but a wrong/foreign `code_challenge`, not yet built) rather than
letting the corrected label quietly imply nothing changed. Mutation-proven (row 13): disabling
`injectForeignCode` entirely makes test 34 fail, confirming it depends on the scenario firing —
the client-identity-binding property it actually tests. No coverage was lost; it was
mislabeled, and the mislabeling had gone unnoticed specifically because the test had never been
mutation-checked before.

## Task 13: a real observation surface for the request log

The request log recorded header *presence* only, so "exactly one Authorization header carrying
the current token" (test 63) and audience isolation (test 35, tests 17/9's audience-adjacent
assertions) were inferred from the request succeeding rather than observed directly — a
malformed, duplicated, or foreign-but-still-accepted header would have passed unnoticed.

Extended `RequestLogEntry` with `authorizationTokenId`: the bearer token's identity, hashed the
same way (`shortHash`, duplicated in `packages/test-server/src/hash.ts` — this package has no
dependency on `iap-auth` to import it from) IapClient's own `tokenId` is, so it's directly
comparable to `currentTokenId(driver, origin)` in tests without ever logging the raw token
value. Test 63 and test 35 rewritten to assert identity (`authorizationTokenId === tokenId`),
not just presence. Test 17 was checked but not changed: after Task 9's reverted attempt, its
current scope has no cached token at all (the only unambiguous case for detecting
"unprotected"), so there's no positive identity to assert — only absence, which it already
covers correctly.

Mutation-proven (row 14): this is new *test infrastructure* (the request-log field itself), not
product code, so the mutation matches the precedent set by mutation 7 (`fixtures.ts`'s
`stopServiceWorker`) — break the instrumentation, confirm the tests built on top of it actually
depend on it. Forcing `bearerTokenId` to always return a fixed wrong value left presence
assertions passing and failed both tests exactly at the new identity assertion, confirming
they're genuinely exercising the new field rather than passing vacuously.

## Task 14: recovering test 40's `via: 'worker'` variant

`context.setOffline(true)` doesn't reach the stand-in Worker's own `fetch()` in this
environment (confirmed directly, not assumed — see the test's own comment), so the `worker`
variant was skipped. The property is reachable server-side instead: added a new
`endpointUnreachable` target, `'resource'` (distinct from the existing `'resourceMetadata'`),
which destroys the socket for the protected resource itself — a real network-level failure the
stand-in's real `fetch()` genuinely hits, the same way Task 12's control-plane scenarios
constructed attacks the client's own internals couldn't be reached from. Also added
`endpointUnreachable`'s missing `{on: false}` support (mirroring `unprotected`/
`rotateRefreshTokens`), needed to restore reachability mid-test for the recovery assertion.

Worth recovering specifically (not just for coverage symmetry) because the worker path has a
failure mode the sw path structurally can't: the offscreen document's `handleStandInFetch`
decides, on its own, whether a Worker-reported outcome looks like a token rejection — a
transport failure and a 401 are two different things it has to tell apart correctly. Mutation
15 targets exactly that: made the offscreen document treat *any* Worker error (not just a 401)
as a rejection worth reporting. It fails test 40 (`via: 'worker'`) as expected — a spurious
`/token` request appears where the test asserts there must be none — confirming the test
actually depends on that distinction being made correctly, not just on the offline case
happening to produce a `TRANSPORT`-shaped outcome.

## Task 15: closing the test 27 gap

`discovery.spec.ts`'s test 27 comment claimed `fallbackClientId`'s success path was "covered by
packages/iap-auth's own unit tests" — that test did not exist (the finding that motivated
`[[feedback_verify_coverage_claims]]`). Written now: `client.test.ts`'s "fallbackClientId >
succeeds using the configured fallback client id when the AS has no registration_endpoint".
Reaching it required a real, statically-registered client on the test AS
(`FALLBACK_CLIENT_ID` in `as.ts`) — with no `registration_endpoint`, the client never tells the
AS its `redirect_uri` via DCR, so the AS has to already know a client by that exact id and
`redirect_uri` ahead of time, the same "the test server is ours" pattern Task 12 used.

Also answered the question the gap exposed: the shipped extension deliberately does not
configure a `fallbackClientId`, and that's correct, not an oversight. PROMPT.md frames DCR (RFC
7591) as letting the client "self-register with no admin step" — `fallbackClientId` exists for
the opposite case, an AS that doesn't support DCR at all, requiring an operator to have
pre-registered a client_id with that specific AS out of band. Configuring one at build time
would only work against that one pre-known AS, contradicting the extension's own "any RFC
9728-compliant resource, zero admin step" design. It's library-only API for a consumer of
`@iap-demo/iap-auth` targeting a specific, known, DCR-less AS. Documented at both ends: test
27's comment in `discovery.spec.ts`, and the `createIapClient` call site in
`packages/extension/src/service-worker/index.ts`.

Mutation-proven (row 16): disabled the `fallbackClientId` branch in `discovery.ts` entirely —
the new unit test fails with the same `MISCONFIGURED` error the "without a fallbackClientId"
half already asserts, confirming the new test genuinely depends on that branch being taken.

## Notes on process

- Mutations to `packages/extension/src/service-worker/index.ts` (mutation 5) and
  `packages/e2e/src/fixtures.ts` (mutation 7) were applied, run, and reverted individually
  within this task — consistent with the earlier agreement that a non-empty diff there is
  flagged and explained, not silently introduced. Both were reverted via `git checkout --`
  before this document was written; neither left a lasting change.
- Mutation 3's TypeScript build reported two `noUnusedLocals`/`noUnusedParameters`-adjacent
  errors during the temporary lock-removal (the unused `inFlight` map and `logger` field) —
  expected and harmless for a throwaway mutation; Vite's build (which the e2e suite actually
  runs against) does not block on `tsc` errors, so the mutated extension still built and ran
  correctly for the test.
