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
- Apply the same technique to tests 8 and 9's `via: 'worker'` variants. With overlap forced, a
  missing lock produces ten refreshes while the documented tokenId-echo race produces at most a
  small handful — which finally separates those two causes instead of hiding both under
  `toBeLessThanOrEqual(4)`. Tighten the bound to whatever the echo race alone can actually
  produce, and justify that number.

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

### Task 19 — Sanity-check test 7's request budget

The bound was corrected upward to `< 25` after observing that recovery from `revokeGrant` —
failed refresh, full silent authorization ladder, final retry — genuinely produces that many
requests. The spec asked for a bound, so this is compliant.

But 25 is a lot for one recovery. Count what a correct recovery *should* require and compare
against the log. If the excess is redundant discovery or re-registration that caching should have
prevented, that is a real inefficiency worth fixing and the bound should come down. If it is
inherent, record the breakdown in a comment so the next reader does not have to re-derive it.

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
11–15, stop for human review. Then 16–19, stop for human review.

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
