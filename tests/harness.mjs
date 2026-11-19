// Shared plumbing for the upgrade scenarios. Each scenario launches its own
// Chromium with a fresh profile; the update server is shared, so test files
// must run serially (--test-concurrency=1).
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

export const SERVER = process.env.UPDATE_SERVER ?? 'http://update-server:8080';
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? 'artifacts';
const POLICY_FILE = process.env.POLICY_FILE ?? '/etc/chromium/policies/managed/e2e.json';
const EXTERNAL_DIR = process.env.EXTERNAL_EXTENSIONS_DIR ?? '/usr/share/chromium/extensions';
export const TIMEOUT = Number(process.env.STEP_TIMEOUT_MS ?? 60_000);

export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, what, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

export async function admin(path, { method = 'GET', body } = {}) {
  const r = await fetch(SERVER + path, { method, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

/** Publish an ordered list of entries (versions or CRX file names). */
export async function publish(entries, mode = 'ok') {
  await admin('/_admin/publish', { method: 'POST', body: { entries, mode } });
  log(`published ${JSON.stringify(entries)} mode=${mode}`);
}

export const requests = () => admin('/_admin/requests');

/** Wait until the server has seen a request matching `pred` (after `since`). */
export const waitForRequest = (pred, what, since = 0, timeout) =>
  waitFor(async () => (await requests()).slice(since).find(pred), `server request: ${what}`, timeout);

/** Steps that depend on each other: once one fails, skip the rest. */
export function stepper(it) {
  let failed = false;
  return (name, fn) =>
    it(name, async (t) => {
      if (failed) return t.skip('previous step failed');
      try {
        await fn(t);
      } catch (e) {
        failed = true;
        throw e;
      }
    });
}

/**
 * Launch Chromium with the extension installed from the update server.
 *   install: 'force'    -> ExtensionInstallForcelist policy (enterprise force-install)
 *            'external' -> external extension JSON (normal, user-disableable install)
 *   updateFrequency: seconds between Chromium's own periodic update checks
 */
export async function launch(name, { install = 'force', updateFrequency = 3600 } = {}) {
  const { id, updateUrl } = await admin('/_admin/meta');
  await admin('/_admin/reset', { method: 'POST' });
  const artifacts = join(ARTIFACTS, name);
  await mkdir(artifacts, { recursive: true });

  // Install method. DevTools must be allowed for the test to drive policy-installed extensions.
  const policy = { DeveloperToolsAvailability: 1 };
  if (install === 'force') policy.ExtensionInstallForcelist = [`${id};${updateUrl}`];
  await writeFile(POLICY_FILE, JSON.stringify(policy, null, 2));
  const externalFile = join(EXTERNAL_DIR, `${id}.json`);
  await rm(externalFile, { force: true });
  if (install === 'external') await writeFile(externalFile, JSON.stringify({ external_update_url: updateUrl }));

  const profileDir = await mkdtemp(join(tmpdir(), 'profile-'));
  const verbose = process.env.CHROMIUM_LOG === '1';
  let browser;
  let extPage;
  let internalsPage;
  const startBrowser = async () => {
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN ?? '/usr/bin/chromium',
      headless: process.env.HEADLESS !== '0',
      dumpio: verbose,
      userDataDir: profileDir,
      // Puppeteer's defaults would block extensions and the background updater.
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
      ],
      args: [
        '--no-sandbox', // unprivileged container; isolation comes from Docker
        '--disable-dev-shm-usage',
        // Background (IDLE-priority) update downloads are written to disk by
        // BEST_EFFORT tasks, which Chromium fences until "startup complete". In
        // headless automation that only fires via a 3-minute failsafe. Shorten it.
        `--enable-features=ImprovedStartupBestEffortDelay:StartupDelayFailsafeTimeout/${process.env.STARTUP_FAILSAFE ?? '5s'}`,
        `--extensions-update-frequency=${updateFrequency}`,
        ...(verbose
          ? [
              '--enable-logging=stderr',
              '--v=0',
              '--vmodule=*extension*=2,*crx*=2,*install*=2,*updat*=2,*unpack*=2',
              `--log-net-log=${join(process.cwd(), artifacts, 'netlog.json')}`,
              '--net-log-capture-mode=Everything',
            ]
          : []),
      ],
    });
    log(`[${name}] ${await browser.version()}, install=${install}, updateFrequency=${updateFrequency}s`);
    browser.on('console', (m) => log(`[${name}] console`, m.type(), m.text()));
  };
  await startBrowser();

  /** Quit and relaunch Chromium on the same profile (like a user restarting the browser). */
  const restart = async () => {
    await browser.close();
    extPage = internalsPage = undefined;
    log(`[${name}] restarting browser`);
    await startBrowser();
  };

  // Extension page handle (chrome-extension://<id>/test.html). Unlike the MV3
  // service worker it doesn't idle out, and reloading it reflects the installed
  // version. Chromium closes it when the extension reloads, so reopen as needed.
  const ext = (version, timeout) =>
    waitFor(async () => {
      if (!extPage || extPage.isClosed()) extPage = await browser.newPage();
      await extPage.goto(`chrome-extension://${id}/test.html`, { waitUntil: 'load', timeout: 5000 });
      const v = await extPage.evaluate(() => self.__test?.version);
      if (v && (!version || v === version)) return extPage;
    }, `extension ${version ?? ''} page`, timeout);
  const closeExt = async () => {
    if (extPage && !extPage.isClosed()) await extPage.close();
    extPage = undefined;
  };

  // Chromium's own view of the extension, from chrome://extensions-internals (a
  // WebUI page, so it doesn't count as extension activity).
  const internals = async () => {
    if (!internalsPage || internalsPage.isClosed()) internalsPage = await browser.newPage();
    await internalsPage.goto('chrome://extensions-internals', { waitUntil: 'load' });
    const list = await waitFor(
      () => internalsPage.evaluate(() => { try { return JSON.parse(document.body.innerText); } catch { return null; } }),
      'extensions-internals JSON',
      5000,
    );
    return list.find((e) => e.id === id);
  };
  const installedVersion = async () => (await internals())?.version;

  const waitForVersion = async (version, timeout) => {
    let last;
    await waitFor(async () => {
      const v = await installedVersion();
      if (v !== last) log(`[${name}] installed version ${(last = v)}`);
      return v === version;
    }, `Chromium to install ${version}`, timeout);
  };

  /** Read extension storage through its page (opens it if needed). */
  const state = async () => (await ext()).evaluate(() => self.__test.state());

  /** chrome.runtime.requestUpdateCheck() from the extension page. */
  const checkForUpdate = async ({ keepPageOpen = false } = {}) => {
    const p = await ext();
    const result = await p.evaluate(() => self.__test.checkForUpdate());
    log(`[${name}] requestUpdateCheck -> ${JSON.stringify(result)}`);
    // An open extension page counts as activity; close it unless asked not to.
    if (!keepPageOpen) await closeExt();
    return result;
  };

  /** Add items through the extension page, then close it so the extension can go idle. */
  const addItems = async (...titles) => {
    const p = await ext();
    for (const t of titles) await p.evaluate((t) => self.__test.addItem(t), t);
    await closeExt();
  };

  /** Wait until the service worker's onInstalled handler has recorded `reason` (and finished migrating). */
  const waitForInstalledEvent = (reason, version) =>
    waitFor(async () => {
      const st = await state();
      return st.events?.some((e) => e.reason === reason && (!version || e.version === version)) && st;
    }, `onInstalled(${reason}${version ? ` ${version}` : ''}) to be recorded`, 15_000).finally(closeExt);

  /** Chromium's persisted settings for the extension + its install dirs on disk. */
  const savedSettings = async () => {
    const prefs = {};
    for (const f of ['Preferences', 'Secure Preferences']) {
      const p = JSON.parse(await readFile(join(profileDir, 'Default', f), 'utf8').catch(() => '{}'));
      prefs[f] = p.extensions?.settings?.[id];
    }
    prefs.installDirs = await readdir(join(profileDir, 'Default', 'Extensions', id)).catch((e) => e.message);
    return prefs;
  };

  const close = async () => {
    try {
      const reqs = await requests();
      await writeFile(join(artifacts, 'server-requests.json'), JSON.stringify(reqs, null, 2));
      await writeFile(join(artifacts, 'extension-internals.json'), JSON.stringify(await internals(), null, 2));
      const st = await state().catch((e) => ({ error: e.message }));
      await writeFile(join(artifacts, 'extension-state.json'), JSON.stringify(st, null, 2));
      await writeFile(join(artifacts, 'extension-prefs.json'), JSON.stringify(await savedSettings(), null, 2));
    } catch (e) {
      log(`[${name}] artifact collection failed: ${e.message}`);
    }
    await browser.close();
  };

  return {
    id, ext, closeExt, internals, installedVersion, waitForVersion, savedSettings,
    state, addItems, waitForInstalledEvent, checkForUpdate, restart, close,
  };
}

/** The seeded items as each schema stores them. */
export const SEED = ['buy milk', 'ship v2'];
export const itemsAtSchema = (schema) =>
  SEED.map((title) =>
    schema === 1 ? title : schema === 2 ? { title, done: false } : { title, done: false, tags: [] },
  );
