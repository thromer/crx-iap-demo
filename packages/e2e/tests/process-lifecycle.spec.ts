import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import { expect, test, watchForPage } from '../src/fixtures.ts';

// Test 10 (process lifecycle): stop the service worker between two fetch calls -> second
// succeeds, no prompt.
test('fetch after the service worker is stopped and restarted succeeds with no prompt', async ({
  testServer,
  extensionContext,
  serviceWorker,
  driver,
  stopServiceWorker,
  wakeWorker,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;

  const first = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(first.ok).toBe(true);

  // Stops and confirms termination (see fixtures.ts's module header on why this can't be done
  // by asserting on extensionContext.serviceWorkers() here).
  await stopServiceWorker(serviceWorker);

  // Re-acquire a live worker handle (the old one is dead) before continuing, per PROMPT.md's
  // wakeWorker() contract. The access token survives in chrome.storage.session, which is
  // scoped to the browser session, not the service worker's own lifetime.
  await wakeWorker();

  const pagePromise = watchForPage(extensionContext);
  const second = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.status).toBe(200);
    expect(second.promptOccurred).toBe(false);
  }
});
