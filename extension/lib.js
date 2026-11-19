// Shared by the service worker (importScripts) and test.html (<script>).
// Values substituted by scripts/pack.mjs at build time.
const SCHEMA = __SCHEMA__;
const VERSION = chrome.runtime.getManifest().version;

// Serialize storage read-modify-write ops within this context.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

// Hooks for the e2e test, evaluated in an extension page via CDP.
self.__test = {
  version: VERSION,
  schema: SCHEMA,
  state: () => chrome.storage.local.get(null),
  addItem: (title) =>
    serial(async () => {
      const { data } = await chrome.storage.local.get('data');
      data.items.push(SCHEMA >= 3 ? { title, done: false, tags: [] } : SCHEMA >= 2 ? { title, done: false } : title);
      await chrome.storage.local.set({ data });
    }),
  checkForUpdate: () => chrome.runtime.requestUpdateCheck(),
};
