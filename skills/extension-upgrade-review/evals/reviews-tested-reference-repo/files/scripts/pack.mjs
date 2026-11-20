// Builds one signed CRX3 per entry in versions.json. All use keys/key.pem (=> the
// same extension ID) unless an entry names another key, e.g. to test rejection.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import crx3 from 'crx3';

const root = resolve(import.meta.dirname, '..');
const { updateUrl, versions, patches = {} } = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'));
const mainKey = join(root, 'keys', 'key.pem');
const buildDir = join(root, 'build');
const distDir = join(root, 'dist');

// Extension ID = first 16 bytes of sha256(DER SubjectPublicKeyInfo), hex mapped 0-f -> a-p.
const extensionId = (keyPath) => {
  const spki = createPublicKey(createPrivateKey(readFileSync(keyPath))).export({ type: 'spki', format: 'der' });
  return [...createHash('sha256').update(spki).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
};

mkdirSync(join(root, 'keys'), { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, 'crx'), { recursive: true });

const built = [];
for (const v of versions) {
  const { version, schema, permissions = [] } = v;
  const keyPath = v.key ? join(root, v.key) : mainKey;
  const file = v.file ?? `ext-${version}.crx`;
  const out = join(buildDir, file.replace(/\.crx$/, ''));

  cpSync(join(root, 'extension'), out, { recursive: true });
  for (const f of readdirSync(out)) {
    const p = join(out, f);
    writeFileSync(
      p,
      readFileSync(p, 'utf8')
        .replaceAll('__VERSION__', version)
        .replaceAll('__SCHEMA__', String(schema))
        .replaceAll('__UPDATE_URL__', updateUrl),
    );
  }
  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Optional manifest patch (e.g. content scripts); permissions are merged, other keys set.
  for (const [k, val] of Object.entries(v.patch ? patches[v.patch] : {})) {
    manifest[k] = k === 'permissions' ? [...manifest.permissions, ...val] : val;
  }
  manifest.permissions = [...new Set([...manifest.permissions, ...permissions])];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // crx3 creates the key on first use and reuses it afterwards.
  await crx3([out], { keyPath, crxPath: join(distDir, 'crx', file) });
  const signedBy = extensionId(keyPath);
  built.push({ version, schema, file, permissions: manifest.permissions, signedBy });
  console.log(`packed ${file} (v${version}, schema ${schema}, perms ${manifest.permissions}, id ${signedBy})`);
}

const id = extensionId(mainKey);
writeFileSync(join(distDir, 'crx', 'meta.json'), JSON.stringify({ id, updateUrl, versions: built }, null, 2));
console.log(`extension id: ${id}`);
