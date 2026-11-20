# Designing an MV3 extension for seamless upgrades

Habits that keep an update invisible to the user: no lost work, no doubled behaviour, no "reload
the page to fix it".

Legend: **✓** = verified by this repo's tests (Chromium 155/156; see the [README](../README.md)).
**○** = general MV3 behaviour I haven't tested here; check it before relying on it.

## The mental model

An update is an **unload of every extension context, then a load of the new version**:

| Context | What happens on update |
|---|---|
| Service worker | Killed; new one starts (`onInstalled`, reason `update`). Globals are gone. ✓ |
| Extension pages (tab, popup, options, side panel, offscreen) | Closed. An open page **delays** the update until `onUpdateAvailable` → `runtime.reload()`. ✓ |
| Content scripts, ISOLATED | **Keep running, orphaned**: `chrome.*` throws `Extension context invalidated.` ✓ |
| Content scripts, MAIN | Keep running, can't tell anything happened. ✓ |
| Manifest CSS in open tabs | **Stays applied.** ✓ |
| New content scripts | Only on navigation; existing tabs need re-injection ([examples](content-scripts-examples.md)). ✓ |
| `chrome.storage.local` / `sync` | Kept: the **only** thing that crosses versions by design. ✓ |
| `chrome.storage.session` | Cleared, also on reload ✓ and disable ○. The once-per-load re-injection relies on this. |
| Back/forward cache | Flushed. ✓ |
| Alarms, context menus, dynamic DNR rules, `registerContentScripts(persistAcrossSessions)` | Generally **persist** into the new version. ○ |

Two consequences shape everything below:

1. **Runtime messaging never crosses versions.** An orphaned content script can't reach the new
   service worker, and the old worker is gone. ✓ So you don't need protocol negotiation between your
   own SW and content scripts. You need *failure handling* instead.
2. **Everything that does cross versions is a compatibility surface:** stored data, handed-over
   content-script state, persistent registrations, the MAIN↔ISOLATED DOM protocol, web pages
   (`externally_connectable`), the native messaging host, and your backend. Version each of them.

## 1. Messaging between content scripts and the service worker

### Treat "extension context invalidated" as a lifecycle signal, not an error

Wrap every call. When `chrome.runtime.id` is gone, stop the instance (`ctx.alive()` in this repo's
lifecycle) instead of logging an error per event forever.

### Expect the worker to restart mid-request

The worker can be killed between your request and its reply: idle timeout, update, crash. Expect
`The message port closed before a response was received` or
`Could not establish connection. Receiving end does not exist.` Retry once, and make the operation
**idempotent** with a request id so a retry can't apply twice.

```js
// content script
async function call(type, payload, { retries = 1 } = {}) {
  const id = crypto.randomUUID(); // same id on retry -> the SW can dedupe
  for (let attempt = 0; ; attempt++) {
    if (!globalThis.chrome?.runtime?.id) throw new Error('orphaned'); // caller goes dormant
    try {
      const res = await chrome.runtime.sendMessage({ type, id, payload });
      if (res?.error) throw Object.assign(new Error(res.error), { remote: true });
      return res?.value;
    } catch (e) {
      if (!globalThis.chrome?.runtime?.id) throw new Error('orphaned');
      const transient = /message port closed|Receiving end does not exist/.test(e.message);
      if (e.remote || !transient || attempt >= retries) throw e;
    }
  }
}
```

### Service worker: register synchronously, wait for migrations, always answer

- Register every listener at the **top level, synchronously**. Events that wake the worker are only
  delivered to listeners that exist by the end of the first turn. ○ (`sw.js` decides from the
  manifest whether to register, but does it synchronously.)
- Right after an update, a freshly navigated tab already runs the **new** content script, which can
  message the worker **while `onInstalled` migrations are still running**. Gate handlers on a
  `ready` promise.
- Always send a response, errors included. A dropped `sendResponse` looks like a closed port to the
  caller.

```js
// sw.js
const ready = migrateIfNeeded(); // top level: every worker start; cheap when already migrated
const seen = new Map(); // request id -> result, for idempotent retries (persist if it must survive restarts)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready
    .then(() => seen.get(msg.id) ?? handle(msg, sender))
    .then((value) => (seen.set(msg.id, value), sendResponse({ value })))
    .catch((e) => sendResponse({ error: e.message }));
  return true; // async response
});
```

### Long-lived ports

- They disconnect on update **and** when the worker goes idle. In `onDisconnect`, check
  `chrome.runtime.id`. If it's gone, go dormant. Otherwise reconnect **lazily**, on the next send,
  not in a loop that keeps the worker awake ([example](content-scripts-examples.md#7-long-lived-port-to-the-service-worker)).
- Don't keep anything on a port that you can't rebuild from storage.

### Where you *do* need protocol versions

- **MAIN ↔ ISOLATED DOM events.** An old MAIN script can run next to a new ISOLATED one, at least
  until re-injection reaches it, and indefinitely if a new manifest drops the MAIN entry. Put a `v`
  in every message and ignore unknown types. Treat the content as page-controlled: the page can read
  and forge these events. ✓
- **Content-script state handoff:** see [§10 of the examples](content-scripts-examples.md#10-state-schema-versions).
- **Web pages via `externally_connectable`, and other extensions:** they talk to whichever version
  is installed now. Version the messages and answer unknown versions with a clear error.
- **Native messaging host:** it updates independently of the extension. Start every connection with
  a handshake (`{hello, min, max}`) and agree on a version both sides support.

## 2. Stored data

- **Store a schema version and migrate forward, cumulatively** (1→2→3, as `sw.js` does). One
  update can skip versions: a manifest that lists several versions jumps to the first newer entry,
  and publishing only the newest means users arrive from anywhere. ✓
- **Run the migration check on every worker start, not only in `onInstalled`.** `onInstalled` can
  be delayed: an update with a permission increase stays disabled, with `onInstalled` held, until
  the user approves. ✓ It can also be lost if the worker dies mid-migration. Make migrations
  idempotent: check the schema first, then write the new data and the new schema in **one**
  `storage.set`.
- **Readers must tolerate older data.** A content script in a fresh tab, or an extension page, can
  read storage before the migration finishes. Either ask the worker, which waits on `ready`, or
  handle every schema version you might see.
- **Rollback is a new, higher version.** Chromium ignores a lower version (`no_update`). ✓ So "roll
  back" means shipping old code under a new number, and that code reads data the newer version
  already migrated. **Keep unknown fields**, never delete data in the same release that stops
  writing it, and keep the down-migration path in mind for one release.
- **Persist user work continuously, not on teardown.** An orphaned context can't write (✓), and
  extension pages are closed by the update (✓). Drafts belong in storage on every change. Use
  `storage.session` for ephemeral data, `storage.local` for data that should survive a restart.
- Keep migrations fast and small; huge rewrites belong in chunks with progress saved, resumable on
  the next worker start.

## 3. Persistent registrations: reconcile, don't just create

Anything registered with Chromium can outlive the version that registered it: alarms, context
menus, dynamic and session DNR rules, `scripting.registerContentScripts`, `declarativeContent`.
Re-creating it blindly throws "duplicate id" or leaves stale entries. ○ Reconcile on install and
update: compute the wanted set, diff it against what's registered, then apply.

```js
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'lookup', title: 'Look up', contexts: ['selection'] });

  const wanted = [{ id: 'widget', matches: ['https://*.example.com/*'], js: ['widget.js'] }];
  const have = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have });
  await chrome.scripting.registerContentScripts(wanted); // may name files the old version lacked: register after unregister

  const oldRules = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldRules, addRules: buildRules() });

  if (!(await chrome.alarms.get('sync'))) chrome.alarms.create('sync', { periodInMinutes: 30 });
});
```

Dynamically registered content scripts are content scripts too: re-inject them into open tabs the
same way as manifest ones (`reinject.js` only reads the manifest; extend it with
`getRegisteredContentScripts()`).

## 4. Content scripts and injected UI

Built and tested in this repo; details in the [README](../README.md#content-scripts-across-updates) and [examples](content-scripts-examples.md):

- Re-inject once per extension load; make every script a single instance with a state handoff and
  complete teardown; wrap scripts in an IIFE. ✓
- **Put injected UI in a shadow root, with its styles inside it.** Manifest CSS stays applied in
  orphaned tabs ✓, so a renamed or removed rule from the old version keeps styling the new
  version's DOM. Styles inside the shadow root go away with the node on teardown. Use manifest
  CSS only for small, stable, namespaced rules.
- **Namespace everything that lands in the page:** element ids, classes, `data-*` attributes,
  event names, `Symbol.for` keys. Keep the namespace stable across versions; that's how the next
  version finds the old one.
- **UI in an extension iframe** (a `chrome-extension://` page inside the site) dies with the old
  version, leaving an empty frame. ○ Have the content script own the iframe and replace it during
  the handoff.
- **`web_accessible_resources`:** an orphaned script's `<img src="chrome-extension://…/old.png">`
  now resolves against the **new** package. Don't remove or rename exposed files in the release
  that stops using them. With `use_dynamic_url`, the URL itself may change on reload. ○
- **MAIN-world hooks:** capture originals at `document_start`. On teardown, restore them only if
  you're still the outermost wrapper; otherwise become a pass-through. ✓

## 5. Applying updates

- `runtime.onUpdateAvailable` fires when Chromium is waiting for the extension to go idle (e.g. a
  page is open). ✓ Reload **when it's safe**: finish or checkpoint the in-flight operation (an
  upload, a sync batch, a form the user is typing in) and then call `runtime.reload()`. Don't
  reload in the middle of user work just because the event fired.
- Don't expect updates to arrive quickly. The updater checks every few hours, and
  `requestUpdateCheck()` backs off about 5h after a check that doesn't end in an install. ✓ Users
  can be several versions behind.

## 6. Releases

From this repo's self-hosted update tests:

- **Keep the signing key forever:** a new key is a new extension ID, a different extension. ✓
- **Publish only the newest version** and make migrations cumulative. If you list several,
  newest first: Chromium takes the first entry newer than the installed version, one install per
  check. ✓
- **Permission increases disable normal installs** until the user approves (force-installed ones
  are granted silently). ✓ Prefer `optional_permissions` / `optional_host_permissions` requested
  at the moment of use. Plan a permission increase as its own release with a migration path for
  users who never approve.
- Bump `minimum_chrome_version` deliberately. Users on older browsers stay on your old version, ○
  and your backend has to keep serving them.
- **Decouple deploy from release:** risky behaviour behind server-side flags or a kill switch.
  Shipping a fix through the updater takes hours; flipping a flag takes minutes.

## 7. Backend and other external parties

- Old versions linger: offline machines, browsers on an old `minimum_chrome_version`, extensions
  stuck disabled by a permission prompt. Send the extension version with every API call, support
  N−k versions explicitly, and give old clients a clear "please update" response instead of
  failing on a changed payload.
- Version the native messaging protocol with a handshake (§1).

## 8. Observability

- Log `onInstalled` with `previousVersion`, migration start/finish/failure, and re-injection
  reports (timeouts, inaccessible tabs). The repo's `events` log is a small version of this. ✓
- Report errors with the extension version and the schema version.
- `chrome.runtime.setUninstallURL` captures some of the users an upgrade drove away.

## 9. Testing upgrades

The harness in this repo does the real thing: self-hosted updates, Chromium's own updater. Use it as
a release gate:

- **Upgrade matrix:** every supported older version → the candidate, with realistic data. Include
  N−1, the oldest still in use, and the last version before each schema change.
- **With state in flight:** open tabs (✓), an open extension page (✓), a tab still loading (✓),
  a hung tab (✓), an SPA (✓), back/forward (✓), and a pending long operation.
- **Same-version reload and disable/enable,** not just version bumps. ✓ (reload; disable/enable
  needs a non-policy install.)
- **Rollback drill:** release N+1, then ship N's code as N+2 and check it reads N+1's data.
- **Permission-increase path**, for both install types. ✓
- Assert "**exactly once**": every user action handled by one live instance, of the newest
  version. ✓

## Checklist for a release

- [ ] Schema bumped? Migration cumulative, idempotent, single write, also run on worker start.
- [ ] Old readers (content scripts, pages) tolerate the new data; the previous version can read it after a rollback.
- [ ] New permissions? Optional if at all possible; otherwise a release plan for users who don't approve.
- [ ] Persistent registrations (menus, alarms, DNR, registered scripts) reconciled in `onInstalled`.
- [ ] Content scripts: lifecycle wrapper, full teardown, UI in shadow DOM, namespace unchanged.
- [ ] Handoff state and MAIN↔ISOLATED messages: version field present, unknown fields kept.
- [ ] No exposed resource removed or renamed that the previous version's scripts may still reference.
- [ ] Messages: idempotent ids, transient-failure retry, handlers gated on `ready`.
- [ ] Backend and native host accept both this version and the previous ones still in use.
- [ ] Upgrade matrix green in the e2e harness.
