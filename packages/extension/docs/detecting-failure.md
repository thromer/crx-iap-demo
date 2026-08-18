# Detecting a rejected token (checkpoint-2 decision)

PROMPT.md requires picking between two failure-detection paths before proceeding past
checkpoint 2: wrapping a public error/response path the library already exposes, or a
service-worker polling fallback. This build uses the **first path**.

The stand-in library's Worker (`src/standin/worker.ts`) posts `{status}` back to whoever
commanded it after every request. The offscreen document (`src/offscreen/offscreen.ts`) is
that caller — it is the "wrapper around the library's response path" the decision calls for.
On any `401`, *if* it has a cached tokenId for that resource (pushed from the service worker
via a `tokenChanged` broadcast, or pulled via `currentTokenId` on a cache miss), it calls
`reportRejected(resource, tokenId)`. No cached tokenId (resource never had a token attached —
unprotected, or an app-level 401 unrelated to IAP) means nothing is reported. A `403` is never
reported regardless of status — see test matrix group "DNR attachment", #62.

This is a **narrower integration point than a network primitive**, per PROMPT.md: the
offscreen document reads an outcome the library already handed back, rather than patching or
observing `fetch` itself.

**Assumption this rests on:** the real third-party library, whatever it turns out to be, hands
its caller *some* indication of the response it got — a status code, a thrown error, anything
inspectable. If the real library swallows failed responses entirely and exposes nothing, this
path doesn't apply and the documented fallback is the service worker polling a lightweight
endpoint on its own schedule (PROMPT.md's "genuine downgrade from per-request detection").
That fallback is **not implemented** here, since the stand-in doesn't need it — confirm which
case actually applies once the real library is integrated, and build the fallback only if it's
the one that's needed.

## Concurrent rejections: the cached tokenId can go stale mid-flight

"Pushed via `tokenChanged`, or pulled via `currentTokenId` on a cache miss" (above) is a cache,
and like any cache it can be read after the value it reflects has already changed. Under
concurrent 401s for the same resource, the SW can complete a refresh — and broadcast the new
state — between one caller detecting its 401 and that caller reading the cached tokenId to
report it. Two effects follow from this, and they pull in opposite directions:

- **The echo race** (documented in PROMPT.md and exercised by tests 8/9's `via: 'worker'`
  variants): a caller can read the *new*, now-current tokenId instead of the stale one its own
  request actually carried. `reportRejected` can't tell "this is a stale report of an
  already-superseded token" (correctly a no-op) apart from "this is a genuine rejection of the
  token that's current right now" (correctly triggers another refresh) — so a stale report that
  happens to land on the new tokenId triggers an extra, unnecessary refresh.
- **Suppression** (checkpoint-3 review, Task 11a): the *first* effect of a refresh completing
  is `writeAccessEntry(resource, null, ...)`, broadcast immediately — before the refresh's own
  `/token` request is even issued. A caller whose read lands after *that* broadcast (but before
  the new tokenId's broadcast) sees `null` and, per the `if (tokenId)` guard above, reports
  nothing at all. This is the *opposite* failure mode from the echo race: instead of an extra
  refresh, it's a caller correctly declining to pile on because someone else has already started
  fixing the problem — real coalescing, confirmed by mutation
  (`docs/mutation-check.md`'s mutations 9a/9b): removing it alone changes nothing (the lock
  still catches everything), but it measurably reduces concurrent refresh churn on its own when
  the lock is also absent.

Net effect: suppression partially mitigates the echo race's blast radius in practice (fewer
callers are even reading a stale tokenId to begin with, since some have already been told
"already handled") without changing its worst case — a caller can still read *between* the null
broadcast and the new-tokenId broadcast and get neither protection. Bounded, not eliminated.

**What happens to a suppressed caller if the in-flight refresh fails, rather than succeeds?**
It's waiting (via `waitForTokenChange`, in the e2e harness's `performFetch` — see
`packages/e2e/src/fixtures.ts`) for a tokenId that only ever arrives if the refresh that
triggered suppression actually completes. Checked directly (checkpoint-3 review, Task 11a) by
arming `invalidGrantOnNextRefresh` together with `tokenEndpointHang` and observing the
suppressed callers' outcome: **it does not hang.** A failed refresh falls through to the
authorization ladder as usual (GRANT_DEAD, then silent re-auth); once that completes and
broadcasts, every waiter — suppressed or not — sees the new tokenId and proceeds. Suppression
only ever defers a caller's own report, never blocks it on nothing. See
`packages/e2e/tests/dnr-attachment.spec.ts`'s test 57b for the permanent coverage.

## The tokenId↔request correlation limitation (checkpoint-3 review, Task 16)

**Mechanism.** Under DNR, the `Authorization` header is attached by the browser's network
stack, below the JS layer entirely — `packages/extension/src/service-worker/dnr.ts`'s rule
`set`s a header value on matching requests; nothing in this extension's JS ever sees what a
specific outgoing request actually carried. So when the offscreen document observes a `401`
from the stand-in Worker's request, it cannot know *which* token that particular request was
rejected for — it can only report whatever tokenId it currently believes is valid (`tokenIdFor`,
above). This is **structural, not an implementation weakness**: no code change on this side
closes the gap, because the information genuinely never reaches JS. It will behave identically
against real Cloudflare Access, or any other DNR-fronted resource.

**Blast radius.** This is the root cause of the echo race documented above, not a separate
issue — "the cached tokenId can go stale mid-flight" is what this structural gap actually looks
like in practice. Concretely: a caller can name the *current* tokenId as rejected when its own
request in fact carried a *stale* one (or vice versa), because there is no way to bind "this
401" to "this specific token value" after the fact. The cost is an occasional redundant
refresh, not a correctness failure — see the replay-detection finding below for how bounded
that cost actually is.

**Which assertions were bounded as a result, and what changed.** Before checkpoint-3 review
Task 11, this gap forced tests 8 and 9's `via: 'worker'` variants into a loose bound
(`toBeLessThanOrEqual(4)`) rather than an exact count, since real IPC scheduling determined how
often the race actually fired. Task 11 didn't close the structural gap — it forced the race
window shut for those two tests specifically, by arming `tokenEndpointHang` so no second
tokenId can even exist yet by the time all ten reporters have read the cached value; that
collapsed the *observable* result back to an exact count without touching the underlying
mechanism. One assertion remains genuinely bounded because of a related-but-distinct gap (not
this one): test 54 (`dnr-attachment.spec.ts`) asserts eventual success within `performFetch`'s
retry cap, not first-attempt success, because of the `currentTokenId`/DNR *ordering* limitation
Task 10 fixed for the deliberate-write case but that a native browser API's own timing can't be
forced open for testing (see `docs/mutation-check.md`'s mutation 8 finding).

**Mitigations considered and rejected.** Reading the request's own headers via
`chrome.webRequest.onBeforeSendHeaders` (or similar) would let the offscreen document observe
the *actual* header DNR attached, closing the correlation gap directly. Rejected: it would
reopen exactly the choice PROMPT.md's checkpoint-2 decision already settled — "a narrower
integration point than a network primitive" (this file's top section) — by adding a
network-observation primitive back in, plus the extra permission surface and complexity that
choice was made to avoid. Snapshotting the tokenId *before* issuing the request (rather than
after detecting failure) doesn't help either: DNR evaluates and attaches the header
asynchronously, invisible to JS, at send time — a rule can still change between snapshot and
send regardless of when the snapshot is taken, so earlier snapshotting doesn't narrow the
window, only moves it.

**Determined empirically, not assumed: can a redundant refresh consume an already-rotated
(dead) refresh token and trip replay detection?** This would be a materially worse cost than
"one extra round trip" — `node-oidc-provider`'s rotation replay detection revokes the *entire
grant* on a reused refresh token, forcing full re-authentication. Checked directly: armed
`detectRefreshReplay` (which also enables `rotateRefreshTokens`), established a token, then
issued five *sequential* `reportRejected` calls each naming whatever the *current* tokenId was
at the time — simulating the echo race's worst case, where a stale report happens to land on
the current value, repeatedly. All five succeeded, and a final fetch afterward still succeeded
— the grant survived every round. This holds by construction, not luck: `acquireToken`'s read
of the refresh token and its submission to the AS both happen strictly inside the single-flight
lock's critical section for that resource (see `client.ts`), so no caller can ever read a
refresh token that a *concurrent* caller is about to rotate out from under it — by the time any
redundant refresh runs, it's reading whatever the lock's most recent holder just wrote. The
echo race can still produce wasted round trips; it cannot produce a stale-token replay, because
the lock's atomicity rules that out structurally, not incidentally. No manual-verification note
was needed beyond what's already there, given this was proven rather than left as a risk to
watch for — but worth re-confirming against real Cloudflare Access if the single-flight lock
implementation ever changes shape, since the guarantee depends specifically on read-then-submit
staying atomic within it.
