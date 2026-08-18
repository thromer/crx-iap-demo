import type { RequestLogEntry } from '../../test-server/src/state.ts';
import {
  armScenario,
  currentTokenId,
  establishToken,
  expect,
  performFetch,
  realSleep,
  requestLog,
  test,
  watchForPage,
} from '../src/fixtures.ts';

// Checkpoint-3 review, Task 19: classifies a request log entry by its role in a recovery
// sequence, ignoring the random interaction id in the path, so the sequence can be asserted
// exactly without the assertion being coupled to oidc-provider's internal id generation.
function requestKind(e: RequestLogEntry): string {
  if (e.server !== 'as') return 'resource';
  if (e.path === '/token') return 'token';
  if (e.path === '/auth') return 'auth-start';
  if (e.path.startsWith('/interaction/')) return 'interaction';
  if (e.path.startsWith('/auth/')) return 'auth-resume';
  return `other:${e.path}`;
}

// One "recovery unit": a refresh attempt that fails (invalid_grant, GRANT_DEAD) and falls
// through to the silent authorization ladder. The ladder is 4 requests server-side, not the 3
// a reading of authorize.ts alone would suggest — confirmed directly, not assumed, since
// oidc-provider's own interaction-resolution flow includes an internal session-resumption hop
// this project's own code doesn't originate: GET /auth (initiate) -> GET /interaction/:id
// (resolve; autoApprove means this redirects immediately, no submit step) -> GET /auth/:id
// (oidc-provider redirects back through the authorization endpoint to finish the response) ->
// POST /token (code exchange). So one recovery unit is 1 (failed refresh) + 4 (ladder) = 5
// requests.
const RECOVERY_UNIT = ['token', 'auth-start', 'interaction', 'auth-resume', 'token'];

// Tests 1-9 (token lifecycle). PROMPT.md requires this group to run twice: once through the
// SW's own fetch() classify/retry ladder (via: 'sw'), once through the stand-in Worker's
// DNR-attached request with no ladder of its own (via: 'worker') — see performFetch's doc
// comment in fixtures.ts for how the two are reconciled into one assertion surface.
for (const via of ['sw', 'worker'] as const) {
  test.describe(`via: ${via}`, () => {
    test.use({ via });

    test('1: a locally expired token refreshes silently on next fetch', async ({
      testServer,
      extensionContext,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);
      // Only 'worker' needs this: 'sw' treats the token as stale immediately via the 60s skew
      // margin, but the stand-in path has no local-expiry check — see performFetch/realSleep's
      // doc comments in fixtures.ts.
      if (via === 'worker') await realSleep(1200);

      const before = await requestLog(testServer);
      const pagePromise = watchForPage(extensionContext);
      const second = await performFetch(driver, via, origin, '/api/resource');
      const page = await pagePromise;

      expect(page).toBeNull();
      expect(second.ok).toBe(true);
      expect(second.status).toBe(200);

      const after = await requestLog(testServer);
      const tokenRequests = after
        .slice(before.length)
        .filter((e) => e.server === 'as' && e.path === '/token');
      expect(tokenRequests).toHaveLength(1);
    });

    test('2: rejectNextAccessToken on a locally-valid token refreshes and retries, no prompt', async ({
      testServer,
      extensionContext,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await establishToken(driver, origin);

      await armScenario(testServer, 'rejectNextAccessToken');
      const before = await requestLog(testServer);
      const pagePromise = watchForPage(extensionContext);
      const outcome = await performFetch(driver, via, origin, '/api/resource');
      const page = await pagePromise;

      expect(page).toBeNull();
      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe(200);

      const after = await requestLog(testServer);
      const tokenRequests = after
        .slice(before.length)
        .filter((e) => e.server === 'as' && e.path === '/token');
      expect(tokenRequests).toHaveLength(1);
    });

    test('3: rotateRefreshTokens persists the new refresh token; a second refresh succeeds', async ({
      testServer,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'rotateRefreshTokens');
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);

      const second = await performFetch(driver, via, origin, '/api/resource'); // refresh #1, rotates
      expect(second.ok).toBe(true);
      const third = await performFetch(driver, via, origin, '/api/resource'); // refresh #2, using the rotated token
      expect(third.ok).toBe(true);
      expect(third.status).toBe(200);
    });

    test('4: omitRefreshTokenOnRefresh keeps the original refresh token usable', async ({
      testServer,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'omitRefreshTokenOnRefresh');
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);

      const second = await performFetch(driver, via, origin, '/api/resource'); // refresh omits refresh_token
      expect(second.ok).toBe(true);
      const third = await performFetch(driver, via, origin, '/api/resource'); // refresh again, using the original
      expect(third.ok).toBe(true);
      expect(third.status).toBe(200);
    });

    test('5: invalidGrantOnNextRefresh + autoApprove re-authorizes silently', async ({
      testServer,
      extensionContext,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);

      await armScenario(testServer, 'invalidGrantOnNextRefresh');
      const pagePromise = watchForPage(extensionContext);
      const outcome = await performFetch(driver, via, origin, '/api/resource');
      const page = await pagePromise;

      expect(page).toBeNull();
      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe(200);
    });

    test('6: invalidGrantOnNextRefresh + forceLogin prompts exactly once, then succeeds', async ({
      testServer,
      extensionContext,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);

      await armScenario(testServer, 'invalidGrantOnNextRefresh');
      await armScenario(testServer, 'forceLogin');
      if (via === 'worker') await realSleep(1200);

      const seenPages: number[] = [];
      extensionContext.on('page', () => seenPages.push(Date.now()));

      const outcomePromise = performFetch(driver, via, origin, '/api/resource');
      const authPage = await extensionContext.waitForEvent('page');
      await authPage.waitForSelector('#approve');
      await authPage.click('#approve');

      const outcome = await outcomePromise;
      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe(200);
      expect(seenPages).toHaveLength(1);
    });

    test('7: revokeGrant mid-session terminates recovery without a prompt loop', async ({
      testServer,
      extensionContext,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);

      await armScenario(testServer, 'revokeGrant');
      const before = await requestLog(testServer);
      const pagePromise = watchForPage(extensionContext);
      // Both the RS and the refresh endpoint permanently reject once armed, so this cannot
      // recover — the assertion is that ONE triggering call terminates cleanly (one recovery
      // attempt, no silent-auth/refresh loop) rather than retrying unboundedly. Deliberately
      // not performFetch() here for 'worker': its own bounded-but-generous retry loop (needed
      // to absorb the real DNR rule-update race in test 8) would retrigger reportRejected
      // several times against an unrecoverable grant, amplifying the request count for reasons
      // that have nothing to do with what this test is actually checking.
      if (via === 'sw') {
        await driver.send({ type: 'fetch', resource: `${origin}/api/resource` });
      } else {
        await driver.standInFetch(origin, '/api/resource');
      }
      const page = await pagePromise;
      const after = await requestLog(testServer);

      expect(page).toBeNull();

      const since = after.slice(before.length);
      const kinds = since.map(requestKind);

      // Assert the sequence shape, not just a count: a spurious extra discovery/registration
      // hit, a missing refresh attempt, or an extra ladder round are all caught here, none of
      // which a bare ceiling (the previous `toBeLessThan(25)`) could ever distinguish from a
      // correct-but-slow recovery.
      const expected =
        via === 'sw'
          ? [...RECOVERY_UNIT, 'resource', ...RECOVERY_UNIT, 'resource']
          : ['resource', ...RECOVERY_UNIT];
      expect(kinds).toEqual(expected);

      // Idempotent endpoints (discovery, DCR) are cached from establishToken() and must not be
      // re-fetched during recovery — a real caching bug would show up as extra entries here,
      // invisible beneath any ceiling under 25.
      expect(since.filter((e) => e.path.startsWith('/.well-known'))).toHaveLength(0);
      expect(since.filter((e) => e.path === '/reg')).toHaveLength(0);

      // Derived backstop, not recalibrated to whatever the code happens to do: 5 requests per
      // recovery unit (1 failed refresh + 4-step ladder — see RECOVERY_UNIT's comment) + 1
      // resource request. 'sw' hits this twice — once proactively (the 60s skew margin treats
      // the 1s-lived token as already stale, so client.fetch() refreshes before ever attempting
      // the resource) and once reactively (the retried resource request also 401s while
      // revokeGrant is armed, triggering client.fetch()'s one allowed reactive retry) — for
      // 2 * (5 + 1) = 12. 'worker' only ever reacts to the single standInFetch call's 401 (no
      // proactive check, and this test deliberately drives it directly rather than through
      // performFetch's retry loop) — for 1 * (5 + 1) = 6.
      const expectedCount =
        via === 'sw' ? 2 * (RECOVERY_UNIT.length + 1) : RECOVERY_UNIT.length + 1;
      expect(since).toHaveLength(expectedCount);
    });

    test('8: ten concurrent fetches on an expired token coalesce into one refresh; grant survives', async ({
      testServer,
      driver,
    }) => {
      const origin = testServer.origins.rsA;
      await armScenario(testServer, 'detectRefreshReplay');
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, origin);
      if (via === 'worker') await realSleep(1200);

      // Checkpoint-3 review, Task 11/11a. `tokenEndpointHang` stalls *every* /token request
      // while armed, not just the first, forcing genuine overlap instead of hoping IPC latency
      // reveals it (same reasoning as test 57 in dnr-attachment.spec.ts).
      //
      // This asserts end-to-end coalescing on the real stand-in library path — genuine
      // integration value in its own right — but on 'worker' the exact count it produces is
      // NOT proof of the single-flight lock the way it is on 'sw'. `reportRejected` clears the
      // cached token (`writeAccessEntry(resource, null, ...)`, broadcast immediately) *before*
      // calling `acquireToken` (the step the hang stalls) — so the first call to reach that
      // point broadcasts null well within the hang window, and any of the other nine calls
      // whose `tokenIdFor()` read in offscreen.ts happens after that broadcast see `null` and
      // never send `reportRejected` at all (the `if (tokenId)` guard there). That's a real,
      // independent coalescing mechanism — nine callers correctly declining to report because
      // someone else has already invalidated and is refreshing — sitting in front of the lock,
      // not the lock itself. Confirmed by mutation: removing the single-flight lock alone does
      // NOT fail this test on 'worker' (suppression alone still coalesces to the same count),
      // but removing suppression *and* the lock together does (see mutation-check.md's
      // suppression mutation). The lock itself is proven at the e2e level by test 57, which
      // drives reportRejected directly from the driver page and so bypasses suppression
      // entirely — and at the unit level by client.test.ts's single-flight-lock tests.
      if (via === 'worker') await armScenario(testServer, 'tokenEndpointHang', { seconds: 2 });

      const before = await requestLog(testServer);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => performFetch(driver, via, origin, '/api/resource')),
      );
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(true);
        expect(outcome.status).toBe(200);
      }

      const after = await requestLog(testServer);
      const tokenRequests = after
        .slice(before.length)
        .filter((e) => e.server === 'as' && e.path === '/token');
      expect(tokenRequests).toHaveLength(1);

      // Grant not revoked: it still works afterward.
      const final = await performFetch(driver, via, origin, '/api/resource');
      expect(final.ok).toBe(true);
      expect(await currentTokenId(driver, origin)).not.toBeNull();
    });

    test('9: ten concurrent fetches across two resources use two independent refreshes', async ({
      testServer,
      driver,
    }) => {
      const originA = testServer.origins.rsA;
      const originB = testServer.origins.rsB;
      await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });
      await establishToken(driver, originA);
      await establishToken(driver, originB);
      if (via === 'worker') await realSleep(1200);

      // Checkpoint-3 review, Task 11/11a: same forced overlap and the same offscreen
      // suppression vs. lock attribution as test 8 — see its comment. tokenEndpointHang applies
      // to the AS's /token endpoint regardless of resource, so it forces the same guarantee
      // independently for originA's and originB's five concurrent calls each.
      if (via === 'worker') await armScenario(testServer, 'tokenEndpointHang', { seconds: 2 });

      const before = await requestLog(testServer);
      const calls = Array.from({ length: 10 }, (_, i) =>
        performFetch(driver, via, i % 2 === 0 ? originA : originB, '/api/resource'),
      );
      const outcomes = await Promise.all(calls);
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(true);
        expect(outcome.status).toBe(200);
      }

      const after = await requestLog(testServer);
      const tokenRequests = after
        .slice(before.length)
        .filter((e) => e.server === 'as' && e.path === '/token');
      expect(tokenRequests).toHaveLength(2);
    });
  });
}
