# Manual verification

Only for what genuinely cannot be automated. This file currently holds one item, produced by
the checkpoint-3 review's Task 6 (diagnosing the `channel: 'chrome'` divergence). The full
8-item list PROMPT.md specifies for this file (real library conformance, real IdP conformance,
Cloudflare's PKCE parsing bug, SSO carry-over, real MFA, policy denial, packed build, and a
comprehensibility walkthrough) is checkpoint 5's deliverable and has not been written yet —
this item is filed here now, ahead of that, because it is a harness-environment finding the
review specifically asked not to leave buried in a fixtures.ts comment.

---

## 1. `channel: 'chrome'` cannot load an unpacked extension in this environment — diagnosed, not fixable here

**Status:** confirmed root cause. Not fixable via Playwright launch configuration. The automated
suite runs on Playwright's bundled Chromium instead; see "What this leaves unverified" below.

### What was observed

`packages/e2e`'s fixtures omit `channel: 'chrome'` from `chromium.launchPersistentContext(...)`,
diverging from PROMPT.md's Component D launch snippet. Passing `channel: 'chrome'` (real,
installed Google Chrome — version 151.0.7922.137 stable in this environment) results in the
extension never registering a service worker at all: `context.serviceWorkers()` stays empty and
`context.waitForEvent('serviceworker')` times out.

### Root cause

Launching the real `google-chrome-stable` binary directly (bypassing Playwright entirely) with
`--enable-logging=stderr --v=1` and inspecting stderr shows the exact cause:

```
[...] WARNING:chrome/browser/extensions/extension_service.cc:441] --disable-extensions-except is not allowed in Google Chrome, ignoring.
```

Official, Google-branded Chrome builds contain a source-level guard that silently discards the
`--disable-extensions-except` command-line flag — a restriction Chromium's own open-source
builds (including Playwright's bundled Chromium) do not have. `--load-extension` and
`--disable-extensions-except` are meant to be used together (Playwright's own default args
otherwise include `--disable-extensions`, which wins over `--load-extension` unless excluded —
see finding 2 in `packages/e2e/src/fixtures.ts`'s header); with the exempting flag discarded,
the unpacked extension the command line names never gets a chance to stay enabled the way it
does in Chromium.

This is intentional, documented-in-source Google Chrome policy — believed to exist specifically
so unpacked/sideloaded extensions can't be silently force-installed via command-line flags
against the branded binary outside its normal Developer Mode UI toggle, which requires a real
user gesture. It is not a Playwright bug, not an environment misconfiguration, and not specific
to this sandbox.

### Why it is not fixed here

Two theoretical escape hatches were checked and ruled out:

- **A newer automation-specific flag.** Some Chromium command-line switches exist specifically
  to relax automation restrictions (e.g. `--enable-unsafe-swiftshader`,
  `--enable-unsafe-webgpu`, which this same binary does honor). `strings` against the installed
  `chrome` binary found no `--enable-unsafe-extension-debugging`-shaped equivalent for this
  restriction in this Chrome version.
- **Enterprise policy files** (`ExtensionInstallAllowlist` / `ExtensionInstallForcelist`,
  written to `/etc/opt/chrome/policies/managed/`) can permit specific extension IDs machine-wide
  through Chrome's managed-policy system. This was **not attempted**: it requires root, applies
  machine-wide rather than to this project, and is not something a test harness should silently
  configure on the host it runs on. It would also need to be re-applied identically on every
  machine that ever runs this suite against real Chrome, which defeats a large part of the
  point of an automated, portable harness.

### What this leaves unverified

The entire automated `packages/e2e` suite runs against **Playwright's bundled Chromium**
(open-source, unbranded), not the redistributable Google Chrome build end users actually run.
Bundled Chromium in this environment reports as `151.0.7922.34`; installed stable Chrome
reports `151.0.7922.137` — same major version, different exact build. Behaviors that are
plausible candidates for divergence between the two, and are **not otherwise covered** by
manual verification item 7 below (packed build) or item 2 (real IdP conformance):

- `chrome.identity.launchWebAuthFlow`'s exact interactive-tab and cookie-jar-sharing behavior.
- `declarativeNetRequest` header-modification semantics (`set` vs `append`, timing of rule
  application relative to request dispatch) — this project's design leans on DNR being reliable
  at the network layer below any JS context; if Chromium and Chrome diverge here specifically,
  it would matter.
- Any Google-account-integration-adjacent behavior in extension loading itself (not expected to
  matter for this project, since the extension makes no Google-specific API calls, but
  unconfirmed).

**What to do by hand:** load the built, *packed* extension (see manual-verification item 7,
once written) into a real, stable Google Chrome profile with Developer Mode enabled via the
`chrome://extensions` UI (the one path real Chrome does allow), and re-run the manual smoke
flow described in items 1–2 of this file's eventual full list. This is deliberately the same
loading mechanism a real end user would use, since that is exactly the case
`--disable-extensions-except` cannot stand in for.

---

## 2. Watch for redundant refreshes against real Cloudflare Access, checkpoint-3 review Task 16

**Status:** the specific worst-case risk (a redundant refresh consuming an already-rotated
refresh token and tripping replay-detection grant revocation) was proven structurally
unreachable, not just untested — see
`packages/extension/docs/detecting-failure.md`'s "tokenId↔request correlation limitation"
section for the full reasoning and the empirical check (five sequential echo-shaped
`reportRejected` reports against `detectRefreshReplay`, grant survives every time). This entry
exists because the underlying cause — DNR attaches the `Authorization` header below the JS
layer, so this extension can never bind a specific `401` to the specific token value that
request carried — is structural and will behave identically against real Cloudflare Access.

**What to watch for by hand:** under concurrent library activity against a real Cloudflare
Access-protected resource (multiple overlapping requests hitting a locally-expired-looking or
recently-rotated token around the same time), confirm the *frequency* of redundant refreshes
stays low in practice — this project's own test harness can force the race window open
artificially (`tokenEndpointHang`) but cannot observe how often real-world IPC/network timing
alone triggers it. A materially higher redundant-refresh rate than expected wouldn't be a
correctness bug (the grant-survival guarantee above holds regardless of frequency), but it
would mean unnecessary load against Cloudflare's token endpoint worth knowing about before
relying on this pattern at any real scale.
