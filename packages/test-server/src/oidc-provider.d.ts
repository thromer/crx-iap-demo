// oidc-provider ships no bundled type declarations. This declares only the
// surface this package actually uses, verified against node_modules/oidc-provider@9.11.3
// source (helpers/defaults.js, models/base_token.js, actions/grants/refresh_token.js,
// shared/check_resource.js, helpers/initialize_app.js).
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export interface ResourceServerInfo {
    scope?: string;
    accessTokenTTL?: number;
    accessTokenFormat?: 'opaque' | 'jwt' | 'paseto';
    audience?: string;
  }

  export interface KoaContext {
    method: string;
    path: string;
    url: string;
    status: number;
    body: Record<string, unknown> | undefined;
    req: IncomingMessage;
    res: ServerResponse;
    get(field: string): string;
    set(field: string, value: string | string[]): void;
    oidc?: {
      route?: string;
      params?: Record<string, unknown>;
    };
  }

  export interface InteractionDetails {
    uid: string;
    prompt: { name: string; reasons?: string[] };
    params: Record<string, unknown>;
    session?: { accountId?: string };
  }

  export interface InteractionResult {
    login?: { accountId: string };
    consent?: { grantId?: string };
    error?: string;
    error_description?: string;
  }

  export interface ClientMetadata {
    client_id: string;
    token_endpoint_auth_method?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
  }

  export interface Configuration {
    clients?: ClientMetadata[];
    scopes?: string[];
    findAccount?: (
      ctx: KoaContext,
      sub: string,
    ) => Promise<{ accountId: string; claims: () => Promise<Record<string, unknown>> }>;
    features?: {
      devInteractions?: { enabled: boolean };
      registration?: { enabled: boolean; initialAccessToken?: boolean };
      revocation?: { enabled: boolean };
      resourceIndicators?: {
        enabled: boolean;
        defaultResource?: (ctx: KoaContext, client: unknown) => Promise<string | undefined>;
        getResourceServerInfo?: (
          ctx: KoaContext,
          resourceIndicator: string,
          client: unknown,
        ) => Promise<ResourceServerInfo>;
      };
    };
    ttl?: {
      AccessToken?: number | ((ctx: KoaContext, token: unknown, client: unknown) => number);
    };
    rotateRefreshToken?: boolean | ((ctx: KoaContext) => boolean | Promise<boolean>);
    interactions?: {
      url?: (ctx: KoaContext, interaction: InteractionDetails) => Promise<string> | string;
    };
    pkce?: { required?: (ctx: KoaContext, client: unknown) => boolean };
  }

  export interface Grant {
    addOIDCScope(scope: string): void;
    addResourceScope(resource: string, scope: string): void;
    save(): Promise<string>;
  }

  export interface AccessTokenInstance {
    accountId: string;
    clientId: string;
    aud: string | undefined;
    isExpired: boolean;
  }

  export interface ClientInstance {
    clientId: string;
  }

  export interface AuthorizationCodeData {
    accountId: string;
    client: ClientInstance;
    codeChallenge?: string | undefined;
    codeChallengeMethod?: string | undefined;
    expiresWithSession?: boolean;
    grantId: string;
    redirectUri: string;
    resource?: string;
    scope: string;
  }

  export default class Provider {
    constructor(issuer: string, configuration?: Configuration);
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    use(middleware: (ctx: KoaContext, next: () => Promise<void>) => Promise<void>): void;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<InteractionDetails>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: InteractionResult,
      opts?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
    Grant: new (data: {
      accountId: string;
      clientId: string;
    }) => Grant;
    Client: { find(clientId: string): Promise<ClientInstance | undefined> };
    AuthorizationCode: new (
      data: AuthorizationCodeData,
    ) => { save(): Promise<string> };
    AccessToken: {
      find(
        token: string,
        opts?: { ignoreExpiration?: boolean },
      ): Promise<AccessTokenInstance | undefined>;
    };
  }
}
