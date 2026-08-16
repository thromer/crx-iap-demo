import type { CurrentTokenIdOutcome, FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, expect, requestLog, test, watchForPage } from '../src/fixtures.ts';

// Test 1 (token lifecycle): token expires locally -> next fetch succeeds, exactly one token
// request, no auth tab.
test('locally expired token refreshes silently on next fetch', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;

  // A short lifetime plus the module's 60s skew margin means every cached token is treated as
  // locally stale before it is ever reused - no real waiting required (see PROMPT.md's "no
  // clock manipulation" rule; this is a real server-side scenario, not a fake clock).
  await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

  const first = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(first.ok).toBe(true);

  const before = await requestLog(testServer);
  const pagePromise = watchForPage(extensionContext);

  const second = await driver.send<FetchOutcome>({ type: 'fetch', resource });

  const page = await pagePromise;
  expect(page).toBeNull();
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.status).toBe(200);
    expect(second.promptOccurred).toBe(false);
  }

  const after = await requestLog(testServer);
  const since = after.slice(before.length);
  const tokenRequests = since.filter((e) => e.server === 'as' && e.path === '/token');
  expect(tokenRequests).toHaveLength(1);
});

// Test 8 (token lifecycle): detectRefreshReplay + ten parallel calls on an expired token ->
// exactly one token request; all ten resolve; grant not revoked.
test('ten concurrent fetches on an expired token coalesce into one refresh, grant survives', async ({
  testServer,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;

  await armScenario(testServer, 'detectRefreshReplay');
  await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

  const initial = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(initial.ok).toBe(true);

  const before = await requestLog(testServer);

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, () => driver.send<FetchOutcome>({ type: 'fetch', resource })),
  );
  for (const outcome of outcomes) {
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.status).toBe(200);
  }

  const after = await requestLog(testServer);
  const since = after.slice(before.length);
  const tokenRequests = since.filter((e) => e.server === 'as' && e.path === '/token');
  expect(tokenRequests).toHaveLength(1);

  // Grant not revoked: a further fetch still succeeds without falling back to reauthorization.
  const final = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(final.ok).toBe(true);
  if (final.ok) expect(final.status).toBe(200);

  const tokenId = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: testServer.origins.rsA,
  });
  expect(tokenId.tokenId).not.toBeNull();
});
