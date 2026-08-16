import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, expect, test, watchForPage } from '../src/fixtures.ts';

// Tests 29 (tampered state) and 31 (authorization code replay) are not constructible from this
// harness without adding a hook to the extension that PROMPT.md forbids: both attacks require
// the *attacker's* forged material to be compared against the client's own PKCE `state` /
// `code_verifier`, and both are internal, never-persisted local variables inside
// runAuthorizationLadder() (packages/iap-auth/src/authorize.ts) — never written to storage,
// never sent in a message, never logged by value. There is no scenario or observation point
// that produces a state/code an external harness could legitimately replay or corrupt to match
// what the client is about to check. Test 30 (wrong code_verifier -> rejected, no token issued)
// exercises exactly the same underlying defense (oauth4webapi's PKCE verification at the token
// endpoint) as test 34 (injectForeignCode) below, which *is* constructible, since the decoy
// grant's code_challenge structurally can never match the real client's code_verifier — so 34
// stands in for 30's security property. Per PROMPT.md's working agreement: "If a test cannot be
// written without adding a hook to the extension, stop and say so ... a missing test is a
// better outcome than a divergent artifact."

// Test 32: denyAuthorization -> FORBIDDEN, not retried, distinct from an authentication
// failure. The "IdP login succeeded but policy denied" case.
test('32: denyAuthorization classifies as FORBIDDEN, not retried', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'denyAuthorization');

  const pagePromise = watchForPage(extensionContext);
  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.errorClass).toBe('FORBIDDEN');
    expect(outcome.promptOccurred).toBe(false);
  }
});

// Test 33: a redirect with an error and no code must not be treated as success. Reuses
// denyAuthorization (the only scenario that produces an error-carrying redirect with no code)
// but asserts the weaker, more general property this test is actually about, distinct from
// test 32's specific FORBIDDEN classification.
test('33: an authorization error redirect with no code is never treated as success', async ({
  testServer,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'denyAuthorization');

  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);
});

// Test 34: injectForeignCode -> rejected. The decoy client's authorization code, handed to the
// real client's redirect_uri, must be rejected at the token endpoint — its code_challenge was
// bound to the decoy grant, not this client's code_verifier.
test('34: an injected foreign authorization code is rejected', async ({ testServer, driver }) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'injectForeignCode');

  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);
});
