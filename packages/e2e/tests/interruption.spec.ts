import type { ActionOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, expect, test } from '../src/fixtures.ts';

// Test 38: close the auth tab mid-flow -> rejection handled, lock releases, immediate retry
// succeeds. ("stale verifier cleared" holds by construction: the PKCE code_verifier is a local
// variable inside runAuthorizationLadder(), packages/iap-auth/src/authorize.ts, never
// persisted anywhere to begin with.)
test('38: closing the auth tab mid-flow releases the lock; an immediate retry succeeds', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'forceLogin');

  const firstAttempt = driver.send<ActionOutcome>({
    type: 'login',
    resource: origin,
    opts: { interactive: true },
  });
  const authPage = await extensionContext.waitForEvent('page');
  await authPage.close();
  const first = await firstAttempt;
  expect(first.ok).toBe(false);

  const retryAttempt = driver.send<ActionOutcome>({
    type: 'login',
    resource: origin,
    opts: { interactive: true },
  });
  const retryPage = await extensionContext.waitForEvent('page');
  await retryPage.waitForSelector('#approve');
  await retryPage.click('#approve');
  const retry = await retryAttempt;
  expect(retry.ok).toBe(true);
});

// Test 39: a second login for the same resource while one is pending coalesces into the first
// and resolves with the same outcome. Exactly one auth tab opened.
test('39: a concurrent second login coalesces into the first; exactly one auth tab', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'forceLogin');

  const seenPages: number[] = [];
  extensionContext.on('page', () => seenPages.push(Date.now()));

  const [first, second] = await Promise.all([
    driver.send<ActionOutcome>({ type: 'login', resource: origin, opts: { interactive: true } }),
    driver.send<ActionOutcome>({ type: 'login', resource: origin, opts: { interactive: true } }),
    (async () => {
      const authPage = await extensionContext.waitForEvent('page');
      await authPage.waitForSelector('#approve');
      await authPage.click('#approve');
    })(),
  ]);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(seenPages).toHaveLength(1);
});
