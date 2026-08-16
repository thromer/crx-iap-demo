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

function classify(err: unknown): { errorClass: FailureClass; message: string } {
  if (err instanceof IapError) return { errorClass: err.class, message: err.message };
  return { errorClass: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) };
}

async function handleFetch(resource: string, opts: FetchOpts | undefined): Promise<FetchOutcome> {
  const before = getInteractiveAttemptCount();
  try {
    const init: RequestInit = {};
    if (opts?.method !== undefined) init.method = opts.method;
    if (opts?.headers !== undefined) init.headers = opts.headers;
    if (opts?.body !== undefined) init.body = opts.body;
    const response = await client.fetch(resource, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      ok: true,
      status: response.status,
      headers,
      body: await response.text(),
      promptOccurred: getInteractiveAttemptCount() > before,
    };
  } catch (err) {
    return { ok: false, ...classify(err), promptOccurred: getInteractiveAttemptCount() > before };
  }
}

async function handleAction(fn: () => Promise<void>): Promise<ActionOutcome> {
  const before = getInteractiveAttemptCount();
  try {
    await fn();
    return { ok: true, promptOccurred: getInteractiveAttemptCount() > before };
  } catch (err) {
    return { ok: false, ...classify(err), promptOccurred: getInteractiveAttemptCount() > before };
  }
}

async function handleProbe(resource: string): Promise<ProbeOutcome> {
  return client.probe(resource);
}

async function handleCurrentTokenId(resource: string): Promise<CurrentTokenIdOutcome> {
  return { tokenId: currentTokenIds.get(resource) ?? null };
}

chrome.runtime.onMessage.addListener((message: SwRequest, _sender, sendResponse) => {
  switch (message.type) {
    case 'fetch':
      handleFetch(message.resource, message.opts).then(sendResponse);
      return true;
    case 'login':
      handleAction(() => client.login(message.resource, message.opts)).then(sendResponse);
      return true;
    case 'logout':
      handleAction(() => client.logout(message.resource)).then(sendResponse);
      return true;
    case 'probe':
      handleProbe(message.resource).then(sendResponse);
      return true;
    case 'reportRejected':
      handleAction(() => client.reportRejected(message.resource, message.tokenId)).then(
        sendResponse,
      );
      return true;
    case 'currentTokenId':
      handleCurrentTokenId(message.resource).then(sendResponse);
      return true;
    default:
      return false;
  }
});
