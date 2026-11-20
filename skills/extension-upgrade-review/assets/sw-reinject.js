// Service-worker side of re-injection (reference copy, extension-upgrade-review skill).
// importScripts('reinject.js') (or import it) first. Needs "scripting", "alarms" and host
// permissions covering the content scripts' matches. Register at top level.
// --- Content scripts in tabs that were open before this extension load ---------
// The old version's scripts there hand over their state and shut down
// (cs-lifecycle.js).
const hasContentScripts = !!chrome.runtime.getManifest().content_scripts?.length;

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
  const report = await reinjectContentScripts({ onlyMissing: true });
  await setPending(report);
  console.debug('reinject', { type: 'reinjected', trigger: 'load', report });
}
const loaded = onLoad();
// Any onInstalled listener makes Chromium start the worker on install/update/reload.
chrome.runtime.onInstalled.addListener(() => {});

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
  console.debug('reinject', { type: 'reinjected', trigger, report });
}
// Registered only with content scripts (top level, synchronously, as MV3 requires).
if (hasContentScripts) {
  chrome.tabs.onActivated.addListener(({ tabId }) => retryPending('activated', tabId));
  chrome.alarms.onAlarm.addListener((a) => a.name === 'reinject-retry' && retryPending('alarm'));
}

