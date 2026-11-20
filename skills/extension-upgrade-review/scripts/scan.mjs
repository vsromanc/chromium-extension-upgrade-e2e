#!/usr/bin/env node
// Read-only inventory of a browser-extension project for an upgrade-safety review.
// Dependency-free (Node 18+). Prints Markdown (default) or JSON (--json).
//
//   node scan.mjs <project-dir> [--json] [--all] [--max-hits N]
//
// Large projects carry dead code, so the scan starts from the extension's real
// entry points (manifest(s), their HTML pages, framework conventions), follows
// imports / importScripts / <script src> / injected `files`, and tags every hit as
// LIVE (reachable from an entry) or not. Only live hits are listed unless --all.
//
// It does NOT judge. Hits are leads to read; a missing hit is a hint, not proof
// (code can be generated, aliased, minified, or reached in ways not modelled here).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const maxIdx = args.indexOf('--max-hits');
const root = resolve(args.find((a, i) => !a.startsWith('--') && (maxIdx < 0 || i !== maxIdx + 1)) ?? '.');
const asJson = args.includes('--json');
const showAll = args.includes('--all');
const maxHits = (maxIdx >= 0 && Number(args[maxIdx + 1])) || 10;

const SKIP = new Set(['node_modules', '.git', 'coverage', '.cache', '.turbo', '.next', '.idea', '.vscode']);
const BUILD = new Set(['dist', 'build', 'out', '.output', '.plasmo', 'release', 'artifacts', 'target']);
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.vue', '.svelte']);
const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.mts', '.cts', '.cjs', '.vue', '.svelte'];

// --- Walk ------------------------------------------------------------------------------
const all = [];
(function walk(dir, inBuild) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(p, inBuild || BUILD.has(e.name));
    } else all.push({ path: p, build: inBuild });
  }
})(root, false);

const isBuild = new Map(all.map((f) => [f.path, f.build]));
const rel = (p) => relative(root, p) || '.';
const cache = new Map();
const read = (p) => {
  if (!cache.has(p)) {
    let t = '';
    try {
      t = statSync(p).size < 3_000_000 ? readFileSync(p, 'utf8') : '';
    } catch {}
    cache.set(p, t);
  }
  return cache.get(p);
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const sources = all.filter((f) => !f.build && SRC_EXT.has(extname(f.path))).map((f) => f.path);

// --- Manifests (source and built) -------------------------------------------------------
const manifests = [];
for (const { path: f, build } of all.filter((f) => f.path.endsWith(`${sep}manifest.json`))) {
  const text = read(f);
  if (!text.includes('manifest_version')) continue;
  let m;
  try {
    m = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  } catch (e) {
    manifests.push({ path: f, build, error: `unparseable (${e.message}); template?` });
    continue;
  }
  manifests.push({ path: f, build, m, template: /__\w+__|\{\{|\$\{/.test(text) });
}
const vparts = (v) => String(v ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
const vcmp = (a, b) => {
  const x = vparts(a);
  const y = vparts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const sourceManifests = manifests.filter((x) => !x.build);
const builtManifests = manifests.filter((x) => x.build && x.m).sort((a, b) => vcmp(b.m.version, a.m.version));
// Describe every source manifest, plus the newest built one (the real shape when the source is
// a template or generated), plus the newest built one that has content scripts.
const shown = [...sourceManifests];
if (builtManifests[0]) shown.push(builtManifests[0]);
const builtCs = builtManifests.find((x) => x.m.content_scripts?.length);
if (builtCs && !shown.includes(builtCs)) shown.push(builtCs);

// --- Build tooling -------------------------------------------------------------------------
const tooling = [];
const pkg = (() => {
  try {
    return JSON.parse(read(join(root, 'package.json')) || '{}');
  } catch {
    return {};
  }
})();
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const TOOLS = {
  wxt: 'WXT: manifest from wxt.config.* + entrypoints/ (defineBackground / defineContentScript / *.html)',
  plasmo: 'Plasmo: manifest from package.json "manifest" + background.ts, contents/, popup/options/sidepanel, tabs/',
  '@crxjs/vite-plugin': 'CRXJS: manifest from manifest.json / manifest.config.* via Vite',
  'webextension-polyfill': 'APIs used as browser.*',
  'extension.js': 'Extension.js: manifest.json in source',
};
for (const [n, note] of Object.entries(TOOLS)) if (deps[n]) tooling.push({ name: n, version: deps[n], note });
for (const f of sources) if (/(^|\/)(wxt|manifest)\.config\.[cm]?[jt]s$/.test(rel(f))) tooling.push({ name: 'config', path: rel(f), note: 'manifest defined in code' });

// --- Path aliases (tsconfig/jsconfig paths) ----------------------------------------------
const aliases = [];
for (const cfg of ['tsconfig.json', 'jsconfig.json', '.wxt/tsconfig.json']) {
  const t = read(join(root, cfg));
  if (!t) continue;
  try {
    const j = JSON.parse(t.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    const base = resolve(root, dirname(cfg), j.compilerOptions?.baseUrl ?? '.');
    for (const [k, v] of Object.entries(j.compilerOptions?.paths ?? {})) {
      aliases.push({ prefix: k.replace(/\*$/, ''), targets: v.map((x) => resolve(base, x.replace(/\*$/, ''))) });
    }
  } catch {}
}
for (const [prefix, dir] of [['@/', 'src'], ['~/', 'src'], ['@/', '.'], ['~/', '.'], ['@@/', '.'], ['~~/', '.']]) {
  aliases.push({ prefix, targets: [join(root, dir)] });
}

// --- Entry points --------------------------------------------------------------------------
const entries = new Map(); // abs path -> why
const unresolved = [];
const extRoots = [...new Set(sourceManifests.map((x) => dirname(x.path)))];
if (!extRoots.length) extRoots.push(root, join(root, 'src'), join(root, 'public'));

function resolveFile(spec, fromDir) {
  const candidates = [];
  if (spec.startsWith('.')) candidates.push(resolve(fromDir, spec));
  else if (spec.startsWith('/')) for (const r of extRoots) candidates.push(join(r, spec));
  else {
    for (const a of aliases) if (spec.startsWith(a.prefix)) for (const t of a.targets) candidates.push(join(t, spec.slice(a.prefix.length)));
    if (!candidates.length && /\.(m?js|ts|html)$/.test(spec)) candidates.push(resolve(fromDir, spec)); // importScripts('lib.js')
  }
  for (const c of candidates) {
    for (const ext of RESOLVE_EXT) if (isFile(c + ext) && !isBuild.get(c + ext)) return c + ext;
    for (const ext of RESOLVE_EXT.slice(1)) if (isFile(join(c, `index${ext}`)) && !isBuild.get(join(c, `index${ext}`))) return join(c, `index${ext}`);
    // Built names often differ from sources: content.js -> content.ts
    const noExt = c.replace(/\.(m?js|cjs)$/, '');
    if (noExt !== c) for (const ext of RESOLVE_EXT.slice(1)) if (isFile(noExt + ext) && !isBuild.get(noExt + ext)) return noExt + ext;
  }
  return null;
}
const addEntry = (spec, why, fromDirs) => {
  for (const d of fromDirs) {
    const f = resolveFile(spec, d) ?? resolveFile(`./${spec.replace(/^\//, '')}`, d);
    if (f) {
      if (!entries.has(f)) entries.set(f, why);
      return;
    }
  }
  unresolved.push(`${spec} (${why})`);
};

for (const x of manifests.filter((x) => x.m)) {
  const m = x.m;
  const dirs = [dirname(x.path), ...extRoots];
  const tag = x.build ? 'built manifest' : 'manifest';
  if (m.background?.service_worker) addEntry(m.background.service_worker, `${tag} background`, dirs);
  for (const s of m.background?.scripts ?? []) addEntry(s, `${tag} background`, dirs);
  for (const [k, v] of [
    ['background page', m.background?.page],
    ['popup', m.action?.default_popup ?? m.browser_action?.default_popup],
    ['options', m.options_page ?? m.options_ui?.page],
    ['side panel', m.side_panel?.default_path],
    ['devtools', m.devtools_page],
    ...Object.entries(m.chrome_url_overrides ?? {}).map(([k2, v2]) => [`override ${k2}`, v2]),
    ...(m.sandbox?.pages ?? []).map((p) => ['sandbox', p]),
  ]) {
    if (v) addEntry(v, `${tag} ${k}`, dirs);
  }
  for (const [i, c] of (m.content_scripts ?? []).entries()) {
    for (const js of c.js ?? []) addEntry(js, `${tag} content_scripts[${i}] ${c.world ?? 'ISOLATED'}`, dirs);
  }
}
// Framework conventions (manifest generated from these).
const conv = [
  [/^(src\/)?entrypoints\/[^/]+\.(ts|tsx|js|jsx|html)$/, 'WXT entrypoint'],
  [/^(src\/)?entrypoints\/[^/]+\/(index|main)\.(ts|tsx|js|jsx|html)$/, 'WXT entrypoint'],
  [/^(src\/)?background(\/index)?\.(ts|tsx|js)$/, 'background (convention)'],
  [/^(src\/)?contents\/[^/]+\.(ts|tsx|js|jsx)$/, 'Plasmo content script'],
  [/^(src\/)?(popup|options|sidepanel|newtab|devtools)(\/index)?\.(tsx|ts|jsx|js|vue|svelte|html)$/, 'UI page (convention)'],
  [/^(src\/)?tabs\/[^/]+\.(tsx|ts|jsx|js|html)$/, 'Plasmo tab page'],
];
if (tooling.length || !manifests.some((x) => x.m)) {
  for (const f of all.filter((f) => !f.build)) {
    const r = rel(f.path).replace(/\\/g, '/');
    for (const [re, why] of conv) if (re.test(r) && !entries.has(f.path)) entries.set(f.path, why);
  }
}

// --- Reachability -------------------------------------------------------------------------
const IMPORT_RES = [
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /<script[^>]*\ssrc=['"]([^'"]+)['"]/g,
];
const STRINGS_IN = [/importScripts\(([^)]*)\)/g, /\bfiles\s*:\s*\[([^\]]*)\]/g, /\bjs\s*:\s*\[([^\]]*)\]/g];
const live = new Set();
const queue = [...entries.keys()];
while (queue.length) {
  const f = queue.pop();
  if (live.has(f)) continue;
  live.add(f);
  const text = read(f);
  const specs = [];
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) specs.push(m[1]);
  for (const re of STRINGS_IN) for (const m of text.matchAll(re)) for (const s of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) specs.push(s[1]);
  // Pages opened by code: getURL('x.html'), tabs.create({url:'x.html'}), offscreen url, sidePanel path.
  for (const m of text.matchAll(/['"`]([\w./-]+\.html)['"`]/g)) specs.push(m[1]);
  for (const spec of specs) {
    if (/^(https?:|data:|chrome:|#)/.test(spec)) continue;
    const t =
      resolveFile(spec, dirname(f)) ??
      (/\.(html|m?js)$/.test(spec) ? resolveFile(`/${spec.replace(/^\//, '')}`, dirname(f)) : null);
    if (t && !live.has(t)) queue.push(t);
  }
}
const liveSources = sources.filter((f) => live.has(f));
const reachKnown = entries.size > 0;
const isTest = (f) => /(^|\/)(tests?|__tests__|e2e|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(rel(f));

// --- Pattern hits -------------------------------------------------------------------------
const API = String.raw`(?:chrome|browser)`;
const PATTERNS = [
  ['onInstalled', `${API}\\.runtime\\.onInstalled`, 'migrations / registrations / re-injection live here?'],
  ['onStartup', `${API}\\.runtime\\.onStartup`, ''],
  ['onUpdateAvailable', `${API}\\.runtime\\.onUpdateAvailable`, 'how pending updates are applied'],
  ['runtime.reload', `${API}\\.runtime\\.reload\\(`, ''],
  ['previousVersion', `previousVersion`, 'update logging / migrations'],
  ['sendMessage', `${API}\\.(?:runtime|tabs)\\.sendMessage\\(`, 'callers: invalidated context, closed port'],
  ['connect', `${API}\\.(?:runtime|tabs)\\.connect\\(`, 'ports: lazy reconnect; onDisconnect checks runtime.id'],
  ['onMessage', `${API}\\.runtime\\.onMessage\\.addListener`, 'top-level; always respond; wait for migrations'],
  ['onConnect', `${API}\\.runtime\\.onConnect\\.addListener`, ''],
  ['external messaging', `onMessageExternal|onConnectExternal`, 'cross-version surface: version it'],
  ['native messaging', `connectNative|sendNativeMessage`, 'host updates independently: handshake'],
  ['runtime.id check', `runtime\\??\\.id\\b`, 'orphan detection'],
  ['context invalidated', `[Cc]ontext invalidated`, 'orphan handling'],
  ['storage write', `${API}\\.storage\\.(?:local|sync|session)\\.set\\(`, ''],
  ['storage.session', `${API}\\.storage\\.session`, ''],
  ['schema/migration', `\\b(?:schemaVersion|schema_version|dataVersion|dbVersion|STORAGE_VERSION|SCHEMA|migrat\\w*)\\b`, 'stored-data versioning'],
  ['indexedDB', `indexedDB\\.open\\(|new Dexie\\(|openDB\\(`, 'IndexedDB upgrade path'],
  ['contextMenus.create', `${API}\\.contextMenus\\.create\\(`, 'duplicate id after update unless removeAll()'],
  ['contextMenus.removeAll', `${API}\\.contextMenus\\.removeAll\\(`, ''],
  ['alarms.create', `${API}\\.alarms\\.create\\(`, 'alarms.get first'],
  ['dynamic DNR', `updateDynamicRules|updateSessionRules`, 'reconcile on update'],
  ['registerContentScripts', `registerContentScripts|updateContentScripts`, 'persist across updates; re-inject too'],
  ['getRegisteredContentScripts', `getRegisteredContentScripts`, ''],
  ['executeScript', `${API}\\.(?:scripting|tabs)\\.executeScript\\(`, 're-injection?'],
  ['insertCSS', `${API}\\.(?:scripting|tabs)\\.insertCSS\\(`, ''],
  ['documentIds', `documentIds`, ''],
  ['shadow DOM', `attachShadow\\(|createShadowRootUi|createShadowRoot`, 'injected UI isolation'],
  ['DOM CustomEvent', `new CustomEvent\\(`, 'cross-world / handoff protocol'],
  ['window.postMessage', `window\\.postMessage\\(|\\.contentWindow\\.postMessage\\(`, 'page-visible: version + validate'],
  ['page API hook', `(?:window\\.)?fetch\\s*=(?!=)|history\\.(?:push|replace)State\\s*=(?!=)|XMLHttpRequest\\.prototype\\.\\w+\\s*=(?!=)|EventTarget\\.prototype\\.\\w+\\s*=(?!=)`, 'MAIN-world hook: undoable?'],
  ['MutationObserver', `new MutationObserver\\(`, 'disconnect on teardown?'],
  ['setInterval', `setInterval\\(`, 'cleared on teardown?'],
  ['AbortController', `new AbortController\\(`, ''],
  ['permissions.request', `${API}\\.permissions\\.request\\(`, ''],
  ['setUninstallURL', `setUninstallURL`, ''],
  ['getURL', `${API}\\.runtime\\.getURL\\(`, 'resources an orphaned script may still load'],
  ['extension iframe', `<iframe|createElement\\(['"]iframe`, 'extension page embedded in sites?'],
];
const compiled = PATTERNS.map(([id, re, note]) => ({ id, re: new RegExp(re), note }));
const hits = Object.fromEntries(PATTERNS.map(([id, , note]) => [id, { note, liveCount: 0, live: [], otherCount: 0, other: [] }]));
for (const f of sources) {
  const L = !reachKnown || live.has(f);
  read(f)
    .split('\n')
    .forEach((line, i) => {
      if (line.length > 2000) return; // minified
      for (const { id, re } of compiled) {
        if (!re.test(line)) continue;
        const h = hits[id];
        const s = `${rel(f)}:${i + 1}: ${line.trim().slice(0, 140)}`;
        if (L) {
          h.liveCount++;
          if (h.live.length < maxHits) h.live.push(s);
        } else {
          h.otherCount++;
          if (h.other.length < maxHits) h.other.push(`${s}${isTest(f) ? '  [test]' : ''}`);
        }
      }
    });
}

// --- Content-script files: wrapping heuristic -----------------------------------------------
const csFiles = [];
for (const [f, why] of entries) {
  if (!/content_scripts|content script/i.test(why)) continue;
  const text = read(f);
  const top = text
    .split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /^(?:const|let|class)\s+\w/.test(l));
  csFiles.push({
    file: rel(f),
    why,
    lines: text.split('\n').length,
    esm: /^\s*(import|export)\s/m.test(text),
    topLevelLexical: top.length,
    topLevelSample: top.slice(0, 3).map(([l, n]) => `${n}: ${l.trim().slice(0, 70)}`),
    checksRuntimeId: /runtime\??\.id\b/.test(text),
  });
}

// Module-level mutable state in background entries (lost on every worker restart).
const bgState = [];
for (const [f, why] of entries) {
  if (!/background/.test(why)) continue;
  read(f)
    .split('\n')
    .forEach((l, i) => {
      if (/^(?:let|var)\s+\w/.test(l) || /^const\s+\w+\s*=\s*(?:new (?:Map|Set)\b|\{\s*\}|\[\s*\])/.test(l)) bgState.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
}

const testFiles = all
  .filter((f) => !f.build && SRC_EXT.has(extname(f.path)) && isTest(f.path))
  .filter((f) => /upgrad|requestUpdateCheck|onInstalled|migrat|reinject|orphan|previousVersion/i.test(read(f.path).slice(0, 300_000)))
  .map((f) => rel(f.path))
  .slice(0, 20);

// --- Output ---------------------------------------------------------------------------------
const summarize = (x) => {
  if (!x.m) return { path: rel(x.path), built: x.build, error: x.error };
  const m = x.m;
  return {
    path: rel(x.path),
    built: x.build,
    template: x.template || undefined,
    manifest_version: m.manifest_version,
    version: m.version,
    minimum_chrome_version: m.minimum_chrome_version,
    update_url: m.update_url,
    key: m.key ? 'present' : undefined,
    background: m.background,
    permissions: m.permissions ?? [],
    optional_permissions: m.optional_permissions ?? [],
    host_permissions: m.host_permissions ?? [],
    optional_host_permissions: m.optional_host_permissions ?? [],
    content_scripts: (m.content_scripts ?? []).map((c, i) => ({ i, world: c.world ?? 'ISOLATED', run_at: c.run_at ?? 'document_idle', ...c })),
    web_accessible_resources: m.web_accessible_resources,
    externally_connectable: m.externally_connectable,
  };
};
const report = {
  root,
  git: existsSync(join(root, '.git')),
  files: { total: all.length, sources: sources.length, liveSources: liveSources.length, inBuildDirs: all.filter((f) => f.build).length },
  reachability: reachKnown ? 'from entry points' : 'unknown (no entry points found): every file treated as live',
  manifests: shown.map(summarize),
  otherBuiltManifests: builtManifests.filter((x) => !shown.includes(x)).length,
  tooling,
  entries: [...entries].map(([f, why]) => ({ file: rel(f), why })),
  unresolvedEntries: [...new Set(unresolved)],
  notLiveSources: reachKnown ? sources.filter((f) => !live.has(f) && !isTest(f)).map(rel) : [],
  contentScriptFiles: csFiles,
  backgroundModuleState: bgState,
  upgradeTestFiles: testFiles,
  hits,
};
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const out = [];
const p = (s = '') => out.push(s);
p(`# Upgrade-review inventory: ${root}`);
p(`Files: ${report.files.total} (${report.files.inBuildDirs} in build dirs: only their manifests are read). Sources: ${report.files.sources}, **live: ${report.files.liveSources}** (${report.reachability}). Git: ${report.git ? 'yes' : 'no'}.`);
p();
p('## Manifests');
if (!report.manifests.length) p('None found. If tooling below generates it, read its config, or build the project and rerun (built manifests are read).');
for (const m of report.manifests) {
  p(`### ${m.path}${m.built ? ' (built)' : ''}${m.template ? ' (template with placeholders)' : ''}`);
  if (m.error) {
    p(`- ${m.error}`);
    continue;
  }
  p(`- MV${m.manifest_version}, version ${m.version}${m.minimum_chrome_version ? `, minimum_chrome_version ${m.minimum_chrome_version}` : ''}${m.update_url ? `, update_url ${m.update_url}` : ''}${m.key ? ', key present' : ''}`);
  p(`- background: ${JSON.stringify(m.background ?? null)}`);
  p(`- permissions ${JSON.stringify(m.permissions)}, optional ${JSON.stringify(m.optional_permissions)}`);
  p(`- host_permissions ${JSON.stringify(m.host_permissions)}, optional ${JSON.stringify(m.optional_host_permissions)}`);
  if (m.web_accessible_resources) p(`- web_accessible_resources: ${JSON.stringify(m.web_accessible_resources)}`);
  if (m.externally_connectable) p(`- externally_connectable: ${JSON.stringify(m.externally_connectable)}`);
  if (!m.content_scripts.length) p('- content_scripts: none');
  for (const c of m.content_scripts) {
    const rules = ['exclude_matches', 'include_globs', 'exclude_globs', 'match_about_blank', 'match_origin_as_fallback']
      .filter((k) => c[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(c[k])}`)
      .join(' ');
    p(`- content_scripts[${c.i}] ${c.world}, ${c.run_at}${c.all_frames ? ', all_frames' : ''}: matches=${JSON.stringify(c.matches)} ${rules} js=${JSON.stringify(c.js ?? [])} css=${JSON.stringify(c.css ?? [])}`);
  }
}
if (report.otherBuiltManifests) p(`(${report.otherBuiltManifests} more built manifests not shown)`);
if (tooling.length) {
  p();
  p('## Build tooling');
  for (const t of tooling) p(`- ${t.name}${t.version ? `@${t.version}` : ''}${t.path ? ` (${t.path})` : ''}: ${t.note}`);
}
p();
p('## Entry points (review starts here)');
for (const e of report.entries) p(`- ${e.file}: ${e.why}`);
if (!report.entries.length) p('- none resolved: find them by hand (build config, package.json scripts)');
if (report.unresolvedEntries.length) p(`- unresolved: ${report.unresolvedEntries.slice(0, 15).join('; ')}`);
if (csFiles.length) {
  p();
  p('## Content-script entry files');
  for (const c of csFiles) {
    p(`- ${c.file} (${c.why}, ${c.lines} lines${c.esm ? ', ESM source: check the bundle wraps it' : ''}): top-level const/let/class ${c.topLevelLexical}${c.topLevelLexical ? ` (${c.topLevelSample.join(' | ')})` : ''}; checks runtime.id: ${c.checksRuntimeId ? 'yes' : 'no'}`);
  }
}
if (bgState.length) {
  p();
  p('## Module-level mutable state in background entries (reset on every worker restart)');
  for (const b of bgState.slice(0, maxHits)) p(`- ${b}`);
}
p();
p('## Upgrade-related tests');
p(testFiles.length ? testFiles.map((t) => `- ${t}`).join('\n') : '- none found');
p();
p(`## API / pattern hits in live code${showAll ? ' (+ not-live, --all)' : ''}`);
p('0 is a hint, not proof. "+N not live" = only in unreachable files or tests (--all lists them).');
for (const [id, h] of Object.entries(hits)) {
  p(`- **${id}**: ${h.liveCount}${h.otherCount ? ` (+${h.otherCount} not live)` : ''}${h.note ? `: ${h.note}` : ''}`);
  for (const s of h.live) p(`  - ${s}`);
  if (showAll) for (const s of h.other) p(`  - (not live) ${s}`);
}
if (report.notLiveSources.length) {
  p();
  p(`## Not reachable from any entry point (${report.notLiveSources.length}; tests excluded)`);
  p('Possibly dead, or reached in a way the scan does not model (dynamic paths, build aliases). Skip unless an entry point turns out to use it.');
  for (const f of report.notLiveSources.slice(0, 25)) p(`- ${f}`);
  if (report.notLiveSources.length > 25) p(`- … ${report.notLiveSources.length - 25} more`);
}
console.log(out.join('\n'));
