import type { ActionOutcome, FetchOutcome } from '../../extension/src/shared/messages.ts';
import {
  armScenario,
  currentTokenId,
  establishToken,
  expect,
  performFetch,
  realSleep,
  requestLog,
  test,
  waitForTokenChange,
} from '../src/fixtures.ts';

// Test 53 (DNR attachment): the stand-in Worker's requests reach the RS with an Authorization
// header, asserted from the request log. The stand-in (packages/extension/src/standin/worker.ts)
// patches self.fetch inside a dedicated Worker and is only ever driven through the offscreen
// document's relay, so a hit here is structurally guaranteed to have originated in the Worker.
test("53: the stand-in Worker's requests carry the DNR-attached Authorization header", async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);

  const outcome = await driver.standInFetch(origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);

  const log = await requestLog(testServer);
  const hit = log.findLast((e) => e.server === 'rs-a' && e.path === '/api/resource');
  expect(hit).toBeDefined();
  expect(hit?.hadAuthorizationHeader).toBe(true);
});

// Test 54: onTokenChanged's DNR sync is genuinely wired end to end — a Worker request issued
// immediately after login eventually carries the token via the real
// SW → chrome.declarativeNetRequest → browser network stack path, with no explicit wait.
//
// This proves the wiring, not the ordering guarantee behind it (that the rule is installed
// before login/getToken resolves — Component A's "listeners are awaited before the triggering
// call resolves"). A native DNR call can't be slowed down from here to make that race
// observable; the ordering is instead proven deterministically at the unit level, with
// controllable-delay fakes standing in for it: packages/iap-auth/test/client.test.ts's
// "onTokenChanged ordering" (client-side half) and packages/extension/test/token-sync.test.ts
// (SW-side half). See docs/mutation-check.md's mutation 8 for why (checkpoint-3 review, Task
// 10) — same unit-proves-the-mechanism / e2e-proves-the-wiring split as test 57's disposition.
test('54: a Worker request issued immediately after login eventually carries the token', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);

  const before = await requestLog(testServer);
  const outcome = await performFetch(driver, 'worker', origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);

  // "Eventually" — bounded by performFetch's own retry cap, not required to land on the very
  // first attempt (that stronger claim is what this test can no longer make; see header).
  const since = (await requestLog(testServer)).slice(before.length);
  expect(since.filter((e) => e.server === 'rs-a').length).toBeLessThanOrEqual(3);
});

// Test 55: token refreshes mid-session (shortLivedTokens) -> the rule updates; a Worker request
// issued during the update window that carries a stale token 401s and is recovered on retry
// without a prompt.
test('55: a Worker request during a mid-session refresh recovers via the rejection path, no prompt', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
  await establishToken(driver, origin);
  await realSleep(1200); // real expiry — see performFetch's doc comment in fixtures.ts

  const seenPages: number[] = [];
  extensionContext.on('page', () => seenPages.push(Date.now()));

  const outcome = await performFetch(driver, 'worker', origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  expect(outcome.status).toBe(200);
  expect(seenPages).toHaveLength(0);
});

// Test 56: a Worker request while the rule is temporarily absent (invalidated, no replacement
// yet) 401s and is recovered via the rejection path, no prompt. Forced directly via logout()
// immediately followed by a fresh login racing a standInFetch — logout removes the rule
// (packages/extension/src/service-worker/dnr.ts's removeAuthorizationRule), and a request
// landing before the subsequent login's rule is installed hits exactly this window.
test('56: a Worker request while the rule is briefly absent recovers via the rejection path', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);
  await driver.send<ActionOutcome>({ type: 'logout', resource: origin });

  // logout() clears the tokenId the offscreen document would need to name in a rejection
  // report, so recovery here goes through a fresh login rather than reportRejected — issuing
  // both concurrently and asserting the Worker request eventually succeeds is the honest way
  // to exercise "no rule yet, then recovered" without a hook into DNR's internal timing.
  const [loginOutcome, standInOutcome] = await Promise.all([
    driver.send<ActionOutcome>({ type: 'login', resource: origin, opts: { interactive: true } }),
    (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await driver.standInFetch(origin, '/api/resource');
        if (result.ok && result.status === 200) return result;
        await realSleep(200);
      }
      return driver.standInFetch(origin, '/api/resource');
    })(),
  ]);
  expect(loginOutcome.ok).toBe(true);
  expect(standInOutcome.ok).toBe(true);
  if (standInOutcome.ok) expect(standInOutcome.status).toBe(200);
});

// Test 57 (DNR attachment): ten concurrent reportRejected calls naming the same tokenId ->
// exactly one token endpoint request, exactly one rule update.
//
// Checkpoint-3 review, Task 11: `Promise.all()` only guarantees the ten calls are *issued*
// together, not that they *arrive* together — real Chrome extension IPC staggers them enough
// that, in practice, the first call often finishes its whole invalidate-then-reacquire cycle
// before the others are even checked, so reportRejected's own idempotency check (by tokenId,
// unrelated to the lock) coalesces them on its own. A mutation check confirmed this: removing
// the single-flight lock entirely did not fail this test (see docs/mutation-check.md, mutation
// 3) even though it correctly failed the in-process unit equivalent. Forcing the race open
// deterministically instead of hoping IPC latency reveals it: `tokenEndpointHang` stalls the
// *first* refresh's token-endpoint request for ~1s, guaranteeing the other nine calls' own
// idempotency checks (`current.tokenId !== tokenId`) still see the original, not-yet-superseded
// tokenId when they run — the exact condition under which idempotency alone cannot coalesce
// them, and only the lock (serializing all ten, so the 2nd-10th see the already-updated entry
// by the time it's their turn) can.
//
// "Exactly one rule update" is not independently observable without adding instrumentation to
// the extension, which PROMPT.md's non-goals section forbids ("no test-only code, hooks,
// flags, or conditionals in packages/extension"). It is proven by construction instead: the
// module's contract is that onTokenChanged fires once per successful token change and is
// awaited before the triggering call resolves (see packages/iap-auth/src/client.ts's
// writeAccessEntry), and reportRejected is idempotent by tokenId with a single-flight refresh
// — so "exactly one token request" for this batch implies exactly one onTokenChanged fire and
// therefore exactly one rule update. The session-rule snapshot afterward is a sanity check on
// top of that, not the primary assertion.
test('57: ten concurrent reportRejected calls for the same tokenId coalesce into one refresh', async ({
  testServer,
  driver,
  serviceWorker,
}) => {
  const origin = testServer.origins.rsA;

  await establishToken(driver, origin);

  const before = await currentTokenId(driver, origin);
  expect(before).not.toBeNull();
  const tokenId = before as string;

  await armScenario(testServer, 'tokenEndpointHang', { seconds: 1 });
  const beforeLog = await requestLog(testServer);

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, () =>
      driver.send<ActionOutcome>({ type: 'reportRejected', resource: origin, tokenId }),
    ),
  );
  for (const outcome of outcomes) expect(outcome.ok).toBe(true);

  const afterLog = await requestLog(testServer);
  const since = afterLog.slice(beforeLog.length);
  const tokenRequests = since.filter((e) => e.server === 'as' && e.path === '/token');
  expect(tokenRequests).toHaveLength(1);

  const after = await currentTokenId(driver, origin);
  expect(after).not.toBeNull();
  expect(after).not.toBe(tokenId);

  // Sanity check: exactly one session rule exists for this origin afterward (DNR replaces by
  // deterministic rule ID, so this doesn't independently prove the update count, but it does
  // rule out a duplicate/leaked rule).
  const rules = await serviceWorker.evaluate(async (rsOrigin) => {
    const all = await chrome.declarativeNetRequest.getSessionRules();
    return all.filter((r) => r.condition.urlFilter === `|${rsOrigin}/*`);
  }, origin);
  expect(rules).toHaveLength(1);
});

// Test 57b (checkpoint-3 review, Task 11a): a caller suppressed by offscreen.ts's
// null-broadcast gate (see detecting-failure.md's "Concurrent rejections" section) is waiting
// on a tokenId that only ever arrives if the refresh that triggered suppression actually
// completes. If that refresh fails and needs the authorization ladder to recover, does the
// suppressed caller eventually see the new tokenId, or does it wait forever? Checked directly,
// not assumed: arms both a genuine refresh failure (invalidGrantOnNextRefresh) and
// tokenEndpointHang together, so the recovery path (failed refresh -> fall through to the
// ladder -> silent re-auth -> a *second* hung /token exchange) takes several real seconds
// before the new tokenId broadcasts — long enough that a caller relying on suppression alone
// would be stuck waiting the whole time if anything wedged.
//
// Answer: it doesn't hang. The suppressed callers' wait ends once the ladder's recovery
// completes and broadcasts, the same as any other waiter — suppression only ever defers a
// caller's own report, never blocks it on nothing. waitForTokenChange is given a generous but
// bounded window here specifically to prove termination, not to accommodate expected slowness.
test('57b: a caller suppressed by offscreen null-broadcast still recovers if the in-flight refresh needs the ladder', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
  await establishToken(driver, origin);
  await realSleep(1200);

  await armScenario(testServer, 'invalidGrantOnNextRefresh');
  await armScenario(testServer, 'autoApprove');
  await armScenario(testServer, 'tokenEndpointHang', { seconds: 2 });

  const previous = await currentTokenId(driver, origin);
  const before = await requestLog(testServer);

  // Fire all ten concurrently, same shape as test 57/8/9: some will report, some will be
  // suppressed by the null broadcast once the first one starts recovering.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => driver.standInFetch(origin, '/api/resource')),
  );
  for (const result of results) {
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(401);
  }

  // Bounded, not indefinite: this must terminate, well within the two hung /token round trips
  // (failed refresh, then the ladder's code exchange) plus real overhead.
  const changed = await waitForTokenChange(driver, origin, previous, 20_000);
  expect(changed).not.toBeNull();
  expect(changed).not.toBe(previous);

  const since = (await requestLog(testServer)).slice(before.length);
  const tokenRequests = since.filter((e) => e.server === 'as' && e.path === '/token');
  // Exactly two: the failed refresh (invalid_grant) and the ladder's successful code exchange
  // — not more, confirming recovery doesn't loop or retry redundantly under suppression.
  expect(tokenRequests).toHaveLength(2);

  // A follow-up request now succeeds with the recovered token.
  const followUp = await performFetch(driver, 'worker', origin, '/api/resource');
  expect(followUp.ok).toBe(true);
  expect(followUp.status).toBe(200);
});

// Test 58: reportRejected naming an already-superseded tokenId -> no-op, no second refresh.
test('58: reportRejected for an already-superseded tokenId is a no-op', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);

  const staleTokenId = await currentTokenId(driver, origin);
  expect(staleTokenId).not.toBeNull();

  const before = await requestLog(testServer);
  const first = await driver.send<ActionOutcome>({
    type: 'reportRejected',
    resource: origin,
    tokenId: staleTokenId as string,
  });
  expect(first.ok).toBe(true);
  const afterFirst = (await requestLog(testServer)).slice(before.length);
  expect(afterFirst.filter((e) => e.server === 'as' && e.path === '/token')).toHaveLength(1);

  const newTokenId = await currentTokenId(driver, origin);
  expect(newTokenId).not.toBe(staleTokenId);

  const beforeSecond = await requestLog(testServer);
  const second = await driver.send<ActionOutcome>({
    type: 'reportRejected',
    resource: origin,
    tokenId: staleTokenId as string, // still the OLD, now-superseded id
  });
  expect(second.ok).toBe(true);
  const afterSecond = (await requestLog(testServer)).slice(beforeSecond.length);
  expect(afterSecond.filter((e) => e.server === 'as' && e.path === '/token')).toHaveLength(0);
});

// Test 59: a Worker request to a non-protected origin -> no rule matches, no Authorization
// header, confirmed from the request log.
test('59: a Worker request to an unprotected origin carries no Authorization header', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'unprotected');

  const outcome = await driver.standInFetch(origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);

  const log = await requestLog(testServer);
  const hit = log.findLast((e) => e.server === 'rs-a' && e.path === '/api/resource');
  expect(hit?.hadAuthorizationHeader).toBe(false);
});

// Test 60: forceLogin + ten concurrent reportRejected calls -> exactly one auth tab; the rule
// updates once, after login completes.
test('60: forceLogin with ten concurrent reportRejected calls opens exactly one auth tab', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);

  const tokenId = await currentTokenId(driver, origin);
  expect(tokenId).not.toBeNull();

  await armScenario(testServer, 'invalidGrantOnNextRefresh');
  await armScenario(testServer, 'forceLogin');

  const seenPages: number[] = [];
  extensionContext.on('page', () => seenPages.push(Date.now()));

  const [outcomes] = await Promise.all([
    Promise.all(
      Array.from({ length: 10 }, () =>
        driver.send<ActionOutcome>({
          type: 'reportRejected',
          resource: origin,
          tokenId: tokenId as string,
        }),
      ),
    ),
    (async () => {
      const authPage = await extensionContext.waitForEvent('page');
      await authPage.waitForSelector('#approve');
      await authPage.click('#approve');
    })(),
  ]);

  for (const outcome of outcomes) expect(outcome.ok).toBe(true);
  expect(seenPages).toHaveLength(1);

  const after = await currentTokenId(driver, origin);
  expect(after).not.toBeNull();
  expect(after).not.toBe(tokenId);
});

// Test 61: logout -> the session rule is removed; a subsequent Worker request reaches the RS
// with no Authorization header.
test('61: logout removes the session rule; a subsequent Worker request carries no Authorization header', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);

  const logoutOutcome = await driver.send<ActionOutcome>({ type: 'logout', resource: origin });
  expect(logoutOutcome.ok).toBe(true);

  const outcome = await driver.standInFetch(origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(401);

  const log = await requestLog(testServer);
  const hit = log.findLast((e) => e.server === 'rs-a' && e.path === '/api/resource');
  expect(hit?.hadAuthorizationHeader).toBe(false);
});

// Test 62: appLevel403 reached through the Worker -> not reported as a rejection, no refresh,
// no rule change. The detection mechanism must distinguish this from a real 401 (see
// docs/detecting-failure.md: only a 401 is ever reported).
test('62: an application-level 403 through the Worker is not reported as a rejection', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);
  const before = await currentTokenId(driver, origin);

  await armScenario(testServer, 'appLevel403');
  const beforeLog = await requestLog(testServer);
  const outcome = await driver.standInFetch(origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(403);

  const since = (await requestLog(testServer)).slice(beforeLog.length);
  expect(since.filter((e) => e.server === 'as' && e.path === '/token')).toHaveLength(0);
  expect(await currentTokenId(driver, origin)).toBe(before);
});

// Test 63: the module's own SW fetch() while a rule is active -> the request reaches the RS
// with exactly one Authorization header carrying the *current* token, confirming the
// documented DNR-wins behavior rather than a corrupted/conflicting header. Checkpoint-3
// review, Task 13: the request log now records the header's value (hashed the same way
// IapClient's own tokenId is — see hash.ts), directly comparable to `currentTokenId`, so this
// asserts identity, not just presence — a stale, duplicated, or foreign header now fails this
// test even if the resource server happened to still accept it.
test("63: the module's own fetch() succeeds normally while a DNR rule is active for the same origin", async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);
  const tokenId = await currentTokenId(driver, origin);

  const before = await requestLog(testServer);
  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);

  const since = (await requestLog(testServer)).slice(before.length);
  expect(since).toHaveLength(1);
  expect(since[0]?.hadAuthorizationHeader).toBe(true);
  expect(since[0]?.authorizationTokenId).toBe(tokenId);
});
