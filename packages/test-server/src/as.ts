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

  // A grant for the decoy client, whose resulting code is then handed to the real
  // client's redirect_uri: the code-injection attack RFC 9700 / PKCE defends against.
  const decoyGrant = new provider.Grant({ accountId: TEST_ACCOUNT_ID, clientId: DECOY_CLIENT_ID });
  decoyGrant.addOIDCScope('openid');
  const grantId = await decoyGrant.save();

  const codeChallenge = interaction.params['code_challenge'];
  const codeChallengeMethod = interaction.params['code_challenge_method'];
  const code = new provider.AuthorizationCode({
    accountId: TEST_ACCOUNT_ID,
    client: decoyClient,
    codeChallenge: typeof codeChallenge === 'string' ? codeChallenge : undefined,
    codeChallengeMethod: typeof codeChallengeMethod === 'string' ? codeChallengeMethod : undefined,
    expiresWithSession: true,
    grantId,
    redirectUri,
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
