// Checkpoint-2 primitive checks, per PROMPT.md:
//   1. A DNR `modifyHeaders` rule can `set` the Authorization header and the value reaches
//      the server (verify before building anything on top of the design).
//   2. A stand-in library Worker request reaches the test server with a bearer token
//      attached, proving DNR operates below the JS execution context regardless of which
//      Worker issued the request.
//
// Not part of the automated suite (that's packages/e2e, checkpoint 3) — a one-shot script
// run by hand against a production build.
//
// Notes from getting this to run at all, worth keeping close to the script:
//   - Playwright's default launch args include `--disable-extensions`, which silently wins
//     over `--disable-extensions-except` / `--load-extension` unless excluded via
//     `ignoreDefaultArgs`.
//   - `channel: 'chrome'` (real Google Chrome 151 in this environment) refused to load an
//     unpacked extension via `--load-extension` at all; Playwright's bundled Chromium does.
//     Worth re-checking when packages/e2e is built — PROMPT.md's harness snippet uses
//     `channel: 'chrome'`.
//   - `chrome.runtime.sendMessage` called from *inside* `worker.evaluate()` (i.e. the sender
//     and the service worker's own listener are the same context) fails with "Could not
//     establish connection." Routing the same message through a page context (the popup)
//     works. The real e2e harness will need this in mind for its `via: 'sw'` driving.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startTestServer } from '../../test-server/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.join(__dirname, '..', 'dist');

async function launchWithExtension(userDataDir, spkiList) {
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      `--ignore-certificate-errors-spki-list=${spkiList}`,
    ],
  });
}

async function checkDnrPrimitive() {
  const server = await startTestServer();
  const context = await launchWithExtension(
    path.join(__dirname, '.tmp-profile-1'),
    server.leafSpkiSha256Base64,
  );
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    // Install a session rule directly (bypassing IapClient) — the raw primitive check,
    // independent of the rest of the auth dance.
    await worker.evaluate(async (rsOrigin) => {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [999],
        addRules: [
          {
            id: 999,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                {
                  header: 'Authorization',
                  operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: 'Bearer primitive-check-token',
                },
              ],
            },
            condition: {
              urlFilter: `|${rsOrigin}/*`,
              resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
            },
          },
        ],
      });
    }, server.origins.rsA);

    await worker.evaluate((rsOrigin) => fetch(`${rsOrigin}/api/whatever`), server.origins.rsA);

    const log = await (await fetch(`${server.origins.control}/control/requests`)).json();
    const hit = log.find((e) => e.origin === server.origins.rsA && e.path === '/api/whatever');
    assert.ok(hit, 'expected a request to reach rs-a');
    assert.ok(
      hit.hadAuthorizationHeader,
      'expected the DNR rule to attach an Authorization header',
    );
    console.log('CHECK 1 (DNR set-Authorization primitive): PASS');
  } finally {
    await context.close();
    await server.close();
  }
}

async function checkStandInWorkerAttachment() {
  const server = await startTestServer();
  const context = await launchWithExtension(
    path.join(__dirname, '.tmp-profile-2'),
    server.leafSpkiSha256Base64,
  );
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Real login through the message API, so a token — and its DNR rule — exist before the
    // stand-in Worker's request goes out.
    const loginOutcome = await page.evaluate(
      (rsOrigin) =>
        chrome.runtime.sendMessage({
          type: 'login',
          resource: rsOrigin,
          opts: { interactive: true },
        }),
      server.origins.rsA,
    );
    assert.ok(loginOutcome.ok, `login failed: ${JSON.stringify(loginOutcome)}`);

    // Give the offscreen document a moment to exist and pick up the tokenChanged broadcast.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const standInOutcome = await page.evaluate(
      (rsOrigin) =>
        chrome.runtime.sendMessage({
          type: 'standinFetch',
          resource: rsOrigin,
          path: '/api/resource',
        }),
      server.origins.rsA,
    );
    await page.close();

    assert.equal(
      standInOutcome.ok,
      true,
      `stand-in fetch failed: ${JSON.stringify(standInOutcome)}`,
    );
    assert.equal(
      standInOutcome.status,
      200,
      `stand-in fetch was not authorized: ${standInOutcome.status}`,
    );

    const log = await (await fetch(`${server.origins.control}/control/requests`)).json();
    const hit = log.findLast((e) => e.origin === server.origins.rsA && e.path === '/api/resource');
    assert.ok(hit, 'expected a request to /api/resource from rs-a');
    assert.ok(
      hit.hadAuthorizationHeader,
      'expected the stand-in Worker request to carry a bearer token',
    );
    console.log('CHECK 2 (stand-in Worker DNR attachment): PASS');
  } finally {
    await context.close();
    await server.close();
  }
}

async function main() {
  await checkDnrPrimitive();
  await checkStandInWorkerAttachment();
}

main()
  .then(() => {
    console.log('all checks passed');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
