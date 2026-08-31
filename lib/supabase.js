'use strict';
/**
 * Key/value store backed by a Supabase table, spoken to over PostgREST with
 * plain fetch. Same three-function shape as lib/kv.js, so the deployment can
 * use whichever store it happens to have.
 *
 * The table is a plain kv pair:
 *   millionaire_kv (key text primary key, value jsonb, updated_at timestamptz)
 *
 * `value` is jsonb rather than text, so objects round-trip without a second
 * layer of JSON escaping.
 *
 * Credentials come from the environment first — that is how a proper
 * deployment should supply them — and fall back to config/store.json for the
 * hosted copy, which has no way to set env vars.
 */

const TABLE = 'millionaire_kv';

function fileConfig() {
  // The repo layout during local runs and tests.
  try { return require('../config/store.json'); } catch (_) {}
  // The flattened name used inside the generated single-file function.
  try { return require('./store-config'); } catch (_) {}
  return {};
}

const file = fileConfig().supabase || {};

const BASE = String(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || file.url || ''
).replace(/\/+$/, '');

const KEY = String(
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  file.key || ''
);

function configured() {
  return !!(BASE && KEY);
}

function headers(extra) {
  return Object.assign({
    apikey: KEY,
    Authorization: 'Bearer ' + KEY
  }, extra || {});
}

async function request(path, options) {
  const res = await fetch(BASE + '/rest/v1/' + path, options);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Supabase request failed (' + res.status + ') ' + detail.slice(0, 200));
  }
  return res;
}

/** @returns {Promise<any|null>} the stored value, or null when unset. */
async function getJson(key) {
  const path = TABLE + '?select=value&key=eq.' + encodeURIComponent(key);
  const res = await request(path, { headers: headers() });
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0].value === undefined ? null : rows[0].value;
}

async function setJson(key, value) {
  // merge-duplicates makes this an upsert on the primary key.
  await request(TABLE + '?on_conflict=key', {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify([{ key: key, value: value, updated_at: new Date().toISOString() }])
  });
  return value;
}

module.exports = { configured, getJson, setJson, TABLE };
