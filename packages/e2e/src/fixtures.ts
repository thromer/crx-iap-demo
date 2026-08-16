// Playwright fixtures for the extension e2e suite (PROMPT.md "Component D").
//
// Three deliberate deviations from PROMPT.md's Component D snippet, confirmed empirically in
// this sandboxed dev environment (the first two at checkpoint 2, via
// packages/extension/scripts/verify-primitives.mjs, and re-confirmed here; the third found
// while building this fixture file):
//
//   1. `channel: 'chrome'` (real Google Chrome) refuses to load an unpacked extension via
//      `--load-extension` at all in this environment — the service worker never registers.
//      Playwright's bundled Chromium loads it fine, so `channel` is omitted below. This is an
//      environment/launch-config difference only; it does not change the tested artifact.
//   2. `chrome.runtime.sendMessage(...)` called from *inside* `worker.evaluate()` — i.e. sender
//      and the service worker's own `onMessage` listener are the same JS context — fails with
//      "Could not establish connection. Receiving end does not exist." Driving is therefore
//      routed through a page context (a popup.html tab held open for the test's duration) via
//      `page.evaluate()`, exactly as the popup itself would do. `worker.evaluate()` is still
//      used for pure *observation* (chrome.storage.*.get(), chrome.declarativeNetRequest
//      inspection), which works fine — PROMPT.md's own guidance already prefers request-log
//      assertions over these anyway.
//   3. After `ServiceWorker.stopAllWorkers` succeeds, `context.serviceWorkers()` does not shrink
//      here — it keeps listing the dead worker — and PROMPT.md's claim that a dead handle's
//      `evaluate()` "throws" doesn't hold either: it hangs indefinitely instead of rejecting.
//      `stopServiceWorker()` below therefore verifies termination by racing the old handle's
//      `evaluate()` against a short timeout and treating the timeout itself as confirmation,
//      rather than asserting on `serviceWorkers()` length or awaiting a rejection.
//   4. PROMPT.md's `wakeWorker()` recipe — open popup.html, wait for a fresh 'serviceworker'
//      event — does not work here: this extension's popup only reads chrome.storage on load
//      (see src/popup/popup.ts), never sends a chrome.runtime message, and merely loading a
//      chrome-extension:// page does not itself respawn a stopped service worker in this
//      environment. A `chrome.runtime.sendMessage(...)` call, in contrast, reliably does — and
//      when it does, the *original* Worker handle comes back to life (evaluate() starts
//      succeeding again; `serviceWorkers()[0]` is the same object reference), so there is
//      nothing to "re-acquire." `wakeWorker()` below sends a harmless message from a throwaway
//      page instead of waiting on an event, and returns the same handle it was given.
//
// See MEMORY.md's crx-iap-e2e-chrome-quirks entry for the checkpoint-2 findings this confirms;
// it has been updated with findings 3 and 4 above.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BrowserContext,
  test as base,
  type ConsoleMessage,
  chromium,
  type Page,
  type Worker,
} from '@playwright/test';
import type { StandInFetchOutcome, SwRequest } from '../../extension/src/shared/messages.ts';
import { startTestServer, type TestServerHandle } from '../../test-server/src/index.ts';
import type { RequestLogEntry } from '../../test-server/src/state.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.join(__dirname, '..', '..', 'extension', 'dist');

export interface Driver {
  extensionId: string;
  send<T>(message: SwRequest): Promise<T>;
  standInFetch(resource: string, path: string, method?: string): Promise<StandInFetchOutcome>;
}

interface Fixtures {
  testServer: TestServerHandle;
  extensionContext: BrowserContext;
  serviceWorker: Worker;
  workerConsole: ConsoleMessage[];
  wakeWorker: () => Promise<Worker>;
  stopServiceWorker: (worker: Worker) => Promise<void>;
  driver: Driver;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures require this parameter even when unused.
  testServer: async ({}, use) => {
    const server = await startTestServer();
    await use(server);
    await server.close();
  },

  extensionContext: async ({ testServer }, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'iap-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      // See module header: Playwright's default args include --disable-extensions, which
      // otherwise silently wins over --disable-extensions-except / --load-extension.
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        `--ignore-certificate-errors-spki-list=${testServer.leafSpkiSha256Base64}`,
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ extensionContext }, use) => {
    const worker =
      extensionContext.serviceWorkers()[0] ??
      (await extensionContext.waitForEvent('serviceworker'));
    await use(worker);
  },

  workerConsole: async ({ serviceWorker }, use, testInfo) => {
    const messages: ConsoleMessage[] = [];
    serviceWorker.on('console', (msg) => messages.push(msg));
    await use(messages);
    await testInfo.attach('service-worker-console', {
      body: messages.map((m) => `[${m.type()}] ${m.text()}`).join('\n'),
      contentType: 'text/plain',
    });
  },

  // Wakes a stopped service worker. See the module header (finding 4): opening popup.html
  // alone does not respawn it here, and once a chrome.runtime message does, the *same* Worker
  // handle comes back to life rather than a new one needing to be re-acquired — so this sends
  // a harmless message from a throwaway page and hands back the original handle.
  wakeWorker: async ({ extensionContext, serviceWorker }, use) => {
    const extensionId = new URL(serviceWorker.url()).host;
    const wake = async (): Promise<Worker> => {
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'currentTokenId', resource: 'https://wake.invalid' }),
      );
      await page.close();
      return serviceWorker;
    };
    await use(wake);
  },

  // Stops the given worker handle via CDP and confirms it. See the module header (finding 3):
  // context.serviceWorkers() does not shrink here and evaluate() on the dead handle hangs
  // rather than rejecting, so termination is confirmed by racing a trivial evaluate() against
  // a short timeout and treating the timeout as confirmation.
  stopServiceWorker: async ({ extensionContext }, use) => {
    const stop = async (worker: Worker): Promise<void> => {
      const page = await extensionContext.newPage();
      const session = await extensionContext.newCDPSession(page);
      await session.send('ServiceWorker.enable');
      await session.send('ServiceWorker.stopAllWorkers');
      await page.close();

      const stillAlive = await Promise.race([
        worker.evaluate(() => 1).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      if (stillAlive) throw new Error('service worker did not stop within 1500ms');
    };
    await use(stop);
  },

  // A single popup.html tab, held open for the test, used to drive every message — see the
  // module header on why this replaces PROMPT.md's worker.evaluate()-based driving.
  driver: async ({ extensionContext, serviceWorker }, use) => {
    const extensionId = new URL(serviceWorker.url()).host;
    const page: Page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const driver: Driver = {
      extensionId,
      send: (message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message),
      standInFetch: (resource, standinPath, method) =>
        page.evaluate((m) => chrome.runtime.sendMessage(m), {
          type: 'standinFetch',
          resource,
          path: standinPath,
          method,
        }) as Promise<StandInFetchOutcome>,
    };
    await use(driver);
    await page.close();
  },
});

export { expect } from '@playwright/test';

export async function armScenario(
  server: TestServerHandle,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const response = await fetch(`${server.origins.control}/control/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...args }),
  });
  if (!response.ok) {
    throw new Error(`failed to arm scenario "${name}": ${await response.text()}`);
  }
}

export async function requestLog(server: TestServerHandle): Promise<RequestLogEntry[]> {
  const response = await fetch(`${server.origins.control}/control/requests`);
  return (await response.json()) as RequestLogEntry[];
}

// Races a short timeout against the 'page' event so tests can assert "no auth tab opened"
// without an arbitrary sleep. Set up *before* triggering the action under test, then awaited
// after — see callers.
export function watchForPage(context: BrowserContext, withinMs = 2000): Promise<Page | null> {
  return context.waitForEvent('page', { timeout: withinMs }).catch(() => null);
}
