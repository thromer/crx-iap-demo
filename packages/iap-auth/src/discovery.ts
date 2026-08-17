import * as oauth from 'oauth4webapi';
import { toIapError } from './errors.ts';
import { asMetadataKey, clientRegistrationKey, resourceMetadataKey } from './keys.ts';
import { requestSignal, transportCustomFetch, transportFetch, withTransportRetry } from './net.ts';
import type { KeyValueStore, Logger } from './types.ts';
import { IapError } from './types.ts';

interface CachedResourceMetadata {
  issuer: string;
}

interface CachedClientRegistration {
  clientId: string;
}

function isTransport(err: unknown): boolean {
  return toIapError(err, '').class === 'TRANSPORT';
}

async function retryDiscovery<T>(
  logger: Logger,
  correlationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTransportRetry(logger, 'discovery', correlationId, isTransport, () => undefined, fn);
}

/**
 * Resolves the authorization server for `resource`, using the WWW-Authenticate challenge's
 * `resource_metadata` parameter (already parsed by oauth4webapi, never hand-parsed here).
 * Rejects a `resource_metadata` URL on a foreign origin without ever requesting it — this is
 * the RFC 9728 spoofing defense and it happens before any network call.
 *
 * Deliberately does NOT use oauth4webapi's `resourceDiscoveryRequest` primitive: that function
 * takes the resource identifier and derives the well-known metadata URL itself, with no way to
 * hand it the exact URL the server's challenge named. That would bypass the origin check above
 * entirely (it would just never look at a foreign resource_metadata value in the first place)
 * rather than validate-then-reject it — a materially different security property, and the one
 * this project's own crossOriginResourceMetadata test (#23) is specifically written against.
 * The request itself still goes through this module's one transportFetch chokepoint.
 */
export async function discoverResource(
  resource: string,
  resourceMetadataUrl: string,
  durable: KeyValueStore,
  logger: Logger,
  correlationId: string,
): Promise<{ issuer: string }> {
  const cached = (await durable.get(resourceMetadataKey(resource))) as
    | CachedResourceMetadata
    | undefined;
  if (cached) {
    logger.debug('discovery', 'resource metadata cache hit', { resource, correlationId });
    return cached;
  }

  const resourceUrl = new URL(resource);
  const metadataUrl = new URL(resourceMetadataUrl);
  if (metadataUrl.origin !== resourceUrl.origin) {
    logger.error('discovery', 'resource_metadata origin does not match resource; refusing', {
      resource,
      resourceMetadataUrl,
      correlationId,
    });
    throw new IapError(
      'MISCONFIGURED',
      `resource_metadata origin (${metadataUrl.origin}) does not match resource origin (${resourceUrl.origin})`,
    );
  }

  logger.debug('discovery', 'fetching resource metadata', { url: metadataUrl.href, correlationId });
  const fetchResourceMetadata = transportFetch('resource metadata fetch');
  const metadata = await retryDiscovery(logger, correlationId, async () => {
    const response = await fetchResourceMetadata(metadataUrl, {
      redirect: 'manual',
      signal: requestSignal(),
    });
    try {
      return await oauth.processResourceDiscoveryResponse(resourceUrl, response);
    } catch (err) {
      throw toIapError(err, 'resource metadata validation');
    }
  });

  const servers = metadata.authorization_servers ?? [];
  if (servers.length === 0) {
    throw new IapError('MISCONFIGURED', 'resource metadata lists no authorization servers');
  }
  // Deterministic selection: first-listed authorization server wins.
  const issuer = servers[0] as string;

  const result: CachedResourceMetadata = { issuer };
  await durable.set(resourceMetadataKey(resource), result);
  logger.info('discovery', 'resource metadata cached', { resource, issuer, correlationId });
  return result;
}

export async function discoverAuthorizationServer(
  issuer: string,
  durable: KeyValueStore,
  logger: Logger,
  correlationId: string,
): Promise<oauth.AuthorizationServer> {
  const cached = (await durable.get(asMetadataKey(issuer))) as
    | oauth.AuthorizationServer
    | undefined;
  if (cached) {
    logger.debug('discovery', 'AS metadata cache hit', { issuer, correlationId });
    return cached;
  }

  logger.debug('discovery', 'fetching AS metadata', { issuer, correlationId });
  const issuerUrl = new URL(issuer);
  const as = await retryDiscovery(logger, correlationId, async () => {
    const response = await oauth.discoveryRequest(issuerUrl, {
      algorithm: 'oauth2',
      signal: requestSignal(),
      [oauth.customFetch]: transportCustomFetch('AS metadata fetch'),
    });
    try {
      return await oauth.processDiscoveryResponse(issuerUrl, response);
    } catch (err) {
      throw toIapError(err, 'AS metadata validation');
    }
  });

  await durable.set(asMetadataKey(issuer), as);
  logger.info('discovery', 'AS metadata cached', { issuer, correlationId });
  return as;
}

export async function registerOrGetClient(
  as: oauth.AuthorizationServer,
  redirectUri: string,
  durable: KeyValueStore,
  logger: Logger,
  correlationId: string,
  fallbackClientId: string | undefined,
): Promise<oauth.Client> {
  const cached = (await durable.get(clientRegistrationKey(as.issuer))) as
    | CachedClientRegistration
    | undefined;
  if (cached) {
    logger.debug('dcr', 'client registration cache hit', { issuer: as.issuer, correlationId });
    return { client_id: cached.clientId };
  }

  if (!as.registration_endpoint) {
    if (fallbackClientId) {
      logger.info('dcr', 'no registration_endpoint, using fallbackClientId', {
        issuer: as.issuer,
        correlationId,
      });
      const result: CachedClientRegistration = { clientId: fallbackClientId };
      await durable.set(clientRegistrationKey(as.issuer), result);
      return { client_id: fallbackClientId };
    }
    throw new IapError(
      'MISCONFIGURED',
      `authorization server ${as.issuer} has no registration_endpoint and no fallbackClientId was configured`,
    );
  }

  logger.debug('dcr', 'registering client', { issuer: as.issuer, correlationId });
  const client = await retryDiscovery(logger, correlationId, async () => {
    const response = await oauth.dynamicClientRegistrationRequest(
      as,
      {
        token_endpoint_auth_method: 'none',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      {
        signal: requestSignal(),
        [oauth.customFetch]: transportCustomFetch('dynamic client registration'),
      },
    );
    try {
      return await oauth.processDynamicClientRegistrationResponse(response);
    } catch (err) {
      throw toIapError(err, 'dynamic client registration');
    }
  });

  const result: CachedClientRegistration = { clientId: client.client_id };
  await durable.set(clientRegistrationKey(as.issuer), result);
  logger.info('dcr', 'client registered', {
    issuer: as.issuer,
    clientId: client.client_id,
    correlationId,
  });
  return client;
}
