# Detecting a rejected token (checkpoint-2 decision)

PROMPT.md requires picking between two failure-detection paths before proceeding past
checkpoint 2: wrapping a public error/response path the library already exposes, or a
service-worker polling fallback. This build uses the **first path**.

The stand-in library's Worker (`src/standin/worker.ts`) posts `{status}` back to whoever
commanded it after every request. The offscreen document (`src/offscreen/offscreen.ts`) is
that caller — it is the "wrapper around the library's response path" the decision calls for.
On any `401`, *if* it has a cached tokenId for that resource (pushed from the service worker
via a `tokenChanged` broadcast, or pulled via `currentTokenId` on a cache miss), it calls
`reportRejected(resource, tokenId)`. No cached tokenId (resource never had a token attached —
unprotected, or an app-level 401 unrelated to IAP) means nothing is reported. A `403` is never
reported regardless of status — see test matrix group "DNR attachment", #62.

This is a **narrower integration point than a network primitive**, per PROMPT.md: the
offscreen document reads an outcome the library already handed back, rather than patching or
observing `fetch` itself.

**Assumption this rests on:** the real third-party library, whatever it turns out to be, hands
its caller *some* indication of the response it got — a status code, a thrown error, anything
inspectable. If the real library swallows failed responses entirely and exposes nothing, this
path doesn't apply and the documented fallback is the service worker polling a lightweight
endpoint on its own schedule (PROMPT.md's "genuine downgrade from per-request detection").
That fallback is **not implemented** here, since the stand-in doesn't need it — confirm which
case actually applies once the real library is integrated, and build the fallback only if it's
the one that's needed.
