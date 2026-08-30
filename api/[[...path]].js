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

const KEY = { state: 'mm:state', settings: 'mm:settings', bank: 'mm:questions' };

// Survives between invocations that reuse the same warm instance, which keeps
// the no-KV demo mode usable for a single player.
let warm = null;

async function load() {
  const usingKv = kv.configured();

  let settings = null, bank = null, state = null;
  if (usingKv) {
    [settings, bank, state] = await Promise.all([
      kv.getJson(KEY.settings),
      kv.getJson(KEY.bank),
      kv.getJson(KEY.state)
    ]);
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

  if (!usingKv) warm = ctx;
  return ctx;
}

async function persist(ctx, what) {
  if (!kv.configured()) {
    warm = ctx; // best effort: only this instance will see it
    return;
  }
  const writes = [];
  if (what.state) writes.push(kv.setJson(KEY.state, ctx.state));
  if (what.settings) writes.push(kv.setJson(KEY.settings, ctx.settings));
  if (what.bank) writes.push(kv.setJson(KEY.bank, ctx.bank));
  await Promise.all(writes);
}

const route = createRouter({
  load,
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
    version: require('../package.json').version
  })
});

module.exports = function handler(req, res) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  let pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/api/')) pathname = '/api' + pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return route(req, res, url, pathname);
};
