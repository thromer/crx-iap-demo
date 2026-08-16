import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, expect, test } from '../src/fixtures.ts';

// Test 65 (slow-tagged, excluded from the default run — see playwright.config.ts's
// grepInvert): stallAuthorization(400) -> the authorization tab sits open for over six
// minutes and the flow still completes, proving the service worker survives, since
// identity.launchWebAuthFlow is exempt from the five-minute timeout.
//
// Mechanism: the extension's authorizer (packages/extension/src/service-worker/authorizer.ts)
// caps a *non-interactive* attempt at 10s (timeoutMsForNonInteractive), so a 400s stall on the
// AS's /interaction endpoint times out the silent leg well before it resolves and escalates to
// a real, visible interactive tab — which has no such cap. That tab then re-runs the same
// stalled request and sits open for the remaining ~400s until the AS (autoApprove, the
// default) finally finishes the interaction and redirects back with a code.
//
// NOTE: not run in the session that authored this test — a real ~7 minute wall-clock cost per
// run. Written to the same patterns already proven elsewhere in this suite (armScenario,
// driver.send, extensionContext page events); run explicitly with
// `npx playwright test --grep @slow` to verify.
test('65 @slow: an authorization tab open for over six minutes still completes', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  test.setTimeout(9 * 60 * 1000);

  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'stallAuthorization', { seconds: 400 });

  const outcomePromise = driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  const authPage = await extensionContext.waitForEvent('page');

  const outcome = await outcomePromise;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.status).toBe(200);
  expect(authPage.isClosed()).toBe(true);
});
