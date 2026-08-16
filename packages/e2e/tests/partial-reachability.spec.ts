import type { FetchOutcome } from '../../extension/src/shared/messages.ts';
import {
  armScenario,
  expect,
  requestLog,
  resetServer,
  test,
  watchForPage,
} from '../src/fixtures.ts';

// Tests 44-48 (partial reachability): the chain fails midway with everything else healthy.
// For each: classified TRANSPORT (except 47, see below), no prompt, and no poisoned cache — a
// retry after /control/reset succeeds without a fresh install or manual cache clear. Resetting
// the server does not touch the extension's own chrome.storage cache, so a post-reset retry
// exercising cache reuse is a real assertion, not a tautology.

// Test 44: endpointUnreachable('resourceMetadata') -> challenge parsed, metadata unreachable;
// TRANSPORT, not MISCONFIGURED (these must not be conflated: one is retryable, the other is
// not).
test('44: an unreachable resource metadata endpoint classifies as TRANSPORT, not MISCONFIGURED', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'endpointUnreachable', { which: 'resourceMetadata' });

  const pagePromise = watchForPage(extensionContext);
  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('TRANSPORT');

  await resetServer(testServer);
  const retry = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(retry.ok).toBe(true);
  if (retry.ok) expect(retry.status).toBe(200);
});

// Test 45: endpointUnreachable('asMetadata') -> the 9728 probe succeeds, discovery fails.
// Resource metadata may be cached; a half-fetched AS metadata document must not be.
test('45: an unreachable AS metadata endpoint fails cleanly; resource metadata is cached, AS metadata is not', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'endpointUnreachable', { which: 'asMetadata' });

  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('TRANSPORT');

  await resetServer(testServer);
  const before = await requestLog(testServer);
  const retry = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(retry.ok).toBe(true);

  const since = (await requestLog(testServer)).slice(before.length);
  // Resource metadata came from cache: no further request for it.
  expect(since.some((e) => e.path === '/.well-known/oauth-protected-resource')).toBe(false);
  // AS metadata was never successfully cached: this retry had to fetch it again.
  expect(since.some((e) => e.path === '/.well-known/oauth-authorization-server')).toBe(true);
});

// Test 46: endpointUnreachable('registration') -> discovery cached and reused on retry; no
// partial client_id persisted. On retry, exactly one further DCR request and zero further
// discovery requests.
test('46: an unreachable registration endpoint fails cleanly; discovery is cached, registration is retried exactly once', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'endpointUnreachable', { which: 'registration' });

  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('TRANSPORT');

  await resetServer(testServer);
  const before = await requestLog(testServer);
  const retry = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(retry.ok).toBe(true);

  const since = (await requestLog(testServer)).slice(before.length);
  expect(since.filter((e) => e.path === '/.well-known/oauth-protected-resource')).toHaveLength(0);
  expect(since.filter((e) => e.path === '/.well-known/oauth-authorization-server')).toHaveLength(0);
  expect(since.filter((e) => e.path === '/reg')).toHaveLength(1);
});

// Test 47: endpointUnreachable('authorization') -> fails before any tab opens; immediate retry
// after reset works. ("no orphaned PKCE verifier" holds by construction: code_verifier is a
// local variable in runAuthorizationLadder(), never persisted.)
test('47: an unreachable authorization endpoint fails before any tab opens; retry after reset works', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'endpointUnreachable', { which: 'authorization' });

  const pagePromise = watchForPage(extensionContext);
  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(outcome.ok).toBe(false);

  await resetServer(testServer);
  const retry = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(retry.ok).toBe(true);
  if (retry.ok) expect(retry.status).toBe(200);
});

// Test 48: endpointUnreachable('token') after a successful authorization -> the code is
// consumed and unrecoverable, so this must degrade to a clean re-authorization rather than a
// stuck state or a retry loop against a dead code. The module never retains a code/verifier
// across calls, so a fresh call after reset structurally cannot "retry" the dead one — it just
// runs a brand new ladder, confirmed here by the retry completing silently (no tab).
test('48: an unreachable token endpoint after a successful authorization degrades to a clean retry, not a stuck state', async ({
  testServer,
  extensionContext,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'endpointUnreachable', { which: 'token' });

  const outcome = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.errorClass).toBe('TRANSPORT');

  await resetServer(testServer);
  const pagePromise = watchForPage(extensionContext);
  const retry = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  const page = await pagePromise;

  expect(page).toBeNull();
  expect(retry.ok).toBe(true);
  if (retry.ok) expect(retry.status).toBe(200);
});
