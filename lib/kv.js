'use strict';
/**
 * Picks the remote store the deployment actually has.
 *
 * Upstash wins when both are configured: it is the store the platform wires up
 * through its own integration, so if someone has gone to the trouble of
 * connecting one, that is the one they mean.
 *
 * Every driver exposes the same three calls, so nothing above this file has to
 * know which one answered.
 */
const upstash = require('./kv-upstash');
const supabase = require('./supabase');

function driver() {
  // Escape hatch for the tests and for demoing the read-only mode on purpose:
  // config/store.json would otherwise always supply a store.
  if (process.env.MM_NO_STORE) return null;
  if (upstash.configured()) return upstash;
  if (supabase.configured()) return supabase;
  return null;
}

/** 'upstash' | 'supabase' | null — for the status readout on the phone. */
function driverName() {
  const d = driver();
  if (!d) return null;
  return d === upstash ? 'upstash' : 'supabase';
}

function configured() {
  return driver() !== null;
}

function getJson(key) {
  const d = driver();
  if (!d) return Promise.resolve(null);
  return d.getJson(key);
}

function setJson(key, value) {
  const d = driver();
  if (!d) return Promise.resolve(value);
  return d.setJson(key, value);
}

module.exports = { configured, driverName, getJson, setJson };
