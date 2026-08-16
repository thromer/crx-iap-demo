import type {
  ActionOutcome,
  CurrentTokenIdOutcome,
  FetchOutcome,
} from '../../extension/src/shared/messages.ts';
import {
  armScenario,
  currentTokenId,
  establishToken,
  expect,
  requestLog,
  test,
} from '../src/fixtures.ts';

// Test 51: logout calls the revocation endpoint, clears local state, next request prompts (in
// this test-server, autoApprove is the default, so "prompts" means "runs a full fresh
// authorization ladder again" rather than reusing a refresh token — confirmed via request log,
// since a real visible tab only appears under forceLogin).
test('51: logout revokes at the AS and clears local state; the next request re-authorizes', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await establishToken(driver, origin);
  expect(await currentTokenId(driver, origin)).not.toBeNull();

  const before = await requestLog(testServer);
  const outcome = await driver.send<ActionOutcome>({ type: 'logout', resource: origin });
  expect(outcome.ok).toBe(true);

  const since = (await requestLog(testServer)).slice(before.length);
  expect(since.some((e) => e.server === 'as' && e.path === '/token/revocation')).toBe(true);
  expect(await currentTokenId(driver, origin)).toBeNull();

  const afterLogout = await requestLog(testServer);
  const next = await driver.send<FetchOutcome>({
    type: 'fetch',
    resource: `${origin}/api/resource`,
  });
  expect(next.ok).toBe(true);
  if (next.ok) expect(next.status).toBe(200);

  const sinceLogout = (await requestLog(testServer)).slice(afterLogout.length);
  // A fresh authorization_code exchange, not a refresh — there's no refresh token left.
  expect(sinceLogout.some((e) => e.server === 'as' && e.path === '/auth')).toBe(true);
});

// Test 52: logout against an AS with no revocation_endpoint -> resolves cleanly, clears state,
// no throw.
test('52: logout against an AS with no revocation_endpoint resolves cleanly and clears state', async ({
  testServer,
  driver,
}) => {
  const origin = testServer.origins.rsA;
  await armScenario(testServer, 'noRevocationEndpoint');
  await establishToken(driver, origin);
  expect(await currentTokenId(driver, origin)).not.toBeNull();

  const before = await requestLog(testServer);
  const outcome = await driver.send<ActionOutcome>({ type: 'logout', resource: origin });
  expect(outcome.ok).toBe(true);

  const since = (await requestLog(testServer)).slice(before.length);
  expect(since.some((e) => e.path === '/token/revocation')).toBe(false);

  const tokenId = await driver.send<CurrentTokenIdOutcome>({
    type: 'currentTokenId',
    resource: origin,
  });
  expect(tokenId.tokenId).toBeNull();
});
