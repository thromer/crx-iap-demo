import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import Provider, { type Configuration, type InteractionDetails } from 'oidc-provider';
import type { GeneratedCertificates } from './certs/generate.ts';
import { ORIGINS } from './config.ts';
import { delay, readRawBody, replayableRequest, sendJson, sendMalformed } from './http.ts';
import type { TokenValidation, TokenValidator } from './rs.ts';
import { state } from './state.ts';

const TEST_ACCOUNT_ID = 'test-user';
// Registered statically so injectForeignCode has a real, distinct client to mint a code for.
const DECOY_CLIENT_ID = 'decoy-client';

const ROUTES = {
  authorization: '/auth',
  token: '/token',
  registration: '/reg',
  revocation: '/token/revocation',
} as const;

const RFC8414_PATH = '/.well-known/oauth-authorization-server';
const INTERACTION_GET = /^\/interaction\/([^/]+)$/;
const INTERACTION_SUBMIT = /^\/interaction\/([^/]+)\/submit$/;

function buildConfiguration(): Configuration {
  return {
    clients: [
      {
        client_id: DECOY_CLIENT_ID,
        token_endpoint_auth_method: 'none',
        redirect_uris: ['https://decoy.invalid/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      },
    ],
    scopes: ['openid', 'offline_access'],
    findAccount: async (_ctx, sub) => ({
      accountId: sub,
      claims: async () => ({ sub }),
    }),
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, initialAccessToken: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => undefined,
        getResourceServerInfo: async () => ({
          scope: 'openid offline_access',
        }),
      },
    },
    ttl: {
      AccessToken: () => state.scenarios.shortLivedTokensSeconds ?? 3600,
    },
    rotateRefreshToken: () => state.scenarios.rotateRefreshTokens,
    // A native-app client (RFC 8252) exchanges its code from its own origin — for a Chrome
    // extension, chrome-extension://<id> — not from a page at the redirect_uri's origin, so
    // oidc-provider's default heuristic (matching Origin against registered redirect_uris)
    // never allows it. Any origin is fine for a public client on a test double.
    clientBasedCORS: () => true,
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
  };
}

export function createTokenValidator(provider: Provider): TokenValidator {
  return {
    async validate(token: string, resource: string): Promise<TokenValidation> {
      const accessToken = await provider.AccessToken.find(token);
      if (!accessToken || accessToken.isExpired) {
        return { ok: false, reason: 'invalid_token' };
      }
      if (accessToken.aud !== resource) {
        return { ok: false, reason: 'wrong_audience' };
      }
      return { ok: true };
    },
  };
}

function unreachableTargetForPath(
  pathname: string,
): 'asMetadata' | 'registration' | 'authorization' | 'revocation' | undefined {
  if (pathname === RFC8414_PATH) return 'asMetadata';
  if (pathname === ROUTES.registration) return 'registration';
  if (pathname === ROUTES.authorization) return 'authorization';
  if (pathname === ROUTES.revocation) return 'revocation';
  return undefined;
}

function serveRfc8414Metadata(res: ServerResponse): void {
  const malformed = state.scenarios.malformedMetadata;
  if (malformed && malformed.target === 'asMetadata') {
    sendMalformed(res, malformed.kind);
    return;
  }

  const issuer = state.scenarios.issuerMismatch ? 'https://issuer-mismatch.invalid' : ORIGINS.as;
  const doc: Record<string, unknown> = {
    issuer,
    authorization_endpoint: `${ORIGINS.as}${ROUTES.authorization}`,
    token_endpoint: `${ORIGINS.as}${ROUTES.token}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
  if (!state.scenarios.noRevocationEndpoint) {
    doc['revocation_endpoint'] = `${ORIGINS.as}${ROUTES.revocation}`;
  }
  if (!state.scenarios.noRegistrationEndpoint) {
    doc['registration_endpoint'] = `${ORIGINS.as}${ROUTES.registration}`;
  }
  sendJson(res, 200, doc);
}

async function handleTokenEndpoint(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const bodyBuf = await readRawBody(req);
  const params = new URLSearchParams(bodyBuf.toString('utf8'));
  const grantType = params.get('grant_type');

  const status = state.scenarios.tokenEndpointStatus;
  if (status) {
    const headers: Record<string, string> = {};
    if (status.retryAfter !== undefined) headers['retry-after'] = String(status.retryAfter);
    res.writeHead(status.code, { ...headers, 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'server_error', error_description: 'scenario: tokenEndpointStatus' }),
    );
    return;
  }

  if (state.scenarios.tokenEndpointHangSeconds !== undefined) {
    await delay(state.scenarios.tokenEndpointHangSeconds);
  }

  if (grantType === 'authorization_code') {
    if (state.scenarios.rejectCodeExchange) {
      state.scenarios.rejectCodeExchange = false;
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'scenario: rejectCodeExchange',
      });
      return;
    }
  }

  if (grantType === 'refresh_token') {
    if (state.scenarios.invalidGrantOnNextRefresh) {
      state.scenarios.invalidGrantOnNextRefresh = false;
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'scenario: invalidGrantOnNextRefresh',
      });
      return;
    }
    if (state.scenarios.revokeGrant) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'scenario: revokeGrant' });
      return;
    }
  }

  provider.callback()(replayableRequest(req, bodyBuf), res);
}

async function finishInteraction(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  interaction: InteractionDetails,
): Promise<void> {
  const clientId = interaction.params['client_id'];
  if (typeof clientId !== 'string') throw new Error('interaction missing client_id');

  const grant = new provider.Grant({ accountId: TEST_ACCOUNT_ID, clientId });
  grant.addOIDCScope('openid offline_access');

  const resourceParam = interaction.params['resource'];
  const resources = Array.isArray(resourceParam)
    ? resourceParam
    : typeof resourceParam === 'string'
      ? [resourceParam]
      : [];
  for (const resource of resources) {
    grant.addResourceScope(resource, 'openid offline_access');
  }

  const grantId = await grant.save();

  await provider.interactionFinished(
    req,
    res,
    { login: { accountId: TEST_ACCOUNT_ID }, consent: { grantId } },
    { mergeWithLastSubmission: false },
  );
}

async function injectForeignCode(
  provider: Provider,
  res: ServerResponse,
  interaction: InteractionDetails,
): Promise<void> {
  const decoyClient = await provider.Client.find(DECOY_CLIENT_ID);
  if (!decoyClient) throw new Error('decoy client not registered');

  const clientId = interaction.params['client_id'];
  if (typeof clientId !== 'string') throw new Error('interaction missing client_id');
  const redirectUri = interaction.params['redirect_uri'];
  if (typeof redirectUri !== 'string') throw new Error('interaction missing redirect_uri');
  const resourceParam = interaction.params['resource'];
  if (typeof resourceParam !== 'string') throw new Error('interaction missing resource');

  // A grant for the decoy client, whose resulting code is then handed to the real client's
  // redirect_uri: the code-injection attack RFC 9700 defends against. Deliberately bound to
  // *this* interaction's own code_challenge (the real client's own PKCE value for this
  // attempt), not a mismatched one — verified by tracing oidc-provider's own token-endpoint
  // handler (packages/test-server, checkpoint-3 review, Task 12): findGrantSource() and
  // validateGrant() both check the code/grant's clientId against the presenting client before
  // checkPKCE() ever runs, so a decoy-client code is rejected on client-identity binding,
  // structurally before PKCE verification is reached at all. That's still a real, correct
  // RFC 9700 defense — code binding to the client that requested it — just not the same one
  // PKCE (code_verifier matching) provides; the two are complementary defenses against
  // adjacent attacks, and this scenario exercises the former.
  const decoyGrant = new provider.Grant({ accountId: TEST_ACCOUNT_ID, clientId: DECOY_CLIENT_ID });
  decoyGrant.addOIDCScope('openid');
  decoyGrant.addResourceScope(resourceParam, 'openid');
  const grantId = await decoyGrant.save();

  const codeChallenge = interaction.params['code_challenge'];
  const codeChallengeMethod = interaction.params['code_challenge_method'];
  const code = new provider.AuthorizationCode({
    accountId: TEST_ACCOUNT_ID,
    client: decoyClient,
    codeChallenge: typeof codeChallenge === 'string' ? codeChallenge : undefined,
    codeChallengeMethod: typeof codeChallengeMethod === 'string' ? codeChallengeMethod : undefined,
    grantId,
    redirectUri,
    resource: resourceParam,
    scope: 'openid',
  });
  const codeValue = await code.save();

  const target = new URL(redirectUri);
  target.searchParams.set('code', codeValue);
  const stateParam = interaction.params['state'];
  if (typeof stateParam === 'string') target.searchParams.set('state', stateParam);
  res.writeHead(302, { location: target.toString() });
  res.end();
}

// Checkpoint-3 review, Task 12: shared by tamperState and reissuePreviousCode, both of which
// need to mint a real, correctly-bound authorization code for the actual client (unlike
// injectForeignCode's decoy grant) so that the property under test is isolated to what each
// scenario deliberately corrupts afterward — the state value or the code's reuse — not PKCE
// binding, which stays correct here.
async function mintRealCode(
  provider: Provider,
  interaction: InteractionDetails,
): Promise<{ codeValue: string; redirectUri: string }> {
  const clientId = interaction.params['client_id'];
  if (typeof clientId !== 'string') throw new Error('interaction missing client_id');
  const client = await provider.Client.find(clientId);
  if (!client) throw new Error('client not registered');
  const redirectUri = interaction.params['redirect_uri'];
  if (typeof redirectUri !== 'string') throw new Error('interaction missing redirect_uri');

  const resourceParam = interaction.params['resource'];
  if (typeof resourceParam !== 'string') throw new Error('interaction missing resource');

  const grant = new provider.Grant({ accountId: TEST_ACCOUNT_ID, clientId });
  grant.addOIDCScope('openid offline_access');
  grant.addResourceScope(resourceParam, 'openid offline_access');
  const grantId = await grant.save();

  const codeChallenge = interaction.params['code_challenge'];
  const codeChallengeMethod = interaction.params['code_challenge_method'];
  const code = new provider.AuthorizationCode({
    accountId: TEST_ACCOUNT_ID,
    client,
    codeChallenge: typeof codeChallenge === 'string' ? codeChallenge : undefined,
    codeChallengeMethod: typeof codeChallengeMethod === 'string' ? codeChallengeMethod : undefined,
    grantId,
    redirectUri,
    resource: resourceParam,
    scope: 'openid offline_access',
  });
  const codeValue = await code.save();
  return { codeValue, redirectUri };
}

// Test 29: the AS rewrites `state` in the redirect before returning it — the client's own
// `state` was never touched, so `validateAuthResponse` must reject the mismatch before any
// token request is ever issued.
async function tamperState(
  provider: Provider,
  res: ServerResponse,
  interaction: InteractionDetails,
): Promise<void> {
  const { codeValue, redirectUri } = await mintRealCode(provider, interaction);
  const target = new URL(redirectUri);
  target.searchParams.set('code', codeValue);
  target.searchParams.set('state', 'tampered-state-value');
  res.writeHead(302, { location: target.toString() });
  res.end();
}

// Test 31: the first interaction under this scenario mints and remembers a real code; every
// subsequent one reuses it instead of minting fresh, with *this* request's own `state` (so
// state validation passes and the failure is isolated to the code itself). Whether the token
// endpoint ultimately rejects it as already-consumed (node-oidc-provider's single-use
// enforcement) or as a PKCE mismatch against this request's own fresh code_verifier is not
// distinguished here — either is a correct rejection of a replayed code, which is the only
// property being asserted.
async function reissuePreviousCode(
  provider: Provider,
  res: ServerResponse,
  interaction: InteractionDetails,
): Promise<void> {
  const redirectUriParam = interaction.params['redirect_uri'];
  if (typeof redirectUriParam !== 'string') throw new Error('interaction missing redirect_uri');

  let codeValue = state.reissuedCode;
  if (!codeValue) {
    const minted = await mintRealCode(provider, interaction);
    codeValue = minted.codeValue;
    state.reissuedCode = codeValue;
  }

  const target = new URL(redirectUriParam);
  target.searchParams.set('code', codeValue);
  const stateParam = interaction.params['state'];
  if (typeof stateParam === 'string') target.searchParams.set('state', stateParam);
  res.writeHead(302, { location: target.toString() });
  res.end();
}

function renderApproveForm(uid: string): string {
  return `<!doctype html>
<html>
  <head><title>Sign in</title></head>
  <body>
    <form method="post" action="/interaction/${uid}/submit">
      <button type="submit" id="approve">Approve</button>
    </form>
  </body>
</html>`;
}

async function handleInteractionGet(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const interaction = await provider.interactionDetails(req, res);

  if (state.scenarios.stallAuthorizationSeconds !== undefined) {
    await delay(state.scenarios.stallAuthorizationSeconds);
  }

  if (state.scenarios.denyAuthorization) {
    await provider.interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'denied by test scenario' },
      { mergeWithLastSubmission: false },
    );
    return;
  }

  if (state.scenarios.injectForeignCode) {
    await injectForeignCode(provider, res, interaction);
    return;
  }

  if (state.scenarios.tamperState) {
    await tamperState(provider, res, interaction);
    return;
  }

  if (state.scenarios.reissuePreviousCode) {
    await reissuePreviousCode(provider, res, interaction);
    return;
  }

  if (state.scenarios.forceLogin) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(renderApproveForm(interaction.uid));
    return;
  }

  await finishInteraction(provider, req, res, interaction);
}

async function handleInteractionSubmit(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const interaction = await provider.interactionDetails(req, res);
  await finishInteraction(provider, req, res, interaction);
}

export function createAuthorizationServer(cert: GeneratedCertificates): {
  provider: Provider;
  server: https.Server;
} {
  const provider = new Provider(ORIGINS.as, buildConfiguration());

  const server = https.createServer(
    { cert: cert.leafCertPem, key: cert.leafKeyPem },
    (req, res) => {
      void handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${String(err)}`);
      });
    },
  );

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', ORIGINS.as);
    const authHeader = req.headers.authorization;

    state.logRequest({
      server: 'as',
      method: req.method ?? 'GET',
      origin: ORIGINS.as,
      path: url.pathname,
      hadAuthorizationHeader: authHeader !== undefined,
    });

    const unreachableTarget = unreachableTargetForPath(url.pathname);
    if (unreachableTarget && state.scenarios.unreachable.has(unreachableTarget)) {
      req.socket.destroy();
      return;
    }
    if (url.pathname === ROUTES.token && state.scenarios.unreachable.has('token')) {
      req.socket.destroy();
      return;
    }

    if (url.pathname === RFC8414_PATH) {
      serveRfc8414Metadata(res);
      return;
    }

    const getMatch = req.method === 'GET' ? INTERACTION_GET.exec(url.pathname) : null;
    if (getMatch) {
      await handleInteractionGet(provider, req, res);
      return;
    }
    const submitMatch = req.method === 'POST' ? INTERACTION_SUBMIT.exec(url.pathname) : null;
    if (submitMatch) {
      await handleInteractionSubmit(provider, req, res);
      return;
    }

    if (url.pathname === ROUTES.token && req.method === 'POST') {
      await handleTokenEndpoint(provider, req, res);
      return;
    }

    provider.callback()(req, res);
  }

  return { provider, server };
}
