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
// first. Two derivations were tried and checked against actual runs before this one held
// (checkpoint-3 review, Task 20): (1) assumed a PKCE mismatch, reasoning checkPKCE() runs before
// consumeGrantSource() — wrong, the actual error was "authorization code not found"; (2) traced
// that to this test's own logout() revoking the refresh token, and assumed the specific
// `provider.AuthorizationCode.revokeByGrantId()` call in revoke.js's cascade
// (node_modules/oidc-provider/lib/helpers/revoke.js) was responsible — also wrong: disabling
// just that call still produced "authorization code not found", proven by mutation-testing the
// assumption itself. The real mechanism (confirmed via instrumentation, not just reading):
// MemoryAdapter tracks each grant's member tokens in one shared per-grantId index
// (node_modules/oidc-provider/lib/adapters/memory_adapter.js's getGrantMembers/setGrantMembers),
// and ANY single `<Model>.revokeByGrantId()` call — even just the unconditional
// `provider.AccessToken` one, first in revoke.js's array — walks that shared index and deletes
// every grantable token under it, including the authorization code, regardless of which model
// initiated the call. So the rejection is deterministically "authorization code not found",
// regardless of code_verifier. No code_verifier access needed: the AS does the replaying, not
// the harness reaching into the client.
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
  const before = await requestLog(testServer);
  const second = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(second.ok).toBe(false);

  const since = (await requestLog(testServer)).slice(before.length);
  const tokenRequest = since.find((e) => e.server === 'as' && e.path === '/token');
  expect(tokenRequest?.errorCode).toBe('authorization code not found');

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
// test 32's specific FORBIDDEN classification. Note (checkpoint-3 review, Task 20's sweep): with
// only denyAuthorization available to construct this, this test can't fully separate itself from
// test 32 — both currently observe the same errorClass. What it adds beyond 32 is the structural
// check below: the client never even attempts a token exchange for a code-less error redirect,
// which is the actual "not treated as success" property, proven the same way as test 29.
test('33: an authorization error redirect with no code is never treated as success', async ({
  testServer,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'denyAuthorization');

  const before = await requestLog(testServer);
  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);

  const since = (await requestLog(testServer)).slice(before.length);
  expect(since.filter((e) => e.server === 'as' && e.path === '/token')).toHaveLength(0);
});

// Test 34: injectForeignCode -> rejected on client-identity binding, not PKCE. Correction
// (checkpoint-3 review, Task 12): this scenario's code is deliberately bound to the real
// client's own code_challenge (see injectForeignCode's comment in
// packages/test-server/src/as.ts) — the rejection comes from client-identity binding (the code
// belongs to a different client_id than the one presenting it), not a PKCE code_verifier
// mismatch. Both are real RFC 9700 defenses against adjacent attacks; this test exercises client
// binding specifically, asserted below via the AS's captured error_detail (checkpoint-3 review,
// Task 20). Test 34a exercises the PKCE case.
test('34: an injected foreign authorization code is rejected on client-identity binding', async ({
  testServer,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'injectForeignCode');

  const before = await requestLog(testServer);
  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);

  const since = (await requestLog(testServer)).slice(before.length);
  const tokenRequest = since.find((e) => e.server === 'as' && e.path === '/token');
  expect(tokenRequest?.errorCode).toBe('client mismatch');
});

// Test 34a: substituteCodeChallenge -> rejected on PKCE, not client-identity binding. The code
// is bound to the real client_id and redirect_uri (so findGrantSource()'s client-identity check
// passes) but to an AS-chosen code_challenge the client's real code_verifier can't satisfy —
// isolating checkPKCE()'s rejection from test 34's (checkpoint-3 review, Task 20).
test('34a: a code bound to a substituted code_challenge is rejected on PKCE mismatch', async ({
  testServer,
  driver,
}) => {
  const resource = `${testServer.origins.rsA}/api/resource`;
  await armScenario(testServer, 'substituteCodeChallenge');

  const before = await requestLog(testServer);
  const outcome = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('MISCONFIGURED');

  const since = (await requestLog(testServer)).slice(before.length);
  const tokenRequest = since.find((e) => e.server === 'as' && e.path === '/token');
  expect(tokenRequest?.errorCode).toBe('code_verifier does not match code_challenge');

  // Not wedged: a fresh login attempt right after succeeds normally. Unlike rejectCodeExchange,
  // substituteCodeChallenge isn't single-shot (it drives the interaction handler on every
  // authorization, like injectForeignCode/tamperState) — disarm it first so this retry gets a
  // real code_challenge instead of repeating the same rejection.
  await armScenario(testServer, 'substituteCodeChallenge', { on: false });
  const retry = await driver.send<FetchOutcome>({ type: 'fetch', resource });
  expect(retry.ok).toBe(true);
  if (retry.ok) expect(retry.status).toBe(200);
});
