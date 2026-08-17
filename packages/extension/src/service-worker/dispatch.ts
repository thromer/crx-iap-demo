// The single place that decides how a chrome.runtime message handler responds: exactly once,
// on the success path xor the error path, regardless of whether the failure originated in the
// work itself or in mapping a successful result into a response. Every case in index.ts's
// onMessage listener goes through this — no per-message-type try/catch alongside it, so there
// is exactly one place this decision is made.
//
// Why a naive `work().then(onSuccess, onError)` isn't enough: if `onSuccess` itself throws
// (e.g. an async response-body read failing) that rejection does not reach `.then`'s second
// argument — only a rejection of the *original* promise does — so it would surface as an
// unhandled rejection and the caller's sendResponse would never be called. The bug this
// replaces (handleProbe having no catch at all, hanging the message channel on a throw) was
// exactly this shape of mistake. A single try/catch around both awaits guarantees `sendResponse`
// fires exactly once no matter which step fails.
export function respond<T, R>(
  work: () => Promise<T>,
  onSuccess: (value: T) => R | Promise<R>,
  onError: (err: unknown) => R,
  sendResponse: (response: R) => void,
): void {
  void (async () => {
    try {
      sendResponse(await onSuccess(await work()));
    } catch (err) {
      sendResponse(onError(err));
    }
  })();
}
