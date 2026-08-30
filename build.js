'use strict';
/**
 * Vercel build step.
 *
 * A normal deploy (git-connected, or `npx vercel`) ships public/ as-is and this
 * does nothing. When the deployment was uploaded through an API that could not
 * carry the whole tree, public/ arrives as a compressed, checksummed bundle
 * instead — this expands it, verifying every part on the way so a truncated or
 * corrupted upload fails the build loudly rather than serving a broken site.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const BUNDLE = path.join(ROOT, 'vercel-bundle');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function main() {
  if (fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    console.log('public/ is already present — nothing to expand.');
    return;
  }
  if (!fs.existsSync(path.join(BUNDLE, 'manifest.json'))) {
    fail('No public/index.html and no vercel-bundle/manifest.json — nothing to serve.');
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'manifest.json'), 'utf8'));
  console.log('Expanding ' + manifest.parts.length + ' bundle parts...');

  let b64 = '';
  for (const part of manifest.parts) {
    const p = path.join(BUNDLE, part.name);
    if (!fs.existsSync(p)) fail('Missing bundle part: ' + part.name);
    const text = fs.readFileSync(p, 'utf8');

    if (text.length !== part.length) {
      fail(part.name + ' is ' + text.length + ' chars, expected ' + part.length +
           ' — the upload of this part was truncated.');
    }
    const got = sha(Buffer.from(text));
    if (got !== part.sha256) {
      fail(part.name + ' checksum mismatch\n  expected ' + part.sha256 + '\n  got      ' + got +
           '\n  This part was corrupted in transit; re-upload just this part.');
    }
    b64 += text;
  }

  const br = Buffer.from(b64, 'base64');
  if (sha(br) !== manifest.brotliSha256) fail('Reassembled archive checksum mismatch.');

  const json = zlib.brotliDecompressSync(br);
  if (sha(json) !== manifest.jsonSha256) fail('Decompressed payload checksum mismatch.');

  const map = JSON.parse(json.toString('utf8'));
  const names = Object.keys(map);
  if (names.length !== manifest.files) {
    fail('Expected ' + manifest.files + ' files, got ' + names.length + '.');
  }

  for (const rel of names) {
    // Refuse anything that would escape public/.
    const dest = path.join(PUBLIC, rel);
    if (!dest.startsWith(PUBLIC + path.sep)) fail('Refusing to write outside public/: ' + rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, map[rel]);
  }

  console.log('Wrote ' + names.length + ' files into public/:');
  names.sort().forEach(n => console.log('  ' + n));
}

function fail(message) {
  console.error('\nBUILD FAILED: ' + message + '\n');
  process.exit(1);
}

main();
