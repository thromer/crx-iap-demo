import type { Authorizer } from '@iap-demo/iap-auth';

// Bumped on every interactive attempt so the popup can report "a prompt occurred" for
// manual verification — purely observational, no bearing on the ladder itself.
let interactiveAttemptCount = 0;
export function getInteractiveAttemptCount(): number {
  return interactiveAttemptCount;
}

// Single-shot and dumb, per the module's contract: it does not decide *whether* to go
// interactive — createIapClient owns the silent-then-interactive ladder. This adapter only
// knows how to run one attempt of one kind.
export function createLaunchWebAuthFlowAuthorizer(): Authorizer {
  const redirectUri = chrome.identity.getRedirectURL('cb');

  return {
    redirectUri: () => redirectUri,
    authorize(url, opts) {
      if (opts.interactive) interactiveAttemptCount += 1;
      return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          {
            url,
            interactive: opts.interactive,
            ...(opts.interactive
              ? {}
              : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 }),
          },
          (redirectUrl) => {
            if (chrome.runtime.lastError || !redirectUrl) {
              reject(
                new Error(
                  chrome.runtime.lastError?.message ?? 'launchWebAuthFlow: no redirect URL',
                ),
              );
              return;
            }
            resolve(redirectUrl);
          },
        );
      });
    },
  };
}
