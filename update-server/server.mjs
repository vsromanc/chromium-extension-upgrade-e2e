// Minimal self-hosted extension update server.
//   GET|POST /updates.xml        -> gupdate manifest: one <app> per published entry, in order
//   GET      /crx/<file>.crx     -> CRX file
// Admin API (used by the tests):
//   POST /_admin/publish  body: { entries: ["1.0.1", "ext-1.0.3-evil.crx", ...], mode: "ok" }
//                         entries are versions or CRX file names from meta.json, in XML order.
//                         mode: ok | down (503 for everything) | corrupt (CRX bodies truncated)
//   GET  /_admin/requests -> log of update checks / downloads
//   POST /_admin/reset    -> clear request log
//   GET  /_admin/meta     -> { id, versions, published }
//   GET  /_admin/health
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const DATA = process.env.DATA_DIR ?? '/data/crx';
const BASE = process.env.PUBLIC_BASE ?? `http://update-server:${PORT}`;
const meta = JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8'));

let published = { entries: [], mode: 'ok' };
let requests = [];

const resolveEntry = (e) => meta.versions.find((v) => v.file === e || v.version === e);

const xml = () => {
  const apps = published.entries.map((e) => {
    const v = resolveEntry(e);
    return `  <app appid='${meta.id}' status='ok'>
    <updatecheck codebase='${BASE}/crx/${v.file}' version='${v.version}'/>
  </app>`;
  });
  if (!apps.length) apps.push(`  <app appid='${meta.id}' status='ok'>\n    <updatecheck status='noupdate'/>\n  </app>`);
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
${apps.join('\n')}
</gupdate>
`;
};

const readBody = (req) =>
  new Promise((ok) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => ok(b));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const body = await readBody(req);
  const send = (code, type, payload) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(payload);
  };

  if (!url.pathname.startsWith('/_admin/')) {
    const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname, query: url.search, mode: published.mode };
    requests.push(entry);
    console.log(JSON.stringify(entry));
    // Record how each response ended: 'finish' = fully sent, 'close' first = client aborted.
    const t0 = Date.now();
    res.on('finish', () => console.log(`  -> ${req.method} ${url.pathname} finished ${res.statusCode} in ${Date.now() - t0}ms`));
    res.on('close', () => !res.writableFinished && console.log(`  -> ${req.method} ${url.pathname} ABORTED by client after ${Date.now() - t0}ms`));
    if (published.mode === 'down') return send(503, 'text/plain', 'down for maintenance');
  }

  if (url.pathname === '/updates.xml') return send(200, 'application/xml', xml());

  const m = url.pathname.match(/^\/crx\/([\w.-]+\.crx)$/);
  if (m) {
    const file = join(DATA, m[1]);
    if (!existsSync(file)) return send(404, 'text/plain', 'not found');
    res.writeHead(200, { 'content-type': 'application/x-chrome-extension' });
    if (published.mode === 'corrupt') {
      const buf = readFileSync(file);
      return res.end(buf.subarray(0, Math.floor(buf.length / 2)));
    }
    return createReadStream(file).pipe(res);
  }

  if (url.pathname === '/_admin/health') return send(200, 'text/plain', 'ok');
  if (url.pathname === '/_admin/meta') return send(200, 'application/json', JSON.stringify({ ...meta, published }));
  if (url.pathname === '/_admin/requests') return send(200, 'application/json', JSON.stringify(requests));
  if (url.pathname === '/_admin/reset' && req.method === 'POST') {
    requests = [];
    return send(200, 'text/plain', 'ok');
  }
  if (url.pathname === '/_admin/publish' && req.method === 'POST') {
    const { entries = [], mode = 'ok' } = JSON.parse(body || '{}');
    const unknown = entries.filter((e) => !resolveEntry(e));
    if (unknown.length) return send(400, 'text/plain', `unknown entries: ${unknown}`);
    if (!['ok', 'down', 'corrupt'].includes(mode)) return send(400, 'text/plain', `unknown mode ${mode}`);
    published = { entries, mode };
    console.log(`published: ${JSON.stringify(published)}`);
    return send(200, 'application/json', JSON.stringify(published));
  }
  send(404, 'text/plain', 'not found');
}).listen(PORT, () => console.log(`update server on :${PORT}, id=${meta.id}`));
