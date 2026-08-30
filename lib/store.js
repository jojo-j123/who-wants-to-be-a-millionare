'use strict';
/**
 * Tiny JSON file store. Atomic writes (write temp + rename) so a crash mid-save
 * can never leave a half-written question bank behind.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function read(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] could not read ' + name + '.json:', err.message);
      const broken = filePath(name) + '.broken-' + Date.now();
      try { fs.renameSync(filePath(name), broken); console.error('[store] moved damaged file to ' + broken); } catch (_) {}
    }
    if (fallback !== undefined) write(name, fallback);
    return fallback;
  }
}

function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath(name);
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return value;
}

/** Keeps a timestamped copy under data/backups/ before a destructive replace. */
function backup(name) {
  const src = filePath(name);
  if (!fs.existsSync(src)) return null;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, name + '-' + stamp + '.json');
  fs.copyFileSync(src, dest);
  prune(dir, name, 20);
  return dest;
}

function prune(dir, name, keep) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith(name + '-')).sort();
  while (files.length > keep) {
    try { fs.unlinkSync(path.join(dir, files.shift())); } catch (_) {}
  }
}

module.exports = { read, write, backup, DATA_DIR };
