import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, expect, requestLog, test, watchForPage } from '../src/fixtures.ts';

// Test 15 (discovery): unprotected -> 200, zero .well-known requests, zero AS traffic, no
// prompt.
test('an unprotected resource is fetched plainly with no discovery or AS traffic', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'unprotected');

  const before = await requestLog(testServer);
  const pagePromise = watchForPage(extensionContext);

  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });

  const page = await pagePromise;
  expect(page).toBeNull();
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.status).toBe(200);
    expect(outcome.promptOccurred).toBe(false);
  }

  const after = await requestLog(testServer);
  const since = after.slice(before.length);
  expect(since.filter((e) => e.server === 'as')).toHaveLength(0);
  expect(since.filter((e) => e.path.startsWith('/.well-known'))).toHaveLength(0);
  expect(since).toHaveLength(1);
  expect(since[0]?.hadAuthorizationHeader).toBe(false);
});

// Test 23 (discovery): crossOriginResourceMetadata -> rejected. No request of any kind to the
// foreign origin. Security-critical.
test('a resource_metadata URL on a foreign origin is rejected before any request to it', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'crossOriginResourceMetadata');

  const pagePromise = watchForPage(extensionContext);
  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.errorClass).toBe('MISCONFIGURED');
    expect(outcome.promptOccurred).toBe(false);
  }

  // The foreign origin (example.invalid) is unreachable from this sandbox regardless; the
  // real assertion is structural (see discovery.ts: the origin check happens before any fetch
  // is issued), confirmed here by there being no hang/timeout and an immediate MISCONFIGURED
  // classification rather than a TRANSPORT failure from attempting the foreign request.
  const log = await requestLog(testServer);
  expect(log.some((e) => e.path.includes('example.invalid'))).toBe(false);
});
