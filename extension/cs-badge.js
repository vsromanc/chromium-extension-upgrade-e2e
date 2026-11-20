// ISOLATED world, top frame only, include_globs: a stateless badge. Shows the
// teardown half of the lifecycle: the old badge must not linger next to the new one.
(() => {
  __ueSingleton({
    name: 'badge',
    world: 'ISOLATED',
    start(_prev, ctx) {
      const el = document.createElement('div');
      el.id = 'ue-badge';
      el.textContent = `ext ${ctx.version}`;
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
