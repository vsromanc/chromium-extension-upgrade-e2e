// MAIN world (page realm), document_start: hooks history.pushState and forwards
// page navigations to the ISOLATED script. Page-world hooks are the classic
// double-run hazard: without a handoff every update would wrap pushState again.
(() => {
  // Handed-over state crosses into the page realm, so treat it as untrusted.
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

  __ueSingleton({
    name: 'main',
    world: 'MAIN',
    start(prev, ctx) {
      const state = { navs: count(prev?.navs) };
      const orig = history.pushState;
      const hooked = function (...args) {
        const r = orig.apply(this, args);
        if (ctx.alive('pushState')) {
          state.navs++;
          ctx.report({ state });
          window.dispatchEvent(new CustomEvent('ue-cs:nav', { detail: JSON.stringify({ url: location.href, by: ctx.id }) }));
        }
        return r;
      };
      history.pushState = hooked;

      // The MAIN world can't see the extension go away; its ISOLATED partner tells it.
      // Only a partner that started after us may stop us: an old partner noticing
      // the update late must not stop a successor that already took over. (Keyed
      // by start time, not version: a same-version reload has the same version.)
      const onStop = (e) => {
        let from;
        try {
          from = JSON.parse(e.detail).startedAt;
        } catch {
          return;
        }
        if (from >= ctx.startedAt) ctx.stop('controller-stopped');
      };
      window.addEventListener('ue-cs:main-stop', onStop);

      ctx.report({ state });
      return {
        stop() {
          window.removeEventListener('ue-cs:main-stop', onStop);
          // Unhook. If someone wrapped us since, our wrapper stays as a pass-through
          // (ctx.alive() is false from now on).
          if (history.pushState === hooked) history.pushState = orig;
          return state;
        },
      };
    },
  });
})();
