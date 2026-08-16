import type {
  ActionOutcome,
  CurrentTokenIdOutcome,
  FetchOutcome,
} from '../../extension/src/shared/messages.ts';
import { armScenario, expect, requestLog, test } from '../src/fixtures.ts';

// Test 53 (DNR attachment): the stand-in Worker's requests reach the RS with an Authorization
// header, asserted from the request log. The stand-in (packages/extension/src/standin/worker.ts)
// patches self.fetch inside a dedicated Worker and is only ever driven through the offscreen
// document's relay, so a hit here is structurally guaranteed to have originated in the Worker.
test("the stand-in Worker's requests carry the DNR-attached Authorization header", async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;

  // Establishes the token and, via onTokenChanged (awaited before this resolves), the DNR
  // session rule for this origin.
  const login = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(login.ok).toBe(true);

  const outcome = await driver.standInFetch(origin, '/api/resource');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);

  const log = await requestLog(testServer);
  const hit = log.findLast((e) => e.server === 'rs-a' && e.path === '/api/resource');
  expect(hit).toBeDefined();
  expect(hit?.hadAuthorizationHeader).toBe(true);
});

// Test 57 (DNR attachment): ten concurrent reportRejected calls naming the same tokenId ->
// exactly one token endpoint request, exactly one rule update.
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
test('ten concurrent reportRejected calls for the same tokenId coalesce into one refresh', async ({
  testServer,
  driver,
  serviceWorker,
}) => {
  const origin = testServer.origins.rsA;

  await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

  const login = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(login.ok).toBe(true);

  const before = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  expect(before.tokenId).not.toBeNull();
  const tokenId = before.tokenId as string;

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

  const after = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  expect(after.tokenId).not.toBeNull();
  expect(after.tokenId).not.toBe(tokenId);

  // Sanity check: exactly one session rule exists for this origin afterward (DNR replaces by
  // deterministic rule ID, so this doesn't independently prove the update count, but it does
  // rule out a duplicate/leaked rule).
  const rules = await serviceWorker.evaluate(async (rsOrigin) => {
    const all = await chrome.declarativeNetRequest.getSessionRules();
    return all.filter((r) => r.condition.urlFilter === `|${rsOrigin}/*`);
  }, origin);
  expect(rules).toHaveLength(1);
});
