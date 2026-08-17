# Checkpoint-3 review: principles behind Tasks 9–19

The follow-up round (`checkpoint-3-tasks-9-19.md`) named 19 specific tasks. Rather than one
memory per task, these are the four recurring failure modes behind them — captured as
persistent memory (so they carry into future sessions) and here, for review.

## 1. "Not testable without a hook" often stops one step too early

Tests 29–31 were declared unconstructible because `state` and `code_verifier` are internal to
`iap-auth` and never externalized by the client. True, but incomplete: the authorization server
that issues and validates those values is a fake I control entirely. It can rewrite a `state`
in a redirect, mint a code with the wrong binding, or reissue a stale one — none of which
touches a line of client code. The same blind spot showed up treating the request log's shape
(header presence, not value) as fixed, when the log is written by test-server code I'm equally
free to extend.

**The check going forward:** before writing "not constructible without a hook," ask
specifically whether the *other side* of the boundary — a fake/mock/server already under my
control — could produce or observe the same effect. Reserve "not constructible" for cases where
that really would require touching the production code under test.

## 2. A narrowed test can be hiding a real bug, not resolving an architecture conflict

Test 17 needed "a resource that becomes unprotected must stop receiving a token." The client's
`fetch()` is deliberately optimistic and doesn't clear a cached token on discovering a resource
is unprotected, so I reasoned the stale header would be sent "harmlessly" and rewrote the test
around a resource with no prior cached token — avoiding the case the spec actually meant.
Optimism and this requirement aren't in tension: optimism governs the *request*; dropping a
token on discovering unprotected status governs the client's reaction to the *response*. The
client was missing real behavior.

**The check going forward:** when a "faithful reinterpretation" of a test happens to land
exactly on what the code currently does, rather than on some other equally-valid reading of the
spec, that's the tell. Ask "is this the code being wrong, not the spec being ambiguous?" before
finalizing the narrower test.

## 3. Concurrency tests over async transport can pass by accident

A mutation check that deleted a single-flight lock entirely correctly failed the in-process
unit-test equivalent of "ten concurrent calls collapse to one" (true synchronous `Promise.all`,
no transport in the way) but did *not* fail the e2e version of the same claim, which drives the
ten calls through real `chrome.runtime.sendMessage` IPC. `Promise.all()` guarantees the calls
are *issued* together; it does not guarantee they *arrive* together once each one travels
through a real transport. IPC scheduling staggered the ten calls enough that an unrelated,
weaker mechanism (an idempotency check keyed on a value that had, in practice, usually already
changed) produced the same observable result the lock would have — so the test passed without
the lock ever being exercised.

**The check going forward:** for any test whose entire point is "N concurrent operations
collapse to fewer" over a transport that isn't guaranteed-synchronous, don't trust
`Promise.all()` alone. Force the race window open deterministically — here, arming a
server-side stall on the first in-flight request guarantees the other nine are still pending
when they arrive — so only the real mechanism can produce the correct result, and validate that
the same way a mutation check would: break the mechanism, confirm the test now fails.

## 4. An unverified "covered elsewhere" claim is worse than an admitted gap

A discovery test's comment claimed `fallbackClientId`'s success path was "covered by
`packages/iap-auth`'s own unit tests." No such test existed. It was caught only by chance,
while compiling an unrelated disclosure document. A false coverage claim doesn't just fail to
close the gap — it actively hides it from every future review that reasonably trusts the
comment instead of re-checking.

**The check going forward:** before writing that a property is "covered by" something other
than the code immediately in front of me, go read that coverage and confirm it actually asserts
the specific thing being claimed. If it doesn't exist yet, write it in the same pass or say
plainly that it doesn't, rather than describing an aspiration as a fact.

---

These are captured as memory (`feedback_test_double_authority`,
`feedback_reinterpretation_vs_product_gap`, `feedback_deterministic_concurrency_tests`,
`feedback_verify_coverage_claims`) so they inform work on this repo — and any repo with a
similar shape — in future sessions, not just this review round.
