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

Builds come from `versions.json` (1.0.0–1.0.2 = schema 1–3, 1.1.0 = +`tabs`, `ext-1.0.3-evil.crx` = other key).
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
  `lib.js` + `test.html` are test hooks (strip them from production builds).
- `keys/key.pem` — signing key, generated on first build. **Keep it**: a new key = a new extension ID.
- `update-server/` — dependency-free Node server (gupdate XML, CRX hosting, admin API).
- `browser/` — Debian Chromium + puppeteer-core test runner.
