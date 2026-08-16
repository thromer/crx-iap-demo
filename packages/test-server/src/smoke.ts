import { createHash, randomBytes } from 'node:crypto';
import { startTestServer } from './index.ts';

// This script talks to a locally-generated, untrusted-by-default CA (see certs/generate.ts).
// The shipped iap-auth client never disables TLS verification; only this smoke harness does.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchNoRedirect(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'manual' });
}

async function controlScenario(
  controlOrigin: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(`${controlOrigin}/control/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...args }),
  });
  if (!res.ok) throw new Error(`scenario ${name} failed: ${res.status} ${await res.text()}`);
}

async function controlReset(controlOrigin: string): Promise<void> {
  const res = await fetch(`${controlOrigin}/control/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`reset failed: ${res.status}`);
}

async function main(): Promise<void> {
  const handle = await startTestServer();
  const { as, rsA, control } = handle.origins;
  console.log(`test-server up: as=${as} rsA=${rsA} control=${control}`);

  try {
    console.log('\n[happy path] RFC 8414 discovery');
    const asMeta = (await (
      await fetchNoRedirect(`${as}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    assert(asMeta['issuer'] === as, 'issuer matches AS origin');
    assert(typeof asMeta['registration_endpoint'] === 'string', 'registration_endpoint present');

    console.log('\n[happy path] RFC 9728 protected resource metadata');
    const rsMeta = (await (
      await fetchNoRedirect(`${rsA}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    assert(Array.isArray(rsMeta['authorization_servers']), 'authorization_servers present');
    assert(
      (rsMeta['authorization_servers'] as string[])[0] === as,
      'authorization_servers points at AS',
    );

    console.log('\n[happy path] initial request is challenged');
    const challenge = await fetchNoRedirect(`${rsA}/api/resource`);
    assert(challenge.status === 401, 'unauthenticated request gets 401');
    const wwwAuth = challenge.headers.get('www-authenticate') ?? '';
    assert(wwwAuth.includes('resource_metadata='), 'challenge carries resource_metadata');

    console.log('\n[happy path] dynamic client registration');
    const regRes = await fetch(`${as}/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://example.chromiumapp.org/cb'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    assert(
      regRes.status === 201 || regRes.status === 200,
      `registration succeeded (${regRes.status})`,
    );
    const client = (await regRes.json()) as { client_id: string };
    assert(typeof client.client_id === 'string', 'client_id issued');

    console.log('\n[happy path] PKCE authorization code flow');
    const verifier = base64url(randomBytes(32));
    const challengeValue = base64url(createHash('sha256').update(verifier).digest());
    const redirectUri = 'https://example.chromiumapp.org/cb';

    const authUrl = new URL(`${as}/auth`);
    authUrl.searchParams.set('client_id', client.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid offline_access');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('resource', rsA);
    authUrl.searchParams.set('code_challenge', challengeValue);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', 'smoke-state');

    let cookies: string[] = [];
    let res = await fetchNoRedirect(authUrl.toString());
    let location = res.headers.get('location');
    for (const raw of res.headers.getSetCookie?.() ?? []) cookies.push(raw.split(';')[0] ?? '');
    assert(res.status === 303 && !!location, 'authorize redirects to interaction');

    for (let hop = 0; hop < 5 && location && !location.startsWith(redirectUri); hop += 1) {
      const nextUrl = location.startsWith('http') ? location : `${as}${location}`;
      res = await fetchNoRedirect(nextUrl, { headers: { cookie: cookies.join('; ') } });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const pair = raw.split(';')[0] ?? '';
        const name = pair.split('=')[0];
        cookies = cookies.filter((c) => !c.startsWith(`${name}=`));
        cookies.push(pair);
      }
      location = res.headers.get('location');
    }
    assert(
      !!location && location.startsWith(redirectUri),
      'auto-approve completed silently, no HTML page rendered',
    );
    const code = new URL(location ?? '').searchParams.get('code');
    assert(!!code, 'authorization code issued');

    const tokenRes = await fetch(`${as}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: rsA,
      }),
    });
    assert(tokenRes.status === 200, `token exchange succeeded (${tokenRes.status})`);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    assert(typeof tokens.access_token === 'string', 'access_token issued');
    assert(
      typeof tokens.refresh_token === 'string',
      'refresh_token issued (prompt=consent honored)',
    );

    console.log('\n[happy path] access token authorizes the resource');
    const resourceRes = await fetch(`${rsA}/api/resource`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert(resourceRes.status === 200, 'authorized request succeeds');

    console.log('\n[happy path] refresh with resource indicator');
    const refreshRes = await fetch(`${as}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        resource: rsA,
      }),
    });
    assert(refreshRes.status === 200, 'refresh succeeded');
    const refreshed = (await refreshRes.json()) as { access_token: string };
    const refreshedRes = await fetch(`${rsA}/api/resource`, {
      headers: { authorization: `Bearer ${refreshed.access_token}` },
    });
    assert(refreshedRes.status === 200, 'refreshed access token authorizes the resource');

    console.log('\n[scenario] unprotected');
    await controlReset(control);
    await controlScenario(control, 'unprotected');
    const unprotectedRes = await fetch(`${rsA}/api/resource`);
    assert(
      unprotectedRes.status === 200,
      'unprotected resource returns 200 with no Authorization header',
    );

    console.log('\n[scenario] appLevel401(basic)');
    await controlReset(control);
    await controlScenario(control, 'appLevel401', { kind: 'basic' });
    const basicRes = await fetch(`${rsA}/api/resource`);
    assert(basicRes.status === 401, 'app-level 401 returned');
    assert(
      (basicRes.headers.get('www-authenticate') ?? '').startsWith('Basic'),
      'Basic challenge, not Bearer/IAP',
    );

    console.log('\n[scenario] rejectNextAccessToken (trust the 401 over local expiry)');
    await controlReset(control);
    await controlScenario(control, 'rejectNextAccessToken');
    const rejectedRes = await fetch(`${rsA}/api/resource`, {
      headers: { authorization: `Bearer ${refreshed.access_token}` },
    });
    assert(rejectedRes.status === 401, 'previously-valid token rejected once');
    assert(
      (rejectedRes.headers.get('www-authenticate') ?? '').includes('invalid_token'),
      'classified as invalid_token',
    );

    console.log('\n[scenario] issuerMismatch');
    await controlReset(control);
    await controlScenario(control, 'issuerMismatch');
    const mismatchMeta = (await (
      await fetch(`${as}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    assert(mismatchMeta['issuer'] !== as, 'issuer no longer matches AS origin (spoof simulated)');

    await controlReset(control);
    console.log('\nSMOKE TEST PASSED');
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
