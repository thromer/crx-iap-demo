# Checkpoint 3 review — questions before sign-off

Answer these in a single reply. Where a question asks for code or a diff, paste it rather than
describing it. Do not change any code while answering — this is a review pass. If a question
rests on a false premise, say so instead of answering around it.

---

## A. The `UNKNOWN` classification

`UNKNOWN` is not one of the five classes in the spec's classification table (`TOKEN_STALE`,
`GRANT_DEAD`, `FORBIDDEN`, `TRANSPORT`, `MISCONFIGURED`).

1. Does `UNKNOWN` exist as a declared member of the error type, or was it a stringly-typed
   fallback? Paste its definition.
2. What is its response policy? Specifically: can any code path reach `launchWebAuthFlow`, a
   token refresh, or a retry as a result of an `UNKNOWN`?
3. Was it present since checkpoint 1, or added during checkpoint 3? If earlier, what were the
   unit tests asserting about it?
4. Enumerate every code path that can still produce `UNKNOWN` today.

## B. Scope of the `TypeError` fix

5. Is there now a single chokepoint through which all module-issued network calls pass, or are
   the two `issueResourceRequest` call sites individually wrapped?
6. List every place the module initiates a network request — including calls made *by*
   `oauth4webapi` on the module's behalf: `resourceDiscoveryRequest`, `discoveryRequest`,
   `dynamicClientRegistrationRequest`, `authorizationCodeGrantRequest`,
   `refreshTokenGrantRequest`, and revocation. For each, state whether a raw `TypeError` is
   currently caught and classified as `TRANSPORT`.
7. Does `oauth4webapi` wrap network failures in its own error type, or do raw `TypeError`s
   propagate out of its primitives? This determines whether the chokepoint belongs around our
   calls or around a custom `fetch` implementation handed to the library.

## C. Hook contamination — highest priority

8. Paste `git diff` of `packages/extension/src/` from the checkpoint-2 tag to HEAD. **If it is
   empty, say so explicitly.**
9. What is the current driving mechanism, concretely? Is the `sendMessage` issued from a page
   context (popup or another extension page), or from within the service worker by some other
   means?
10. Does anything in the shipped artifact exist solely to make the harness work — an exported
    global, a message type the popup never uses, a build-time conditional, an extra HTML page?

## D. Environment workarounds

11. `channel: 'chrome'` refusing to load the extension is a significant divergence. What is the
    harness launching instead, and what browser and version does it report at runtime? Bundled
    Chromium and stable Chrome differ on extension and `chrome.identity` behavior.
12. Given that a dead handle's `evaluate()` hangs rather than throwing, how does the harness
    currently detect that a worker is dead? If the answer is a timeout: what is it, and how
    much wall-clock does it add across the suite?
13. What is `wakeWorker()` doing now?

## E. Did the checkpoint actually pass

14. Of tests 1, 8, 10, 15, 23, 40, 53, 57 — which ran green, which are skipped, and were any
    assertions weakened relative to the spec? In particular: are the "no prompt" assertions
    racing the `page` event as specified, or sleeping?
15. For test 53, confirm the stand-in's request genuinely originated inside a dedicated Worker
    rather than a same-document `fetch`. How is that established?
16. Did the checkpoint-2 DNR `set`-`Authorization` primitive check pass against the real test
    server? Which failure-detection path was chosen — typed library errors or SW polling — and
    where is that decision documented?
