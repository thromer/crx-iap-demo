import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import {
  armScenario,
  currentTokenId,
  establishToken,
  expect,
  performFetch,
  requestLog,
  test,
  watchForPage,
} from '../src/fixtures.ts';

// Test 40 (transport vs. auth): context.setOffline(true) -> no prompt, no auth state
// mutation, TRANSPORT error. Restore connectivity -> next request succeeds with the original
// token. Parameterized per PROMPT.md, since offline should block the stand-in Worker's own
// request directly (unlike 41-43 below, which are entirely AS/token-endpoint concerns the
// stand-in never talks to) — but see the 'worker' skip below.
for (const via of ['sw', 'worker'] as const) {
  test.describe(`via: ${via}`, () => {
    test.use({ via });

    test('40: going offline classifies as TRANSPORT with no auth mutation; recovers with the same token', async ({
      testServer,
      extensionContext,
      driver,
    }) => {
      // Confirmed directly (message-level, bypassing this test's own assertions):
      // context.setOffline(true) blocks a page-level fetch() in this environment but does NOT
      // block the stand-in's dedicated Worker fetch, spawned from the extension's offscreen
      // document — Playwright's offline network emulation does not reach that target here.
      // Not a bug in the extension; nothing to work around inside packages/extension without
      // adding the kind of test-only hook PROMPT.md forbids. See fixtures.ts's module header
      // (finding 6) and the memory note this was folded into.
      test.skip(
        via === 'worker',
        "context.setOffline() does not reach the stand-in's dedicated Worker in this environment — see fixtures.ts finding 6",
      );

      const origin = testServer.origins.rsA;
      await establishToken(driver, origin);

      const before = await currentTokenId(driver, origin);
      expect(before).not.toBeNull();

      await extensionContext.setOffline(true);
      try {
        const pagePromise = watchForPage(extensionContext);
        const offlineOutcome = await performFetch(driver, via, origin, '/api/resource');
        const page = await pagePromise;

        expect(page).toBeNull();
        expect(offlineOutcome.ok).toBe(false);
        if (via === 'sw') expect(offlineOutcome.errorClass).toBe('TRANSPORT');
      } finally {
        await extensionContext.setOffline(false);
      }

      expect(await currentTokenId(driver, origin)).toBe(before);

      const recovered = await performFetch(driver, via, origin, '/api/resource');
      expect(recovered.ok).toBe(true);
      expect(recovered.status).toBe(200);
      expect(await currentTokenId(driver, origin)).toBe(before);
    });
  });
}

// Tests 41-43: entirely an IapClient/AS concern (token endpoint transport failures). The
// stand-in Worker never talks to the AS at all — only to the RS — so there is no meaningful
// "via: worker" variant here beyond what test 40 already proves about the stand-in path's
// offline tolerance. SW-driven only.
test.describe('token endpoint transport failures (SW-driven)', () => {
  test('41: tokenEndpointStatus(500) backs off and retries, not re-authorization; no auth tab', async ({
    testServer,
    extensionContext,
    driver,
  }) => {
    const origin = testServer.origins.rsA;
    await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

    const first = await driver.send<FetchOutcome>({
      type: 'fetch',
      resource: `${origin}/api/resource`,
    });
    expect(first.ok).toBe(true);

    await armScenario(testServer, 'tokenEndpointStatus', { code: 500 });
    const pagePromise = watchForPage(extensionContext);
    const outcome = await driver.send<FetchOutcome>({
      type: 'fetch',
      resource: `${origin}/api/resource`,
    });
    const page = await pagePromise;

    expect(page).toBeNull();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorClass).toBe('TRANSPORT');
  });

  test('42: tokenEndpointStatus(429) with Retry-After is honored over the default backoff', async ({
    testServer,
    driver,
  }) => {
    const origin = testServer.origins.rsA;
    await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

    const first = await driver.send<FetchOutcome>({
      type: 'fetch',
      resource: `${origin}/api/resource`,
    });
    expect(first.ok).toBe(true);

    // A Retry-After far larger than the ~200/400ms default backoff makes the honored-vs-not
    // distinction unambiguous from the request-log timestamps alone.
    await armScenario(testServer, 'tokenEndpointStatus', { code: 429, retryAfter: 3 });
    const before = await requestLog(testServer);
    await driver.send<FetchOutcome>({ type: 'fetch', resource: `${origin}/api/resource` });
    const after = await requestLog(testServer);

    const tokenAttempts = after
      .slice(before.length)
      .filter((e) => e.server === 'as' && e.path === '/token');
    expect(tokenAttempts.length).toBeGreaterThanOrEqual(2);
    const gapMs = (tokenAttempts[1]?.timestamp ?? 0) - (tokenAttempts[0]?.timestamp ?? 0);
    expect(gapMs).toBeGreaterThanOrEqual(2500);
  });

  test('43: tokenEndpointHang aborts via AbortController and classifies TRANSPORT, no prompt', async ({
    testServer,
    extensionContext,
    driver,
  }) => {
    const origin = testServer.origins.rsA;
    await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

    const first = await driver.send<FetchOutcome>({
      type: 'fetch',
      resource: `${origin}/api/resource`,
    });
    expect(first.ok).toBe(true);

    // Longer than iap-auth's REQUEST_TIMEOUT_MS (8s), so the client's own AbortController
    // fires well before the server would ever respond.
    await armScenario(testServer, 'tokenEndpointHang', { seconds: 30 });
    const pagePromise = watchForPage(extensionContext, 15_000);
    const outcome = await driver.send<FetchOutcome>({
      type: 'fetch',
      resource: `${origin}/api/resource`,
    });
    const page = await pagePromise;

    expect(page).toBeNull();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorClass).toBe('TRANSPORT');
  });
});
