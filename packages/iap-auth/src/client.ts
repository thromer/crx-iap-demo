import * as oauth from 'oauth4webapi';
import { refreshAccessToken, runAuthorizationLadder, type TokenResult } from './authorize.ts';
import { discoverAuthorizationServer, discoverResource, registerOrGetClient } from './discovery.ts';
import { classifyTokenEndpointError, toIapError } from './errors.ts';
import { shortHash } from './hash.ts';
import { accessKey, refreshKey, resourceMetadataKey } from './keys.ts';
import { KeyedSingleFlight } from './lock.ts';
import { createLogger } from './logger.ts';
import { requestSignal } from './net.ts';
import { issueResourceRequest } from './resource-request.ts';
import type {
  Clock,
  CreateIapClientOptions,
  IapClient,
  ProbeResult,
  TokenChangeListener,
} from './types.ts';
import { IapError } from './types.ts';

const SKEW_MARGIN_MS = 60_000;

interface AccessEntry {
  token: string;
  expiresAt: number;
  tokenId: string;
}

const systemClock: Clock = { now: () => Date.now() };

export function createIapClient(opts: CreateIapClientOptions): IapClient {
  const { session, durable, authorizer, fallbackClientId } = opts;
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createLogger('debug');

  const singleFlight = new KeyedSingleFlight(logger);
  const listeners = new Set<TokenChangeListener>();
  let correlationCounter = 0;
  function newCorrelationId(): string {
    correlationCounter += 1;
    return `c${correlationCounter}`;
  }

  function isFresh(entry: AccessEntry): boolean {
    return entry.expiresAt - SKEW_MARGIN_MS > clock.now();
  }

  async function readAccessEntry(resource: string): Promise<AccessEntry | undefined> {
    return (await session.get(accessKey(resource))) as AccessEntry | undefined;
  }

  async function writeAccessEntry(
    resource: string,
    entry: AccessEntry | null,
    correlationId: string,
  ): Promise<void> {
    if (entry) {
      await session.set(accessKey(resource), entry);
      logger.debug('storage', 'access token stored', {
        resource,
        tokenId: entry.tokenId,
        correlationId,
      });
    } else {
      await session.delete(accessKey(resource));
      logger.debug('storage', 'access token cleared', { resource, correlationId });
    }
    logger.debug('token', 'onTokenChanged firing', {
      resource,
      tokenId: entry?.tokenId ?? null,
      correlationId,
    });
    for (const listener of listeners) {
      await listener(resource, entry?.token ?? null, entry?.tokenId ?? null);
    }
  }

  async function finalizeToken(
    resource: string,
    result: TokenResult,
    correlationId: string,
  ): Promise<AccessEntry> {
    if (result.refreshToken) {
      await durable.set(refreshKey(resource), result.refreshToken);
      logger.debug('token', 'refresh token persisted', { resource, correlationId });
    }
    // Rotation handling: when the AS omits refresh_token on refresh, the existing one (if
    // any) is left untouched above — inverting this would silently kill the session one
    // refresh later.
    const tokenId = await shortHash(result.accessToken);
    const entry: AccessEntry = {
      token: result.accessToken,
      expiresAt: clock.now() + result.expiresIn * 1000,
      tokenId,
    };
    await writeAccessEntry(resource, entry, correlationId);
    return entry;
  }

  async function ensureDiscoveryContext(
    resource: string,
    correlationId: string,
    resourceMetadataUrlHint: string | undefined,
  ): Promise<{ as: oauth.AuthorizationServer; client: oauth.Client }> {
    let resourceMetadataUrl = resourceMetadataUrlHint;
    const cached = (await durable.get(resourceMetadataKey(resource))) as
      | { issuer: string }
      | undefined;
    if (!cached && !resourceMetadataUrl) {
      logger.debug('discovery', 'no cached or hinted resource metadata, probing resource', {
        resource,
        correlationId,
      });
      const { response, challenge } = await issueResourceRequest(
        'GET',
        new URL(resource),
        new Headers(),
        undefined,
        undefined,
      );
      if (challenge.kind !== 'bearer') {
        throw new IapError(
          'MISCONFIGURED',
          `resource ${resource} did not present a Bearer challenge (status ${response.status})`,
        );
      }
      if (!challenge.resourceMetadataUrl) {
        throw new IapError(
          'MISCONFIGURED',
          `resource ${resource} sent a Bearer challenge with no resource_metadata`,
        );
      }
      resourceMetadataUrl = challenge.resourceMetadataUrl;
    }

    const { issuer } = await discoverResource(
      resource,
      resourceMetadataUrl ?? '',
      durable,
      logger,
      correlationId,
    );
    const as = await discoverAuthorizationServer(issuer, durable, logger, correlationId);
    const client = await registerOrGetClient(
      as,
      authorizer.redirectUri(),
      durable,
      logger,
      correlationId,
      fallbackClientId,
    );
    return { as, client };
  }

  async function acquireToken(
    resource: string,
    ladderOpts: { interactive?: boolean } | undefined,
    correlationId: string,
    resourceMetadataUrlHint: string | undefined,
  ): Promise<AccessEntry> {
    const refreshToken = (await durable.get(refreshKey(resource))) as string | undefined;
    const cachedResourceMeta = (await durable.get(resourceMetadataKey(resource))) as
      | { issuer: string }
      | undefined;

    if (refreshToken && cachedResourceMeta) {
      const as = await discoverAuthorizationServer(
        cachedResourceMeta.issuer,
        durable,
        logger,
        correlationId,
      );
      const client = await registerOrGetClient(
        as,
        authorizer.redirectUri(),
        durable,
        logger,
        correlationId,
        fallbackClientId,
      );
      try {
        const result = await refreshAccessToken(
          as,
          client,
          refreshToken,
          resource,
          logger,
          correlationId,
        );
        logger.info('classify', 'refresh succeeded', { resource, correlationId });
        return await finalizeToken(resource, result, correlationId);
      } catch (err) {
        const kind = classifyTokenEndpointError(err);
        if (kind !== 'invalid_grant') {
          logger.error('classify', 'TRANSPORT: refresh failed', {
            resource,
            correlationId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw toIapError(err, 'token refresh');
        }
        logger.info('classify', 'GRANT_DEAD: refresh returned invalid_grant', {
          resource,
          correlationId,
        });
        await durable.delete(refreshKey(resource));
        // fall through to the authorization ladder below
      }
    }

    const { as, client } = await ensureDiscoveryContext(
      resource,
      correlationId,
      resourceMetadataUrlHint,
    );
    const result = await runAuthorizationLadder(
      as,
      client,
      resource,
      authorizer,
      logger,
      correlationId,
      ladderOpts,
    );
    return await finalizeToken(resource, result, correlationId);
  }

  async function bufferBody(
    init: RequestInit | undefined,
  ): Promise<{ body: oauth.ProtectedResourceRequestBody; contentType: string | undefined }> {
    const body = init?.body;
    if (body === undefined || body === null) return { body: undefined, contentType: undefined };
    if (typeof body === 'string') return { body, contentType: undefined };
    if (body instanceof URLSearchParams) return { body, contentType: undefined };
    if (body instanceof ArrayBuffer) return { body, contentType: undefined };
    if (body instanceof Uint8Array) return { body, contentType: undefined };
    if (body instanceof ReadableStream) {
      throw new IapError(
        'MISCONFIGURED',
        'ReadableStream request bodies cannot be replayed after a refresh; buffer the body before calling fetch()',
      );
    }
    // Blob / FormData — serialize via Request so multipart boundaries etc. are preserved,
    // then replay the buffered bytes with the captured content-type on every attempt.
    const req = new Request('http://placeholder.invalid', {
      method: 'POST',
      body: body as BodyInit,
    });
    const buffered = await req.arrayBuffer();
    return { body: buffered, contentType: req.headers.get('content-type') ?? undefined };
  }

  return {
    // In the extension, a declarativeNetRequest rule attaches the same Authorization header
    // to every matching request from this extension — including this call. Normally both
    // carry the same value; during a refresh window they can diverge, and DNR's `set` wins
    // over whatever is attached here. That's the safe outcome, since the rule is only ever
    // updated to the current token — see the matching note next to where the rule is
    // installed (packages/extension/src/service-worker/dnr.ts).
    async fetch(input, init) {
      const correlationId = newCorrelationId();
      const url = new URL(input);
      const resource = url.origin;
      const method = init?.method ?? 'GET';
      const { body, contentType } = await bufferBody(init);

      function buildHeaders(): Headers {
        const headers = new Headers(init?.headers);
        if (contentType) headers.set('content-type', contentType);
        return headers;
      }

      const cached = await readAccessEntry(resource);
      let token: string | undefined;
      if (cached) {
        if (isFresh(cached)) {
          token = cached.token;
        } else {
          logger.info('classify', 'TOKEN_STALE: local expiry passed before send', {
            resource,
            correlationId,
          });
          const refreshed = await singleFlight.run(resource, correlationId, () =>
            acquireToken(resource, undefined, correlationId, undefined),
          );
          token = refreshed.token;
        }
      }

      const first = await issueResourceRequest(method, url, buildHeaders(), body, token);

      if (first.response.status === 403) {
        logger.info('classify', 'FORBIDDEN', { resource, correlationId });
        throw new IapError('FORBIDDEN', `resource server denied access to ${resource}`);
      }

      if (first.challenge.kind !== 'bearer') {
        // Not a 401, or a 401 for reasons unrelated to IAP (Basic/bare/JSON app-level 401).
        // Passes through unchanged: never an IAP challenge, never a prompt.
        return first.response;
      }

      if (!first.challenge.resourceMetadataUrl) {
        logger.error('classify', 'MISCONFIGURED: Bearer challenge missing resource_metadata', {
          resource,
          correlationId,
        });
        throw new IapError(
          'MISCONFIGURED',
          `resource ${resource} sent a Bearer challenge with no resource_metadata`,
        );
      }

      logger.info(
        'classify',
        token
          ? 'TOKEN_STALE: 401 invalid_token on a token we believed valid'
          : 'first contact: running authorization',
        { resource, correlationId },
      );

      const entry = await singleFlight.run(resource, correlationId, () =>
        acquireToken(
          resource,
          undefined,
          correlationId,
          first.challenge.kind === 'bearer' ? first.challenge.resourceMetadataUrl : undefined,
        ),
      );

      const retry = await issueResourceRequest(method, url, buildHeaders(), body, entry.token);
      return retry.response;
    },

    async probe(resource): Promise<ProbeResult> {
      const correlationId = newCorrelationId();
      const { response, challenge } = await issueResourceRequest(
        'GET',
        new URL(resource),
        new Headers(),
        undefined,
        undefined,
      );

      if (challenge.kind === 'bearer' && challenge.resourceMetadataUrl) {
        try {
          const { issuer } = await discoverResource(
            resource,
            challenge.resourceMetadataUrl,
            durable,
            logger,
            correlationId,
          );
          return { kind: 'oauth', authorizationServer: issuer, resource };
        } catch (err) {
          return { kind: 'unsupported', reason: err instanceof Error ? err.message : String(err) };
        }
      }

      if (response.status >= 200 && response.status < 300) {
        return { kind: 'unprotected' };
      }

      return { kind: 'unsupported', reason: `unexpected response (status ${response.status})` };
    },

    async login(resource, opts) {
      const correlationId = newCorrelationId();
      logger.info('token', 'login requested', {
        resource,
        correlationId,
        interactive: opts?.interactive,
      });
      await singleFlight.run(resource, correlationId, () =>
        acquireToken(resource, opts, correlationId, undefined),
      );
    },

    async logout(resource) {
      const correlationId = newCorrelationId();
      await singleFlight.run(resource, correlationId, async () => {
        const cachedResourceMeta = (await durable.get(resourceMetadataKey(resource))) as
          | { issuer: string }
          | undefined;
        const refreshToken = (await durable.get(refreshKey(resource))) as string | undefined;

        if (cachedResourceMeta && refreshToken) {
          try {
            const as = await discoverAuthorizationServer(
              cachedResourceMeta.issuer,
              durable,
              logger,
              correlationId,
            );
            if (as.revocation_endpoint) {
              const client = await registerOrGetClient(
                as,
                authorizer.redirectUri(),
                durable,
                logger,
                correlationId,
                fallbackClientId,
              );
              const res = await oauth.revocationRequest(as, client, oauth.None(), refreshToken, {
                signal: requestSignal(),
              });
              await oauth.processRevocationResponse(res);
              logger.info('token', 'revoked at authorization server', { resource, correlationId });
            } else {
              logger.info('token', 'no revocation_endpoint; clearing local state only', {
                resource,
                correlationId,
              });
            }
          } catch (err) {
            logger.warn('token', 'revocation failed; clearing local state anyway', {
              resource,
              correlationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        await durable.delete(refreshKey(resource));
        await writeAccessEntry(resource, null, correlationId);
      });
    },

    async getToken(resource, opts) {
      const cached = await readAccessEntry(resource);
      if (cached && isFresh(cached)) {
        return { token: cached.token, tokenId: cached.tokenId };
      }
      const correlationId = newCorrelationId();
      logger.info('classify', 'TOKEN_STALE: no fresh cached token', { resource, correlationId });
      const entry = await singleFlight.run(resource, correlationId, () =>
        acquireToken(resource, opts, correlationId, undefined),
      );
      return { token: entry.token, tokenId: entry.tokenId };
    },

    async reportRejected(resource, tokenId) {
      const correlationId = newCorrelationId();
      await singleFlight.run(resource, correlationId, async () => {
        const current = await readAccessEntry(resource);
        if (!current || current.tokenId !== tokenId) {
          logger.debug('classify', 'reportRejected no-op: tokenId already superseded', {
            resource,
            tokenId,
            correlationId,
          });
          return;
        }
        logger.info('classify', 'TOKEN_STALE: reported rejected by resource server', {
          resource,
          tokenId,
          correlationId,
        });
        await writeAccessEntry(resource, null, correlationId);
        await acquireToken(resource, undefined, correlationId, undefined);
      });
    },

    onTokenChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
