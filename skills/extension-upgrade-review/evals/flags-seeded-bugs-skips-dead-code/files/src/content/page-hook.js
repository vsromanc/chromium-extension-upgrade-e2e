// MAIN world: tell the content script about SPA navigations.
const origPushState = history.pushState;
history.pushState = function (...args) {
  const r = origPushState.apply(this, args);
  window.dispatchEvent(new Event('tab-notes:navigated'));
  return r;
};
window.addEventListener('popstate', () => window.dispatchEvent(new Event('tab-notes:navigated')));
