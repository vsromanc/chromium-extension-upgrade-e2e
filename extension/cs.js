// ISOLATED world, document_idle: a small panel counting clicks on #btn and page
// navigations reported by the MAIN-world script. State survives updates via handoff.
(() => {
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0); // may come through the DOM

  __ueSingleton({
    name: 'isolated',
    world: 'ISOLATED',
    start(prev, ctx) {
      const state = { clicks: count(prev?.clicks), navs: count(prev?.navs) };
      const panel = document.createElement('div');
      panel.className = 'ue-panel';
      const render = () => {
        panel.textContent = `ext ${ctx.version}: ${state.clicks} clicks, ${state.navs} navs`;
        ctx.report({ state });
      };
      const onClick = (e) => {
        if (!ctx.alive('click') || !e.target.closest?.('#btn')) return;
        state.clicks++;
        render();
      };
      const onNav = () => {
        if (!ctx.alive('nav')) return;
        state.navs++;
        render();
      };
      document.addEventListener('click', onClick, true);
      window.addEventListener('ue-cs:nav', onNav);
      // Re-injection may land before <body> exists; reinject.js waits for
      // DOMContentLoaded, but don't depend on it.
      const attach = () => document.body.append(panel);
      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
      render();

      return {
        stop() {
          document.removeEventListener('click', onClick, true);
          window.removeEventListener('ue-cs:nav', onNav);
          document.removeEventListener('DOMContentLoaded', attach);
          panel.remove();
          // Our MAIN-world partner can't detect the update itself; tell it only when
          // our extension context is gone. Not on a restart ('reopened') or when a
          // sibling of the same load takes over (Chrome's own document_idle injection
          // racing ours): MAIN stays, the new ISOLATED instance is its partner.
          if (!globalThis.chrome?.runtime?.id) {
            window.dispatchEvent(new CustomEvent('ue-cs:main-stop', { detail: JSON.stringify({ startedAt: ctx.startedAt }) }));
          }
          return state;
        },
      };
    },
  });
})();
