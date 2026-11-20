# Content scripts across updates — code examples

How to use `extension/reinject.js` and `extension/cs-lifecycle.js` in your own extension.
Background and verified behaviour: [README → Content scripts across updates](../README.md#content-scripts-across-updates).

The rules, in short:

- List `cs-lifecycle.js` **first** in every `content_scripts` entry, in both worlds.
- Wrap each script in `__ueSingleton({ name, world, start })`. `start(prev, ctx)` returns `{ stop({ reason }) }`.
- `stop()` undoes **everything** `start` did and returns the state for the successor. The state must
  be JSON data. `reason === 'reopened'` means a restart after `document.open()`, not going away.
- Every handler starts with `if (!ctx.alive('<source>')) return;`.
- Treat `prev` as untrusted input. In the ISOLATED world it may have come through the DOM.

Rename `NS` in `cs-lifecycle.js` (`'ue-cs'`) to something unique to your extension, and never change
it between versions. Strip `report()` / `data-ue` from production builds.

## 1. Manifest

```json
{
  "permissions": ["scripting", "alarms", "storage"],
  "host_permissions": ["https://*.example.com/*"],
  "background": { "service_worker": "sw.js" },
  "content_scripts": [
    {
      "matches": ["https://*.example.com/*"],
      "js": ["cs-lifecycle.js", "page-hooks.js"],
      "world": "MAIN",
      "run_at": "document_start",
      "all_frames": true
    },
    {
      "matches": ["https://*.example.com/*"],
      "exclude_matches": ["https://*.example.com/account/*"],
      "css": ["panel.css"],
      "js": ["cs-lifecycle.js", "panel.js"]
    }
  ]
}
```

`host_permissions` must cover the `matches`: `scripting.executeScript` needs host access, and
re-injection goes through it.

## 2. Service worker: re-inject once per extension load

Don't key this on `onInstalled`: it doesn't fire when the extension is re-enabled. Use a flag in
`chrome.storage.session`, which Chromium clears whenever the extension unloads. The first worker
start after a load then does the work. This is a trimmed copy of `extension/sw.js`:

```js
// sw.js
importScripts('reinject.js'); // reinjectContentScripts()

async function onLoad() {
  if ((await chrome.storage.session.get('loadHandled')).loadHandled) return;
  await chrome.storage.session.set({ loadHandled: true });
  // onlyMissing: after a browser restart Chrome already injected this load's scripts.
  const report = await reinjectContentScripts({ onlyMissing: true });
  await setPending(report);
}
const loaded = onLoad(); // every worker start; only the first one per load does anything

// onInstalled wakes the worker on install/update/reload (any listener does).
chrome.runtime.onInstalled.addListener(() => {});

// Tabs that didn't answer within the timeout (hung, alert(), debugger): retry later.
async function setPending(report) {
  const { reinjectPending = [] } = await chrome.storage.session.get('reinjectPending');
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const pending = new Set(reinjectPending.filter((id) => open.has(id)));
  for (const r of report) r.timedOut ? pending.add(r.tabId) : pending.delete(r.tabId);
  await chrome.storage.session.set({ reinjectPending: [...pending] });
  if (!pending.size) await chrome.alarms.clear('reinject-retry');
  else if (!(await chrome.alarms.get('reinject-retry'))) chrome.alarms.create('reinject-retry', { periodInMinutes: 0.5 });
}
async function retryPending(onlyTab) {
  await loaded;
  const { reinjectPending = [] } = await chrome.storage.session.get('reinjectPending');
  const tabIds = onlyTab ? reinjectPending.filter((id) => id === onlyTab) : reinjectPending;
  if (tabIds.length) await setPending(await reinjectContentScripts({ tabIds, onlyMissing: true }));
}
// After a re-enable nothing wakes the worker; the first tab switch does.
chrome.tabs.onActivated.addListener(({ tabId }) => retryPending(tabId));
chrome.alarms.onAlarm.addListener((a) => a.name === 'reinject-retry' && retryPending());

// Host access granted later (optional host permissions, or the user picks "On all sites"):
// tabs that just became reachable have no content scripts yet.
chrome.permissions.onAdded.addListener(({ origins }) => {
  if (origins?.length) reinjectContentScripts({ onlyMissing: true }).then(setPending);
});
```

Permissions: `scripting`, `alarms`, plus host permissions covering your `matches`.

## 3. Smallest possible script: UI only, no state

```js
// badge.js (ISOLATED)
(() => {
  __ueSingleton({
    name: 'badge',
    world: 'ISOLATED',
    start(_prev, ctx) {
      const el = document.createElement('div');
      el.className = 'my-ext-badge';
      el.textContent = `v${ctx.version}`;
      // Re-injection or a late start can run before <body> exists.
      const attach = () => document.body.append(el);
      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
      return {
        stop: () => {
          document.removeEventListener('DOMContentLoaded', attach);
          el.remove();
          return null;
        },
      };
    },
  });
})();
```

The IIFE matters. Re-running a script in the same isolated world (same version, injected twice)
would otherwise throw `Identifier '…' has already been declared` on top-level `const`/`let`.

## 4. Stateful ISOLATED script: one AbortController for every listener

Passing one `signal` to every `addEventListener` makes teardown a single `abort()` call. Nothing
gets forgotten when you add a listener later.

```js
// panel.js (ISOLATED)
(() => {
  const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

  __ueSingleton({
    name: 'panel',
    world: 'ISOLATED',
    start(prev, ctx) {
      // Validate: the page can forge state on the DOM handoff path.
      const state = { opened: prev?.opened === true, highlights: int(prev?.highlights), query: str(prev?.query) };

      const ac = new AbortController();
      const { signal } = ac;

      const panel = document.createElement('aside');
      panel.className = 'my-ext-panel';
      panel.hidden = !state.opened;
      document.body.append(panel);

      document.addEventListener('keydown', (e) => {
        if (!ctx.alive('keydown') || !(e.altKey && e.key === 'p')) return;
        state.opened = !state.opened;
        panel.hidden = !state.opened;
      }, { signal, capture: true });

      document.addEventListener('mouseup', async () => {
        if (!ctx.alive('mouseup')) return;
        const text = String(getSelection()).trim();
        if (!text) return;
        state.highlights++;
        try {
          // chrome.* can fail if the extension goes away mid-call: check again after awaiting.
          const res = await chrome.runtime.sendMessage({ type: 'lookup', text });
          if (ctx.alive('lookup-reply')) panel.textContent = res.summary;
        } catch {
          ctx.alive('lookup-error'); // goes dormant if the context was invalidated
        }
      }, { signal });

      const mo = new MutationObserver(() => {
        if (ctx.alive('mutation')) {
          /* re-decorate new nodes */
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });

      const timer = setInterval(() => ctx.alive('poll') && refresh(), 30_000);
      function refresh() {
        /* periodic work */
      }

      return {
        stop() {
          ac.abort(); // every listener above
          mo.disconnect();
          clearInterval(timer);
          panel.remove();
          return state;
        },
      };
    },
  });
})();
```

## 5. MAIN-world page hook, paired with an ISOLATED script

The MAIN world can't call `chrome.*` and can't tell that the extension was updated. It reports to
its ISOLATED partner through DOM events. The partner stops it, by version, when the partner itself
gets orphaned.

```js
// page-hooks.js (MAIN, document_start): observe the page's fetch() calls.
(() => {
  __ueSingleton({
    name: 'page-hooks',
    world: 'MAIN',
    start(prev, ctx) {
      const state = { requests: Number.isSafeInteger(prev?.requests) ? prev.requests : 0 };
      const orig = window.fetch;

      const hooked = function (input, init) {
        const p = orig.call(this, input, init);
        if (ctx.alive('fetch')) {
          state.requests++;
          const url = String(input instanceof Request ? input.url : input);
          // detail as a string: objects don't cross worlds reliably.
          window.dispatchEvent(new CustomEvent('my-ext:fetch', { detail: JSON.stringify({ url }) }));
        }
        return p;
      };
      window.fetch = hooked;

      // Only a partner that started after us may stop us, so an old partner noticing the
      // update late can't stop a newer hook. Keyed by start time, not version: a
      // same-version reload has the same version. performance.now() is the same
      // clock in both worlds of a document.
      const onStop = (e) => {
        try {
          if (JSON.parse(e.detail).startedAt >= ctx.startedAt) ctx.stop('partner-orphaned');
        } catch {}
      };
      window.addEventListener('my-ext:stop-main', onStop);

      return {
        stop() {
          window.removeEventListener('my-ext:stop-main', onStop);
          // Restore only if nobody wrapped us since. Otherwise stay in the chain as a
          // pass-through (ctx.alive() returns false from now on).
          if (window.fetch === hooked) window.fetch = orig;
          return state;
        },
      };
    },
  });
})();
```

```js
// network-log.js (ISOLATED): the partner.
(() => {
  __ueSingleton({
    name: 'network-log',
    world: 'ISOLATED',
    start(prev, ctx) {
      const seen = Array.isArray(prev?.seen) ? prev.seen.filter((u) => typeof u === 'string').slice(-50) : [];
      const ac = new AbortController();

      window.addEventListener('my-ext:fetch', (e) => {
        if (!ctx.alive('fetch-event')) return;
        let url;
        try {
          ({ url } = JSON.parse(e.detail)); // anyone on the page can dispatch this event
        } catch {
          return;
        }
        seen.push(String(url).slice(0, 2000));
        if (seen.length > 50) seen.shift();
      }, { signal: ac.signal });

      return {
        stop() {
          ac.abort();
          // Only when our extension is gone. Not on a takeover by a sibling of the same load,
          // nor on a document.open() restart: then the MAIN hook should keep running.
          if (!chrome.runtime?.id) {
            window.dispatchEvent(new CustomEvent('my-ext:stop-main', { detail: JSON.stringify({ startedAt: ctx.startedAt }) }));
          }
          return { seen };
        },
      };
    },
  });
})();
```

Put the MAIN entry before the ISOLATED one in the manifest. Re-injection follows manifest order,
so the new hook replaces the old one before the new partner arrives.

## 6. State the page must not see: storage instead of the handoff

The ISOLATED handoff between versions goes through DOM events, which the page can watch. For
anything sensitive, hand over only a key and keep the data in `chrome.storage.session`. The old
version can't write once it's orphaned, so persist on change, not in `stop()`.

```js
// sw.js: content scripts can't reach storage.session unless you allow it.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
```

```js
// draft.js (ISOLATED)
(() => {
  __ueSingleton({
    name: 'draft',
    world: 'ISOLATED',
    start(prev, ctx) {
      // A per-tab key is fine to pass through the DOM. The draft itself is not.
      const key = typeof prev?.key === 'string' ? prev.key : `draft:${crypto.randomUUID()}`;
      let draft = '';
      chrome.storage.session.get(key).then((r) => {
        if (ctx.alive('restore')) draft = r[key] ?? '';
      });

      const ac = new AbortController();
      document.addEventListener('input', (e) => {
        if (!ctx.alive('input') || !e.target.matches?.('textarea.compose')) return;
        draft = e.target.value;
        chrome.storage.session.set({ [key]: draft }); // persist now: no chrome.* after orphaning
      }, { signal: ac.signal });

      return {
        stop() {
          ac.abort();
          return { key };
        },
      };
    },
  });
})();
```

## 7. Long-lived port to the service worker

A port disconnects in two cases: the extension is unloaded, or the service worker goes idle.
`ctx.alive()` tells the two apart. Reconnect lazily, on the next use: reconnecting right away
from every tab would keep waking the worker.

```js
// sync.js (ISOLATED)
(() => {
  __ueSingleton({
    name: 'sync',
    world: 'ISOLATED',
    start(_prev, ctx) {
      let port = null;
      const getPort = () => {
        if (!port) {
          port = chrome.runtime.connect({ name: 'sync' });
          port.onMessage.addListener((msg) => ctx.alive('port-msg') && apply(msg));
          port.onDisconnect.addListener(() => {
            port = null;
            ctx.alive('port-disconnect'); // orphaned -> dormant; worker idle -> reconnect on next send
          });
        }
        return port;
      };
      const send = (msg) => ctx.alive('send') && getPort().postMessage(msg);
      function apply(msg) {
        /* update the page from msg */
      }

      const ac = new AbortController();
      document.addEventListener('visibilitychange', () => send({ type: 'visible', visible: !document.hidden }), { signal: ac.signal });

      return {
        stop() {
          ac.abort();
          try {
            port?.disconnect();
          } catch {}
          port = null;
          return null;
        },
      };
    },
  });
})();
```

## 8. Testing it: what to assert

See `tests/content-scripts.test.mjs` for the full scenario. The useful checks for your own
extension are:

```js
// After an update with tabs left open, per tab and frame:
assert.deepEqual(liveMap(await instances(tab)), liveMap(await instances(freshTab))); // same scripts as a fresh load
assert.equal(newIsolated.via, 'event'); // ISOLATED: new world per extension load
assert.equal(newMain.via, 'global'); // MAIN: page realm, shared
assert.deepEqual(newIsolated.state, oldIsolated.state); // state carried over
// One user action -> exactly one reaction, by the newest version:
assert.equal(document.querySelectorAll('.my-ext-panel').length, 1);
```

## 9. First rollout: clean up after a version without the lifecycle

The first version that ships `cs-lifecycle.js` replaces versions that don't have it. Those old
scripts never answer a takeover, and their listeners keep running until the tab reloads. You can't
stop them. You can remove what they show, and make sure their handlers already fail safely on
`chrome.*`, which throws once they're orphaned. Ship this sweep for a few versions, then drop it.

```js
// legacy-sweep.js (ISOLATED), listed after cs-lifecycle.js in the first lifecycle-aware versions.
(() => {
  // DOM the pre-lifecycle versions added (whatever selectors they used).
  const LEGACY = ['#my-ext-panel-v1', '.my-ext-highlight-v1'];
  __ueSingleton({
    name: 'legacy-sweep',
    world: 'ISOLATED',
    start() {
      const sweep = () => document.querySelectorAll(LEGACY.join(',')).forEach((el) => el.remove());
      sweep();
      // Old code may re-add its UI from a still-running listener: keep sweeping for a while.
      const mo = new MutationObserver(sweep);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      const done = setTimeout(() => mo.disconnect(), 60_000);
      return {
        stop() {
          mo.disconnect();
          clearTimeout(done);
          return null;
        },
      };
    },
  });
})();
```

## 10. State schema versions

Handed-over state is a message between two versions of your code, possibly an older one after a
rollback. Version it the way you'd version stored data: migrate forward, and keep unknown fields.

```js
// In start(prev, ctx):
const STATE_V = 3;
function readState(prev) {
  let s = prev && typeof prev === 'object' ? { ...prev } : {};
  const v = Number.isInteger(s.v) ? s.v : 1;
  if (v < 2) s = { ...s, highlights: Array.isArray(s.highlights) ? s.highlights.length : 0 }; // v1 kept a list
  if (v < 3) s = { ...s, query: '' }; // v3 added query
  // v > STATE_V (rollback): use what we understand, keep the rest for the next upgrade.
  return {
    ...s,
    v: Math.max(v, STATE_V),
    highlights: Number.isSafeInteger(s.highlights) ? s.highlights : 0,
    query: typeof s.query === 'string' ? s.query.slice(0, 200) : '',
  };
}
```
