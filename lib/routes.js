'use strict';
/**
 * The HTTP API, written once and driven by two very different runtimes:
 *
 *   · server.js      long-lived local process, state in memory, JSON files on
 *                    disk, live updates pushed over SSE
 *   · api/index.js   Vercel serverless, state in a KV store, read-only disk,
 *                    clients poll for updates
 *
 * Everything environment-specific arrives through the `host` object, so the
 * rules of the show cannot drift apart between the two.
 */

const game = require('./game');
const api = require('./api');

/**
 * @param {object} host
 *   load()            -> Promise<{state, settings, bank}>
 *   persist(ctx, what)-> Promise    what = {state, settings, bank} booleans
 *   broadcast(ctx)    -> void       push to connected screens (no-op if polling)
 *   openStream(req,res)-> void|null null when the runtime cannot hold a stream
 *   info()            -> Promise<object>  extra fields for /api/info
 *   canWrite()        -> boolean    false on a read-only deployment
 */
function createRouter(host) {

  async function handle(req, res, url, pathname) {
    // ---- open endpoints: the stage display needs these without a PIN ----
    if (pathname === '/api/state' && req.method === 'GET') {
      const ctx = await host.load();
      const changed = game.settle(ctx.state);
      if (changed && host.canWrite()) await host.persist(ctx, { state: true });
      return json(res, 200, snapshot(ctx, host));
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      if (!host.openStream) return json(res, 501, { error: 'This deployment uses polling instead of a live stream.' });
      return host.openStream(req, res);
    }

    if (pathname === '/api/info' && req.method === 'GET') {
      const ctx = await host.load();
      const extra = await host.info();
      return json(res, 200, Object.assign({
        pinRequired: !!(ctx.settings.security && ctx.settings.security.adminPin),
        readOnly: !host.canWrite(),
        questions: ctx.bank.questions.length
      }, extra));
    }

    // ---- everything below drives or edits the show ----
    const ctx = await host.load();
    if (!pinOk(req, url, ctx.settings)) return json(res, 401, { error: 'Wrong or missing PIN.' });

    if (pathname === '/api/auth' && req.method === 'POST') return json(res, 200, { ok: true });

    if (pathname === '/api/action' && req.method === 'POST') {
      const body = await readJson(req);
      const actions = Array.isArray(body) ? body : [body];
      let applied = 0;
      let touchedSettings = false;
      for (const action of actions) {
        if (!action || typeof action.type !== 'string') continue;
        if (game.reduce(ctx, action) !== null) {
          applied++;
          // A few live controls double as saved settings.
          if (action.type === 'timer/set' || action.type === 'timer/toggle' ||
              action.type === 'prize/set') touchedSettings = true;
        }
      }
      if (!applied) return json(res, 400, { error: 'No known action in request.' });
      game.settle(ctx.state);
      await host.persist(ctx, { state: true, settings: touchedSettings && host.canWrite() });
      host.broadcast(ctx);
      return json(res, 200, snapshot(ctx, host));
    }

    if (pathname === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, ctx.settings);
      if (req.method === 'PUT' || req.method === 'PATCH') {
        requireWritable(host);
        const body = await readJson(req);
        ctx.settings = api.sanitizeSettings(body, ctx.settings);
        game.reduce(ctx, { type: 'lifeline/sync' });
        await host.persist(ctx, { settings: true, state: true });
        host.broadcast(ctx);
        return json(res, 200, { ok: true, settings: ctx.settings });
      }
    }

    if (pathname === '/api/questions') {
      if (req.method === 'GET') return json(res, 200, ctx.bank);
      if (req.method === 'POST') {
        requireWritable(host);
        const q = api.sanitizeQuestion(await readJson(req));
        ctx.bank.questions.push(q);
        await host.persist(ctx, { bank: true });
        host.broadcast(ctx);
        return json(res, 200, { ok: true, question: q });
      }
      if (req.method === 'PUT') {
        requireWritable(host);
        ctx.bank = api.sanitizeBank(await readJson(req));
        await host.persist(ctx, { bank: true, backup: 'questions' });
        host.broadcast(ctx);
        return json(res, 200, { ok: true, count: ctx.bank.questions.length });
      }
    }

    const qMatch = pathname.match(/^\/api\/questions\/([^/]+)$/);
    if (qMatch) {
      const id = qMatch[1];
      const idx = ctx.bank.questions.findIndex(q => q.id === id);
      if (idx < 0) return json(res, 404, { error: 'No question with id ' + id });

      if (req.method === 'DELETE') {
        requireWritable(host);
        const [removed] = ctx.bank.questions.splice(idx, 1);
        await host.persist(ctx, { bank: true });
        host.broadcast(ctx);
        return json(res, 200, { ok: true, removed });
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        requireWritable(host);
        const body = await readJson(req);
        ctx.bank.questions[idx] = api.sanitizeQuestion(Object.assign({}, body, { id }), ctx.bank.questions[idx]);
        await host.persist(ctx, { bank: true });
        host.broadcast(ctx);
        return json(res, 200, { ok: true, question: ctx.bank.questions[idx] });
      }
    }

    if (pathname === '/api/export' && req.method === 'GET') {
      return json(res, 200, {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: ctx.settings,
        questions: ctx.bank.questions
      });
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      requireWritable(host);
      const body = await readJson(req);
      const report = { questions: 0, settings: false };
      const what = {};

      if (body && (Array.isArray(body.questions) || Array.isArray(body))) {
        const incoming = api.sanitizeBank(body.questions || body);
        ctx.bank = body.mode === 'append'
          ? api.sanitizeBank(ctx.bank.questions.concat(incoming.questions))
          : incoming;
        report.questions = ctx.bank.questions.length;
        what.bank = true;
        what.backup = 'questions';
      }
      if (body && body.settings) {
        ctx.settings = api.sanitizeSettings(body.settings, ctx.settings);
        game.reduce(ctx, { type: 'lifeline/sync' });
        report.settings = true;
        what.settings = true;
        what.state = true;
      }
      await host.persist(ctx, what);
      host.broadcast(ctx);
      return json(res, 200, Object.assign({ ok: true }, report));
    }

    return json(res, 404, { error: 'Unknown endpoint ' + pathname });
  }

  /** Wraps handle() so any thrown error becomes a clean JSON response. */
  return async function route(req, res, url, pathname) {
    try {
      await handle(req, res, url, pathname);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return;
      json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  };
}

/* ------------------------------------------------------------ helpers */

function snapshot(ctx, host) {
  return {
    state: ctx.state,
    settings: publicSettings(ctx.settings),
    stats: { questions: ctx.bank.questions.length, clients: host.clientCount ? host.clientCount() : 0 },
    serverTime: Date.now()
  };
}

/** The stage display must never receive the admin PIN. */
function publicSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  copy.security = { pinRequired: !!(settings.security && settings.security.adminPin) };
  return copy;
}

function pinOk(req, url, settings) {
  const required = settings.security && settings.security.adminPin;
  if (!required) return true;
  const supplied = req.headers['x-admin-pin'] || url.searchParams.get('pin') || '';
  return String(supplied) === String(required);
}

function requireWritable(host) {
  if (!host.canWrite()) {
    throw api.httpError(503, 'This deployment is read-only. Questions and settings can only be ' +
      'edited when a KV store is connected, or when running the local server.');
  }
}

function readJson(req) {
  // Vercel hands the parsed body over; the bare Node server does not.
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = typeof req.body === 'string' ? req.body : '';
    if (raw) return finish();

    let tooBig = false;
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return reject(api.httpError(413, 'Payload too large (4 MB limit).'));
      finish();
    });
    req.on('error', () => reject(api.httpError(400, 'Request failed.')));

    function finish() {
      if (!raw.trim()) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(api.httpError(400, 'Body is not valid JSON.')); }
    }
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

module.exports = { createRouter, publicSettings, json };
