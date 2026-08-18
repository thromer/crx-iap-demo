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
