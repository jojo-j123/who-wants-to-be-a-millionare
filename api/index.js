'use strict';
/**
 * Vercel serverless entry point — the same show, hosted.
 *
 * Differences from the local server, all of them forced by the platform:
 *   · state lives in a KV store, because functions are ephemeral and a phone
 *     and a TV will not land on the same instance
 *   · clients poll instead of holding an SSE stream, for the same reason
 *   · with no KV connected the deployment still runs, but read-only: perfect
 *     for showing the game off, not for driving a real show
 *
 * The routing and the game rules are shared with server.js via lib/routes.js.
 *
 * This is an optional catch-all route, so every /api/* request lands here with
 * its original path intact — a rewrite would have replaced the path this
 * router needs to dispatch on.
 */

const { URL } = require('url');
const game = require('../lib/game');
const apiValidate = require('../lib/api');
const kv = require('../lib/kv');
const defaults = require('../lib/defaults');
const { createRouter } = require('../lib/routes');

// Bundled at build time and read-only at runtime — the starting point for a
// deployment whose KV store is still empty.
const seedQuestions = require('../data/questions.json');
const seedSettings = require('../data/settings.json');

const KEY = { state: 'mm:state', settings: 'mm:settings', bank: 'mm:questions', logo: 'mm:logo' };

// Survives between invocations that reuse the same warm instance, which keeps
// the no-KV demo mode usable for a single player.
let warm = null;

// Set when the store last refused to answer. A show that is mid-episode when
// the database goes down should keep playing on whatever this instance already
// has, rather than putting a 500 on the television.
let storeDown = null;

async function load() {
  const usingKv = kv.configured();

  let settings = null, bank = null, state = null;
  if (usingKv) {
    try {
      [settings, bank, state] = await Promise.all([
        kv.getJson(KEY.settings),
        kv.getJson(KEY.bank),
        kv.getJson(KEY.state)
      ]);
      storeDown = null;
    } catch (err) {
      storeDown = err.message;
      console.error('[store] read failed, serving from memory:', err.message);
      if (warm) return warm;
      settings = bank = state = null;
    }
  } else if (warm) {
    return warm;
  }

  const ctx = {
    settings: apiValidate.sanitizeSettings({}, Object.assign({}, defaults, settings || seedSettings)),
    bank: apiValidate.sanitizeBank(bank || seedQuestions)
  };
  ctx.state = state || game.initialState(ctx.settings);

  // A state saved before the lifelines were edited would be missing them.
  game.reduce(ctx, { type: 'lifeline/sync' });

  // Always keep a copy: it is the fallback if the store stops answering.
  warm = ctx;
  return ctx;
}

async function persist(ctx, what) {
  if (!kv.configured()) {
    warm = ctx; // best effort: only this instance will see it
    return;
  }
  warm = ctx;
  const writes = [];
  if (what.state) writes.push(kv.setJson(KEY.state, ctx.state));
  if (what.settings) writes.push(kv.setJson(KEY.settings, ctx.settings));
  if (what.bank) writes.push(kv.setJson(KEY.bank, ctx.bank));
  try {
    await Promise.all(writes);
    storeDown = null;
  } catch (err) {
    // The caller gets a 503 with this text; the show itself carries on.
    storeDown = err.message;
    throw apiValidate.httpError(503, 'The show database is not answering, so that change was not saved. ' +
      'The show keeps running on this screen. (' + err.message + ')');
  }
}

// The logo is deliberately absent from load(): it is the one big value in the
// store, and load() runs on every request. This reads it only when /api/logo is
// actually asked for, which each screen does once per logo thanks to the ETag.
let warmLogo;

async function readLogo() {
  if (!kv.configured()) return warmLogo || null;
  try {
    const logo = await kv.getJson(KEY.logo);
    warmLogo = logo || null;
    return warmLogo;
  } catch (err) {
    console.error('[store] logo read failed:', err.message);
    return warmLogo || null;
  }
}

async function writeLogo(logo) {
  warmLogo = logo;
  if (!kv.configured()) return;
  try {
    await kv.setJson(KEY.logo, logo);
    storeDown = null;
  } catch (err) {
    // Same contract as persist(): a store that is not answering is a 503 the
    // host can read, not a 500 that looks like the app fell over.
    storeDown = err.message;
    throw apiValidate.httpError(503, 'The show database is not answering, so the logo was not saved. ' +
      'The show keeps running on this screen. (' + err.message + ')');
  }
}

const route = createRouter({
  load,
  readLogo,
  writeLogo,
  persist,
  broadcast: () => {},          // nothing to push to: clients poll
  openStream: null,             // a function cannot hold a stream open per-client
  clientCount: () => 0,
  canWrite: () => kv.configured(),

  info: async () => ({
    transport: 'poll',
    pollMs: 1000,
    mode: 'vercel',
    storage: kv.configured() ? 'kv' : 'ephemeral',
    driver: kv.driverName(),
    storeError: storeDown,
    version: require('../package.json').version
  })
});

module.exports = function handler(req, res) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));

  // vercel.json rewrites every /api/* request here and passes the original path
  // in __path. Vercel's own filesystem routing would only ever hand this
  // function a single segment, which silently killed /api/questions/<id>:
  // the router answered with its own 404 before the show saw the request, so
  // editing and deleting a question were dead while everything else looked
  // fine. Routing it ourselves means the path cannot be lost again.
  // Falls back to the real URL, which is what the local server and the tests use.
  const routed = url.searchParams.get('__path');
  let pathname;
  if (routed !== null) {
    url.searchParams.delete('__path');
    pathname = '/api/' + safeDecode(routed);
  } else {
    pathname = safeDecode(url.pathname);
  }
  if (!pathname.startsWith('/api/')) pathname = '/api' + pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  return route(req, res, url, pathname);
};

/** A stray % in a question id must not take the whole request down. */
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}
