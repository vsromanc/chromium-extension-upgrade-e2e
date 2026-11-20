// Content-script lifecycle across extension updates. Listed first in every
// content_scripts entry (both worlds), and re-run by reinject.js.
//
// After an update Chromium leaves the old version's content scripts running in
// open tabs: their timers and DOM listeners keep firing, chrome.* is dead
// ("Extension context invalidated"), and the new version is NOT injected there.
// reinject.js injects the new version; this file makes every script a single
// instance per frame + world that hands its state to its successor and tears
// itself down, so nothing runs twice.
//
//   __ueSingleton({ name, world, start })
//     start(prevState | null, ctx) -> { stop({ reason }): state }
//     stop() must remove every listener, timer, hook and DOM node it added.
//     reason 'reopened' = restarting on a new document (see below), not going away.
//     State must be JSON data: it is JSON round-tripped on every handoff.
//     Handlers call ctx.alive('<source>') first and bail out if it returns false.
//
// Instance states: live -> dormant (torn down, holding its final state for a
// successor) -> gone (state handed over). 'failed' = start() threw; it holds the
// state it was handed, so the next instance still gets it.
//
// Everything is wrapped in an IIFE: a re-run in the same realm must not hit
// "Identifier has already been declared" on top-level const/let.
(() => {
  const NS = 'ue-cs'; // per-extension namespace, must stay stable across versions
  const VERSION = '__VERSION__';
  const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

  globalThis.__ueSingleton = ({ name, world, start }) => {
    const key = Symbol.for(`${NS}:${name}`);
    const evt = `${NS}:${name}`;
    const id = `${name}@${VERSION}#${Math.random().toString(36).slice(2, 7)}`;
    // Same clock in every world of this document: orders instances across versions.
    const startedAt = performance.now();
    // The MAIN world has no extension context; its ISOLATED partner tells it to stop.
    const orphaned = world === 'ISOLATED' ? () => !globalThis.chrome?.runtime?.id : () => false;

    // Test probe: this instance's record in <html data-ue='{id: record}'>, readable
    // from any world. Strip from production builds.
    const rec = { script: name, world, version: VERSION };
    const report = (patch) => {
      Object.assign(rec, patch);
      const el = document.documentElement;
      if (!el) return;
      const all = JSON.parse(el.dataset.ue || '{}');
      all[id] = rec;
      el.dataset.ue = JSON.stringify(all);
    };

    // --- Take over from the previous instance, if any -------------------------
    let prev = null;
    let from = null;
    let via = null;
    const old = globalThis[key];
    if (old) {
      // Same JS realm: always for MAIN; for ISOLATED only within one extension
      // load (a re-run of the same version). Direct call, invisible to the page.
      ({ id: from, state: prev } = old.yield(id));
      via = 'global';
    } else if (world === 'ISOLATED') {
      // An updated extension gets a fresh isolated world, so the old version's
      // globals are out of reach. The DOM is shared: synchronous event handshake.
      const onState = (e) => {
        try {
          ({ id: from, state: prev } = JSON.parse(e.detail));
          via = 'event';
        } catch {} // anyone can dispatch this; garbage = no predecessor
      };
      document.addEventListener(`${evt}:state`, onState);
      document.dispatchEvent(new CustomEvent(`${evt}:takeover`, { detail: id }));
      document.removeEventListener(`${evt}:state`, onState);
    }

    // --- Own lifecycle ----------------------------------------------------------
    let status = 'live';
    let inst = null;
    let finalState = null;
    let root = document.documentElement;

    const goDormant = (reason, extra = {}) => {
      if (status !== 'live') return;
      status = 'dormant';
      clearInterval(watchdog);
      try {
        finalState = json(inst.stop({ reason }));
      } catch (e) {
        extra.stopError = e.message;
      }
      report({ status, reason, state: finalState, ...extra });
    };

    const alive = (source) => {
      if (status !== 'live') return false;
      if (!orphaned()) return true;
      // Our extension context is gone: record how chrome.* behaves now, then stop.
      let apiError = 'no error';
      try {
        chrome.runtime.sendMessage({ type: 'ping' })?.catch?.(() => {});
      } catch (e) {
        apiError = e.message;
      }
      goDormant(`orphaned:${source}`, { apiError, runtimeId: globalThis.chrome?.runtime?.id ?? null });
      return false;
    };

    const listen = () => {
      if (world === 'ISOLATED') document.addEventListener(`${evt}:takeover`, onTakeover);
    };

    const handOff = (to) => {
      goDormant('takeover');
      clearInterval(watchdog); // also for 'failed'
      status = 'gone';
      document.removeEventListener(`${evt}:takeover`, onTakeover);
      if (globalThis[key] === handle) delete globalThis[key];
      report({ status, to });
      return { id, state: json(finalState) };
    };

    const onTakeover = (e) => {
      // Pages can dispatch DOM events too: only an orphaned instance yields to one.
      // A live instance is only ever replaced in-realm (via the global handle).
      if (!orphaned()) return;
      const out = handOff(e.detail);
      document.dispatchEvent(new CustomEvent(`${evt}:state`, { detail: JSON.stringify(out) }));
    };

    // document.open() (e.g. a late document.write) replaces the DOM and erases every
    // listener on document and window, with no event. Restart on the new document.
    const reopened = () => {
      if (status !== 'live' || document.documentElement === root) return false;
      root = document.documentElement;
      let state = null;
      try {
        state = json(inst.stop({ reason: 'reopened' })); // listeners are gone already; drop hooks/timers
      } catch {}
      listen();
      try {
        inst = start(state, ctx);
        report({ restarts: (rec.restarts ?? 0) + 1 });
      } catch (e) {
        status = 'failed';
        finalState = state;
        clearInterval(watchdog);
        report({ status, error: e.message, state });
      }
      return true;
    };

    // ISOLATED: notice orphaning even when the page is idle, so leftovers don't
    // linger when no successor arrives. Both worlds: notice document.open().
    const watchdog = setInterval(() => reopened() || alive('watchdog'), 1000);

    const handle = { id, version: VERSION, yield: handOff };
    globalThis[key] = handle;
    listen();

    const ctx = {
      id,
      version: VERSION,
      startedAt,
      alive,
      stop: (reason) => goDormant(reason),
      report: (patch) => report(patch),
    };
    report({ status, via, from, startedAt, url: location.href });
    try {
      inst = start(prev, ctx);
    } catch (e) {
      // Keep what we were handed so the next instance (retry, or the next
      // version) still gets it; a takeover of a failed instance is allowed.
      status = 'failed';
      finalState = json(prev);
      clearInterval(watchdog);
      report({ status, error: e.message, state: finalState });
    }
    return handle;
  };
})();
