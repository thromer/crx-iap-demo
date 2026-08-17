import { describe, expect, it, vi } from 'vitest';
import { respond } from '../src/service-worker/dispatch.ts';

// Task 2 (checkpoint-3 review follow-up): "exactly-once needs a test, not just care." The
// failure mode is silent either way — a double sendResponse throws inside the listener where
// nobody sees it, and a zero-response hangs with no error. Both directions are asserted here.

describe('respond()', () => {
  it('calls sendResponse exactly once with the mapped success value when work resolves', async () => {
    const sendResponse = vi.fn();
    const onError = vi.fn();
    respond(
      () => Promise.resolve(42),
      (value) => value * 2,
      onError,
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(84);
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls sendResponse exactly once with the mapped error when work rejects', async () => {
    const sendResponse = vi.fn();
    const onSuccess = vi.fn();
    const err = new Error('boom');
    respond(
      () => Promise.reject(err),
      onSuccess,
      (e) => ({ failed: e }),
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ failed: err });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // The case a naive `work().then(onSuccess, onError)` gets wrong: onSuccess itself throwing
  // does not route to onError under plain .then() semantics, since that only catches a
  // rejection of the original promise — see dispatch.ts's doc comment.
  it('calls sendResponse exactly once with the mapped error when onSuccess itself throws', async () => {
    const sendResponse = vi.fn();
    const err = new Error('mapping failed');
    respond(
      () => Promise.resolve('ok'),
      () => {
        throw err;
      },
      (e) => ({ failed: e }),
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ failed: err });
  });

  it('never calls sendResponse more than once even when onSuccess is async and slow', async () => {
    const sendResponse = vi.fn();
    respond(
      () => Promise.resolve(1),
      async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return value + 1;
      },
      () => 'error',
      sendResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(2);
  });
});
