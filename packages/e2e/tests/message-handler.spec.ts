import type { ProbeOutcome } from '../../extension/src/shared/messages.ts';
import { expect, test } from '../src/fixtures.ts';

// Checkpoint-3 review, Task 2: handleProbe() previously had no try/catch at all, so a throw
// from client.probe() left sendResponse uncalled — the caller's chrome.runtime.sendMessage()
// just hung forever, with no error and no timeout of its own.
//
// The specific unwrapped call site was probe()'s *first* request (before any 401 challenge is
// even parsed) — a later failure fetching the resource_metadata document itself is already
// caught inside client.probe()'s own try/catch (see client.ts), so an endpointUnreachable
// scenario doesn't reach the bug. Going fully offline does: it fails that first request
// directly. This must fail before the fix — verified directly (not asserted from memory): with
// handleProbe reverted to `return client.probe(resource);`, this test failed by hanging past
// the bounded timeout below, exactly as predicted.
test('probe while offline responds within a bounded time, classified TRANSPORT', async ({
  extensionContext,
  driver,
}) => {
  await extensionContext.setOffline(true);
  try {
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000));
    const result = await Promise.race([
      driver.send<ProbeOutcome>({ type: 'probe', resource: 'https://localhost:4020' }),
      timeout,
    ]);

    expect(result).not.toBe('timeout');
    const outcome = result as ProbeOutcome;
    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') expect(outcome.reason).toMatch(/^TRANSPORT:/);
  } finally {
    await extensionContext.setOffline(false);
  }
});
