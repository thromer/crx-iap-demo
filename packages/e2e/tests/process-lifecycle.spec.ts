import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import type { ActionOutcome, FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, EXT_PATH, expect, requestLog, test, watchForPage } from '../src/fixtures.ts';

// Test 10 (process lifecycle): stop the service worker between two fetch calls -> second
// succeeds, no prompt.
test('10: fetch after the service worker is stopped and restarted succeeds with no prompt', async ({
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

// Test 11: stop the service worker while the token is expired -> cold-start refresh path, no
// prompt.
test('11: cold-start refresh after the worker stops while the token is expired, no prompt', async ({
  testServer,
  extensionContext,
  serviceWorker,
  driver,
  stopServiceWorker,
  wakeWorker,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'shortLivedTokens', { seconds: 1 });

  const first = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(first.ok).toBe(true);

  await stopServiceWorker(serviceWorker);
  await wakeWorker();

  const pagePromise = watchForPage(extensionContext);
  const second = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.status).toBe(200);
});

// Test 12: relaunch against the same userDataDir -> access token gone, refresh token and
// client registration present. A genuine browser restart (close + relaunch the same profile
// directory), not a simulation, per PROMPT.md's harness-mechanics note.
test('12: relaunching against the same profile clears the access token but keeps the refresh token and registration', async ({
  testServer,
}) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'iap-e2e-restart-'));
  const origin = testServer.origins.rsA;

  const context1 = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      `--ignore-certificate-errors-spki-list=${testServer.leafSpkiSha256Base64}`,
    ],
  });
  try {
    const worker1 = context1.serviceWorkers()[0] ?? (await context1.waitForEvent('serviceworker'));
    const extensionId = new URL(worker1.url()).host;
    const page1 = await context1.newPage();
    await page1.goto(`chrome-extension://${extensionId}/popup.html`);
    const login = await page1.evaluate(
      (r) =>
        chrome.runtime.sendMessage({ type: 'login', resource: r, opts: { interactive: true } }),
      origin,
    );
    expect((login as ActionOutcome).ok).toBe(true);

    const before = await worker1.evaluate(async () => {
      const session = await chrome.storage.session.get(null);
      const local = await chrome.storage.local.get(null);
      return {
        hasAccess: Object.keys(session).some((k) => k.startsWith('access:')),
        hasRefresh: Object.keys(local).some((k) => k.startsWith('refresh:')),
        hasClient: Object.keys(local).some((k) => k.startsWith('client:')),
      };
    });
    expect(before).toEqual({ hasAccess: true, hasRefresh: true, hasClient: true });
  } finally {
    await context1.close();
  }

  const context2 = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      `--ignore-certificate-errors-spki-list=${testServer.leafSpkiSha256Base64}`,
    ],
  });
  try {
    const worker2 = context2.serviceWorkers()[0] ?? (await context2.waitForEvent('serviceworker'));
    const after = await worker2.evaluate(async () => {
      const session = await chrome.storage.session.get(null);
      const local = await chrome.storage.local.get(null);
      return {
        hasAccess: Object.keys(session).some((k) => k.startsWith('access:')),
        hasRefresh: Object.keys(local).some((k) => k.startsWith('refresh:')),
        hasClient: Object.keys(local).some((k) => k.startsWith('client:')),
      };
    });
    expect(after).toEqual({ hasAccess: false, hasRefresh: true, hasClient: true });
  } finally {
    await context2.close();
  }
});

// Test 13: reload the extension -> registration survives; in-flight PKCE verifier cleared;
// fresh login works immediately.
//
// Confirmed directly, not written from assumption: `chrome.runtime.reload()` (the standard way
// to trigger this from within the extension itself, not a test-only hook) unloads the
// extension and never re-registers it in this environment. `--load-extension` /
// `--disable-extensions-except` are one-time load-at-launch flags here, not a live-reload
// watch — after reload() the service worker disappears from context.serviceWorkers(), the
// existing extension page is force-closed, and a fresh navigation to
// chrome-extension://<id>/... fails outright with net::ERR_BLOCKED_BY_CLIENT even after a 5s
// wait. There is no product-code workaround for this (reload() is a real, unmodified Chrome
// API) and PROMPT.md's non-goals section forbids adding extension hooks to route around a
// harness limitation. Skipped with this explanation rather than a fabricated pass.
//
// Note the part of test 13 this harness *can* still verify by construction, independent of
// reload actually working: the PKCE code_verifier is a local variable inside
// runAuthorizationLadder() (packages/iap-auth/src/authorize.ts) and is never written to any
// KeyValueStore — so there is no verifier state left over after ANY service worker
// restart/reload for a fresh login to trip over. Test 10/11 already exercise the "fresh
// call after a worker restart works cleanly" shape via CDP-based stop/wake.
test.skip('13: reloading the extension keeps the registration and clears in-flight PKCE state', async () => {});

// Test 14: two sequential logins reuse one client registration -> exactly one DCR request
// total. Two resources behind the same AS (rsA, rsB); registration is cached per-issuer.
test('14: two sequential logins across resources reuse a single client registration', async ({
  testServer,
  driver,
}) => {
  const before = await requestLog(testServer);

  const first = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${testServer.origins.rsA}/api/resource`,
  });
  expect(first.ok).toBe(true);

  const second = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${testServer.origins.rsB}/api/resource`,
  });
  expect(second.ok).toBe(true);

  const after = await requestLog(testServer);
  const registrations = after
    .slice(before.length)
    .filter((e) => e.server === 'as' && e.path === '/reg');
  expect(registrations).toHaveLength(1);
});
