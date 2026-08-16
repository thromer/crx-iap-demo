# Task: audit `authts/oidc-client-ts` for edge cases `packages/iap-auth` may have missed. Do not adopt any of its code or add it as a dependency — this is read-only research.

Clone https://github.com/authts/oidc-client-ts into a scratch
directory. Focus on `src/UserManager.ts`, `src/AccessTokenEvents.ts`,
`src/SilentRenewService.ts`, and `src/TokenClient.ts`.

Specifically check whether our design handles the following, all
confirmed as real bugs in that library's issue history:

1. Stale-but-not-yet-expired tokens. Their silent renew only fires
   near expiry, not on an already-expired token found at startup
   (issue #1601, #2012). Confirm our `TOKEN_STALE` classification and
   cold-start path (tests 10–11) genuinely cover "token found already
   expired," not just "token expires while running."
2. Sleep/suspend recovery. Their silent renew fails on wake from sleep
   and does not retry (issue #251). Compare against our
   service-worker-termination tests (10, 11) — sleep and
   SW-termination aren't identical, so check whether sleep introduces
   a failure shape (e.g., a hung in-flight request instead of a clean
   retry) our scenarios don't reproduce.
3. Single-flight and stuck-state bugs. Their predecessor library had a
   renewal flag that got stuck after a page reload mid-renewal, and a
   documented race in refresh-in-flight state (issues #432, and the
   RefreshToken-in-flight discussion). Check whether any equivalent
   "stuck lock" state is reachable in our single-flight implementation
   if the service worker is killed mid-refresh — specifically, whether
   our lock is held in memory (and therefore cleared for free on
   restart) or persisted (and could get stuck).
4. Refresh-token expiry distinct from access-token expiry. Their
   library doesn't account for `refresh_expires_in` separately from
   access token expiry (issue #644). Check whether our classification
   distinguishes "refresh token itself is dead" from "access token is
   dead," or conflates them.

For each of the four, report: does our design already handle it, is it
covered by an existing test number, or is it a gap. If it's a gap,
propose it as a new test case in our existing format — do not propose
adopting their mitigation code, since their fixes are shaped around a
different architecture (iframe-based silent renew, timer-driven) than
ours (lazy on-demand, DNR-attached, no timers).

Write findings to `docs/oidc-client-ts-audit.md`. Stop there — do not
modify `packages/iap-auth` as part of this task.
