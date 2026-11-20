// Focus Timer service worker. All state lives in chrome.storage; listeners are top level.
const SCHEMA = 2;
const MIGRATIONS = {
  // v1 stored minutes as a string
  2: (s) => ({ ...s, minutes: Number(s.minutes) || 25 }),
};

async function migrateIfNeeded() {
  const { settings = {}, schema = 1 } = await chrome.storage.local.get(['settings', 'schema']);
  if (schema >= SCHEMA) return;
  let s = settings;
  for (let v = schema + 1; v <= SCHEMA; v++) s = MIGRATIONS[v](s);
  await chrome.storage.local.set({ settings: s, schema: SCHEMA });
}
const ready = migrateIfNeeded();

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  await ready;
  console.info('installed', reason, previousVersion, chrome.runtime.getManifest().version);
  if (!(await chrome.alarms.get('tick'))) chrome.alarms.create('tick', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'tick') return;
  await ready;
  const { session } = await chrome.storage.local.get('session');
  if (session && Date.now() >= session.endsAt) {
    await chrome.storage.local.remove('session');
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'Focus Timer', message: 'Time is up' });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  ready
    .then(() => handle(msg))
    .then((value) => sendResponse({ value }), (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'start': {
      const { settings } = await chrome.storage.local.get('settings');
      const session = { endsAt: Date.now() + (settings?.minutes ?? 25) * 60_000 };
      await chrome.storage.local.set({ session });
      return session;
    }
    case 'status':
      return (await chrome.storage.local.get('session')).session ?? null;
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

// Apply updates once no session is running.
chrome.runtime.onUpdateAvailable.addListener(async () => {
  const { session } = await chrome.storage.local.get('session');
  if (!session) chrome.runtime.reload();
});
