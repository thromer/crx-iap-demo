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
  if (err instanceof oauth.ResponseBodyError) {
    const header = err.response.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
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

  const callbackParams = oauth.validateAuthResponse(as, client, new URL(redirectUrl), state);

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
          { signal: requestSignal() },
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
