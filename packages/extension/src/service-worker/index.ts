import { createIapClient, IapError } from '@iap-demo/iap-auth';
import type {
  ActionOutcome,
  CurrentTokenIdOutcome,
  FailureClass,
  FetchOpts,
  FetchOutcome,
  ProbeOutcome,
  SwRequest,
  TokenChangedBroadcast,
} from '../shared/messages.ts';
import { createLaunchWebAuthFlowAuthorizer, getInteractiveAttemptCount } from './authorizer.ts';
import { respond } from './dispatch.ts';
import { removeAuthorizationRule, setAuthorizationRule } from './dnr.ts';
import { ensureOffscreenDocument } from './offscreen-manager.ts';
import { createDurableStore, createSessionStore } from './storage.ts';

const client = createIapClient({
  session: createSessionStore(),
  durable: createDurableStore(),
  authorizer: createLaunchWebAuthFlowAuthorizer(),
});

// Tracks the latest known tokenId per resource so 'currentTokenId' queries (from the
// offscreen document, echoing it back on reportRejected) don't need a round trip into
// chrome.storage.
const currentTokenIds = new Map<string, string | null>();

client.onTokenChanged(async (resource, token, tokenId) => {
  currentTokenIds.set(resource, tokenId);

  // DNR sync: `await` inside the listener so the rule is in place before the
  // getToken/reportRejected call that triggered this resolves.
  if (token) {
    await setAuthorizationRule(resource, token);
  } else {
    await removeAuthorizationRule(resource);
  }

  const broadcast: TokenChangedBroadcast = { type: 'tokenChanged', resource, tokenId };
  chrome.runtime.sendMessage(broadcast).catch(() => {
    // No listener currently attached (e.g. offscreen document not yet created) — fine, it
    // will pick up the current tokenId via an explicit 'currentTokenId' query instead.
  });
});

void ensureOffscreenDocument();
chrome.runtime.onInstalled.addListener(() => void ensureOffscreenDocument());
chrome.runtime.onStartup.addListener(() => void ensureOffscreenDocument());

// classify() is used only to shape an *error* response — it must never be reached on a success
// path, so producing UNKNOWN here is already an anomaly: every classifiable failure mode this
// module itself can throw is an IapError. Logged at error level so a real UNKNOWN (some
// genuinely unexpected throw) shows up as loud, not as a normal outcome silently returned to
// the caller.
function classify(err: unknown): { errorClass: FailureClass; message: string } {
  if (err instanceof IapError) return { errorClass: err.class, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  console.error('[classify] UNKNOWN: an unclassified error reached the message boundary', err);
  return { errorClass: 'UNKNOWN', message };
}

function fetchInit(opts: FetchOpts | undefined): RequestInit {
  const init: RequestInit = {};
  if (opts?.method !== undefined) init.method = opts.method;
  if (opts?.headers !== undefined) init.headers = opts.headers;
  if (opts?.body !== undefined) init.body = opts.body;
  return init;
}

async function responseToOutcome(
  response: Response,
  promptOccurred: boolean,
): Promise<FetchOutcome> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    ok: true,
    status: response.status,
    headers,
    body: await response.text(),
    promptOccurred,
  };
}

// Every case below goes through dispatch.ts's respond(): exactly one sendResponse call per
// message, whether the underlying work throws or a success mapper itself throws. No handler
// keeps its own try/catch alongside this — see the checkpoint-3 review's Task 2 ("one place,
// and every handler is allowed to throw").
chrome.runtime.onMessage.addListener((message: SwRequest, _sender, sendResponse) => {
  switch (message.type) {
    case 'fetch': {
      const before = getInteractiveAttemptCount();
      respond(
        () => client.fetch(message.resource, fetchInit(message.opts)),
        (response) => responseToOutcome(response, getInteractiveAttemptCount() > before),
        (err): FetchOutcome => ({
          ok: false,
          ...classify(err),
          promptOccurred: getInteractiveAttemptCount() > before,
        }),
        sendResponse,
      );
      return true;
    }
    case 'login': {
      const before = getInteractiveAttemptCount();
      respond(
        () => client.login(message.resource, message.opts),
        (): ActionOutcome => ({ ok: true, promptOccurred: getInteractiveAttemptCount() > before }),
        (err): ActionOutcome => ({
          ok: false,
          ...classify(err),
          promptOccurred: getInteractiveAttemptCount() > before,
        }),
        sendResponse,
      );
      return true;
    }
    case 'logout': {
      const before = getInteractiveAttemptCount();
      respond(
        () => client.logout(message.resource),
        ({ revoked }): ActionOutcome => ({
          ok: true,
          revoked,
          promptOccurred: getInteractiveAttemptCount() > before,
        }),
        (err): ActionOutcome => ({
          ok: false,
          ...classify(err),
          promptOccurred: getInteractiveAttemptCount() > before,
        }),
        sendResponse,
      );
      return true;
    }
    case 'probe': {
      // ProbeResult (packages/iap-auth/src/types.ts) has no error/transport variant of its
      // own — 'unsupported' with a reason is its only soft-failure channel. A thrown IapError
      // (e.g. TRANSPORT from an unreachable resource metadata endpoint — see net.ts's
      // transportFetch) is folded into that shape here, prefixed with its class so a caller
      // can still tell a transport failure apart from an actual protocol mismatch without a
      // dedicated field.
      respond(
        () => client.probe(message.resource),
        (result): ProbeOutcome => result,
        (err): ProbeOutcome => ({
          kind: 'unsupported',
          reason: err instanceof IapError ? `${err.class}: ${err.message}` : classify(err).message,
        }),
        sendResponse,
      );
      return true;
    }
    case 'reportRejected': {
      const before = getInteractiveAttemptCount();
      respond(
        () => client.reportRejected(message.resource, message.tokenId),
        (): ActionOutcome => ({ ok: true, promptOccurred: getInteractiveAttemptCount() > before }),
        (err): ActionOutcome => ({
          ok: false,
          ...classify(err),
          promptOccurred: getInteractiveAttemptCount() > before,
        }),
        sendResponse,
      );
      return true;
    }
    case 'currentTokenId': {
      respond(
        () => Promise.resolve(currentTokenIds.get(message.resource) ?? null),
        (tokenId): CurrentTokenIdOutcome => ({ tokenId }),
        (): CurrentTokenIdOutcome => ({ tokenId: null }),
        sendResponse,
      );
      return true;
    }
    default:
      return false;
  }
});
