importScripts('lib.js', 'reinject.js'); // SCHEMA, VERSION, serial; reinjectContentScripts

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

// --- Content scripts in tabs that were open before this extension load ---------
// The old version's scripts there hand over their state and shut down
// (cs-lifecycle.js). autoReinject=false is a test switch to watch Chromium without this.
const hasContentScripts = !!chrome.runtime.getManifest().content_scripts?.length;
const autoReinject = async () => (await chrome.storage.local.get('autoReinject')).autoReinject ?? true;

// Once per extension load: install, update, runtime.reload(), re-enable, browser
// start. chrome.storage.session is cleared whenever the extension unloads, so the
// first service-worker start after a load does the work. onInstalled wakes the
// worker for install/update/reload; after a re-enable nothing does until the first
// tab event below. onlyMissing: after a browser restart, tabs already have this
// load's scripts (Chrome injected them), so nothing is re-run.
async function onLoad() {
  if (!hasContentScripts) return;
  if ((await chrome.storage.session.get('loadHandled')).loadHandled) return;
  await chrome.storage.session.set({ loadHandled: true }); // even if switched off: once per load
  if (!(await autoReinject())) return;
  const report = await reinjectContentScripts({ onlyMissing: true });
  await setPending(report);
  logEvent({ type: 'reinjected', trigger: 'load', report });
}
const loaded = onLoad();

// Tabs that didn't answer in time (hung renderer, debugger, alert(), frozen): retry
// when the user switches to the tab, and every 30s while any are pending (a dialog
// dismissed in the active tab produces no tab event).
async function setPending(report) {
  const { reinjectPending = [] } = await chrome.storage.session.get('reinjectPending');
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const pending = new Set(reinjectPending.filter((id) => open.has(id)));
  for (const r of report) r.timedOut ? pending.add(r.tabId) : pending.delete(r.tabId);
  await chrome.storage.session.set({ reinjectPending: [...pending] });
  if (!pending.size) await chrome.alarms.clear('reinject-retry');
  else if (!(await chrome.alarms.get('reinject-retry'))) chrome.alarms.create('reinject-retry', { periodInMinutes: 0.5 });
}
async function retryPending(trigger, onlyTab) {
  await loaded;
  const { reinjectPending = [] } = await chrome.storage.session.get('reinjectPending');
  const tabIds = onlyTab ? reinjectPending.filter((id) => id === onlyTab) : reinjectPending;
  if (!tabIds.length) return;
  const report = await reinjectContentScripts({ tabIds, onlyMissing: true });
  await setPending(report);
  logEvent({ type: 'reinjected', trigger, report });
}
// Registered only with content scripts (top level, synchronously, as MV3 requires).
if (hasContentScripts) {
  chrome.tabs.onActivated.addListener(({ tabId }) => retryPending('activated', tabId));
  chrome.alarms.onAlarm.addListener((a) => a.name === 'reinject-retry' && retryPending('alarm'));
}

// No back/forward-cache handling needed: Chromium flushes the cache when the
// extension unloads (NotRestoredReason CacheFlushed), so going back reloads the
// page and the new version's scripts come from the manifest.

// Apply updates immediately instead of waiting for the worker to go idle.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  logEvent({ type: 'updateAvailable', newVersion: details.version }).then(() => chrome.runtime.reload());
});
