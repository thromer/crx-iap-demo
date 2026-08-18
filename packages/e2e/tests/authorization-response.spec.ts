import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import { armScenario, expect, requestLog, test, watchForPage } from '../src/fixtures.ts';

// Tests 29-31 (checkpoint-3 review, Task 12). The client's own `state`/`code_verifier` are
// indeed internal, never-persisted local variables inside runAuthorizationLadder()
// (packages/iap-auth/src/authorize.ts) — but that only rules out reaching into the *client* to
// construct these attacks. The authorization server is a fake this project controls end to
// end: `state` is echoed back by the AS in the redirect, authorization codes are minted by the
// AS, and token-endpoint outcomes are decided by the AS. All three are constructible from the
// control plane with zero changes to the client or extension — see `mintRealCode`,
// `tamperState`, and `reissuePreviousCode` in packages/test-server/src/as.ts, and
// `rejectCodeExchange` in its token endpoint handler.

// Test 29: the AS rewrites `state` in the authorization redirect before returning it. The
// client's own `state` was never touched, so oauth4webapi's `validateAuthResponse` must reject
// the mismatch before any token request is ever issued.
test('29: a tampered state on the authorization redirect is rejected before any token request', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'tamperState');

  const before = await requestLog(testServer);
  const pagePromise = watchForPage(extensionContext);
  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('MISCONFIGURED');

  const after = await requestLog(testServer);
  const since = after.slice(before.length);
  expect(since.filter((e) => e.server === 'as' && e.path === '/token')).toHaveLength(0);
});

// Test 30 (re-scoped, per the working agreement — recorded here, not just implied): the literal
// wording ("wrong code_verifier -> rejected, no token issued") describes an *AS* property, and
// the AS is node-oidc-provider, whose PKCE correctness is not this project's to prove. (Test 34,
// injectForeignCode, was originally thought to stand in for this via a constructible vector, but
// on inspection it exercises client-identity binding, not PKCE specifically — see its comment.
// No test here isolates genuine PKCE code_verifier mismatch; that gap is separate from this
// one.) The client-side property actually worth testing is what happens when the token endpoint
// rejects the code exchange outright: a clean classified error, no wedge, no loop, and a fresh
// login afterward succeeds.
test('30: a rejected code exchange surfaces a classified error, and a fresh login afterward succeeds', async ({
  testServer,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'rejectCodeExchange');

  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('MISCONFIGURED');

  // Not wedged: a fresh login attempt right after succeeds normally (rejectCodeExchange is
  // single-shot, consumed by the first exchange above).
  const retry = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(retry.ok).toBe(true);
  if (retry.ok) expect(retry.status).toBe(200);
});

// Test 31: the AS returns the same authorization code for a second login as it did for the
// first. node-oidc-provider enforces single-use, and the second login's own fresh PKCE pair
// won't match the first's binding either way — either is a correct rejection of a replayed
// code, and this test doesn't need to distinguish which fired (see reissuePreviousCode's
// comment in as.ts). No code_verifier access needed: the AS does the replaying, not the
// harness reaching into the client.
test('31: a replayed authorization code from a second login fails, and a further fresh login succeeds', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  const resource = `${origin}/api/resource`;
  await armScenario(testServer, 'reissuePreviousCode');

  // First login under this scenario mints and captures a real code, and succeeds normally.
  const first = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.status).toBe(200);

  // Second login (a fresh authorization attempt after logout) reuses the captured code. Note:
  // logout() takes the resource *origin* — client.fetch() normalizes internally via
  // `new URL(input).origin`, but logout() does not, so passing the full path here would key a
  // different cache entry and silently no-op, leaving the still-valid token cached.
  await driver.send({ type: 'logout', resource: origin });
  const second = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(second.ok).toBe(false);

  // Not wedged: turn the scenario off and confirm a further fresh login succeeds.
  await armScenario(testServer, 'reissuePreviousCode', { on: false });
  const third = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(third.ok).toBe(true);
  if (third.ok) expect(third.status).toBe(200);
});

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
// real client's redirect_uri, must be rejected at the token endpoint. Correction (checkpoint-3
// review, Task 12): this scenario's code is deliberately bound to the real client's own
// code_challenge (see injectForeignCode's comment in packages/test-server/src/as.ts) — the
// rejection comes from client-identity binding (the code belongs to a different client_id than
// the one presenting it), not a PKCE code_verifier mismatch. Both are real RFC 9700 defenses
// against adjacent attacks; this test exercises client binding, not PKCE specifically. No test
// in this suite currently exercises a genuine PKCE code_verifier mismatch in isolation — that
// would need its own scenario (a code correctly bound to the real client but a wrong/foreign
// code_challenge), not yet written.
test('34: an injected foreign authorization code is rejected', async ({ testServer, driver }) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'injectForeignCode');

  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);
});
