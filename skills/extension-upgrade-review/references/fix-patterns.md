# Fix patterns

Suggested fixes, keyed to checklist IDs. In a review, point to the pattern and adapt it to the
project's code style and build setup (TypeScript, a bundler, `browser.*` polyfill). Don't paste
whole files into the report: a short adapted snippet plus a pointer is enough.

Reference implementations (tested on Chromium 155/156 with real updates) are in `assets/`:
- `assets/reinject.js`: replays manifest `content_scripts` per frame (rules, worlds, CSS,
  `run_at`, load URL, `documentIds`), with timeouts, `onlyMissing`, and active tab first.
- `assets/sw-reinject.js`: the service-worker side: once per load (`storage.session` flag), and a
  retry for timed-out tabs on activation and a 30s alarm.
- `assets/cs-lifecycle.js`: a single instance per frame and world, state handoff (MAIN: global;
  ISOLATED: DOM handshake), orphan watchdog, `document.open()` restart, and a `failed` state that
  keeps what it was handed.

## A1–A2, A9: re-inject into open tabs

Use `assets/reinject.js` + `assets/sw-reinject.js`. If the project already re-injects, compare it
point by point: once per load (not only `onInstalled`); the manifest rules replayed; `documentIds`;
the load URL (`performance.getEntriesByType('navigation')[0].name`); a wait for `DOMContentLoaded`
for `document_idle`/`document_end` entries in parsing documents; a timeout per step; a retry for
timed-out tabs. Dynamically registered scripts: extend it with `getRegisteredContentScripts()`.

## A3–A4, A7: the instance lifecycle

```js
// Every content-script entry: js: ["cs-lifecycle.js", "feature.js"]
(() => {
  __ueSingleton({
    name: 'feature', // unique per world; stable across versions
    world: 'ISOLATED', // or 'MAIN'
    start(prev, ctx) {
      const state = { count: Number.isSafeInteger(prev?.count) ? prev.count : 0 }; // validate
      const ac = new AbortController();
      document.addEventListener('click', () => {
        if (!ctx.alive('click')) return; // false once orphaned -> instance goes dormant
        state.count++;
      }, { signal: ac.signal });
      const mo = new MutationObserver(() => ctx.alive('mutation') && decorate());
      mo.observe(document.documentElement, { childList: true, subtree: true });
      function decorate() {}
      return {
        stop() {
          ac.abort(); // every listener
          mo.disconnect();
          return state; // JSON data only
        },
      };
    },
  });
})();
```

MAIN-world hook teardown (A7): restore the original only if you're still the outermost wrapper;
otherwise stay as a pass-through. The ISOLATED partner tells MAIN to stop **only when its own
context is gone**, sending its start time. MAIN obeys only a sender that started at the same time
or after it:

```js
// MAIN
const onStop = (e) => {
  try {
    if (JSON.parse(e.detail).startedAt >= ctx.startedAt) ctx.stop('partner-orphaned');
  } catch {}
};
window.addEventListener('my-ext:stop-main', onStop);
// ISOLATED stop():
if (!globalThis.chrome?.runtime?.id) {
  window.dispatchEvent(new CustomEvent('my-ext:stop-main', { detail: JSON.stringify({ startedAt: ctx.startedAt }) }));
}
```

## A5: wrap scripts

Hand-written: wrap the file in `(() => { … })();`. Bundled: make sure the content-script output
format is IIFE (Vite: `build.rollupOptions.output.format = 'iife'` for that entry; WXT, CRXJS and
Plasmo do this already: check the built file).

## A6: versioned, validated state

```js
function readState(prev) {
  const s = prev && typeof prev === 'object' ? { ...prev } : {}; // keep unknown fields (rollback)
  const v = Number.isInteger(s.v) ? s.v : 1;
  if (v < 2) s.items = Array.isArray(s.items) ? s.items.length : 0; // example migration
  return { ...s, v: Math.max(v, 2), items: Number.isSafeInteger(s.items) ? s.items : 0 };
}
```

Secrets: hand over a key, keep the value in `chrome.storage.session` (call
`setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` in the worker), and write on
change, not in `stop()`.

## A8: UI in a shadow root

```js
const host = document.createElement('my-ext-root');
const shadow = host.attachShadow({ mode: 'closed' });
shadow.innerHTML = `<style>${CSS_TEXT}</style><div class="panel"></div>`; // or adoptedStyleSheets
document.body.append(host); // stop(): host.remove() takes the styles with it
```

## A10: first rollout cleanup

A short-lived sweep that removes the pre-lifecycle version's known DOM (selectors from the old
code), via a MutationObserver for about a minute, shipped for a few releases.

## B1–B4: messaging

```js
// worker
const ready = migrateIfNeeded(); // top level; cheap when already migrated
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready
    .then(() => handle(msg, sender))
    .then((value) => sendResponse({ value }), (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

// content script / page
async function call(type, payload, { retries = 1 } = {}) {
  const id = crypto.randomUUID(); // idempotency key: the handler dedupes by id
  for (let attempt = 0; ; attempt++) {
    if (!globalThis.chrome?.runtime?.id) throw new Error('orphaned');
    try {
      const res = await chrome.runtime.sendMessage({ type, id, payload });
      if (res?.error) throw Object.assign(new Error(res.error), { remote: true });
      return res?.value;
    } catch (e) {
      if (!globalThis.chrome?.runtime?.id) throw new Error('orphaned');
      if (e.remote || attempt >= retries || !/message port closed|Receiving end does not exist/.test(e.message)) throw e;
    }
  }
}
```

## B5: ports

```js
let port = null;
const getPort = () => {
  if (!port) {
    port = chrome.runtime.connect({ name: 'sync' });
    port.onDisconnect.addListener(() => {
      port = null;
      ctx.alive('port'); // orphaned -> dormant; worker idle -> reconnect on next send
    });
  }
  return port;
};
```

## C1–C3: migrations

```js
const SCHEMA = 3;
const MIGRATIONS = { 2: (d) => ({ ...d /* … */ }), 3: (d) => ({ ...d /* … */ }) };
async function migrateIfNeeded() {
  const { data, schema = 1 } = await chrome.storage.local.get(['data', 'schema']);
  if (schema >= SCHEMA) return; // newer data (rollback): leave it alone, read defensively
  let d = data ?? {};
  for (let s = schema + 1; s <= SCHEMA; s++) d = MIGRATIONS[s](d);
  await chrome.storage.local.set({ data: d, schema: SCHEMA }); // one write: atomic
}
```

## D1–D4: reconcile registrations

```js
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'lookup', title: 'Look up', contexts: ['selection'] });

  const have = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have });
  await chrome.scripting.registerContentScripts(WANTED_SCRIPTS);

  const old = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old, addRules: buildRules() });

  if (!(await chrome.alarms.get('sync'))) chrome.alarms.create('sync', { periodInMinutes: 30 });
});
```

## E1: apply updates when safe

```js
chrome.runtime.onUpdateAvailable.addListener(async () => {
  await flushPendingWork(); // or set a flag and reload when the current operation ends
  chrome.runtime.reload();
});
```

## E2: permissions

Move new capabilities to `optional_permissions` / `optional_host_permissions` and call
`chrome.permissions.request()` from a user gesture at the moment of use. Keep the feature
disabled, not broken, while the permission isn't granted.

## G2: upgrade tests

A minimal local upgrade test, without an update server, with puppeteer-core + Chromium:
1. Load the old build unpacked (`browser.installExtension(dir)`, `pipe: true, enableExtensions: true`).
2. Open matching tabs and seed data.
3. Copy the new build over the same directory and call `installExtension(dir)` again: it reloads
   as an update.
4. Assert: data migrated; every tab has exactly one live instance of each script, of the new
   version; user actions are handled once.

For real updates through Chromium's updater (policy install from a self-hosted `update_url`), see
the harness this skill came from (an update server and Chromium in Docker).
