// Experiment from 2024: render notes in a shadow root. Never wired up.
export function mountShadow() {
  const host = document.createElement('tab-notes');
  const root = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return root;
}
