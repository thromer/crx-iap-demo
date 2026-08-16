import https from 'node:https';
import type { GeneratedCertificates } from './certs/generate.ts';
import { ORIGINS } from './config.ts';
import { sendJson, sendMalformed } from './http.ts';
import { state } from './state.ts';

export type TokenValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid_token' | 'wrong_audience' };

export interface TokenValidator {
  validate(token: string, resource: string): Promise<TokenValidation>;
}

const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

function wwwAuthenticateBearer(resourceMetadataUrl: string, extra?: string): string {
  const params = [`resource_metadata="${resourceMetadataUrl}"`];
  if (extra) params.push(extra);
  return `Bearer ${params.join(', ')}`;
}

export function createResourceServer(
  name: 'rs-a' | 'rs-b',
  origin: string,
  cert: GeneratedCertificates,
  tokens: TokenValidator,
  asOrigin: string,
): https.Server {
  const server = https.createServer(
    { cert: cert.leafCertPem, key: cert.leafKeyPem },
    (req, res) => {
      void handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${String(err)}`);
      });
    },
  );

  async function handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const authHeader = req.headers.authorization;

    state.logRequest({
      server: name,
      method: req.method ?? 'GET',
      origin,
      path: url.pathname,
      hadAuthorizationHeader: authHeader !== undefined,
    });

    if (
      url.pathname === PROTECTED_RESOURCE_METADATA_PATH &&
      state.scenarios.unreachable.has('resourceMetadata')
    ) {
      req.socket.destroy();
      return;
    }

    if (url.pathname === PROTECTED_RESOURCE_METADATA_PATH) {
      handleProtectedResourceMetadata(res, origin, asOrigin);
      return;
    }

    // Everything else is treated as "the protected resource".
    await handleResource(req, res, url, origin, authHeader, tokens);
  }

  return server;
}

function handleProtectedResourceMetadata(
  res: import('node:http').ServerResponse,
  origin: string,
  asOrigin: string,
): void {
  const malformed = state.scenarios.malformedMetadata;
  if (malformed && malformed.target === 'resourceMetadata') {
    sendMalformed(res, malformed.kind);
    return;
  }

  let authorizationServers: string[];
  if (state.scenarios.emptyAuthorizationServers) {
    authorizationServers = [];
  } else if (state.scenarios.multipleAuthorizationServers) {
    authorizationServers = [asOrigin, `${asOrigin.replace('localhost', '127.0.0.1')}`];
  } else {
    authorizationServers = [asOrigin];
  }

  sendJson(res, 200, {
    resource: origin,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ['header'],
  });
}

async function handleResource(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: URL,
  origin: string,
  authHeader: string | undefined,
  tokens: TokenValidator,
): Promise<void> {
  const scenarios = state.scenarios;
  const resourceMetadataUrl = `${origin}${PROTECTED_RESOURCE_METADATA_PATH}`;

  if (scenarios.unprotected) {
    sendJson(res, 200, { ok: true, resource: origin });
    return;
  }

  if (scenarios.appLevel403) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden by application' }));
    return;
  }

  if (scenarios.appLevel401) {
    const kind = scenarios.appLevel401;
    if (kind === 'basic') {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="app"',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    } else if (kind === 'bare') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_credentials', message: 'application-level 401' }));
    }
    return;
  }

  if (scenarios.redirectToLoginPage) {
    res.writeHead(302, { location: `${origin}/login.html` });
    res.end();
    return;
  }

  if (scenarios.redirectToForeignOrigin) {
    const foreign = origin === ORIGINS.rsA ? ORIGINS.rsB : ORIGINS.rsA;
    res.writeHead(302, { location: `${foreign}${url.pathname}` });
    res.end();
    return;
  }

  const challengeMetadataUrl = scenarios.crossOriginResourceMetadata
    ? `https://example.invalid${PROTECTED_RESOURCE_METADATA_PATH}`
    : resourceMetadataUrl;

  if (!authHeader) {
    if (scenarios.challengeWithoutMetadata) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' });
      res.end();
      return;
    }
    res.writeHead(401, { 'www-authenticate': wwwAuthenticateBearer(challengeMetadataUrl) });
    res.end();
    return;
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  const forceReject = scenarios.rejectNextAccessToken || scenarios.revokeGrant;
  if (scenarios.rejectNextAccessToken) scenarios.rejectNextAccessToken = false;

  const validation = forceReject
    ? ({ ok: false, reason: 'invalid_token' } as const)
    : await tokens.validate(token, origin);

  if (!validation.ok) {
    res.writeHead(401, {
      'www-authenticate': wwwAuthenticateBearer(
        challengeMetadataUrl,
        `error="invalid_token", error_description="${validation.reason}"`,
      ),
    });
    res.end();
    return;
  }

  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) bodyChunks.push(chunk as Buffer);
  const echoedBody = Buffer.concat(bodyChunks).toString('utf8');

  sendJson(res, 200, { ok: true, resource: origin, path: url.pathname, echoedBody });
}
