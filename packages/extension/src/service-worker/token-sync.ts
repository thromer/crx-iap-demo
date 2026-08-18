// Pure ordering logic for the SW's onTokenChanged listener, factored out of index.ts so the
// ordering is unit-testable without chrome.* globals. syncToken() itself makes no chrome.*
// calls — index.ts wires it to the real DNR functions and the real currentTokenIds publish; a
// test can swap in fakes (one with a controllable delay) to observe the ordering directly
// (checkpoint-3 review, Task 10). Not a hook: the shipped SW calls this with the real
// functions and behaves identically — no test flag, no conditional, no behavioral branch.
export interface TokenSyncEffects {
  updateRules(token: string | null): Promise<void>;
  publishTokenId(tokenId: string | null): void;
}

// Awaits updateRules before publishTokenId, matching Component A's documented contract:
// listeners are awaited before the triggering call resolves, so the DNR rule is in place
// before anything else — including a side channel like an offscreen document's direct
// 'currentTokenId' query — can observe the change. `updateRules`/`publishTokenId` are already
// closed over whatever resource this call concerns; syncToken only owns the ordering.
export async function syncToken(
  token: string | null,
  tokenId: string | null,
  effects: TokenSyncEffects,
): Promise<void> {
  await effects.updateRules(token);
  effects.publishTokenId(tokenId);
}
