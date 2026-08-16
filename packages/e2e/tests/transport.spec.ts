import type { CurrentTokenIdOutcome, FetchOutcome } from '../../extension/src/shared/messages.ts';
import { expect, test, watchForPage } from '../src/fixtures.ts';

// Test 40 (transport vs. auth): context.setOffline(true) -> no prompt, no auth state
// mutation, TRANSPORT error. Restore connectivity -> next request succeeds with the original
// token.
test('going offline classifies as TRANSPORT with no auth mutation; recovers with the same token', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  const resource = `${origin}/api/resource`;

  const first = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(first.ok).toBe(true);

  const before = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  expect(before.tokenId).not.toBeNull();

  await extensionContext.setOffline(true);
  try {
    const pagePromise = watchForPage(extensionContext);
    const offlineOutcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
    const page = await pagePromise;

    expect(page).toBeNull();
    expect(offlineOutcome.ok).toBe(false);
    if (!offlineOutcome.ok) {
      expect(offlineOutcome.errorClass).toBe('TRANSPORT');
      expect(offlineOutcome.promptOccurred).toBe(false);
    }
  } finally {
    await extensionContext.setOffline(false);
  }

  const afterOffline = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  expect(afterOffline.tokenId).toBe(before.tokenId);

  const recovered = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(recovered.ok).toBe(true);
  if (recovered.ok) expect(recovered.status).toBe(200);

  const afterRecovery = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  expect(afterRecovery.tokenId).toBe(before.tokenId);
});
