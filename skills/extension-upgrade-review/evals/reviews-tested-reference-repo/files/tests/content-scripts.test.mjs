// Content scripts across an extension update, without reloading tabs.
//
// 2.0.x declare three content_scripts (see versions.json "patches"):
//   main     MAIN world, document_start, all_frames  http://*.test/*  minus /private/ and *nocs*
//   isolated ISOLATED, document_idle, all_frames, css   same rules
//   badge    ISOLATED, top frame only                 http://site-a.test/* with include_globs */page.html*
// Each runs through cs-lifecycle.js and writes instance records to <html data-ue>.
//
//  1. 2.0.0 -> 2.0.1 with re-injection switched off: what Chromium does to the old scripts.
//  2. Re-inject by hand: the new version takes over the old state in both worlds.
//  3. 2.0.1 -> 2.0.2 with re-injection on (once per extension load): same, automatically.
//  4. Re-injected tabs match what Chromium itself injects into fresh tabs.
//  5. User actions are handled exactly once, by the new version.
//  6. Re-running the injection within one version is harmless.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { launch, log, publish, sleep, stepper, waitFor } from './harness.mjs';

const A = 'http://site-a.test:8080';
const FRAME = 'http://site-b.test:8080/frame.html';
const URLS = {
  page: `${A}/page.html`,
  other: `${A}/other.html`,
  private: `${A}/private/page.html`,
  nocs: `${A}/nocs/page.html`,
  foreign: 'http://update-server:8080/page.html', // no host permission; its iframe does match
};
// Which scripts the manifest puts in each frame of each page (every page embeds FRAME).
const RULES = {
  page: { [URLS.page]: ['badge', 'isolated', 'main'], [FRAME]: ['isolated', 'main'] },
  other: { [URLS.other]: ['isolated', 'main'], [FRAME]: ['isolated', 'main'] },
  private: { [URLS.private]: ['badge'], [FRAME]: ['isolated', 'main'] }, // exclude_matches
  nocs: { [URLS.nocs]: ['badge'], [FRAME]: ['isolated', 'main'] }, // exclude_globs
  foreign: { [FRAME]: ['isolated', 'main'] },
};
const expected = (key, version, rules = RULES[key]) =>
  Object.fromEntries(Object.entries(rules).map(([f, names]) => [f, names.map((n) => `${n}@${version}`)]));

// DOM click: puppeteer's page.click() stalls on background tabs (no rAF in headless).
const click = (page) => page.evaluate(() => document.getElementById('btn').click());

/** Every instance record in every frame of a tab. */
async function instances(page) {
  const out = [];
  for (const f of page.frames()) {
    const raw = await f.evaluate(() => document.documentElement.dataset.ue ?? '{}');
    for (const [id, r] of Object.entries(JSON.parse(raw))) out.push({ id, frameUrl: f.url(), ...r });
  }
  return out;
}
/** frame URL -> sorted "script@version" of live instances. */
const liveMap = (list) => {
  const m = {};
  for (const i of list) if (i.status === 'live') (m[i.frameUrl] ??= []).push(`${i.script}@${i.version}`);
  for (const k in m) m[k].sort();
  return m;
};
const top = (list, script, version) =>
  list.filter((i) => i.frameUrl === list.topUrl && i.script === script && (!version || i.version === version));
const topInstances = async (page) => Object.assign(await instances(page), { topUrl: page.url() });

/** Wait until the tab's live instances are exactly `want`. */
async function waitForLive(page, want, what) {
  let last;
  try {
    await waitFor(async () => {
      last = liveMap(await instances(page));
      try {
        assert.deepEqual(last, want);
        return true;
      } catch {
        return false;
      }
    }, what, 20_000);
  } catch (e) {
    assert.deepEqual(last, want, e.message);
  }
}

describe('content scripts across an update, tabs not reloaded', () => {
  const step = stepper(it);
  let x;
  const tabs = {}; // opened on 2.0.0, kept open through every update
  let ids = {}; // instance ids in tabs.page's top frame, per script, of the previous version

  before(async () => {
    await publish(['2.0.0']);
    x = await launch('content-scripts');
    await x.waitForVersion('2.0.0');
    await x.waitForInstalledEvent('install');
    await x.inExt(() => self.__test.set({ autoReinject: false }));
    for (const [k, url] of Object.entries(URLS)) tabs[k] = await x.openPage(url);
  });
  after(() => x?.close());

  step('2.0.0: Chromium injects per the manifest rules (baseline)', async () => {
    for (const k of Object.keys(URLS)) await waitForLive(tabs[k], expected(k, '2.0.0'), `${k} on 2.0.0`);
    // Some state to hand over: 2 clicks + 1 page navigation (same URL, so frame URLs stay put).
    await click(tabs.page);
    await click(tabs.page);
    await tabs.page.evaluate(() => history.pushState(null, '', location.href));
    const list = await topInstances(tabs.page);
    assert.deepEqual(top(list, 'isolated')[0].state, { clicks: 2, navs: 1 });
    assert.deepEqual(top(list, 'main')[0].state, { navs: 1 });
    ids = Object.fromEntries(['main', 'isolated', 'badge'].map((s) => [s, top(list, s)[0].id]));
  });

  step('update without re-injection: old scripts are orphaned, not replaced', async () => {
    await publish(['2.0.1']);
    assert.equal((await x.checkForUpdate()).status, 'update_available');
    await x.waitForVersion('2.0.1');

    // The old ISOLATED scripts keep running: their 1s watchdog timer fires after
    // the extension is gone and finds chrome.runtime.id undefined.
    let list;
    await waitFor(async () => {
      list = await topInstances(tabs.page);
      return list.every((i) => i.status !== 'live');
    }, 'old instances to notice the update', 15_000);
    const iso = top(list, 'isolated')[0];
    const badge = top(list, 'badge')[0];
    const main = top(list, 'main')[0];
    log('orphaned 2.0.0 instances:', JSON.stringify({ iso, badge, main }));
    assert.equal(iso.status, 'dormant');
    assert.equal(iso.reason, 'orphaned:watchdog');
    assert.equal(iso.runtimeId, null, 'chrome.runtime.id is gone');
    assert.match(iso.apiError, /Extension context invalidated/);
    assert.deepEqual(iso.state, { clicks: 2, navs: 1 }, 'final state kept for a successor');
    assert.equal(badge.reason, 'orphaned:watchdog');
    // The MAIN-world script can't tell; it is stopped by its ISOLATED partner.
    assert.equal(main.status, 'dormant');
    assert.equal(main.reason, 'controller-stopped');
    assert.deepEqual(main.state, { navs: 1 });

    // Teardown left no UI or hooks behind; the 2.0.0 manifest CSS is still applied.
    const dom = await tabs.page.evaluate(() => ({
      panels: document.querySelectorAll('.ue-panel').length,
      badges: document.querySelectorAll('#ue-badge').length,
      cssColor: getComputedStyle(document.getElementById('css-target')).color,
    }));
    log('page DOM after orphaning:', JSON.stringify(dom));
    assert.equal(dom.panels, 0);
    assert.equal(dom.badges, 0);
    assert.equal(dom.cssColor, 'rgb(0, 128, 0)', 'old content-script CSS stays applied');

    // Chromium did not inject 2.0.1 into the open tabs... (each tab's watchdog
    // notices on its own 1s tick, so wait per tab)
    for (const k of Object.keys(URLS)) await waitForLive(tabs[k], {}, `${k}: nothing live`);
    // ...but does inject it into a tab navigated now.
    const fresh = await x.openPage(URLS.page);
    await waitForLive(fresh, expected('page', '2.0.1'), 'fresh tab on 2.0.1');
    await fresh.close();
  });

  step('manual re-injection: 2.0.1 takes over the old state in both worlds', async () => {
    const report = await x.inExt(() => self.__test.reinject());
    log('reinject report:', JSON.stringify(report));
    for (const k of Object.keys(URLS)) {
      // The foreign page's top frame isn't ours, so its matching iframe can't be reached.
      const want = k === 'foreign' ? {} : expected(k, '2.0.1');
      await waitForLive(tabs[k], want, `${k} re-injected with 2.0.1`);
    }

    const list = await topInstances(tabs.page);
    const iso = top(list, 'isolated', '2.0.1')[0];
    const main = top(list, 'main', '2.0.1')[0];
    log('2.0.1 instances:', JSON.stringify({ iso, main }));
    // A new isolated world per extension load: the old one is only reachable through the DOM.
    assert.equal(iso.via, 'event');
    assert.equal(iso.from, ids.isolated);
    assert.deepEqual(iso.state, { clicks: 2, navs: 1 });
    // MAIN world is the page's realm, shared by every version.
    assert.equal(main.via, 'global');
    assert.equal(main.from, ids.main);
    assert.deepEqual(main.state, { navs: 1 });
    assert.equal(top(list, 'isolated', '2.0.0')[0].status, 'gone');
    assert.equal(top(list, 'main', '2.0.0')[0].status, 'gone');
    assert.equal(await tabs.page.evaluate(() => getComputedStyle(document.getElementById('css-target')).color), 'rgb(0, 128, 0)');
    ids = Object.fromEntries(['main', 'isolated', 'badge'].map((s) => [s, top(list, s, '2.0.1')[0].id]));
  });

  step('update 2.0.1 -> 2.0.2: re-injected automatically on the new load', async () => {
    await x.inExt(() => self.__test.set({ autoReinject: true }));
    await publish(['2.0.2']);
    assert.equal((await x.checkForUpdate()).status, 'update_available');
    await x.waitForVersion('2.0.2');
    for (const k of Object.keys(URLS)) {
      await waitForLive(tabs[k], k === 'foreign' ? {} : expected(k, '2.0.2'), `${k} on 2.0.2`);
    }
    const list = await topInstances(tabs.page);
    const iso = top(list, 'isolated', '2.0.2')[0];
    const main = top(list, 'main', '2.0.2')[0];
    assert.equal(iso.from, ids.isolated);
    assert.deepEqual(iso.state, { clicks: 2, navs: 1 });
    assert.equal(main.from, ids.main);
    assert.deepEqual(main.state, { navs: 1 });
    const { events } = await waitFor(async () => {
      const st = await x.state();
      return st.events?.some((e) => e.type === 'reinjected' && e.version === '2.0.2') && st;
    }, 'reinjected event', 10_000).finally(x.closeExt);
    log('reinjected event:', JSON.stringify(events.find((e) => e.type === 'reinjected')));
  });

  step('re-injected tabs match what Chromium injects into fresh tabs', async () => {
    for (const [k, url] of Object.entries(URLS)) {
      const fresh = await x.openPage(url);
      await waitForLive(fresh, expected(k, '2.0.2'), `fresh ${k} on 2.0.2`);
      const freshMap = liveMap(await instances(fresh));
      const oldMap = liveMap(await instances(tabs[k]));
      if (k === 'foreign') assert.deepEqual(oldMap, {}, 'known gap: iframe under an inaccessible page');
      else assert.deepEqual(oldMap, freshMap, k);
      await fresh.close();
    }
  });

  step('user actions are handled once, by 2.0.2 only', async () => {
    const prevList = await topInstances(tabs.page);
    await click(tabs.page);
    await tabs.page.evaluate(() => history.pushState(null, '', location.href));
    const afterList = await topInstances(tabs.page);
    // Only the live 2.0.2 instances changed state.
    for (const i of afterList) {
      const prev = prevList.find((b) => b.id === i.id);
      if (i.status === 'live') continue;
      assert.deepEqual(i.state, prev.state, `${i.id} (${i.status}) did not react`);
    }
    assert.deepEqual(top(afterList, 'isolated', '2.0.2')[0].state, { clicks: 3, navs: 2 });
    assert.deepEqual(top(afterList, 'main', '2.0.2')[0].state, { navs: 2 });
    const dom = await tabs.page.evaluate(() => ({
      panels: [...document.querySelectorAll('.ue-panel')].map((e) => e.textContent),
      badges: [...document.querySelectorAll('#ue-badge')].map((e) => e.textContent),
    }));
    assert.deepEqual(dom, { panels: ['ext 2.0.2: 3 clicks, 2 navs'], badges: ['ext 2.0.2'] });
  });

  step('re-injecting the same version again replaces it in-realm, still one instance', async () => {
    const prevIso = top(await topInstances(tabs.page), 'isolated', '2.0.2').find((i) => i.status === 'live');
    await x.inExt(() => self.__test.reinject());
    await waitFor(async () => {
      const list = await topInstances(tabs.page);
      return top(list, 'isolated', '2.0.2').length === 2;
    }, 'second 2.0.2 isolated instance', 10_000);
    for (const k of Object.keys(URLS)) {
      await waitForLive(tabs[k], k === 'foreign' ? {} : expected(k, '2.0.2'), `${k} still one per script`);
    }
    const list = await topInstances(tabs.page);
    const iso = top(list, 'isolated', '2.0.2').find((i) => i.status === 'live');
    assert.equal(iso.via, 'global', 'same extension load = same isolated world');
    assert.equal(iso.from, prevIso.id);
    assert.deepEqual(iso.state, { clicks: 3, navs: 2 });
    assert.equal(await tabs.page.evaluate(() => document.querySelectorAll('.ue-panel').length), 1);
  });
});

// Edge cases (see README "Edge cases"). Own browser; 2.0.0 -> 2.0.1, then a same-version reload.
describe('content-script edge cases', () => {
  const step = stepper(it);
  let x;
  const C = 'http://site-c.test:8080'; // own site = own renderer process, so it can be hung alone
  const both = ['isolated', 'main'];
  const OTHER = { [`${A}/other.html`]: both, [FRAME]: both };
  const SPA = { [`${A}/private/spa`]: both, [FRAME]: both }; // loaded as other.html, then pushState
  const STUCK = { [`${C}/page.html`]: both, [FRAME]: both };
  const SLOW_URL = `${A}/slow.html?ms=20000`;
  const t = {};
  const v = (rules, version) => expected(null, version, rules);
  const events = async () => {
    const st = await x.state();
    await x.closeExt();
    return st.events ?? [];
  };
  const loadEvents = async () => (await events()).filter((e) => e.type === 'reinjected' && e.trigger === 'load');

  before(async () => {
    await publish(['2.0.0']);
    x = await launch('content-scripts-edge');
    await x.waitForVersion('2.0.0');
    await x.waitForInstalledEvent('install');
    t.spa = await x.openPage(`${A}/other.html`);
    t.reopen = await x.openPage(`${A}/other.html`);
    t.back = await x.openPage(`${A}/other.html`);
    t.stuck = await x.openPage(`${C}/page.html`);
  });
  after(() => x?.close());

  step('document.open() wipes listeners and DOM: both worlds restart on the new document', async () => {
    await waitForLive(t.reopen, v(OTHER, '2.0.0'), 'reopen baseline');
    await t.reopen.evaluate(() => {
      document.open();
      document.write('<p id="css-target">rewritten</p><button id="btn">click</button>');
      document.close();
    });
    // The iframe is gone with the old DOM; the watchdog notices within ~1s.
    await waitForLive(t.reopen, v({ [`${A}/other.html`]: both }, '2.0.0'), 'restarted on the new document');
    await click(t.reopen);
    await t.reopen.evaluate(() => history.pushState(null, '', location.href));
    const list = await topInstances(t.reopen);
    const iso = top(list, 'isolated')[0];
    const main = top(list, 'main')[0];
    assert.equal(iso.restarts, 1);
    assert.equal(main.restarts, 1);
    assert.deepEqual(iso.state, { clicks: 1, navs: 1 }, 'click listener and MAIN->ISOLATED channel work again');
    assert.deepEqual(main.state, { navs: 1 });
    assert.equal(await t.reopen.evaluate(() => document.querySelectorAll('.ue-panel').length), 1);
  });

  step('SPA navigated into an excluded path keeps its scripts (Chrome matches the load URL)', async () => {
    await waitForLive(t.spa, v(OTHER, '2.0.0'), 'spa baseline');
    await t.spa.evaluate(() => history.pushState(null, '', '/private/spa'));
    await waitForLive(t.spa, v(SPA, '2.0.0'), 'still running after pushState');
  });

  step('back/forward cache works for these pages (control)', async () => {
    await waitForLive(t.back, v(OTHER, '2.0.0'), 'back baseline');
    await t.back.goto(`${A}/page.html`, { waitUntil: 'load' });
    await t.back.goBack({ waitUntil: 'load' });
    assert.equal(await t.back.evaluate(() => document.documentElement.dataset.restored), 'true', 'restored from bfcache');
    await t.back.goto(`${A}/page.html`, { waitUntil: 'load' }); // leave other.html in the cache across the update
    t.bfcache = await t.back.createCDPSession();
    await t.bfcache.send('Page.enable');
    t.notRestored = [];
    t.bfcache.on('Page.backForwardCacheNotUsed', (e) => t.notRestored.push(...e.notRestoredExplanations.map((x) => x.reason)));
  });

  step('update to 2.0.1 while a tab is still parsing (no <body> yet)', async () => {
    t.slow = await x.openPage(SLOW_URL, { wait: false });
    await sleep(1500); // committed; parser blocked on /slow.js for 20s
    await publish(['2.0.1']);
    assert.equal((await x.checkForUpdate()).status, 'update_available');
    await x.waitForVersion('2.0.1');
    // The load re-injection waited for DOMContentLoaded in the slow tab.
    const ev = await waitFor(async () => (await loadEvents()).find((e) => e.version === '2.0.1'), 'load re-injection', 45_000);
    log('load re-injection:', JSON.stringify(ev.report));
    assert.ok(ev.report.some((r) => r.waited > 0), 'waited for a parsing document');
    await t.slow.loaded;
    await waitForLive(t.slow, v({ [SLOW_URL]: both, [FRAME]: both }, '2.0.1'), 'slow tab after load');
    const list = await instances(t.slow);
    log('slow tab instances:', JSON.stringify(list.map(({ id, status, via, from, frameUrl }) => ({ id, status, via, from, frameUrl }))));
    assert.ok(!list.some((i) => i.status === 'failed'), 'no start() failures');
  });

  step('after the update: SPA and reopened tabs got 2.0.1', async () => {
    await waitForLive(t.spa, v(SPA, '2.0.1'), 'spa re-injected by its load URL');
    await waitForLive(t.reopen, v({ [`${A}/other.html`]: both }, '2.0.1'), 'reopened document re-injected');
    assert.deepEqual(top(await topInstances(t.reopen), 'isolated', '2.0.1')[0].state, { clicks: 1, navs: 1 });
  });

  step('back/forward after the update: cache was flushed, page reloads with 2.0.1', async () => {
    await t.back.goBack({ waitUntil: 'load' });
    log('bfcache not used:', JSON.stringify(t.notRestored));
    assert.equal(await t.back.evaluate(() => document.documentElement.dataset.restored), undefined, 'not restored');
    assert.ok(t.notRestored.includes('CacheFlushed'), 'Chromium flushed the cache on extension unload');
    await waitForLive(t.back, v(OTHER, '2.0.1'), 'reloaded page has 2.0.1 from the manifest');
    assert.ok(!(await instances(t.back)).some((i) => i.version === '2.0.0'), 'fresh document, no orphans');
  });

  step('same-version reload with a hung tab: re-injected once per load; old partner does not stop new MAIN', async () => {
    const prevIso = top(await topInstances(t.spa), 'isolated', '2.0.1').find((i) => i.status === 'live');
    const loadsBefore = (await loadEvents()).length;
    // Hang site-c's renderer for 20s. Not awaited: it returns when the loop ends.
    t.busy = t.stuck.evaluate(() => {
      const end = Date.now() + 20_000;
      while (Date.now() < end);
    }).catch(() => {});
    await sleep(500);
    const p = await x.ext();
    p.evaluate(() => chrome.runtime.reload()).catch(() => {}); // the page closes with the extension
    await sleep(1000);
    await x.closeExt().catch(() => {});

    // Healthy tabs: new 2.0.1 instances from the new load.
    const iso = await waitFor(async () => {
      const live = top(await topInstances(t.spa), 'isolated', '2.0.1').find((i) => i.status === 'live');
      return live && live.id !== prevIso.id && live;
    }, 'new-load instances', 20_000);
    assert.equal(iso.via, 'event', 'same version, but a new isolated world');
    assert.equal(iso.from, prevIso.id);
    await sleep(2500); // past the old instance's watchdog: a late stop must not hit the new MAIN
    await waitForLive(t.spa, v(SPA, '2.0.1'), 'MAIN still live after reload');

    // The hung tab timed out instead of holding everything up.
    const ev = await waitFor(async () => (await loadEvents()).slice(loadsBefore)[0], 'reload re-injection', 20_000);
    log('reload re-injection:', JSON.stringify(ev.report));
    assert.ok(ev.report.some((r) => r.timedOut), 'a tab timed out');
  });

  step('the hung tab is re-injected later (activation or 30s retry alarm)', async () => {
    await t.busy;
    // Nothing reached it: the old instances go dormant once its loop ends.
    await waitForLive(t.stuck, {}, 'hung tab: only dormant instances');
    await t.stuck.bringToFront(); // tabs.onActivated, if this switches tabs in headless
    await waitFor(async () => {
      try {
        assert.deepEqual(liveMap(await instances(t.stuck)), v(STUCK, '2.0.1'));
        return true;
      } catch {
        return false;
      }
    }, 'hung tab re-injected', 45_000);
    const retry = (await events()).find((e) => e.type === 'reinjected' && ['activated', 'alarm'].includes(e.trigger));
    log('hung tab retried by:', retry?.trigger);
    assert.ok(retry, 'retried');
  });
});
