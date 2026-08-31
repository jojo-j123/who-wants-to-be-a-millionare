'use strict';
/**
 * Minimal Redis client for the Vercel deployment, speaking Upstash's REST API
 * over plain fetch. No SDK, so the project keeps its "no dependencies" promise
 * in both environments.
 *
 * Picks up whichever env var names the integration provides:
 *   KV_REST_API_URL / KV_REST_API_TOKEN              (Vercel KV)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash marketplace)
 */

const URL_VAR = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const BASE = URL_VAR.replace(/\/+$/, '');

function configured() {
  return !!(BASE && TOKEN);
}

async function call(pathSegments, options) {
  const url = BASE + '/' + pathSegments.map(encodeURIComponent).join('/');
  const res = await fetch(url, Object.assign({
    headers: { Authorization: 'Bearer ' + TOKEN }
  }, options || {}));

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('KV request failed (' + res.status + ') ' + detail.slice(0, 200));
  }
  const data = await res.json();
  return data.result;
}

/** @returns {Promise<any|null>} parsed JSON value, or null when unset. */
async function getJson(key) {
  const raw = await call(['get', key]);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function setJson(key, value) {
  await call(['set', key], {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value)
  });
  return value;
}

module.exports = { configured, getJson, setJson };
