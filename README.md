# Self-hosted Chromium extension — real upgrade E2E in Docker

Prototype for testing **real upgrades of a self-hosted (non-Web-Store) Chrome/Chromium extension**:
Chromium installs the extension from our own update server via enterprise policy, we publish a new
version, and Chromium's own updater picks it up — all inside an isolated Docker network, driven by
puppeteer-core. Tested with Chromium 156 (Debian trixie), Node 24.

```
make build       # pack every version in versions.json into dist/crx (same key => same ID)
make e2e         # update-server + Chromium in an isolated network, runs every scenario in tests/
make e2e-headed  # same, headed Chromium under Xvfb
make e2e-debug   # + verbose Chromium extension/updater logs and artifacts/<scenario>/netlog.json
TESTS=tests/failures.test.mjs make e2e   # run one scenario file
```

On Omarchy, docker needs sudo by default; the Makefile adds it only for `docker compose`
(build outputs stay owned by you). `omarchy-setup-security-sudoless-docker` removes the prompt.

## Scenarios (`tests/*.test.mjs`)

| File | What it proves |
|---|---|
| `upgrade` | force-installed 1.0.0 → 1.0.1 via Chromium's real updater; storage migrated |
| `versions` | manifest listing several versions: `[1.0.1, 1.0.2]` steps one version per check; `[1.0.2, 1.0.1]` jumps straight to 1.0.2 (both migrations run at once) |
| `failures` | CRX signed with another key, truncated CRX, server 503 → all rejected, 1.0.0 + data intact; then recovers on the next browser start. Publishing a lower version → `no_update` |
| `page-open` | update while an extension page is open → `onUpdateAvailable` → `reload()` applies it |
| `permissions` | 1.1.0 adds `tabs`: force-installed → granted silently; normal (external) install → updated but disabled until the user approves |
| `content-scripts` | ✅ 2.0.x content scripts (MAIN + ISOLATED) across updates with tabs left open: orphaning, re-injection per manifest rules, state handoff, nothing runs twice (see [Content scripts across updates](#content-scripts-across-updates)) |

Builds come from `versions.json` (1.0.0–1.0.2 = schema 1–3, 1.1.0 = +`tabs`, `ext-1.0.3-evil.crx` = other key,
2.0.0–2.0.2 = + the `content-scripts` manifest patch).
The update server's admin API (`POST /_admin/publish {entries, mode}`) sets the manifest entries
(in order) and a failure mode (`ok` | `down` | `corrupt`).

### Results (Chromium 156.0.8078.79, headless, 2026-11-20)

| Scenario | Result |
|---|---|
| Happy path 1.0.0 → 1.0.1, force-installed | ✅ update installed ~4s after `requestUpdateCheck()`; storage migrated |
| `[1.0.1, 1.0.2]` oldest first | ✅ check 1 → 1.0.1, check 2 → 1.0.2 (events `1.0.0->1.0.1`, `1.0.1->1.0.2`) |
| `[1.0.2, 1.0.1]` newest first | ✅ one check → 1.0.2, migrations 2+3 ran in one `onInstalled`; 1.0.1 never downloaded |
| CRX signed with a different key | ✅ downloaded, rejected; 1.0.0 + data intact, still enabled |
| Lower version published | ✅ `requestUpdateCheck()` → `no_update`, nothing downloaded |
| Update while extension page open | ✅ `onUpdateAvailable` fired on 1.0.0 → `reload()` → 1.0.1 in ~2s |
| New permission, force-installed | ✅ 1.1.0 installed, enabled, `tabs` granted silently |
| New permission, normal (external) install | ✅ *observed*: 1.1.0 installed on disk but extension **disabled** (`DISABLE_PERMISSIONS_INCREASE`), `tabs` not granted, `onInstalled` held until re-enabled. The first test version waited on the wrong signal (see gotcha 7); fixed assertion not yet re-run |
| Truncated CRX, server 503, recovery | ⏳ first version relied on the periodic updater, which never fired (gotcha 8); rewritten to use browser restarts, not yet re-run |


## Content scripts across updates

**Question:** keep content scripts working across an update without reloading tabs, with several
`content_scripts` entries (matches / exclude_matches / globs / all_frames) plus MAIN-world page scripts.

### What Chromium does

Verified with the real updater in Docker (Chromium 156, `tests/content-scripts.test.mjs`: 15/15 steps pass, 2026-11-20).
First observed on Chromium 155 locally, using unpacked reloads (the same unload/load as an update).

1. **Old scripts keep running in open tabs, orphaned.** Timers, DOM listeners, and UI they added
   stay. In the ISOLATED world `chrome.runtime.id` becomes `undefined` and `chrome.runtime.sendMessage`
   throws `Extension context invalidated.` The MAIN world can't tell at all. The old manifest CSS
   **stays applied**.
2. **The new version is not injected into existing tabs**, only on later navigations. There is one
   exception: a document still **parsing** when the update lands *does* get the new version's
   `document_idle` scripts from Chromium.
3. **A reloaded extension gets a new isolated world**, even for the same version. The new ISOLATED
   script can't see the old one's globals; the two share only the DOM. Within one load, re-running a
   script lands in the *same* isolated world (so top-level `const` would throw: wrap scripts in an
   IIFE). The MAIN world is the page's realm, shared by every version.
4. `chrome.scripting.executeScript` on a tab whose top frame we have no host access to fails
   (`Cannot access contents of the page…`) even when a subframe matches.
5. **The back/forward cache is flushed when the extension unloads** (`NotRestoredReason: CacheFlushed`).
   Going back reloads the page, which gets the new version from the manifest; no orphans come back.
   Separately, `Cache-Control: no-store` pages never enter the cache, which is why the test server
   serves its pages with `no-cache`.
6. On a renderer that's busy (a long JS loop), `executeScript` doesn't fail; it just waits.

### Recommended approach

- **Re-inject from the service worker** (`extension/reinject.js` + `sw.js`), **once per extension
  load**. `chrome.storage.session` is cleared whenever the extension unloads, so the first worker
  start after install, update, `runtime.reload()`, re-enable or browser start does it.
  `onInstalled` wakes the worker for install/update/reload. After a re-enable, the first tab event
  does. `onlyMissing` skips frames where this load's scripts already run (e.g. after a browser
  restart).
  - Read `chrome.runtime.getManifest().content_scripts` and replay each entry per frame:
    matches/exclude_matches (a pattern without a port matches any port), include/exclude_globs,
    `all_frames`, `world`, `css`, `run_at`, in manifest order.
  - Find frames by probing the tab with `executeScript({allFrames:true, func})`. It returns
    `frameId` + `documentId`, the URL the document **loaded** at (as Chrome matches), whether it's
    still parsing, and whether this load's scripts already run there.
  - Inject by `documentIds`, so a frame that navigated meanwhile is skipped (it got the manifest
    scripts). `document_idle`/`document_end` entries wait for `DOMContentLoaded` in documents still
    parsing.
  - Every step has a timeout (5s). A tab that doesn't answer is retried when it's activated and
    every 30s (`chrome.alarms`). Active tab first, 4 tabs in flight.
  - Needs `scripting`, `alarms` + host permissions: no new permission warning.
- **Make every script a single instance per frame and world with an explicit handoff**
  (`extension/cs-lifecycle.js`). Last one wins: the new instance takes the state and the old one
  tears everything down (listeners, timers, page hooks, DOM):
  - **MAIN:** same realm, so the new instance calls the old one through a `Symbol.for` global.
    The page can see this, as it can everything in MAIN.
  - **ISOLATED, new load:** different realm, so it uses a **synchronous DOM event handshake**
    (`takeover` → old replies `state` → old shuts down). Only an *orphaned* instance yields to the
    event, so pages can't knock a live script out. The page can read and forge this state, so
    validate it and keep secrets out of it (use `chrome.storage.session`).
  - **ISOLATED, same load re-run:** same realm, so the global path works.
  - State is JSON-round-tripped on **both** paths, so a non-JSON state bug can't hide until a real update.
  - **Orphan detection:** ISOLATED instances check `chrome.runtime?.id` in every handler plus a 1s
    watchdog. When it's gone they go *dormant*: torn down, holding their final state for a successor.
    A dormant ISOLATED instance tells its MAIN partner to stop, but only once its own extension
    context is gone. MAIN obeys only a partner that **started after it** (`performance.now()`, the same
    clock in both worlds). A late stop from an old partner therefore can't hit a successor, even on a
    same-version reload.
  - **`start()` may throw** without losing state: the instance becomes `failed` and holds what it was
    handed, so the next instance still gets it.
  - **`document.open()`** erases every listener on `document`/`window` and replaces the DOM. The
    watchdog (both worlds) notices the new `documentElement` and restarts the instance with its state
    (`stop({reason: 'reopened'})`, then `start(state)`).
  - Re-injection follows manifest order, so MAIN (document_start) is replaced before ISOLATED.

### Edge cases

| Case | Status | Where |
|---|---|---|
| Tab hung (busy loop, debugger, `alert()`, frozen) | **Fixed:** per-step timeout; retry on activation / 30s alarm | test: hung tab |
| Same-version reload stopped the new MAIN script | **Fixed:** MAIN stop keyed by start time | test: same-version reload |
| Chromium's own `document_idle` injection + ours in a parsing tab: sibling takeover stopped MAIN | **Fixed:** partner stop only when orphaned | test: parsing tab |
| `start()` throws (e.g. no `<body>` yet) | **Fixed:** `failed` keeps state; reinject waits for DOMContentLoaded; scripts attach on DOMContentLoaded | test: parsing tab |
| Re-enable after disable (no `onInstalled`) | **Fixed:** once-per-load trigger. *Not tested:* a force-installed extension can't be disabled; same mechanism as the tested `runtime.reload()` | — |
| SPA `pushState`'d across an exclude rule | **Fixed:** match the load URL (navigation entry) | test: SPA |
| `document.open()` / late `document.write()` | **Fixed:** watchdog restarts both worlds | test: document.open |
| Non-JSON state works in-realm, breaks across updates | **Fixed:** JSON on both paths | — |
| Hundreds of tabs | **Mitigated:** active first, 4 in flight | — |
| Back/forward cache restores orphans | **Not an issue:** cache flushed on unload | test: back/forward |
| Prerendered page activated after an update | *Unverified;* probably discarded like the bfcache. If not, a `tabs.onUpdated` + `onlyMissing` top-up would fix it (wakes the worker on every page load) | — |
| **First rollout** from a version without `cs-lifecycle.js` | *Can't fix:* old scripts don't answer; their listeners run until reload. Mitigate: remove the old version's known DOM nodes ([example](docs/content-scripts-examples.md#9-first-rollout-clean-up-after-a-version-without-the-lifecycle)); old handlers fail on `chrome.*` | docs |
| Code that doesn't check `ctx.alive()` (frameworks) | *Inherent:* runs until `stop()`; ≤1s normally, up to a minute in throttled background tabs, never in frozen ones. `stop()` must fully unmount | docs |
| Late `document_start` | *Inherent:* a re-injected MAIN hook misses references the page took earlier (`const f = fetch`) | docs |
| State shape changes between versions / rollback | *Convention:* version the state, ignore unknown fields ([example](docs/content-scripts-examples.md#10-state-schema-versions)) | docs |
| Page stops the handshake events, freezes `fetch`/`history`, calls `handle.yield()` (MAIN) | *Inherent:* worst case is fresh state or a hook that fails to install (`failed`), never a double run | docs |
| Matching iframe in a page without host access | *Gap:* `webNavigation.getAllFrames` would fix it but adds a warning permission | main test |
| `match_about_blank` / `match_origin_as_fallback`, IPv6, punycode, `file://` | *Gap* in the hand-written matcher | — |
| Site access restricted by the user / `activeTab` | *Minor divergence:* `activeTab` can let re-injection reach a tab Chrome wouldn't inject | — |
| Frames matched only by MAIN entries | *Churn:* `onlyMissing` can't see MAIN-only frames, so they're re-run (harmlessly) on every trigger | — |

### What the tests check (`tests/content-scripts.test.mjs`)

Pages on `site-a/b/c.test` (compose aliases of the update server). Each embeds an iframe from
site-b; one page is on `update-server` (no host access). The manifest has MAIN + ISOLATED entries
with `exclude_matches: http://*/private/*` and `exclude_globs: */nocs/*`, plus a top-frame-only badge
with `include_globs: */page.html*`. Instance records go to `<html data-ue>`.

**Main scenario**
1. 2.0.0: Chromium's own injection follows the rules (baseline); seed 2 clicks + 1 navigation.
2. 2.0.0 → 2.0.1 with re-injection switched off (`autoReinject=false`): old instances orphaned
   (watchdog, `Extension context invalidated.`), MAIN stopped by its partner, no UI left, CSS still
   applied, no 2.0.1 in open tabs, 2.0.1 in a freshly opened one.
3. Manual re-injection: 2.0.1 everywhere the rules say. ISOLATED took the state `via: event`,
   MAIN `via: global`; foreign page's iframe not reached (gap above).
4. 2.0.1 → 2.0.2: re-injected automatically on the new load; state chain continues.
5. Re-injected tabs == what Chromium injects into fresh tabs, per frame.
6. A click + `pushState` are counted once, by 2.0.2 only; one panel, one badge.
7. Re-injecting 2.0.2 again: replaced in-realm (`via: global`), still one instance per script.

**Edge cases** (own browser)
1. `document.open()` + `write()`: both worlds restart; clicks and the MAIN→ISOLATED channel work again.
2. SPA `pushState` into `/private/`: Chrome keeps the scripts.
3. Back/forward cache works for these pages (control).
4. Update to 2.0.1 while a tab is parsing (20s parser-blocking script): re-injection waited for
   `DOMContentLoaded`, no `failed` instances, one instance per script once loaded.
5. SPA re-injected by its load URL; the reopened document re-injected with its state.
6. Back after the update: not restored (`CacheFlushed`), reloaded with 2.0.1, no orphans.
7. Same-version `runtime.reload()` with site-c hung for 20s: healthy tabs re-injected (new isolated
   world, `via: event`), MAIN still live 2.5s later, the hung tab reported `timedOut`.
8. Once the hang ends, the tab is re-injected by activation or the retry alarm.

## Flow (happy path)

1. Chromium force-installs 1.0.0 via `ExtensionInstallForcelist` → `http://update-server:8080/updates.xml`.
2. Test seeds data through `chrome-extension://<id>/test.html`.
3. Test publishes 1.0.1 (`POST /_admin/publish`) and calls `chrome.runtime.requestUpdateCheck()`.
4. Test closes the extension page and polls `chrome://extensions-internals` until Chromium's real
   updater has downloaded + installed 1.0.1.
5. `onInstalled(reason=update)` in the service worker migrates storage; test asserts data + events.

Artifacts land in `artifacts/<scenario>/`: server request log, extension storage, Chromium's
prefs for the extension, and its `chrome://extensions-internals` record.

## Findings

### Setup that works

- **Two containers on an `internal: true` compose network:** a tiny Node update server
  (gupdate XML + CRX hosting + an admin API to switch the published version / inject failures),
  and Chromium + the test runner.
- **Install via enterprise policy** (Linux): `/etc/chromium/policies/managed/*.json`
  ```json
  { "ExtensionInstallForcelist": ["<EXT_ID>;http://update-server:8080/updates.xml"],
    "DeveloperToolsAvailability": 1 }
  ```
- **Plain HTTP update URLs work** for policy installs on Linux; no TLS needed for testing.
- **Stable ID across versions** = same signing key. ID = first 16 bytes of
  `sha256(DER SubjectPublicKeyInfo)`, hex digits `0-f` mapped to `a-p`. Packed with the `crx3`
  npm package (CRX3); Chromium accepts these for policy/off-store installs.
- **Update manifest** (`updates.xml`):
  ```xml
  <gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
    <app appid="EXT_ID" status="ok">
      <updatecheck codebase="http://update-server:8080/crx/ext-1.0.1.crx" version="1.0.1"/>
    </app>
  </gupdate>
  ```
  Serve CRX as `application/x-chrome-extension`.
- **Upgrade flow verified:** force-install 1.0.0 → publish 1.0.1 → `chrome.runtime.requestUpdateCheck()`
  → Chromium's real updater downloads + installs → `runtime.onInstalled({reason: "update", previousVersion})`
  runs the storage migration. ~5s end to end.

### Gotchas (each one cost a debugging round)

1. **Policy-installed extensions are invisible to DevTools/CDP by default.**
   `DeveloperToolsAvailability` defaults to 0 = "disallow DevTools on extensions installed by
   enterprise policy". Symptom: Puppeteer never sees the extension's service worker target, and
   navigating to `chrome-extension://<id>/…` fails with *"Navigating frame was detached"*.
   Fix (test env only): `"DeveloperToolsAvailability": 1`.

2. **Background update downloads stall for 3 minutes in headless automation.**
   Symptom: update check says `update_available`, server sends the whole CRX, NetLog shows the
   request completing — but nothing installs and nothing is logged. Root cause (Chromium source):
   - Update CRX fetches are `net::IDLE` priority (first installs are `MEDIUM`).
   - `SimpleURLLoader` writes IDLE downloads to the temp file via `BEST_EFFORT` tasks
     (`simple_url_loader.cc`, `GetTaskPriority()`).
   - `BrowserMainLoop` fences all `BEST_EFFORT` tasks until "startup complete"
     (`scoped_best_effort_execution_fence_`).
   - Startup completes on the first real tab paint; headless `about:blank` never triggers it, so it
     falls back to a **3-minute failsafe** (`AfterStartupTaskUtils::GetFailsafeTimeout()`).

   Fix: `--enable-features=ImprovedStartupBestEffortDelay:StartupDelayFailsafeTimeout/5s`.
   Real browsers with a painted tab are unaffected.

3. **MV3 service workers idle out after ~30s and Puppeteer doesn't keep them attached.**
   Drive the extension through an extension page (`chrome-extension://<id>/test.html` with the same
   `chrome.*` APIs) instead of the worker. Close that page while waiting for an update — an open
   extension page counts as activity.

4. **Puppeteer default flags break this:** remove `--disable-extensions`,
   `--disable-background-networking` (kills the updater), `--disable-component-extensions-with-background-pages`,
   `--disable-default-apps` via `ignoreDefaultArgs`.

5. **`requestUpdateCheck()` backs off ~5h** (`kDefaultUpdateFrequency`) after any check that
   doesn't end in an install; a successful install resets it. Recovery tests must rely on the
   periodic updater (`--extensions-update-frequency=<s>`), which is also how real clients recover.

6. Node 24's `node --test` needs a glob (`'tests/**/*.test.mjs'`), not a directory name.

7. **`chrome://extensions-internals` shows a stale version for disabled extensions.** After an
   update that adds a permission (non-policy install), the extension is disabled and internals keeps
   reporting the *old* version, while the profile (`Default/Preferences` →
   `extensions.settings[<id>].manifest.version`, `Default/Extensions/<id>/1.1.0_0`) shows the new
   one is installed. Check `disable_reasons`, not just the version.

8. **Periodic update checks are hard to rely on in tests.** `--extensions-update-frequency` is
   clamped to ≥30s in release builds (`kMinUpdateFrequency`), jittered ±20%, and posted as a
   `BEST_EFFORT` task. With it set to 15 (→30s), no periodic check was observed within 65s after a
   rejected update — cause not yet pinned down. Tests use `requestUpdateCheck()` or a browser
   restart (startup check) instead.

### Several versions in one update manifest

From `safe_manifest_parser.cc` and `ExtensionDownloader::GetUpdateAvailability()` (Chromium 156):

- One `<updatecheck>` per `<app>`; list multiple versions by **repeating `<app appid="SAME_ID">`**.
- Chromium walks entries **in document order** and takes the **first** one newer than the installed
  version (and satisfying `prodversionmin`) — **not** the highest.
- **One install per update check**; no chaining.

| Listed order | From 1.0.0 |
|---|---|
| newest first `[1.0.2, 1.0.1]` | jumps straight to 1.0.2 |
| oldest first `[1.0.1, 1.0.2]` | 1.0.1 now, 1.0.2 on the *next* check (~5h in the wild) |

Recommendation: publish only the newest version and make migrations cumulative. Multiple entries
are mainly useful with `prodversionmin` to serve a fallback build to older browsers.

### Debugging toolkit that paid off

- `chrome://extensions-internals` — JSON per extension: version, location, `disable_reasons`,
  active permissions, keepalives. It's WebUI, so polling it doesn't count as extension activity.
- `--enable-logging=stderr --vmodule=*extension*=2,*crx*=2,*install*=2,*updat*=2` +
  Puppeteer `dumpio: true`. The key line: `extension_updater.cc … <url> written to <tmp>` (missing =
  download never reached disk).
- `--log-net-log=<file> --net-log-capture-mode=Everything` — proved the network side was fine.
- Profile `Default/Preferences` → `extensions.settings[<id>]` and `Default/Extensions/<id>/` —
  shows whether an update was unpacked / delayed.
- Reading Chromium source at the exact tag:
  `https://chromium.googlesource.com/chromium/src/+/refs/tags/<version>/<path>?format=TEXT` (base64).

## Layout

- `extension/` — source; `__VERSION__`, `__SCHEMA__`, `__UPDATE_URL__` substituted per version.
  `reinject.js` + `cs-*.js` = the content-script approach above (`data-ue` reporting is a test probe).
- `docs/content-scripts-examples.md` — how to use that approach in your own extension (code examples).
- `docs/upgrade-best-practices.md` — designing an extension for seamless upgrades: messaging, data, registrations, UI, releases, testing.
- `skills/extension-upgrade-review/` — a Claude Code skill that reviews any MV3 extension project against
  these guidelines. It's read-only: a report with `file:line` evidence and suggested fixes. Install:
  `cp -r skills/extension-upgrade-review ~/.claude/skills/`, then ask Claude Code to "review this
  extension for upgrade safety". It includes a dependency-free scanner (`scripts/scan.mjs`) that
  limits the review to code reachable from the manifest's entry points, a checklist, fix patterns,
  the tested reference implementations, and `evals/` test cases (not run yet).
  `lib.js` + `test.html` are test hooks (strip them from production builds).
- `keys/key.pem` — signing key, generated on first build. **Keep it**: a new key = a new extension ID.
- `update-server/` — dependency-free Node server (gupdate XML, CRX hosting, admin API).
- `browser/` — Debian Chromium + puppeteer-core test runner.
