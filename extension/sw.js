importScripts('lib.js'); // SCHEMA, VERSION, serial

// Data migrations, keyed by the schema they produce.
// schema 1: items are plain strings
// schema 2: items are { title, done } objects
// schema 3: items also have tags: []
const migrations = {
  2: (data) => ({
    ...data,
    items: data.items.map((i) => (typeof i === 'string' ? { title: i, done: false } : i)),
  }),
  3: (data) => ({
    ...data,
    items: data.items.map((i) => ({ tags: [], ...i })),
  }),
};

const logEvent = (evt) =>
  serial(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    events.push({ ...evt, version: VERSION, at: Date.now() });
    await chrome.storage.local.set({ events });
  });

chrome.runtime.onInstalled.addListener((details) => {
  serial(async () => {
    if (details.reason === 'install') {
      await chrome.storage.local.set({ data: { schema: SCHEMA, items: [] } });
    } else if (details.reason === 'update') {
      let { data } = await chrome.storage.local.get('data');
      data ??= { schema: 1, items: [] };
      for (let s = data.schema + 1; s <= SCHEMA; s++) {
        data = { ...migrations[s](data), schema: s };
      }
      await chrome.storage.local.set({ data });
    }
  });
  logEvent({ type: 'installed', reason: details.reason, previousVersion: details.previousVersion });
});

// Apply updates immediately instead of waiting for the worker to go idle.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  logEvent({ type: 'updateAvailable', newVersion: details.version }).then(() => chrome.runtime.reload());
});
