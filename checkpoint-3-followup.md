# Checkpoint 3 follow-up: hardening tasks

Your review answers were complete and the self-reported gaps in A.4/B.6 are accepted as
accurate. `packages/extension/` shows a zero-byte diff since checkpoint 2, so the no-hooks
constraint held — that is the most important result in the review and it passed.

Do the tasks below in order. Tasks 1–4 are correctness. Task 5 is a validity problem with the
harness itself and matters more than its size suggests. Tasks 6–8 are disclosure and
verification.

Do not start any task before the one above it is complete and its tests pass.

---

## Task 1 — One chokepoint for network errors, not four wrapped call sites

The current design wraps individual call sites. That is why two were missed, and a fifth added
later will be missed the same way. Replace it with a single boundary.

You established in B.7 that `oauth4webapi` passes fetch failures through unmodified, and that
it accepts an override: `(options?.[customFetch] || fetch)`. Use it.

- Build one `transportFetch` in `iap-auth` that wraps `fetch`, catches any rejection, and
  rethrows as an `IapError` with class `TRANSPORT`, preserving the original as `cause`.
- Pass it as `[customFetch]` to **every** `oauth4webapi` call: `resourceDiscoveryRequest`,
  `discoveryRequest`, `dynamicClientRegistrationRequest`, `authorizationCodeGrantRequest`,
  `refreshTokenGrantRequest`, `revocationRequest`.
- Route `issueResourceRequest` through the same `transportFetch`. All four call sites then
  inherit the behavior; remove the two ad hoc `try`/`catch` wrappers in `fetch()` so there is
  exactly one place this is handled.
- Add a lint rule or a unit test asserting that no module in `iap-auth` calls bare `fetch`
  outside `transportFetch`. A structural guarantee, not a convention — this is the whole point
  of the task.

Fix the two gaps you identified (`client.ts:113` in `ensureDiscoveryContext`, `client.ts:360`
in `probe`) as a consequence of this refactor, not as separate patches.

## Task 2 — `handleProbe` and every other message handler

`handleProbe` has no `try`/`catch`, so a throw leaves `sendResponse` uncalled and the caller's
`sendMessage` hangs forever. You correctly identified this as more severe than the
classification gap: a hung message channel has no timeout and no error, and in the real
extension it would hang the offscreen document's caller indefinitely.

- Audit **every** handler behind the `chrome.runtime` message API — `fetch`, `login`, `logout`,
  `probe`, `reportRejected`, `currentTokenId`. Each must respond exactly once on every path,
  including throws.
- Prefer a single dispatch wrapper that catches, classifies, and responds, over per-handler
  `try`/`catch` — same reasoning as Task 1.
- Add a test: arm `endpointUnreachable('resourceMetadata')`, send `probe`, assert a classified
  `TRANSPORT` response arrives within a bounded time. It must fail before the fix.

## Task 3 — Classify authorizer rejections; make `UNKNOWN` structurally unreachable

`UNKNOWN` being extension-layer, terminal, and non-prompting is a defensible design and I am
not asking you to remove it. But after Tasks 1 and 2 the only remaining producer is the
deliberately-unwrapped `authorizer.authorize()`, and those rejections carry real information
that is currently discarded.

`launchWebAuthFlow` rejects for at least three distinguishable reasons: the user closed the
tab, a flow is already pending, and the non-interactive attempt found no existing session.
These are not the same outcome and the current code cannot tell them apart.

- Classify authorizer rejections inside the module. At minimum, distinguish "user cancelled" —
  which must **not** escalate to a retry or a second prompt — from "silent attempt found no
  session," which is the normal trigger for escalating to interactive.
- Add whatever class this needs. If none of the existing five fit, propose one with a defined
  response policy rather than reusing `UNKNOWN`, and say why.
- After this, `UNKNOWN` should be reachable only from a genuinely unexpected throw. Add an
  assertion or log at `error` level when it is produced, so it shows up as an anomaly rather
  than a normal outcome.
- Keep the "user closed the tab" behavior covered by test 38 green throughout.

## Task 4 — Revocation failure is currently indistinguishable from success

`client.ts:427-430` swallows every error from `revocationRequest`. The spec requires that
`logout` not throw when there is no revocation endpoint. It does not require pretending a
failed revocation succeeded.

- Narrow the catch: a missing `revocation_endpoint` resolves cleanly and silently. A revocation
  that was attempted and failed still resolves — local state must be cleared regardless — but
  logs at `warn` and reports the outcome to the caller.
- Add a test: `endpointUnreachable` on the revocation endpoint → `logout` resolves, local state
  is cleared, the caller can see that revocation did not happen.

---

## Task 5 — `stopServiceWorker`'s liveness check can never fail

This is the most serious finding in the review and you did not flag it.

```ts
const stillAlive = await Promise.race([
  worker.evaluate(() => 1).then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
]);
```

You noted that a dead handle's `evaluate()` hangs rather than rejecting, so the timeout branch
always wins. That is not merely a fixed 1500ms cost — **it means `stillAlive` is always
`false`, whether or not the worker actually stopped.** The check passes unconditionally. Tests
10 and 11 currently cannot detect the failure they exist to detect: if `stopAllWorkers` silently
did nothing, both would still pass.

- Replace it with a check that reads actual browser state. CDP `Target.getTargets` and the
  disappearance of the `service_worker` target is the obvious candidate, since you already used
  that technique successfully for question 15.
- **Validate the new check in both directions.** Prove it returns "alive" for a running worker
  and "dead" for a stopped one. A liveness check that only ever returns one value is not a
  check, and that is exactly how the current one got shipped.
- Once it is direction-validated, poll it rather than waiting a fixed interval; the 3000ms
  should mostly disappear.
- Then re-run tests 10 and 11. **If either now fails, that is the real result** — they were
  passing on a vacuous precondition. Report it rather than adjusting the test.

## Task 6 — Resolve the `channel: 'chrome'` divergence

Bundled Chromium 151.0.7922.34 is not stable Chrome 151.0.7922.137. You were right not to
dismiss this. It matters specifically because `chrome.identity`, `declarativeNetRequest` header
handling, and extension loading are the three areas most likely to diverge between builds, and
all three are load-bearing here.

- Diagnose why `channel: 'chrome'` fails to register a service worker. Capture the actual
  error and the browser stderr. Do not work around it further until you know the cause.
- If it is fixable, fix it and make stable Chrome the default target, keeping bundled Chromium
  as a fallback.
- If it is not fixable in this environment, write the finding into
  `docs/manual-verification.md` as a first-class item: state that the automated suite runs on
  bundled Chromium, list which behaviors are therefore unverified on stable Chrome, and specify
  what must be exercised by hand. Do not leave this only in a fixtures header comment.

## Task 7 — Disclose what was softened

You mentioned in passing that assertions were softened on checkpoint-4 tests 7 and 8's worker
variant, and that the full run has 2 skips. Neither was enumerated.

For each softened assertion and each skipped test, report: the test number, the spec wording,
what is actually asserted or why it is skipped, and whether it is a Chrome/Playwright
limitation or an unresolved product bug. Do not fix them in this pass — I want the list first.

## Task 8 — Prove the suite can go red

Nothing so far demonstrates the harness detects failures rather than passing vacuously, and
Task 5 shows that concern was well founded.

Run a mutation check. For each of the following, introduce the break, run the named test,
confirm it fails **for the expected reason**, then revert:

| Mutation | Must fail |
|---|---|
| Revert Task 1's `TRANSPORT` classification | 40 |
| Make the single-flight lock global instead of per-resource | 9 |
| Remove the single-flight lock entirely | 8, 57 |
| Skip the cross-origin `resource_metadata` origin check | 23 |
| Never update the DNR rule after a refresh | 55 |
| Return a stale token from `getToken` after `reportRejected` | 58 |
| Make `stopAllWorkers` a no-op | 10, 11 (post-Task-5) |

Report any mutation that did **not** produce a failure. Those indicate a test asserting less
than it appears to. Record the results in `docs/mutation-check.md`.

---

## Working agreement

Tasks 1–4 land as one reviewable change with their tests. Task 5 lands separately, since its
result may change what tests 10 and 11 report. Tasks 6–8 are reports plus, for Task 6, a
possible fixture change.

`biome` and `tsc --noEmit` clean throughout. No changes to
`packages/extension/src/` unless a task explicitly requires one — and if one does, stop and
say so before making it, since the zero-diff property there is worth preserving deliberately
rather than by accident.
