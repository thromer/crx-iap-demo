# Mutation check

Checkpoint-3 review, Task 8 (mutations 1–7); Task 10 adds mutation 8. For each mutation below:
the change was applied to the real source, the extension was rebuilt, the named test(s) were
run against the mutated build, the result was recorded, and the mutation was reverted via
`git checkout --` before moving to the next row (confirmed clean via `git status` between
mutations — none compounded). Every mutation was exercised individually, never combined. This
document is kept current across review rounds, not treated as a one-off (per the checkpoint-3
follow-up working agreement).

## Results

| # | Mutation | Must fail | Result |
|---|---|---|---|
| 1 | Revert Task 1's `TRANSPORT` classification (`net.ts`'s `classifiedFetch` stops catching/wrapping) | 40 | ✅ Failed as expected — `errorClass` was `UNKNOWN` instead of `TRANSPORT` |
| 2 | Make the single-flight lock global instead of per-resource (`lock.ts`'s `run()` uses a fixed key) | 9 | ✅ Failed as expected — one resource's refresh blocked the other's; only 1 token request instead of 2 |
| 3 | Remove the single-flight lock entirely (`lock.ts`'s `run()` calls `fn()` directly) | 8, 57 | ⚠️ **8 failed as expected** (20 token requests instead of 1). **57 did NOT fail** — see finding below |
| 4 | Skip the cross-origin `resource_metadata` origin check (`discovery.ts`'s `discoverResource`) | 23 | ✅ Failed as expected — client attempted the foreign origin, got `TRANSPORT` (unreachable) instead of the expected `MISCONFIGURED` from the (skipped) validation |
| 5 | Never update the DNR rule after a refresh (`service-worker/index.ts`'s `onTokenChanged` listener, install-once-per-resource) | 55 | ✅ Failed as expected — the stand-in Worker's requests kept 401ing against the stale rule, exhausted the retry bound, `outcome.ok` was `false` |
| 6 | Return a stale token from `getToken` after `reportRejected` (`client.ts`'s `readAccessEntry` memoizes the first read per resource, ignores later writes) | 58 | ✅ Failed as expected — the second, already-superseded `reportRejected` call triggered a second refresh instead of no-op'ing |
| 7 | Make `stopAllWorkers` a no-op (`fixtures.ts`'s `stopServiceWorker`, post-Task-5) | 10, 11 | ✅ Both failed as expected — `service worker did not stop within 3000ms (Target.getTargets still lists ...)` |
| 8a | Fire-and-forget the DNR update in `onTokenChanged` (`service-worker/index.ts`, before the `syncToken()` extraction) | 54 (e2e) | ❌ **Did NOT fail** — see finding below |
| 8b | Fire-and-forget `updateRules` inside `syncToken()` itself (`token-sync.ts`, `await effects.updateRules(...)` → `void effects.updateRules(...)`) | `syncToken()` unit tests (`token-sync.test.ts`) | ✅ Failed as expected — `publishTokenId` observed `rulesUpdated === false` |
| 8c | Fire-and-forget the listener loop in `writeAccessEntry` (`client.ts`, `await listener(...)` → `void listener(...)`) | `client.test.ts`'s "onTokenChanged ordering > awaits listeners before getToken resolves" (pre-existing, from Tasks 1–4) | ✅ Failed as expected — `listenerFinished` was still `false` when `getToken` resolved |

**8 of 10 mutation attempts produced the predicted failure, for the predicted reason** (2, 3, 4, 5, 6, 7, 8b, 8c fired correctly; 3/57 and 8a did not, both resolved by moving the observation point rather than the assertion — see below).

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
