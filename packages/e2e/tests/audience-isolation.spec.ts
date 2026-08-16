import type { CurrentTokenIdOutcome, FetchOutcome } from '../../extension/src/shared/messages.ts';
import {
  armScenario,
  establishToken,
  expect,
  performFetch,
  requestLog,
  test,
} from '../src/fixtures.ts';

// Test 35: a token minted for origin A must never be attached to a request against origin B —
// and B gets its own fresh flow rather than reusing A's token.
test('35: a token for one resource is never attached to a different resource', async ({
  testServer,
  driver,
}) => {
  const originA = testServer.origins.rsA;
  const originB = testServer.origins.rsB;
  await establishToken(driver, originA);

  const before = await requestLog(testServer);
  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${originB}/api/resource`,
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);

  const since = (await requestLog(testServer)).slice(before.length);
  // The very first request to B must not carry A's Authorization header.
  const firstToB = since.find((e) => e.origin === originB);
  expect(firstToB?.hadAuthorizationHeader).toBe(false);
  // A fresh flow ran for B: at least a token-endpoint request of its own.
  expect(since.some((e) => e.server === 'as' && e.path === '/token')).toBe(true);
});

// Test 36: two resources behind one AS get two independent token entries, no crosstalk, and
// exactly one client registration (registration is cached per-issuer, not per-resource).
test('36: two resources behind one AS have independent tokens and share one registration', async ({
  testServer,
  driver,
}) => {
  const originA = testServer.origins.rsA;
  const originB = testServer.origins.rsB;

  const before = await requestLog(testServer);
  await establishToken(driver, originA);
  await establishToken(driver, originB);

  const tokenA = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: originA,
  });
  const tokenB = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: originB,
  });
  expect(tokenA.tokenId).not.toBeNull();
  expect(tokenB.tokenId).not.toBeNull();
  expect(tokenA.tokenId).not.toBe(tokenB.tokenId);

  const since = (await requestLog(testServer)).slice(before.length);
  const registrations = since.filter((e) => e.server === 'as' && e.path === '/reg');
  expect(registrations).toHaveLength(1);
});

// Test 37: redirectToForeignOrigin -> Authorization not replayed. Under 'sw' this holds because
// of redirect: 'manual' on the module's own request; under 'worker' because the DNR rule is
// scoped to the origin and does not match the foreign redirect target.
for (const via of ['sw', 'worker'] as const) {
  test(`37 (via: ${via}): a redirect to a foreign origin never replays the Authorization header`, async ({
    testServer,
    driver,
  }) => {
    const origin = testServer.origins.rsA;
    const foreignOrigin = testServer.origins.rsB;
    await establishToken(driver, origin);

    await armScenario(testServer, 'redirectToForeignOrigin');
    const before = await requestLog(testServer);
    await performFetch(driver, via, origin, '/api/resource');

    const since = (await requestLog(testServer)).slice(before.length);
    const foreignHits = since.filter((e) => e.origin === foreignOrigin);
    // 'sw': the module's own fetch() uses redirect: 'manual', so it never even follows the
    // redirect — zero hits to the foreign origin is the expected (stronger) outcome. 'worker':
    // the stand-in's plain fetch() does follow redirects, so the browser actually reaches the
    // foreign origin — the assertion there is that the DNR rule (scoped to the real origin)
    // never matches it, not that the request never happens.
    if (via === 'worker') expect(foreignHits.length).toBeGreaterThan(0);
    for (const hit of foreignHits) expect(hit.hadAuthorizationHeader).toBe(false);
  });
}
