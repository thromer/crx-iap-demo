import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, establishToken, expect, requestLog, test } from '../src/fixtures.ts';

// Test 49 (request replay, SW fetch() only — the stand-in library owns its own bodies): a
// buffered POST body hitting rejectNextAccessToken -> refresh happens and the body is resent
// intact; the RS sees the same body twice.
//
// Test 50 (ReadableStream body -> rejected up front, not silently retried with a consumed
// stream) is covered in packages/iap-auth/test/client.test.ts instead — the extension's
// message protocol only carries a string body, so it can't be driven through this harness; see
// the comment there for why that's Component A's contract, not a gap in this suite.
test('49: a buffered POST body survives a mid-request refresh and reaches the resource server intact', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);
  await armScenario(testServer, 'rejectNextAccessToken');

  const before = await requestLog(testServer);
  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
    opts: { method: 'POST', body: 'the-request-body' },
  });

  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.status).toBe(200);
    const parsed = JSON.parse(outcome.body) as { echoedBody: string };
    expect(parsed.echoedBody).toBe('the-request-body');
  }

  const since = (await requestLog(testServer)).slice(before.length);
  const postsToResource = since.filter((e) => e.method === 'POST' && e.server === 'rs-a');
  expect(postsToResource).toHaveLength(2);
});
