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
//      An earlier version of `stopServiceWorker()` below raced the old handle's `evaluate()`
//      against a 1500ms timeout and treated the timeout as confirmation — which the
//      checkpoint-3 review correctly flagged as vacuous: since evaluate() always hangs rather
//      than rejecting, that race's timeout branch always won regardless of whether the worker
//      had actually stopped. Replaced with CDP `Target.getTargets`, polled — direction-validated
//      (confirmed the service_worker target both disappears on stop and reappears on wake) —
//      see `stopServiceWorker`'s own doc comment below.
//   4. PROMPT.md's `wakeWorker()` recipe — open popup.html, wait for a fresh 'serviceworker'
//      event — does not work here: this extension's popup only reads chrome.storage on load
//      (see src/popup/popup.ts), never sends a chrome.runtime message, and merely loading a
//      chrome-extension:// page does not itself respawn a stopped service worker in this
//      environment. A `chrome.runtime.sendMessage(...)` call, in contrast, reliably does — and
//      when it does, the *original* Worker handle comes back to life (evaluate() starts
//      succeeding again; `serviceWorkers()[0]` is the same object reference), so there is
//      nothing to "re-acquire." `wakeWorker()` below sends a harmless message from a throwaway
//      page instead of waiting on an event, and returns the same handle it was given.
//   6. `context.setOffline(true)` blocks a page-level `fetch()` in this environment but does
//      NOT block the stand-in's dedicated Worker fetch, spawned from the extension's offscreen
//      document — confirmed directly via a message-level check. Playwright's offline network
//      emulation apparently doesn't reach that target here. The `via: 'worker'` variant of the
//      offline test (transport.spec.ts, test 40) is skipped with this explanation rather than
//      silently passing on a request that was never actually blocked.
//   7. `chrome.runtime.reload()` (a real, unmodified extension API, not a hook) unloads the
//      extension and never re-registers it here — `--load-extension` /
//      `--disable-extensions-except` are one-time load-at-launch flags in this environment, not
//      a live-reload watch. Confirmed directly: after reload(), context.serviceWorkers() goes
//      to zero and a fresh navigation to the extension fails with net::ERR_BLOCKED_BY_CLIENT
//      even after a 5s wait. Test 13 (process-lifecycle.spec.ts) is skipped with this
//      explanation.
//
// See MEMORY.md's crx-iap-e2e-chrome-quirks entry for the checkpoint-2 findings this confirms;
// it has been updated with findings 3-7 above.

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
import type {
  CurrentTokenIdOutcome,
  FailureClass,
  FetchOutcome,
  StandInFetchOutcome,
  SwRequest,
} from '../../extension/src/shared/messages.ts';
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

// Test-scoped option (not a fixture value): the token lifecycle (1-9) and transport (40-43)
// groups run once with via: 'sw' (through IapClient.fetch()'s own classify/retry ladder) and
// once with via: 'worker' (through the stand-in Worker's DNR-attached request, which has no
// classification or retry logic of its own — see performFetch below). Every other group is
// SW-only per PROMPT.md ("those paths are identical in both modes"). Override with
// `test.use({ via: 'worker' })` inside a describe block.
interface Options {
  via: 'sw' | 'worker';
}

export const test = base.extend<Fixtures & Options>({
  via: ['sw', { option: true }],

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

  // Stops the given worker handle via CDP and confirms it actually stopped.
  //
  // Checkpoint-3 review, Task 5 (the most serious finding in that review): the previous
  // version raced `worker.evaluate(() => 1)` against a 1500ms timeout and treated the timeout
  // as confirmation of death. But finding 3 above already establishes that evaluate() on a
  // dead handle *hangs* rather than rejecting — which means that race's timeout branch always
  // won, regardless of whether the worker actually stopped. `stillAlive` was always `false`.
  // The check could not fail; tests 10 and 11 could not have detected stopAllWorkers silently
  // doing nothing.
  //
  // Replaced with CDP `Target.getTargets`, polled rather than a fixed wait — validated
  // directly in both directions before use, not assumed: launched a real extension, confirmed
  // its `service_worker` target is present in `Target.getTargets()`, called
  // `ServiceWorker.stopAllWorkers`, and confirmed the target disappears (in this environment,
  // within ~1ms — no discovery mode needed, a bare `Target.getTargets` call reflects it
  // immediately); then wakes it via a message and confirms the *same* target id reappears.
  // Both directions genuinely flip the result, unlike the check this replaces.
  stopServiceWorker: async ({ extensionContext }, use) => {
    const stop = async (worker: Worker): Promise<void> => {
      const workerUrl = worker.url();
      const page = await extensionContext.newPage();
      const session = await extensionContext.newCDPSession(page);
      await session.send('ServiceWorker.enable');
      await session.send('ServiceWorker.stopAllWorkers');

      const deadline = Date.now() + 3000;
      let stopped = false;
      while (Date.now() < deadline) {
        const { targetInfos } = (await session.send('Target.getTargets')) as {
          targetInfos: { type: string; url: string }[];
        };
        const stillPresent = targetInfos.some(
          (t) => t.type === 'service_worker' && t.url === workerUrl,
        );
        if (!stillPresent) {
          stopped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await page.close();
      if (!stopped) {
        throw new Error(
          `service worker did not stop within 3000ms (Target.getTargets still lists ${workerUrl})`,
        );
      }
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

// Clears all armed scenarios and the request log. Does NOT touch the extension's own
// chrome.storage cache — a retry after this that still reuses cached discovery/registration
// state is a real assertion about the client, not a tautology.
export async function resetServer(server: TestServerHandle): Promise<void> {
  await fetch(`${server.origins.control}/control/reset`, { method: 'POST' });
}

// Races a short timeout against the 'page' event so tests can assert "no auth tab opened"
// without an arbitrary sleep. Set up *before* triggering the action under test, then awaited
// after — see callers.
export function watchForPage(context: BrowserContext, withinMs = 2000): Promise<Page | null> {
  return context.waitForEvent('page', { timeout: withinMs }).catch(() => null);
}

// Always SW-driven, regardless of `via` — the stand-in Worker cannot itself acquire a token
// (see performFetch's doc comment). Use this to set up the "already logged in" precondition
// most tests start from before exercising the scenario under test through `performFetch`.
export async function establishToken(driver: Driver, origin: string): Promise<void> {
  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  if (!outcome.ok) throw new Error(`establishToken(${origin}) failed: ${JSON.stringify(outcome)}`);
}

// Real wall-clock wait (not a fake clock — see PROMPT.md's "no clock manipulation" rule,
// which governs simulating time, not waiting for it). Needed wherever a shortLivedTokens
// scenario must produce a *genuine* server-side expiry for `via: 'worker'`: the stand-in path
// has no local-expiry check of its own (that's IapClient.fetch()'s isFresh()/skew-margin logic
// — see client.ts), so it only ever recovers reactively from a real 401. `via: 'sw'` never
// needs this: the 60s skew margin already treats a 1s-lifetime token as stale immediately,
// with no real waiting required.
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function currentTokenId(driver: Driver, origin: string): Promise<string | null> {
  const outcome = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  return outcome.tokenId;
}

// Polls currentTokenId until it differs from `previous`, or throws. Used by the 'worker' via
// mode below, and directly by DNR-attachment tests that need to know a background refresh
// (triggered by reportRejected) has completed before issuing a follow-up request.
export async function waitForTokenChange(
  driver: Driver,
  origin: string,
  previous: string | null,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = await currentTokenId(driver, origin);
    if (id && id !== previous) return id;
    if (Date.now() > deadline) throw new Error(`tokenId for ${origin} did not change in time`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface ViaOutcome {
  ok: boolean;
  status?: number;
  errorClass?: FailureClass;
}

/**
 * Performs one logical fetch through whichever mechanism `via` selects.
 *
 * `via: 'sw'` goes through IapClient.fetch()'s own classify/refresh/retry ladder in one call —
 * a stale or rejected token is recovered transparently, matching PROMPT.md's FetchOutcome.
 *
 * `via: 'worker'` goes through the stand-in Worker's DNR-attached request, which has no
 * classification or retry logic at all (see packages/extension/src/standin/worker.ts and
 * docs/detecting-failure.md) — a 401 there only triggers `reportRejected`, which refreshes the
 * token and updates the DNR rule asynchronously. So this helper mirrors what a real caller of
 * the stand-in library would have to do: on a 401, wait for the token to change and retry.
 * PROMPT.md documents the DNR rule-update window itself ("a request that 401s and is recovered
 * by the normal rejection path ... one round trip slower") as exactly one extra round trip —
 * but `currentTokenId` (what `waitForTokenChange` polls) updates in the SW *before*
 * `updateSessionRules` is awaited (see service-worker/index.ts's onTokenChanged listener), so a
 * retry can still land inside that narrower sub-window and 401 again. Bounded retry loop rather
 * than exactly one, to absorb that without masking a real hang (a bug would still exhaust the
 * bound and fail loudly). A non-401 failure (e.g. offline) is returned as-is, with no retry —
 * there is nothing to recover from and no classification to report.
 *
 * IMPORTANT: the stand-in Worker never logs in — `reportRejected` is only ever sent when the
 * offscreen document already has a cached tokenId for the resource (see
 * docs/detecting-failure.md), so a 401 with *no* prior token is never reported and this will
 * hang waiting for a token change that's never coming. Establish the initial token via
 * `establishToken()` (always SW-driven, regardless of `via`) before calling this for the
 * scenario under test.
 */
export async function performFetch(
  driver: Driver,
  via: 'sw' | 'worker',
  origin: string,
  path: string,
  opts?: { method?: string },
): Promise<ViaOutcome> {
  if (via === 'sw') {
    const outcome = await driver.send<FetchOutcome>(
      opts?.method
        ? { type: 'fetch', resource: `${origin}${path}`, opts: { method: opts.method } }
        : { type: 'fetch', resource: `${origin}${path}` },
    );
    return outcome.ok
      ? { ok: true, status: outcome.status }
      : { ok: false, errorClass: outcome.errorClass };
  }

  let previous = await currentTokenId(driver, origin);
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await driver.standInFetch(origin, path, opts?.method);
    if (!result.ok) return { ok: false };
    if (result.status !== 401) return { ok: true, status: result.status };
    previous = await waitForTokenChange(driver, origin, previous);
  }
  return { ok: false };
}
