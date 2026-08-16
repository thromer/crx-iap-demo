import * as oauth from 'oauth4webapi';
import { toIapError } from './errors.ts';
import { requestSignal, withTransportRetry } from './net.ts';
import type { Authorizer, Logger } from './types.ts';
import { IapError } from './types.ts';

const SCOPE = 'openid offline_access';

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | undefined;
}

function isTransport(err: unknown): boolean {
  return toIapError(err, '').class === 'TRANSPORT';
}

function retryAfterMs(err: unknown): number | undefined {
  // The attempt closures below wrap every non-invalid_grant failure through toIapError before
  // it reaches withTransportRetry, so by the time it gets here `err` is usually an IapError
  // with the original oauth.ResponseBodyError as its `.cause` — checking `err instanceof
  // oauth.ResponseBodyError` directly silently never matched, and Retry-After was never
  // honored, always falling back to the fixed backoff instead.
  const responseBodyError =
    err instanceof oauth.ResponseBodyError
      ? err
      : err instanceof IapError && err.cause instanceof oauth.ResponseBodyError
        ? err.cause
        : undefined;
  if (!responseBodyError) return undefined;
  const header = responseBodyError.response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return undefined;
}

/**
 * Runs the authorization ladder: silent first, interactive only if the caller has not
 * explicitly forbidden it. Lives here, in exactly one place, so the extension's authorizer
 * adapter can stay a dumb single-shot wrapper over launchWebAuthFlow.
 */
export async function runAuthorizationLadder(
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  resource: string,
  authorizer: Authorizer,
  logger: Logger,
  correlationId: string,
  opts: { interactive?: boolean } | undefined,
): Promise<TokenResult> {
  if (!as.authorization_endpoint) {
    throw new IapError(
      'MISCONFIGURED',
      `authorization server ${as.issuer} has no authorization_endpoint`,
    );
  }

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const state = oauth.generateRandomState();
  const redirectUri = authorizer.redirectUri();

  const authUrl = new URL(as.authorization_endpoint);
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('resource', resource);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  // offline_access only yields a refresh_token when the AS sees an explicit consent prompt.
  authUrl.searchParams.set('prompt', 'consent');

  const allowInteractive = opts?.interactive !== false;

  let redirectUrl: string;
  try {
    logger.debug('pkce', 'launching authorizer (silent)', { resource, correlationId });
    redirectUrl = await authorizer.authorize(authUrl.toString(), { interactive: false });
  } catch (silentErr) {
    if (!allowInteractive) {
      logger.warn('pkce', 'silent authorization failed, interactive not permitted', {
        resource,
        correlationId,
      });
      throw silentErr;
    }
    logger.debug('pkce', 'silent authorization failed, escalating to interactive', {
      resource,
      correlationId,
    });
    redirectUrl = await authorizer.authorize(authUrl.toString(), { interactive: true });
  }

  // Unclassified until now: an access_denied redirect (the IdP authenticated the user but
  // policy denied) or a validation failure (tampered state, injected foreign code) both threw
  // here as a raw oauth4webapi error, propagating past classify() as UNKNOWN instead of
  // FORBIDDEN/MISCONFIGURED. access_denied is specifically NOT a generic misconfiguration —
  // PROMPT.md's classification table requires it distinguishable from an authentication
  // failure, and callers must never retry or prompt again for either case.
  let callbackParams: URLSearchParams;
  try {
    callbackParams = oauth.validateAuthResponse(as, client, new URL(redirectUrl), state);
  } catch (err) {
    if (err instanceof oauth.AuthorizationResponseError && err.error === 'access_denied') {
      logger.info('classify', 'FORBIDDEN: access_denied on the authorization redirect', {
        resource,
        correlationId,
      });
      throw new IapError(
        'FORBIDDEN',
        `authorization denied by policy: ${err.error_description ?? err.error}`,
      );
    }
    logger.error('classify', 'MISCONFIGURED: authorization response validation failed', {
      resource,
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw toIapError(err, 'authorization response validation');
  }

  logger.debug('token', 'exchanging authorization code', { resource, correlationId });
  const tokenResponse = await withTransportRetry(
    logger,
    'token',
    correlationId,
    isTransport,
    retryAfterMs,
    async () => {
      let response: Response;
      try {
        response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          oauth.None(),
          callbackParams,
          redirectUri,
          codeVerifier,
          // RFC 8707: resending `resource` at the token request is what lets the AS bind the
          // audience even when scope also includes `openid` — without it, oidc-provider (and
          // likely others) may fall back to resolving no resource at all, minting a
          // token whose audience doesn't match any resource server.
          { signal: requestSignal(), additionalParameters: { resource } },
        );
      } catch (err) {
        throw toIapError(err, 'authorization code exchange');
      }
      try {
        return await oauth.processAuthorizationCodeResponse(as, client, response, {
          expectedNonce: oauth.expectNoNonce,
        });
      } catch (err) {
        throw toIapError(err, 'authorization code exchange');
      }
    },
  );

  return toTokenResult(tokenResponse);
}

export async function refreshAccessToken(
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  refreshToken: string,
  resource: string,
  logger: Logger,
  correlationId: string,
): Promise<TokenResult> {
  logger.debug('refresh', 'requesting refresh', { resource, correlationId });
  const tokenResponse = await withTransportRetry(
    logger,
    'refresh',
    correlationId,
    isTransport,
    retryAfterMs,
    async () => {
      let response: Response;
      try {
        response = await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, {
          signal: requestSignal(),
          additionalParameters: { resource },
        });
      } catch (err) {
        throw toIapError(err, 'token refresh');
      }
      try {
        return await oauth.processRefreshTokenResponse(as, client, response);
      } catch (err) {
        // invalid_grant is not a transport failure; let the caller classify it as GRANT_DEAD.
        if (err instanceof oauth.ResponseBodyError && err.error === 'invalid_grant') throw err;
        throw toIapError(err, 'token refresh');
      }
    },
  );

  return toTokenResult(tokenResponse);
}

function toTokenResult(response: oauth.TokenEndpointResponse): TokenResult {
  return {
    accessToken: response.access_token,
    expiresIn: response.expires_in ?? 3600,
    refreshToken: response.refresh_token,
  };
}
