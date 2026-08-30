'use strict';
/**
 * Packs public/ into a single compressed, checksummed blob.
 *
 * Only needed when the deployment is uploaded file-by-file through an API that
 * cannot carry the whole tree (the Vercel MCP tool, for one). A normal
 * `npx vercel` or git-connected deploy ships public/ directly and ignores all
 * of this — build.js is a no-op when public/ is already populated.
 *
 *   node scripts/build-vercel-bundle.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vercel-bundle');
const CHUNKS = 6;

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, base, out);
    else out[path.relative(base, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

const map = walk(path.join(ROOT, 'public'), path.join(ROOT, 'public'), {});
const json = Buffer.from(JSON.stringify(map));
const br = zlib.brotliCompressSync(json, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length
  }
});
const b64 = br.toString('base64');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const size = Math.ceil(b64.length / CHUNKS);
const parts = [];
for (let i = 0; i < CHUNKS; i++) {
  const text = b64.slice(i * size, (i + 1) * size);
  const name = 'part' + String(i).padStart(2, '0') + '.b64';
  fs.writeFileSync(path.join(OUT, name), text);
  parts.push({ name, length: text.length, sha256: sha(Buffer.from(text)) });
}

const manifest = {
  files: Object.keys(map).length,
  brotliSha256: sha(br),
  jsonSha256: sha(json),
  parts
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('public/ files :', manifest.files);
console.log('brotli        :', br.length, 'bytes');
console.log('base64        :', b64.length, 'chars in', CHUNKS, 'parts of ~' + size);
console.log('written to    :', path.relative(ROOT, OUT));
