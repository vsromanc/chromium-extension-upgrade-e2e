// Re-inject the manifest's content_scripts into tabs that were open before this
// version loaded. Chromium injects manifest content scripts only on navigation,
// so after an update (or a fresh install) existing tabs have none / the old ones.
// Shared by the service worker (importScripts) and test.html.
//
// Replays the manifest's rules per frame: matches, exclude_matches, include_globs,
// exclude_globs, all_frames, world, css, run_at (document_start ->
// injectImmediately), in manifest order. Not handled: match_about_blank /
// match_origin_as_fallback (about:/blob:/data: frames are skipped).
//
// Matching uses each document's original URL (as Chrome does), and document_idle/
// document_end scripts wait for DOMContentLoaded in documents still parsing.
//
// Needs "scripting" + host permissions for the pages. Frames are discovered by
// probing the tab, which requires access to its top frame: a matching iframe
// inside a page we can't access is not reached (it gets the new version on its
// next navigation). chrome.webNavigation.getAllFrames would close that gap but
// adds a permission warning — which disables the extension on update for normal
// installs.

// Match pattern -> predicate. A pattern without a port matches any port.
const matchPattern = (pattern) => {
  if (pattern === '<all_urls>') return (u) => /^(https?|wss?|ftp|file|urn):$/.test(u.protocol);
  const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) throw new Error(`bad match pattern ${pattern}`);
  const [, scheme, hostPort, path] = m;
  const [, host, port] = /^(.*?)(?::(\d+|\*))?$/.exec(hostPort);
  const pathRe = globToRegExp(path, false);
  return (u) => {
    const proto = u.protocol.slice(0, -1);
    if (scheme === '*' ? proto !== 'http' && proto !== 'https' : scheme !== proto) return false;
    if (port && port !== '*' && port !== (u.port || { http: '80', https: '443' }[proto])) return false;
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
      } else if (u.hostname !== host) return false;
    }
    return pathRe.test(u.pathname + u.search);
  };
};

// Glob -> RegExp: '*' = any run of chars; '?' = one char (include/exclude_globs only).
const globToRegExp = (glob, question = true) =>
  new RegExp(
    `^${[...glob]
      .map((c) => (c === '*' ? '.*' : c === '?' && question ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
      .join('')}$`,
  );

const compileContentScript = (cs) => {
  const any = (list, f) => (list ?? []).map(f);
  const matches = any(cs.matches, matchPattern);
  const excludeMatches = any(cs.exclude_matches, matchPattern);
  const includeGlobs = any(cs.include_globs, (g) => globToRegExp(g));
  const excludeGlobs = any(cs.exclude_globs, (g) => globToRegExp(g));
  return (href) => {
    let u;
    try {
      u = new URL(href);
    } catch {
      return false;
    }
    if (!/^(https?|wss?|ftp|file|urn):$/.test(u.protocol)) return false;
    return (
      matches.some((m) => m(u)) &&
      !excludeMatches.some((m) => m(u)) &&
      (!includeGlobs.length || includeGlobs.some((g) => g.test(href))) &&
      !excludeGlobs.some((g) => g.test(href))
    );
  };
};

// A step that doesn't settle (hung renderer, debugger pause, open alert(), frozen
// tab) must not hold up the rest. The abandoned call may still land later; that is
// harmless, re-injection is idempotent (cs-lifecycle.js replaces in-realm).
const timed = (promise, ms) =>
  Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

// Per frame: the URL the document LOADED at (Chrome matches content scripts at load,
// so an SPA that pushState'd into an excluded path keeps its scripts, and vice
// versa), whether it is still parsing, and whether this extension load's ISOLATED
// scripts already run here (cs-lifecycle.js defines __ueSingleton in our world).
const probeFrame = () => ({
  url: performance.getEntriesByType('navigation')[0]?.name || location.href,
  loading: document.readyState === 'loading',
  ours: typeof globalThis.__ueSingleton === 'function',
});
const domReady = () =>
  new Promise((r) => (document.readyState !== 'loading' ? r() : document.addEventListener('DOMContentLoaded', () => r(), { once: true })));

async function injectTab(tab, entries, { onlyMissing, timeoutMs }) {
  // Frame inventory: one result per accessible frame, with its documentId.
  const frames = await timed(
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, injectImmediately: true, func: probeFrame }),
    timeoutMs,
  );
  const injected = [];
  let waited = 0;
  for (const { i, cs, test } of entries) {
    const docs = frames.filter(
      (f) => (cs.all_frames || f.frameId === 0) && test(f.result.url) && !(onlyMissing && f.result.ours),
    );
    if (!docs.length) continue;
    // documentIds (not frameIds): if a frame navigated since the probe, skip it;
    // the new document gets the manifest scripts itself.
    const target = { tabId: tab.id, documentIds: docs.map((f) => f.documentId) };
    if (cs.run_at !== 'document_start' && docs.some((f) => f.result.loading)) {
      // Honour run_at for documents still parsing: wait for DOMContentLoaded (capped).
      const loading = docs.filter((f) => f.result.loading).map((f) => f.documentId);
      waited += loading.length;
      await timed(
        chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: loading }, injectImmediately: true, func: domReady }),
        60_000,
      ).catch(() => {});
    }
    if (cs.css?.length) await timed(chrome.scripting.insertCSS({ target, files: cs.css }), timeoutMs);
    if (cs.js?.length) {
      await timed(
        chrome.scripting.executeScript({
          target,
          files: cs.js,
          world: cs.world ?? 'ISOLATED',
          injectImmediately: cs.run_at === 'document_start',
        }),
        timeoutMs,
      );
    }
    injected.push({ entry: i, frames: docs.length });
  }
  return { tabId: tab.id, injected, waited };
}

/**
 * Re-inject into open tabs. Options:
 *   tabIds       only these tabs
 *   onlyMissing  skip frames where this extension load's scripts already run
 *   timeoutMs    per step; a tab that times out is reported { timedOut: true } for a retry
 *   concurrency  tabs in flight at once (active tab first)
 * Returns [{ tabId, injected: [{ entry, frames }], waited } | { tabId, error, timedOut? }].
 */
async function reinjectContentScripts({ tabIds, onlyMissing = false, timeoutMs = 5000, concurrency = 4 } = {}) {
  const entries = (chrome.runtime.getManifest().content_scripts ?? []).map((cs, i) => ({
    i,
    cs,
    test: compileContentScript(cs),
  }));
  if (!entries.length) return [];
  const tabs = (await chrome.tabs.query({}))
    .filter((t) => !t.discarded && (!tabIds || tabIds.includes(t.id))) // discarded tabs reload when activated
    .sort((a, b) => b.active - a.active || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < tabs.length) {
      const tab = tabs[next++];
      out.push(
        await injectTab(tab, entries, { onlyMissing, timeoutMs }).catch((e) => ({
          tabId: tab.id,
          error: e.message,
          ...(e.message === 'timeout' && { timedOut: true }),
        })),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tabs.length) }, worker));
  return out;
}
