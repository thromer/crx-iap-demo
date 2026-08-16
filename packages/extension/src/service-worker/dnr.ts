// One declarativeNetRequest session rule per resource origin: "attach this header to
// requests matching this origin." No discovery or refresh policy belongs in a rule
// condition — that all lives in IapClient.
//
// Session rules, not dynamic rules: they need not survive a browser restart, matching where
// the access token itself lives (chrome.storage.session).
//
// Rule IDs must be stable numbers. Rather than persist an origin->id map (which could drift
// from reality across a service worker restart), the id is derived deterministically from
// the origin string, so re-deriving it always finds the same rule.
function ruleIdForOrigin(origin: string): number {
  let hash = 0;
  for (let i = 0; i < origin.length; i++) {
    hash = (hash * 31 + origin.charCodeAt(i)) | 0;
  }
  // Rule IDs must be positive; DNR does not accept 0.
  return hash & 0x7fffffff || 1;
}

// Header conflict with IapClient's own `fetch`: this rule applies to *any* matching request
// from this extension, including the SW's own fetch() calls in @iap-demo/iap-auth — so the
// module's own requests have their Authorization header overwritten by this rule's `set`.
// Normally both carry the same value; during a refresh window they can diverge and DNR wins.
// Since the rule is only ever updated to the current token, DNR winning is the safe outcome
// — see the matching note on IapClient#fetch in packages/iap-auth/src/client.ts.
export async function setAuthorizationRule(origin: string, token: string): Promise<void> {
  const id = ruleIdForOrigin(origin);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: 'Authorization',
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: `Bearer ${token}`,
            },
          ],
        },
        condition: {
          urlFilter: `|${origin}/*`,
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.OTHER,
          ],
        },
      },
    ],
  });
}

// Removed rather than left in place with a stale header — a request into this gap gets a
// plain 401, which is correct and unavoidable (see PROMPT.md's "rule-update window" note).
export async function removeAuthorizationRule(origin: string): Promise<void> {
  const id = ruleIdForOrigin(origin);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
}
