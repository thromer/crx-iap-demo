# Mutation check

Checkpoint-3 review, Task 8. For each mutation below: the change was applied to the real
source, the extension was rebuilt, the named test(s) were run against the mutated build, the
result was recorded, and the mutation was reverted via `git checkout --` before moving to the
next row (confirmed clean via `git status` between mutations — none compounded). All seven
mutations were exercised individually, never combined.

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

**6 of 7 mutations produced the predicted failure, for the predicted reason.**

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
