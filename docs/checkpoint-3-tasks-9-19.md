# Checkpoint 3 follow-up: Tasks 9–19

Tasks 7 and 8 are accepted. The mutation check did its job — finding that test 57 cannot
distinguish "lock present" from "IPC latency happened to serialize the calls" is precisely the
class of problem it existed to surface, and disclosing a false coverage claim you wrote
yourself (test 27) is what makes the rest of the disclosure credible.

Generalize from the errors that resulted in all of the checkpoint 3
follow-up tasks and capture as memories. Don't literally generate 19
memories -- capture the principles that you will follow in the
future. Also capture them in a reviewable doc.

---

## Read this first: the test server is ours

The "Never written" section of the disclosure treats tests 29, 30, and 31 as unconstructible
because `state` and `code_verifier` are internal to `iap-auth` and never externalized. That
reasoning holds for the **client** — and stops one step too early.

You do not need to reach inside the client to tamper with these values. **You control the
authorization server.** `state` is echoed back by the AS in the redirect. Authorization codes
are minted by the AS. Token-endpoint outcomes are decided by the AS. Anything the AS controls
is constructible from the control plane without touching a single line of extension code, and
PROMPT.md explicitly permits adding scenarios that are missing.

The same blind spot appears in the test 63 entry, which treats the request log's shape — header
*presence* but not count or value — as a fixed constraint. The request log is ours too.

Tasks 12 and 14 below follow from this. When you hit "this isn't observable," check whether the
server could observe or cause it before concluding it needs a hook.

---

## Product gaps

### Task 9 — A resource that becomes unprotected must stop receiving tokens

This is filed in the disclosure under "Reinterpreted scope … not a softening." It is a product
gap, and the reinterpretation conceals it.

PROMPT.md, Component A: *"Handle transitions both ways mid-session"* — and explicitly, *"one
that becomes unprotected must stop sending tokens."* The disclosure's own reasoning shows the
client does not do this:

> A resource this client already had a token for would keep sending that (harmless, ignored)
> header after flipping unprotected.

It is not entirely harmless. Treating the resource as protected when
it is not may result in a spurious request to the user to
re-authenticate.

Optimism and this requirement are not in conflict. Optimism governs the *request*; this governs
what the client does with the *response*. A 200 carrying no `WWW-Authenticate` challenge from a
resource we hold a token for is positive evidence the resource is no longer IAP-protected:
mark it unprotected, drop the cached token, and remove the DNR rule.

- Implement it.
- Restore test 17 to the spec's wording: establish a token, flip to `unprotected`, assert
  subsequent requests carry no `Authorization` header — asserted from the request log, in both
  `via` modes, since the SW path and the DNR path drop the token by different mechanisms.
- Add a mutation-check row: skip the drop-on-unprotected step, confirm test 17 fails.

### Task 10 — The `currentTokenId` / `updateSessionRules` ordering violation

`performFetch`'s comment states that `currentTokenId` reflects a new token before
`updateSessionRules` has been awaited. That violates Component A's contract that listeners are
awaited before the triggering call resolves.

Note what the mutation check did and did not establish. Mutation 5 ("never update the DNR rule")
correctly failed test 55, so the rule-update path *is* covered. But no mutation targeted the
**ordering**, so test 54 — "the session rule is installed before `getToken` resolves" — remains
unverified.

- Add a mutation that updates the rule but does **not** await it (fire-and-forget in the
  `onTokenChanged` listener). If test 54 still passes, it is not asserting the ordering and must
  be rewritten before the fix lands.
- Then fix the ordering where it actually is — module resolving early, or the listener updating
  other state before awaiting the DNR call.
- Then reduce `performFetch`'s worker-mode retry to the one round trip PROMPT.md documents. If
  more than one is still needed afterward, report it rather than restoring the bound.

---

## Test-strength gaps

### Task 11 — Make test 57's concurrency deterministic

Neither option in `mutation-check.md` is the right one. Both accept that real IPC scheduling
determines whether the ten calls actually overlap. Don't accept that — **force the overlap**.

The test server already has `tokenEndpointHang(seconds)`. Arm it for ~1s before firing the ten
concurrent `reportRejected` calls. Now the first refresh is guaranteed still in flight when the
other nine arrive, so `reportRejected`'s idempotency check cannot collapse them (the token has
not been superseded yet — that is precisely what the hang prevents). Only the lock can. Deterministic,
not timing-fragile, and it removes the IPC-latency dependency entirely rather than working
around it.

- Rewrite test 57 this way.
- **Re-run mutation 3 against it.** It must now fail. If it does not, the test still is not
  asserting what it claims and you should report that rather than adjusting the assertion.

Then apply the same technique to tests 8 and 9's `via: 'worker'` variants, where
`toBeLessThanOrEqual(4)` currently hides two different causes at once. With the overlap forced, a
missing lock produces ten refreshes while the documented tokenId-echo race produces far fewer, which
finally separates them.

**Derive the new bound from the mechanism, not from observation.** Do not run the test, watch what
number comes out, and assert slightly above it — that is how the current `4` got there, and a bound
calibrated to this machine's scheduling will drift on slower CI and has to be raised again,
ratcheting toward meaninglessness. Reason it out from the code instead: `reportRejected` is
idempotent per tokenId, so each *distinct* tokenId that can be echoed during the window is worth at
most one refresh. Work out how many distinct tokenIds can exist in that window — the stale one, plus
however many replacements the SW can publish while the ten reports are arriving — and assert that as
an **exact** count, with the derivation written into the test's comment so the next reader can check
the reasoning rather than trusting the number.

If the derivation comes out genuinely unbounded — if the number of publishable tokenIds depends on
scheduling rather than on the code path — say so, and assert a different property instead: that the
refresh count equals the number of distinct tokenIds actually reported. That is computable from the
request log plus the tokenIds the offscreen document echoed, holds regardless of how the scheduler
behaves, and still fails outright if the lock is missing. A timing-independent assertion of a weaker
property beats a timing-dependent assertion of a stronger one.

### Task 12 — Construct tests 29, 30, and 31 server-side

All three are constructible. New control-plane scenarios, no extension changes.

**29 — tampered `state`.** Add `tamperState`: the AS rewrites the `state` parameter in the
authorization redirect's `Location` before returning it. The client receives a redirect whose
state does not match what it sent. Assert: rejected, no token request follows.

**30 — re-scope, then implement.** The literal wording ("wrong `code_verifier` → rejected, no
token issued") describes an *AS* property, and the AS is `node-oidc-provider`, whose PKCE
correctness is not ours to prove. The client-side property worth testing is what happens when
the token exchange is rejected. Add `rejectCodeExchange`: the token endpoint returns
`invalid_grant` on an `authorization_code` grant. Assert the client surfaces a clean classified
error, does not wedge, does not loop, and a fresh login afterward succeeds. Record the
re-scoping explicitly — this is a genuine change of what is being asserted, not a restatement.

**31 — replayed authorization code.** Add `reissuePreviousCode`: the AS returns the same
authorization code for a second login as it did for the first. `node-oidc-provider` enforces
single-use, so the second exchange fails naturally. Assert: the second attempt fails, the client
does not wedge, and a subsequent fresh login succeeds. No `code_verifier` access needed.

Test 34 (`injectForeignCode`) stays as-is; it covers a different vector.

### Task 13 — Give test 63 a real observation surface

The request log records header presence, not count or value, so "exactly one `Authorization`
header carrying the current token" is currently inferred from the request succeeding.

Extend the request log to record the raw `Authorization` header value (or values, if the header
appears more than once) alongside the existing presence flag. Then assert test 63 directly:
exactly one header, value equal to the current token. This also strengthens Task 9's test 17 and
the audience-isolation tests, which currently assert presence where they mean identity.

Truncate or hash the recorded value if you prefer — an 8-char prefix is enough to compare
against `currentTokenId`, consistent with the module's own logging convention.

### Task 14 — Recover test 40's worker variant

`context.setOffline(true)` not reaching the Worker target is correctly
diagnosed, but the property is reachable server-side: arm
`endpointUnreachable` on the resource server instead.

Worth recovering because the worker path has a failure mode the SW path does not — the offscreen
document misreading a transport failure as a rejection and firing a spurious `reportRejected`,
producing a refresh in response to a network blip. Assert from the request log that **no** token
endpoint request occurs.

### Task 15 — Close the test 27 gap

The disclosure reports that `discovery.spec.ts` claims the `fallbackClientId` success path is
covered by a unit test that does not exist. Write it.

Then answer a question the gap exposes: the shipped extension does not configure
`fallbackClientId`, so that path is unreachable through the real extension. Decide and document
whether it is (a) library-only API for future consumers, in which case unit coverage is
sufficient and the e2e comment should say so, or (b) something the extension should configure,
in which case wire it and add the e2e half. Do not leave it as unreachable code with an
aspirational comment.

---

## Documentation and hygiene

### Task 16 — Document the tokenId↔request correlation limitation

Under DNR the header is attached below the JS layer, so a caller **cannot know which token its
request carried**. This is structural, not an implementation weakness, and will behave the same
against real Cloudflare Access. Write it into `packages/extension/docs/detecting-failure.md` covering
the mechanism, the blast radius, which assertions are bounded as a result, and any mitigation
considered and rejected.

**Determine empirically** whether a redundant refresh can consume a rotated refresh token and
trip the replay-detection path. If it can, the cost is materially worse than "one extra round
trip" and must be stated as such. Add a manual-verification note to watch for redundant
refreshes against real Cloudflare under concurrent library activity.

### Task 17 — Fix the header / MEMORY.md numbering collision

`fixtures.ts`'s header says "Three deliberate deviations" and lists six; the list runs 1, 2, 3,
4, 6, 7 with no 5; and the numbers do not correspond to MEMORY.md's, because
`--disable-extensions` is a numbered finding there but only an inline comment here. MEMORY.md
nonetheless says to check the header's "findings 1–7, verbatim."

Pick one numbering, apply it to both, fix the count, promote `--disable-extensions` to a numbered
finding in the header.

Also relabel fixtures' finding 2 (`sendMessage` from inside `worker.evaluate()`). It is not an
environment quirk — a service worker's own `onMessage` does not receive its own `sendMessage`,
which is documented Chrome behavior. PROMPT.md's Component D snippet was simply wrong. Mark it as
a spec correction so nobody re-tests it hoping a Chrome upgrade fixed it.

### Task 18 — The e2e suite can run against a build containing type errors

From `mutation-check.md`'s process notes: *"Vite's build … does not block on `tsc` errors, so the
mutated extension still built and ran correctly."*

Convenient for a throwaway mutation, wrong as a standing property — it
means a type error can reach the tested artifact. Add `tsc --noEmit`
as a gate in the extension's build script, so the artifact the suite
loads is one that typechecks.

### Task 19 — Replace test 7's request-count ceiling with a sequence assertion

Test 7 currently asserts `expect(after.length - before.length).toBeLessThan(25)`. PROMPT.md
asked for a bound rather than an exact count, so this is nominally compliant — but the number
has no derivation behind it. It was raised from an initial guess because the guess was too
tight, justified observationally ("recovery genuinely produces more requests than first
assumed"). That is calibration to whatever the code happens to do, which means the assertion
can never fail: any regression adding requests short of 25 passes silently, and if one ever
crosses 25, the argument for raising it again is exactly as strong as it was the first time.

It is also the wrong shape for the property. Test 7's real subject is **termination** — that
`revokeGrant` recovery converges instead of looping. A ceiling of 25 is so far above any
plausible correct recovery that it mostly detects infinite loops, which the test timeout
already catches.

Do not tighten the number. Replace the approach.

**Assert the request sequence.** A correct `revokeGrant` recovery has a knowable shape: failed
refresh → silent authorization ladder (discovery and authorization as required) → token
exchange → retried resource request. The request log records method, origin, and path, so
assert that the sequence of endpoint kinds matches the expected recovery path. This fails on a
spurious extra discovery or a duplicated registration, which no ceiling under 25 will ever
catch, and it documents what recovery is supposed to look like for the next reader.

**Assert idempotent endpoints are hit at most once.** Discovery and DCR are cached by design.
If recovery re-fetches AS metadata or re-registers the client, the cache is not working — a
real bug, currently invisible beneath the ceiling.

**Keep a count only as a derived backstop.** Sum the expected sequence, add the documented
retry, and write the arithmetic into the comment. A number with a derivation is checkable; one
calibrated to a machine is not.

**Expect to find something.** Roughly twenty requests for a single recovery is enough that
redundant discovery or re-registration is a live possibility. If that is what is happening, it
is a caching bug that has been sitting under this assertion since it was written — fix it, and
the derived count will come down on its own rather than by adjustment.

**Add a mutation-check row.** Break the discovery or registration cache so recovery re-fetches,
and confirm the new assertion fails. If it does not, the sequence assertion is not capturing
what it claims.

### Task 20 — Test 34 rejects for the wrong reason; split it and assert the cause

You found that `injectForeignCode` presents a **different client_id**, so the AS rejects on
client binding before PKCE verification is ever reached. The test named "an injected foreign
authorization code is rejected" passes, but not for the reason its name claims — and the PKCE
code-substitution defense it was believed to cover is currently untested.

This also invalidates the justification recorded for test 30. The disclosure argued that 34
"exercises exactly the same underlying defense (oauth4webapi's PKCE verification at the token
endpoint)" and therefore stood in for 30. It does not. Update that entry once this task lands.

#### 20.1 — Rename the existing test

Rename `34: an injected foreign authorization code is rejected` to reflect what it actually
verifies — a code issued to a different client is rejected — and update its comment. Client
binding is a real property worth testing; it was only mislabelled. Keep the number.

#### 20.2 — New scenario `substituteCodeChallenge`, new test 34a

Construct a code that reaches the PKCE check and fails *there*. The code must be valid in every
other respect so no earlier check short-circuits it:

- **Same** `client_id` as the real client — otherwise you reproduce 34.
- **Same** `redirect_uri`.
- **State echoed back unchanged**, so the client's local state check passes and the exchange is
  actually attempted.
- Bound to a `code_challenge` of the AS's choosing rather than the one the client sent.

The client then exchanges with its genuine `code_verifier`, which cannot match, and the AS
rejects on PKCE. Assert: the exchange fails, the client surfaces a clean classified error, does
not wedge, and a fresh login afterwards succeeds.

#### 20.3 — Assert *which* defense fired, in both tests

This is the part that generalizes. The original defect was that the test could not distinguish
one rejection cause from another. Fix the observation surface, not just this test: record the
AS's OAuth error code (`invalid_grant`, `invalid_client`, and so on) in the test server's
request log alongside the existing fields.

Then have test 34 assert the rejection carried the client-binding error, and 34a assert it
carried the PKCE-related one. Without this, 34a is one AS-configuration change away from
silently degenerating into 34 all over again.

#### 20.4 — Sweep the other rejection tests

Any test whose assertion is "rejected" without asserting *why* has the same latent defect.
Check at least 23 (cross-origin resource metadata), 24 (issuer mismatch), 29 (tampered state),
33 (error with no code), and 31 if it exists by then. For each: is there a plausible earlier
check that could be doing the rejecting instead of the one the test names? Where the error code
is now recorded, assert it. Where the rejection happens client-side and produces no server
error, assert the classified error's identity rather than merely that something threw.

Report the sweep's findings even where nothing is wrong — a short list confirming which tests
were checked and found sound is worth having.

#### 20.5 — Mutation-check rows

- Disable the PKCE verification the client relies on at the token exchange → 34a must fail.
- Point `substituteCodeChallenge` at a different `client_id` → 34a must fail on the *error code
  assertion*, not pass by accidentally reproducing 34. This is the regression guard for the
  exact bug being fixed here.
  
---

## Accepted without change

For the record, so these are not revisited: test 22's re-scoping to a `probe` message (correct —
`FetchOutcome` has no `unsupported` variant); test 13's skip (the environment limitation is real;
note in the disclosure what test 12's browser-restart path still covers and what it does not);
and the `via: 'sw'` half of test 40.

---

## Working agreement

Tasks 9 and 10 first, separately — both change product behavior and
may move other tests, i.e. stop for human review after each. Then
11–15, stop for human review. Then 16–19, stop for human review. Then 20.

Every new scenario added to the test server gets a matching mutation-check row: break the thing
it is meant to catch, confirm the test goes red. Append to `docs/mutation-check.md`. That
document was the most valuable artifact of the last round; keep it current rather than treating
it as a one-off.

Report any test whose result changes as a consequence of Tasks 9 or 10, especially green→red.
That is the expected shape of these fixes.

`biome check` and `tsc --noEmit` clean throughout. Product-code
changes in `packages/extension/src/` are expected in Tasks 9 and 10 —
flag them in the commit message as correctness rather than harness
support, as with the Task 2 dispatch wrapper.
