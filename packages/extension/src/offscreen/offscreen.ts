import type {
  StandInFetchOutcome,
  StandInFetchRequest,
  TokenChangedBroadcast,
} from '../shared/messages.ts';
import StandInWorker from '../standin/worker.ts?worker';

// Hosts the stand-in library unmodified: no fetch patch of our own here, in this document.
// The only thing this file does is relay commands into the Worker and read back what it
// already tells us about the response — the "far narrower integration point than a network
// primitive" PROMPT.md calls for.
const worker = new StandInWorker();

type WorkerReply = { id: number; status: number } | { id: number; error: string };

let nextCommandId = 0;
const pending = new Map<number, (reply: WorkerReply) => void>();

worker.onmessage = (event: MessageEvent<WorkerReply>) => {
  const resolve = pending.get(event.data.id);
  if (!resolve) return;
  pending.delete(event.data.id);
  resolve(event.data);
};

function runInWorker(url: string, method: string | undefined): Promise<WorkerReply> {
  const id = nextCommandId;
  nextCommandId += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, url, method });
  });
}

// The SW pushes tokenId changes here (see PROMPT.md: "the SW exposes the current tokenId to
// the offscreen document over chrome.runtime whenever it changes"). `undefined` means "never
// told us anything for this resource yet" — distinct from `null`, which means "we know there
// is currently no token" — so a miss here falls back to an explicit pull query.
const knownTokenIds = new Map<string, string | null>();

async function tokenIdFor(resource: string): Promise<string | null> {
  const known = knownTokenIds.get(resource);
  if (known !== undefined) return known;
  const reply = (await chrome.runtime.sendMessage({ type: 'currentTokenId', resource })) as {
    tokenId: string | null;
  };
  knownTokenIds.set(resource, reply.tokenId);
  return reply.tokenId;
}

async function handleStandInFetch(message: StandInFetchRequest): Promise<StandInFetchOutcome> {
  const url = new URL(message.path, message.resource).toString();
  const reply = await runInWorker(url, message.method);
  if ('error' in reply) return { ok: false, message: reply.error };

  if (reply.status === 401) {
    // Only report a rejection when we know we had a token for this resource in the first
    // place — a 401 we were never trying to authenticate for isn't ours to report, and a 403
    // is never reported regardless (see test matrix group "DNR attachment", #62).
    const tokenId = await tokenIdFor(message.resource);
    if (tokenId) {
      await chrome.runtime.sendMessage({
        type: 'reportRejected',
        resource: message.resource,
        tokenId,
      });
    }
  }

  return { ok: true, status: reply.status };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tokenChanged') {
    const broadcast = message as TokenChangedBroadcast;
    knownTokenIds.set(broadcast.resource, broadcast.tokenId);
    return false;
  }
  if (message?.type === 'standinFetch') {
    handleStandInFetch(message as StandInFetchRequest).then(sendResponse);
    return true;
  }
  return false;
});
