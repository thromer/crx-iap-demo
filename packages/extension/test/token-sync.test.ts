import { describe, expect, it } from 'vitest';
import { syncToken } from '../src/service-worker/token-sync.ts';

// Checkpoint-3 review, Task 10. This is the extension-side half of Component A's ordering
// contract: the SW's onTokenChanged listener must have the DNR rule in place before anything
// else — including the offscreen document's direct 'currentTokenId' query — can observe the
// change. syncToken() owns that ordering in isolation, decoupled from chrome.* globals, so it
// can be proven here with a slow fake instead of racing a real browser API (which cannot be
// forced slow — see docs/mutation-check.md's mutation 8 for why e2e can't do this).
describe('syncToken()', () => {
  it('awaits updateRules before calling publishTokenId', async () => {
    let rulesUpdated = false;
    const order: string[] = [];

    await syncToken('tok', 'id1', {
      updateRules: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rulesUpdated = true;
        order.push('updateRules');
      },
      publishTokenId: (id) => {
        // The point of the test: this must observe rulesUpdated already true, not just run
        // after updateRules in program order.
        expect(rulesUpdated).toBe(true);
        expect(id).toBe('id1');
        order.push('publishTokenId');
      },
    });

    expect(order).toEqual(['updateRules', 'publishTokenId']);
  });

  it('passes the token through to updateRules and the tokenId through to publishTokenId', async () => {
    const seenTokens: (string | null)[] = [];
    const seenTokenIds: (string | null)[] = [];

    await syncToken('tok-a', 'id-a', {
      updateRules: async (token) => {
        seenTokens.push(token);
      },
      publishTokenId: (id) => {
        seenTokenIds.push(id);
      },
    });
    await syncToken(null, null, {
      updateRules: async (token) => {
        seenTokens.push(token);
      },
      publishTokenId: (id) => {
        seenTokenIds.push(id);
      },
    });

    expect(seenTokens).toEqual(['tok-a', null]);
    expect(seenTokenIds).toEqual(['id-a', null]);
  });
});
