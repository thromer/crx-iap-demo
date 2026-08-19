import http from 'node:http';
import type { UnreachableEndpoint } from './state.ts';
import { state } from './state.ts';

type ScenarioArgs = Record<string, unknown>;

function str(args: ScenarioArgs, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`scenario arg "${key}" must be a string`);
  return v;
}

function num(args: ScenarioArgs, key: string): number {
  const v = args[key];
  if (typeof v !== 'number') throw new Error(`scenario arg "${key}" must be a number`);
  return v;
}

function bool(args: ScenarioArgs, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new Error(`scenario arg "${key}" must be a boolean`);
  return v;
}

const scenarioHandlers: Record<string, (args: ScenarioArgs) => void> = {
  shortLivedTokens: (args) => {
    state.scenarios.shortLivedTokensSeconds = num(args, 'seconds');
  },
  rejectNextAccessToken: () => {
    state.scenarios.rejectNextAccessToken = true;
  },
  rotateRefreshTokens: (args) => {
    state.scenarios.rotateRefreshTokens = bool(args, 'on', true);
  },
  omitRefreshTokenOnRefresh: () => {
    state.scenarios.omitRefreshTokenOnRefresh = true;
  },
  invalidGrantOnNextRefresh: () => {
    state.scenarios.invalidGrantOnNextRefresh = true;
  },
  detectRefreshReplay: () => {
    // Replay detection is inherent to oidc-provider's rotation: a consumed refresh token
    // reused after rotation destroys the token and revokes the grant. Arming this scenario
    // just turns rotation on so that behavior is in effect.
    state.scenarios.detectRefreshReplay = true;
    state.scenarios.rotateRefreshTokens = true;
  },
  revokeGrant: () => {
    state.scenarios.revokeGrant = true;
  },
  // Accepts an optional `on` flag, like rotateRefreshTokens, so a test can flip protection
  // back on mid-session (PROMPT.md test matrix #16/#17 require both transition directions).
  unprotected: (args) => {
    state.scenarios.unprotected = bool(args, 'on', true);
  },
  appLevel401: (args) => {
    const kind = str(args, 'kind');
    if (kind !== 'basic' && kind !== 'bare' && kind !== 'json') {
      throw new Error(`unknown appLevel401 kind "${kind}"`);
    }
    state.scenarios.appLevel401 = kind;
  },
  appLevel403: () => {
    state.scenarios.appLevel403 = true;
  },
  challengeWithoutMetadata: () => {
    state.scenarios.challengeWithoutMetadata = true;
  },
  redirectToLoginPage: () => {
    state.scenarios.redirectToLoginPage = true;
  },
  crossOriginResourceMetadata: () => {
    state.scenarios.crossOriginResourceMetadata = true;
  },
  issuerMismatch: () => {
    state.scenarios.issuerMismatch = true;
  },
  emptyAuthorizationServers: () => {
    state.scenarios.emptyAuthorizationServers = true;
  },
  multipleAuthorizationServers: () => {
    state.scenarios.multipleAuthorizationServers = true;
  },
  noRegistrationEndpoint: () => {
    state.scenarios.noRegistrationEndpoint = true;
  },
  // Missing from the original registry — needed for test matrix #52 (logout against an AS with
  // no revocation_endpoint must resolve cleanly rather than throw or no-op silently).
  noRevocationEndpoint: () => {
    state.scenarios.noRevocationEndpoint = true;
  },
  malformedMetadata: (args) => {
    const kind = str(args, 'kind');
    if (kind !== 'html' && kind !== 'truncated' && kind !== 'oversized') {
      throw new Error(`unknown malformedMetadata kind "${kind}"`);
    }
    const target = 'target' in args ? str(args, 'target') : 'resourceMetadata';
    if (target !== 'resourceMetadata' && target !== 'asMetadata') {
      throw new Error(`unknown malformedMetadata target "${target}"`);
    }
    state.scenarios.malformedMetadata = { kind, target };
  },
  autoApprove: () => {
    state.scenarios.autoApprove = true;
    state.scenarios.forceLogin = false;
  },
  forceLogin: () => {
    state.scenarios.forceLogin = true;
    state.scenarios.autoApprove = false;
  },
  denyAuthorization: () => {
    state.scenarios.denyAuthorization = true;
  },
  stallAuthorization: (args) => {
    state.scenarios.stallAuthorizationSeconds = num(args, 'seconds');
  },
  injectForeignCode: () => {
    state.scenarios.injectForeignCode = true;
  },
  tamperState: () => {
    state.scenarios.tamperState = true;
  },
  substituteCodeChallenge: (args) => {
    state.scenarios.substituteCodeChallenge = bool(args, 'on', true);
  },
  rejectCodeExchange: () => {
    state.scenarios.rejectCodeExchange = true;
  },
  reissuePreviousCode: (args) => {
    state.scenarios.reissuePreviousCode = bool(args, 'on', true);
  },
  tokenEndpointStatus: (args) => {
    const code = num(args, 'code');
    const retryAfter = 'retryAfter' in args ? num(args, 'retryAfter') : undefined;
    state.scenarios.tokenEndpointStatus = { code, retryAfter };
  },
  tokenEndpointHang: (args) => {
    state.scenarios.tokenEndpointHangSeconds = num(args, 'seconds');
  },
  endpointUnreachable: (args) => {
    const which = str(args, 'which') as UnreachableEndpoint;
    const valid: UnreachableEndpoint[] = [
      'resourceMetadata',
      'asMetadata',
      'registration',
      'authorization',
      'token',
      'revocation',
      'resource',
    ];
    if (!valid.includes(which)) throw new Error(`unknown endpointUnreachable target "${which}"`);
    if (bool(args, 'on', true)) {
      state.scenarios.unreachable.add(which);
    } else {
      state.scenarios.unreachable.delete(which);
    }
  },
  redirectToForeignOrigin: () => {
    state.scenarios.redirectToForeignOrigin = true;
  },
};

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export function createControlServer(): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/control/reset') {
          state.reset();
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/scenario') {
          const body = (await readJsonBody(req)) as ScenarioArgs;
          const name = str(body, 'name');
          const handler = scenarioHandlers[name];
          if (!handler) {
            sendJson(res, 400, { ok: false, error: `unknown scenario "${name}"` });
            return;
          }
          handler(body);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/requests') {
          sendJson(res, 200, state.requestLog);
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
