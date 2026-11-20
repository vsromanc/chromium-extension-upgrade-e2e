# Upgrade-safety checklist

Each rule: **why** it breaks on upgrade, **check** (where to look; `scan:` = the scanner's
section or hit id), **pass** (what good looks like), and the default **severity** if it fails.
Adjust severity to the project: a rule that fails in code that's rarely hit is lower; one that
loses user data is higher.

Evidence marks, as in the source guide: ✓ = verified on Chromium 155/156 with real updates;
○ = general MV3 behaviour, not verified there. Say which kind a finding rests on.

Contents: [A. Content scripts](#a-content-scripts-in-already-open-tabs) · [B. Messaging](#b-messaging) ·
[C. Stored data](#c-stored-data) · [D. Persistent registrations](#d-persistent-registrations) ·
[E. Applying updates and releases](#e-applying-updates-and-releases) · [F. Cross-version surfaces](#f-cross-version-surfaces) ·
[G. Observability and tests](#g-observability-and-tests)

Severity scale:
- **High:** user-visible breakage, lost or corrupted data, or behaviour running twice, on an ordinary update.
- **Medium:** breaks in a realistic but narrower case (a busy tab, rollback, re-enable, a slow page),
  or degrades until the user reloads.
- **Low:** hygiene, or a rare case with a cheap fix.
- **Info:** an observation, no defect.

Applicability: skip a whole section when the scan shows the surface doesn't exist (no content
scripts → A is N/A). Say N/A in the report, briefly.

---

## A. Content scripts in already-open tabs

Applies if any manifest has `content_scripts`, or code calls `registerContentScripts`.

**A1. Existing tabs get the new version.** (High)
- Why: after an update, Chromium leaves the old scripts running orphaned and **does not inject
  the new version into open tabs** ✓. Without re-injection, every open tab loses the feature, or
  runs a zombie, until the user reloads.
- Check: scan `executeScript` / `tabs.query` hits in background code. Look for a loop over tabs
  that injects the manifest's scripts, triggered on install/update.
- Pass: re-injection runs for install **and** update. It's even better if it runs once per
  extension load: a `storage.session` flag checked on worker start, which also covers re-enable
  and `runtime.reload()` ✓.
- Partial: only `onInstalled` (misses re-enable) → Medium.

**A2. Re-injection follows the manifest's matching rules.** (Medium)
- Why: injecting blindly (all tabs, or only `matches`) runs scripts where Chrome wouldn't: pages
  excluded by `exclude_matches`/globs, subframes of `all_frames: false` entries, the wrong world.
- Check: does the injector read `getManifest().content_scripts` (or a shared constant) and apply
  matches, exclude_matches, include_globs, exclude_globs, all_frames, world, css, and run_at
  (`injectImmediately`)? Does it target `documentIds` (a frame that navigated in between already
  got the manifest scripts)? Does it match the URL the document **loaded** at (an SPA that
  `pushState`'d keeps its scripts in Chrome) ✓?
- Pass: rules replayed per frame, in manifest order. Note any manifest features it skips
  (`match_about_blank`, `match_origin_as_fallback`) as Low if the manifest uses them.

**A3. One live instance per frame and world; the old one tears down.** (High)
- Why: re-injection without coordination leaves old **and** new listeners running. Each click is
  handled twice and UI appears twice. The old script's DOM listeners, timers and observers keep
  firing after the update ✓.
- Check: in each content-script entry, is there a "find previous instance → take its state →
  stop it" step? MAIN world: a global (`Symbol.for`/window key). ISOLATED: a DOM handshake,
  because a reloaded extension gets a **new isolated world** and can't see the old globals ✓.
  Does stop/teardown remove *every* listener, interval, MutationObserver, page hook and DOM node?
  (`AbortController` + `{signal}` is the easy way.)
- Pass: explicit single-instance protocol plus complete teardown. Fail: re-injection exists but
  scripts just start (double run). If neither re-injection nor orphan handling exists, report A1
  and A4 instead of A3.

**A4. Orphaned scripts notice and stop.** (High if they act on events; Medium otherwise)
- Why: after unload, `chrome.runtime.id` is `undefined` and `chrome.*` calls throw `Extension
  context invalidated.` ✓. Handlers that keep running throw errors or half-act, and with no
  successor (disabled, uninstalled, no host access) they linger forever.
- Check: `runtime.id check` hits in content scripts. Do handlers bail out when the context is gone?
  Is there a periodic check, or a port `onDisconnect` check, that tears down when no event arrives?
- Pass: guard in handlers plus a watchdog or disconnect-driven teardown.

**A5. Scripts survive being run twice in one realm.** (Medium)
- Why: a re-injected file evaluated in the same world as an earlier run throws
  `Identifier 'x' has already been declared` on top-level `const`/`let`/`class` ✓. This happens
  when the same load injects twice: re-injection racing Chromium's own injection ✓, or a retry.
- Check: scan "Content-script entry files" → top-level const/let/class count. For bundled sources
  (ESM, TS, framework), check the bundle format: Vite/WXT/CRXJS normally emit content scripts as
  an IIFE. Look at the built file if present, or the bundler config.
- Pass: IIFE/module-wrapped output.

**A6. Handed-over state is data, validated, versioned, and holds no secrets.** (Medium)
- Why: the ISOLATED handoff goes through DOM events, which the page can read and forge ✓. A rollback
  hands newer-shaped state to older code. Non-JSON state (Maps, DOM nodes) works within one load
  but breaks across loads.
- Check: the shape of the state passed between instances; validation on receipt; a version field;
  secrets (tokens, PII) going through it.
- Pass: JSON-only, validated, versioned, with secrets kept in `chrome.storage.session` instead.

**A7. MAIN-world hooks are undoable and can't be stopped by the wrong partner.** (Medium)
- Why: a hook installed again on every update wraps the API again, so page events get counted
  twice ✓. The MAIN world can't detect the update itself, so its ISOLATED partner tells it to stop.
  That stop must not hit a successor (keyed by start time, not version: a same-version reload has
  the same version ✓).
- Check: `page API hook` hits. Does teardown restore the original when it's still the outermost
  wrapper, and otherwise become a pass-through? How is the MAIN script told to stop, and how is
  that message scoped?
- Pass: restore or pass-through, plus a stop message scoped so that only an older-or-same-age
  instance obeys it.

**A8. Injected UI and CSS can't clash across versions.** (Medium for heavy manifest CSS; Low otherwise)
- Why: **manifest CSS stays applied** in orphaned tabs ✓. Old rules, renamed or removed in the new
  version, keep styling the new DOM until reload.
- Check: manifest `css` entries; `shadow DOM` hits; how UI is mounted.
- Pass: UI in a shadow root with its styles inside; manifest CSS small and namespaced.

**A9. Busy, loading, and unusual documents don't break re-injection.** (Medium)
- Why: a busy or blocked renderer (long task, `alert()`, debugger, frozen tab) makes
  `executeScript` hang, not fail ✓. A document still parsing has no `<body>` ✓. `document.open()`
  wipes every listener ✓.
- Check: per-tab timeouts, and parallelism so one tab can't stall the rest; a retry for tabs that
  timed out (on activation + alarm); waiting for `DOMContentLoaded` for `document_idle`/`document_end`
  entries; scripts that don't assume `document.body`; a `start()` failure that can't lose the state
  it was handed.
- Pass: most of these. List the missing ones individually (Low–Medium each).

**A10. First rollout of a lifecycle.** (Info / Medium)
- Why: versions shipped *before* the handoff code can't take part. Their scripts never answer a
  takeover, so their listeners run until the tab reloads.
- Check: git history. Did earlier released versions have content scripts without the protocol?
- Pass: a short-lived cleanup of known legacy DOM, and old handlers that fail safely on `chrome.*`.
  Otherwise flag it with the realistic impact.

## B. Messaging

**B1. Service-worker listeners are registered at the top level, synchronously.** (High)
- Why: events that wake a worker are delivered only to listeners registered in its first turn ○.
  A listener added after an `await` or inside a callback misses the very event that started the
  worker: lost messages after every restart, update included.
- Check: background entry files. Are `addListener` calls inside async functions, `.then`,
  `onInstalled`, or conditionals that depend on async values?
- Pass: all at the top level, or synchronously reachable from it.

**B2. Message handlers wait for migrations.** (Medium; High if handlers write migrated data)
- Why: right after an update, a freshly navigated tab already runs the new content script and can
  message the worker **while `onInstalled` migrations are still running**.
- Check: `onMessage`/`onConnect` handlers. Do they await a `ready` promise, or read storage the
  migration is rewriting?
- Pass: handlers gated on migration completion.

**B3. Handlers always answer.** (Medium)
- Why: a handler that returns nothing for an async reply (callback style without `return true`),
  or throws without responding, looks to the caller like a closed port.
- Check: each `onMessage` listener's return path, error path, and unknown message types.
- Pass: promise-based or `return true` + `sendResponse` on every path; errors sent as data.

**B4. Callers handle invalidated contexts and worker restarts.** (Medium)
- Why: from an orphaned content script, `sendMessage` throws `Extension context invalidated.` ✓.
  From a live one, the worker can die mid-request (`message port closed`,
  `Receiving end does not exist`).
- Check: `sendMessage` call sites in content scripts and pages. Try/catch? Retry once on a
  transient error? Idempotency (request id) for anything with side effects?
- Pass: one wrapper that does all three, used everywhere.

**B5. Ports reconnect lazily and detect orphaning.** (Medium)
- Why: ports disconnect on update **and** when the worker idles out. Reconnecting right away from
  every tab keeps the worker alive; never reconnecting loses the channel.
- Check: `connect` hits; `onDisconnect` handlers. Do they check `runtime.id`? Reconnect on next use?
- Pass: both.

**B6. No essential state in worker globals.** (Medium)
- Why: the worker restarts on idle and on update; globals reset ○.
- Check: scan "Module-level mutable state in background entries"; caches that are the only copy
  of something.
- Pass: caches only; anything authoritative is in storage.

## C. Stored data

**C1. Stored data has a schema version and cumulative migrations.** (High where data shape has changed)
- Why: users skip versions. Publishing only the newest version (recommended), or a manifest
  listing newest-first, jumps several versions in one update ✓.
- Check: `schema/migration` hits; how storage is read and written; IndexedDB `onupgradeneeded`.
- Pass: a stored version number; migrations run in order from the stored version to the current one.

**C2. Migrations are idempotent, atomic, and don't depend only on `onInstalled`.** (Medium)
- Why: `onInstalled` can be held: an update that adds a permission stays disabled until the user
  approves, and `onInstalled` waits with it ✓. The worker can also die mid-migration.
- Check: is migration also checked on worker start? Does it write data and schema version in one
  `set`? Is it safe to run twice?
- Pass: all three.

**C3. Readers tolerate older and newer data.** (Medium)
- Why: content scripts and pages can read storage before the migration finishes. A rollback is a
  *higher* version running *older* code (Chromium ignores lower versions ✓), and that code reads
  migrated data.
- Check: readers that destructure fields without defaults; code that deletes unknown fields; data
  removed in the same release that stops writing it.
- Pass: defensive reads; unknown fields preserved.

**C4. User work is persisted continuously.** (Medium)
- Why: extension pages (popup, options, side panel, tabs) are closed by the update ✓, and orphaned
  scripts can't write to storage ✓. Saving on `beforeunload`/teardown is too late.
- Check: forms, drafts and editors in extension pages and injected UI. When do they write?
- Pass: write on change (debounced); restore on open.

## D. Persistent registrations

Applies when the code registers things that outlive a version ○.

**D1. Context menus are re-created idempotently.** (Medium) `removeAll()` before `create`, or
create with handled duplicate-id errors. Otherwise: "Cannot create item with duplicate id" on
update, or stale menus.

**D2. Alarms aren't duplicated or lost.** (Low) `alarms.get` before `create`, or a deliberate reset.

**D3. Dynamic and session DNR rules are reconciled.** (Medium) On update, remove existing ids and
add the wanted set, or diff them. Watch for rule-id collisions with the old version.

**D4. Registered content scripts are reconciled and re-injected.** (Medium)
`getRegisteredContentScripts` → unregister or update → register; files the old version named may
not exist any more. They're content scripts too: A1–A9 apply.

## E. Applying updates and releases

**E1. Pending updates are applied at a safe moment.** (Low–Medium)
- Why: an open extension page delays the update, and `onUpdateAvailable` fires ✓. Without a
  handler, the update waits until the extension is idle, possibly for a long time. Reloading
  blindly interrupts work in progress.
- Check: `onUpdateAvailable` hits; what happens to in-flight work.
- Pass: reload when idle, or checkpoint first.

**E2. Permission changes are deliberate.** (High for a new required permission with a warning)
- Why: a new permission with a warning **disables** normal (non-policy) installs until the user
  approves ✓; force-installed ones get it silently ✓.
- Check: with git, diff `permissions` / `host_permissions` against the last release tag (see
  SKILL.md). Without git, note what can't be checked. Look for `optional_*` and
  `permissions.request` usage.
- Pass: new capabilities as optional permissions requested at use, or an announced release plan.

**E3. Exposed resources stay stable.** (Medium)
- Why: an orphaned script's `chrome-extension://…/file` URLs resolve against the **new** package ○.
  Removed or renamed `web_accessible_resources` break old tabs; `use_dynamic_url` URLs may change
  on reload ○.
- Check: diff `web_accessible_resources` and files against the last release; `getURL` hits in
  content scripts.

**E4. Extension iframes inside web pages recover.** (Medium, if used)
- Why: an extension page embedded in a site dies with the old version ○, leaving an empty frame.
- Check: `extension iframe` hits in content scripts. Does the new instance replace the frame
  during the handoff?

**E5. Release mechanics** (self-hosted `update_url` or a repo-managed update manifest). (varies)
- The signing key is kept (new key = new extension ID ✓). The update manifest lists the newest
  version only, or newest first ✓. Versions only ever increase ✓.
- `minimum_chrome_version` changes are deliberate.

## F. Cross-version surfaces

**F1. Protocols that can span versions carry a version.** (Medium) Covers MAIN↔ISOLATED DOM
events and `postMessage`, `externally_connectable` / `onMessageExternal`, and native messaging
(which needs a handshake). Unknown versions and types are handled, not crashed on.

**F2. The backend tolerates old clients.** (Info–Medium) Requests carry the extension version;
older versions are explicitly supported, or told to update. Applies only if the extension calls
its own API; often it's not visible from the extension repo, so mark it Unknown.

## G. Observability and tests

**G1. Updates are observable.** (Low) `onInstalled` logged with `previousVersion`; migration and
re-injection failures reported with versions; `setUninstallURL` optional.

**G2. Upgrade paths are tested.** (Medium for projects with stored data or content scripts)
- Check: scan "Upgrade-related tests". A real upgrade test (old version → new version through
  the updater, or at least load the old unpacked build → swap files → reload) with open tabs and
  seeded data. Unit tests of migration functions count partially.
- Pass: an upgrade matrix (N−1 and the oldest supported → candidate), plus content-script cases
  if A applies.
