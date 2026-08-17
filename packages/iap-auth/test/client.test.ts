import { Agent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServerHandle } from '../../test-server/src/index.ts';
import { createIapClient } from '../src/index.ts';
import { accessKey, refreshKey } from '../src/keys.ts';
import {
  createHttpAuthorizer,
  createLadderTestAuthorizer,
  FakeClock,
  inMemoryStore,
} from './fakes.ts';
import { armScenario, countRequests, resetServer } from './harness.ts';

const REDIRECT_URI = 'https://client.invalid/cb';

let server: TestServerHandle;

beforeAll(async () => {
  server = await startTestServer();
  setGlobalDispatcher(new Agent({ connect: { ca: server.caCertPem } }));
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetServer(server.origins.control);
});

function newClient(clock: FakeClock, authorizer = createHttpAuthorizer(REDIRECT_URI)) {
  const durable = inMemoryStore();
  const session = inMemoryStore();
  return {
    client: createIapClient({
      session,
      durable,
      authorizer,
      clock,
    }),
    durable,
    session,
  };
}

describe('authorization ladder', () => {
  it('escalates to interactive when the silent leg fails, and succeeds', async () => {
    const clock = new FakeClock();
    const authorizer = createLadderTestAuthorizer(createHttpAuthorizer(REDIRECT_URI));
    authorizer.failSilentOnce = true;
    const { client } = newClient(clock, authorizer);

    const { token, tokenId } = await client.getToken(server.origins.rsA);
    expect(token).toBeTruthy();
    expect(tokenId).toHaveLength(8);
  });

  it('does not escalate when the caller explicitly forbids interactive', async () => {
    const clock = new FakeClock();
    const authorizer = createLadderTestAuthorizer(createHttpAuthorizer(REDIRECT_URI));
    authorizer.failSilentOnce = true;
    const { client } = newClient(clock, authorizer);

    await expect(client.getToken(server.origins.rsA, { interactive: false })).rejects.toThrow(
      /no active session/,
    );
  });

  it('runs the interactive form when forceLogin is armed, then succeeds', async () => {
    await armScenario(server.origins.control, 'forceLogin');
    const clock = new FakeClock();
    const { client } = newClient(clock);

    const { token } = await client.getToken(server.origins.rsA);
    expect(token).toBeTruthy();
  });

  // Regression test: an access_denied redirect (the IdP authenticated the user but policy
  // denied) previously propagated as a raw, unclassified oauth4webapi error instead of
  // FORBIDDEN — see authorize.ts's validateAuthResponse try/catch.
  it('classifies an access_denied redirect as FORBIDDEN, not a generic failure', async () => {
    await armScenario(server.origins.control, 'denyAuthorization');
    const clock = new FakeClock();
    const { client } = newClient(clock);

    await expect(client.getToken(server.origins.rsA)).rejects.toMatchObject({
      class: 'FORBIDDEN',
    });
  });
});

describe('single-flight lock', () => {
  it('coalesces concurrent getToken calls on an expired token into one refresh', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    await client.getToken(server.origins.rsA); // establishes refresh token
    clock.advance(2 * 60 * 60 * 1000); // well past expiry + skew margin

    const before = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.getToken(server.origins.rsA)),
    );
    const after = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );

    expect(after - before).toBe(1);
    const tokenIds = new Set(results.map((r) => r.tokenId));
    expect(tokenIds.size).toBe(1);
  });

  it('does not block one resource on another', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    await Promise.all([client.getToken(server.origins.rsA), client.getToken(server.origins.rsB)]);
    clock.advance(2 * 60 * 60 * 1000);

    const before = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );

    await Promise.all([
      ...Array.from({ length: 5 }, () => client.getToken(server.origins.rsA)),
      ...Array.from({ length: 5 }, () => client.getToken(server.origins.rsB)),
    ]);

    const after = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );
    expect(after - before).toBe(2);
  });
});

describe('idempotent reportRejected', () => {
  it('ten concurrent reports of the same tokenId produce exactly one refresh', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    const { tokenId } = await client.getToken(server.origins.rsA);

    const before = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );
    await Promise.all(
      Array.from({ length: 10 }, () => client.reportRejected(server.origins.rsA, tokenId)),
    );
    const after = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );

    expect(after - before).toBe(1);
  });

  it('a report naming an already-superseded tokenId is a no-op', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    const { tokenId: staleTokenId } = await client.getToken(server.origins.rsA);
    await client.reportRejected(server.origins.rsA, staleTokenId); // refreshes once, supersedes staleTokenId

    const before = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );
    await client.reportRejected(server.origins.rsA, staleTokenId); // stale again — must no-op
    const after = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token',
    );

    expect(after - before).toBe(0);
  });
});

describe('onTokenChanged ordering', () => {
  it('awaits listeners before getToken resolves', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    let listenerFinished = false;
    const unsubscribe = client.onTokenChanged(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      listenerFinished = true;
    });

    await client.getToken(server.origins.rsA);
    expect(listenerFinished).toBe(true);
    unsubscribe();
  });

  it('fires with token === null when reportRejected invalidates with no replacement yet', async () => {
    await armScenario(server.origins.control, 'invalidGrantOnNextRefresh');
    await armScenario(server.origins.control, 'forceLogin');
    const clock = new FakeClock();
    const { client } = newClient(clock);

    const { tokenId } = await client.getToken(server.origins.rsA);

    const seenTokens: Array<string | null> = [];
    const unsubscribe = client.onTokenChanged((_resource, token) => {
      seenTokens.push(token);
    });

    await client.reportRejected(server.origins.rsA, tokenId);

    expect(seenTokens[0]).toBeNull(); // invalidated immediately
    expect(seenTokens.at(-1)).not.toBeNull(); // ladder recovered with a fresh token
    unsubscribe();
  });
});

describe('rotation handling', () => {
  it('persists a rotated refresh token and can refresh again with it', async () => {
    await armScenario(server.origins.control, 'rotateRefreshTokens', { on: true });
    const clock = new FakeClock();
    const { client, durable } = newClient(clock);

    await client.getToken(server.origins.rsA);
    const firstRefreshToken = await durable.get(`refresh:${server.origins.rsA}`);

    clock.advance(2 * 60 * 60 * 1000);
    await client.getToken(server.origins.rsA);
    const secondRefreshToken = await durable.get(`refresh:${server.origins.rsA}`);

    expect(secondRefreshToken).not.toBe(firstRefreshToken);

    clock.advance(2 * 60 * 60 * 1000);
    await expect(client.getToken(server.origins.rsA)).resolves.toBeTruthy();
  });

  it('keeps the existing refresh token when the AS omits one on refresh', async () => {
    await armScenario(server.origins.control, 'omitRefreshTokenOnRefresh');
    const clock = new FakeClock();
    const { client, durable } = newClient(clock);

    await client.getToken(server.origins.rsA);
    const firstRefreshToken = await durable.get(`refresh:${server.origins.rsA}`);

    clock.advance(2 * 60 * 60 * 1000);
    await client.getToken(server.origins.rsA);
    const secondRefreshToken = await durable.get(`refresh:${server.origins.rsA}`);

    expect(secondRefreshToken).toBe(firstRefreshToken);
  });
});

describe('the obtained token actually authorizes the resource', () => {
  // A token endpoint returning 200 with a syntactically valid access_token is not proof the
  // token is USABLE — a wrong audience, wrong scope, etc. would still show up here as a 401
  // from the resource server. Assert against the RS directly rather than only against
  // internal state, or a bug like this can hide behind every other test in this file.
  it('a fresh token from getToken() is accepted by the resource server', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    await client.getToken(server.origins.rsA);
    const response = await client.fetch(`${server.origins.rsA}/api/resource`);

    expect(response.status).toBe(200);
  });

  it('a refreshed token is also accepted by the resource server', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    await client.getToken(server.origins.rsA);
    clock.advance(2 * 60 * 60 * 1000);
    await client.getToken(server.origins.rsA); // forces a refresh

    const response = await client.fetch(`${server.origins.rsA}/api/resource`);
    expect(response.status).toBe(200);
  });
});

describe('replayable request bodies', () => {
  // Test 50 of PROMPT.md's e2e matrix ("ReadableStream body -> rejected up front with a clear
  // error, not silently retried with a consumed stream") cannot be driven through
  // packages/e2e: the extension's SW message protocol only carries a string body
  // (FetchOpts.body: string — see packages/extension/src/shared/messages.ts), since a live
  // ReadableStream can't cross a chrome.runtime.sendMessage boundary via structured clone
  // anyway. That's Component A's own contract, so it belongs here.
  it('rejects a ReadableStream body up front with a clear error', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);
    const stream = new ReadableStream();

    await expect(
      client.fetch(`${server.origins.rsA}/api/resource`, { method: 'POST', body: stream }),
    ).rejects.toMatchObject({ class: 'MISCONFIGURED' });
  });
});

describe('transport classification on fetch()', () => {
  // Regression test: fetch()'s own request to the resource server previously let a raw
  // fetch-level TypeError (offline, connection refused, DNS, TLS) escape unwrapped, so it
  // never reached toIapError and was misclassified as UNKNOWN rather than TRANSPORT by callers
  // that only recognize IapError. Caught via the e2e suite's offline test (packages/e2e's
  // transport.spec.ts, test 40) before this regression test existed.
  it('a connection failure on the resource request itself classifies as TRANSPORT', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    await expect(client.fetch('https://localhost:1/api/resource')).rejects.toMatchObject({
      class: 'TRANSPORT',
    });
  });
});

describe('logout()', () => {
  // Checkpoint-3 review, Task 4: a revocation that succeeds must be distinguishable from one
  // that was attempted and failed — both clear local state and resolve without throwing, but
  // only a confirmed revocation reports revoked: true.
  it('revokes at the AS and reports revoked: true', async () => {
    const clock = new FakeClock();
    const { client, durable, session } = newClient(clock);
    await client.getToken(server.origins.rsA);

    const before = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token/revocation',
    );
    const result = await client.logout(server.origins.rsA);
    const after = await countRequests(
      server.origins.control,
      (e) => e.server === 'as' && e.path === '/token/revocation',
    );

    expect(result).toEqual({ revoked: true });
    expect(after - before).toBe(1);

    // Local state cleared: no access token cached, no refresh token to fall back on. (Not
    // asserted via a subsequent getToken() call: the fake HTTP authorizer used in this suite
    // doesn't distinguish interactive from non-interactive — unlike a real browser, it always
    // completes the flow — so a post-logout getToken() would silently re-authorize rather than
    // reveal a cleared state.)
    expect(await session.get(accessKey(server.origins.rsA))).toBeUndefined();
    expect(await durable.get(refreshKey(server.origins.rsA))).toBeUndefined();
  });

  // Missing from the original scenario registry — added for this test (see
  // packages/test-server's state.ts/control.ts/as.ts: UnreachableEndpoint now includes
  // 'revocation').
  it('a failed revocation attempt still clears local state, resolves, and reports revoked: false', async () => {
    const clock = new FakeClock();
    const { client, durable, session } = newClient(clock);
    await client.getToken(server.origins.rsA);

    await armScenario(server.origins.control, 'endpointUnreachable', { which: 'revocation' });
    const result = await client.logout(server.origins.rsA);

    expect(result).toEqual({ revoked: false });
    expect(await session.get(accessKey(server.origins.rsA))).toBeUndefined();
    expect(await durable.get(refreshKey(server.origins.rsA))).toBeUndefined();
  });

  it('a resource never logged in to has no revocation_endpoint call and reports revoked: false', async () => {
    const clock = new FakeClock();
    const { client } = newClient(clock);

    const result = await client.logout(server.origins.rsA);
    expect(result).toEqual({ revoked: false });
  });
});
