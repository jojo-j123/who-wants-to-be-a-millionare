'use strict';
/**
 * Who Wants to Be a Millionaire — offline show server.
 *
 * Zero dependencies: everything runs on the Node standard library so the whole
 * thing works on a laptop with no internet connection and nothing installed.
 *
 *   node server.js [--port 8080] [--host 0.0.0.0]
 *
 * Screens:
 *   /          launcher — links + LAN address for the phone remote
 *   /display   the big screen for the audience / projector
 *   /admin     the phone remote (host control + question editor)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const store = require('./lib/store');
const game = require('./lib/game');
const api = require('./lib/api');

const PUBLIC_DIR = path.join(__dirname, 'public');
const argv = process.argv.slice(2);
const PORT = Number(argFlag('--port') || process.env.PORT || 8080);
const HOST = argFlag('--host') || process.env.HOST || '0.0.0.0';

function argFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

/* ------------------------------------------------------------ app state */

const DEFAULT_SETTINGS = require('./lib/defaults');

let settings = api.sanitizeSettings({}, Object.assign({}, DEFAULT_SETTINGS, store.read('settings', DEFAULT_SETTINGS)));
let bank = api.sanitizeBank(store.read('questions', { version: 1, questions: [] }));
let state = game.initialState(settings);

const clients = new Set(); // open SSE responses

function ctx() {
  return { state, settings, bank };
}

function broadcast(event) {
  const payload = JSON.stringify(snapshot());
  const frame = 'event: ' + (event || 'state') + '\ndata: ' + payload + '\n\n';
  for (const res of clients) {
    try { res.write(frame); } catch (_) { clients.delete(res); }
  }
}

function snapshot() {
  return {
    state,
    settings: publicSettings(),
    stats: { questions: bank.questions.length, clients: clients.size },
    serverTime: Date.now()
  };
}

/** The stage display must never receive the admin PIN. */
function publicSettings() {
  const copy = JSON.parse(JSON.stringify(settings));
  copy.security = { pinRequired: !!(settings.security && settings.security.adminPin) };
  return copy;
}

/* ------------------------------------------------------------ timer loop */

setInterval(() => {
  if (state.timer.running && state.timer.enabled) {
    game.reduce(ctx(), { type: 'timer/tick' });
    broadcast('state');
  }
}, 1000);

/* ------------------------------------------------------------ auth */

function pinOk(req, url) {
  const required = settings.security && settings.security.adminPin;
  if (!required) return true;
  const supplied = req.headers['x-admin-pin'] || url.searchParams.get('pin') || '';
  return String(supplied) === String(required);
}

/* ------------------------------------------------------------ routing */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (pathname.startsWith('/api/')) return handleApi(req, res, url, pathname);

  // Page routes
  if (pathname === '/' || pathname === '/index.html') return sendFile(res, 'index.html');
  if (pathname === '/display') return sendFile(res, 'display.html');
  if (pathname === '/admin' || pathname === '/remote') return sendFile(res, 'admin.html');

  return sendStatic(res, pathname);
});

function handleApi(req, res, url, pathname) {
  // Read-only endpoints the stage display needs, no PIN.
  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());
  if (pathname === '/api/stream' && req.method === 'GET') return openStream(req, res);
  if (pathname === '/api/info' && req.method === 'GET') {
    return json(res, 200, {
      port: PORT,
      addresses: lanAddresses(),
      pinRequired: !!(settings.security && settings.security.adminPin),
      version: require('./package.json').version
    });
  }

  // Everything below drives or edits the show — PIN protected.
  if (!pinOk(req, url)) return json(res, 401, { error: 'Wrong or missing PIN.' });

  if (pathname === '/api/auth' && req.method === 'POST') return json(res, 200, { ok: true });

  if (pathname === '/api/action' && req.method === 'POST') {
    return readBody(req, res, body => {
      const actions = Array.isArray(body) ? body : [body];
      let applied = 0;
      let touchedSettings = false;
      for (const action of actions) {
        if (!action || typeof action.type !== 'string') continue;
        if (game.reduce(ctx(), action) !== null) {
          applied++;
          // A couple of live controls double as saved settings.
          if (action.type === 'timer/set' || action.type === 'timer/toggle') touchedSettings = true;
        }
      }
      if (!applied) return json(res, 400, { error: 'No known action in request.' });
      if (touchedSettings) store.write('settings', settings);
      broadcast('state');
      return json(res, 200, snapshot());
    });
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET') return json(res, 200, settings);
    if (req.method === 'PUT' || req.method === 'PATCH') {
      return readBody(req, res, body => {
        settings = api.sanitizeSettings(body, settings);
        store.write('settings', settings);
        game.reduce(ctx(), { type: 'lifeline/sync' });
        broadcast('state');
        return json(res, 200, { ok: true, settings });
      });
    }
  }

  if (pathname === '/api/questions') {
    if (req.method === 'GET') return json(res, 200, bank);
    if (req.method === 'POST') {
      return readBody(req, res, body => {
        const q = api.sanitizeQuestion(body);
        bank.questions.push(q);
        store.write('questions', bank);
        broadcast('state');
        return json(res, 200, { ok: true, question: q });
      });
    }
    if (req.method === 'PUT') {
      return readBody(req, res, body => {
        store.backup('questions');
        bank = api.sanitizeBank(body);
        store.write('questions', bank);
        broadcast('state');
        return json(res, 200, { ok: true, count: bank.questions.length });
      });
    }
  }

  const qMatch = pathname.match(/^\/api\/questions\/([^/]+)$/);
  if (qMatch) {
    const id = qMatch[1];
    const idx = bank.questions.findIndex(q => q.id === id);
    if (idx < 0) return json(res, 404, { error: 'No question with id ' + id });
    if (req.method === 'DELETE') {
      const [removed] = bank.questions.splice(idx, 1);
      store.write('questions', bank);
      broadcast('state');
      return json(res, 200, { ok: true, removed });
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      return readBody(req, res, body => {
        const merged = api.sanitizeQuestion(Object.assign({}, body, { id }), bank.questions[idx]);
        bank.questions[idx] = merged;
        store.write('questions', bank);
        broadcast('state');
        return json(res, 200, { ok: true, question: merged });
      });
    }
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    return json(res, 200, { version: 1, exportedAt: new Date().toISOString(), settings, questions: bank.questions });
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    return readBody(req, res, body => {
      const report = { questions: 0, settings: false };
      if (body && (Array.isArray(body.questions) || Array.isArray(body))) {
        store.backup('questions');
        const incoming = api.sanitizeBank(body.questions || body);
        if (body.mode === 'append') {
          bank.questions = bank.questions.concat(incoming.questions);
          bank = api.sanitizeBank(bank.questions);
        } else {
          bank = incoming;
        }
        store.write('questions', bank);
        report.questions = bank.questions.length;
      }
      if (body && body.settings) {
        store.backup('settings');
        settings = api.sanitizeSettings(body.settings, settings);
        store.write('settings', settings);
        game.reduce(ctx(), { type: 'lifeline/sync' });
        report.settings = true;
      }
      broadcast('state');
      return json(res, 200, Object.assign({ ok: true }, report));
    });
  }

  return json(res, 404, { error: 'Unknown endpoint ' + pathname });
}

/* ------------------------------------------------------------ SSE */

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  res.write('retry: 1500\n\n');
  res.write('event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
  clients.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { cleanup(); }
  }, 20000);

  function cleanup() {
    clearInterval(ping);
    clients.delete(res);
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/* ------------------------------------------------------------ plumbing */

function readBody(req, res, handler) {
  let raw = '';
  let tooBig = false;
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return json(res, 413, { error: 'Payload too large (4 MB limit).' });
    let body = null;
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch (_) { return json(res, 400, { error: 'Body is not valid JSON.' }); }
    }
    try {
      handler(body);
    } catch (err) {
      json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  });
  req.on('error', () => json(res, 400, { error: 'Request failed.' }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json'
};

function sendStatic(res, pathname) {
  const rel = pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, 'Not found: ' + pathname);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60'
    });
    res.end(data);
  });
}

function sendFile(res, name) {
  return sendStatic(res, '/' + name);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ iface: name, address: net.address });
    }
  }
  return out;
}

/* ------------------------------------------------------------ boot */

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses();
  const line = '='.repeat(58);
  console.log('\n' + line);
  console.log('  WHO WANTS TO BE A MILLIONAIRE  ·  offline show server');
  console.log(line);
  console.log('  Stage display :  http://localhost:' + PORT + '/display');
  console.log('  Phone remote  :  http://localhost:' + PORT + '/admin');
  if (addrs.length) {
    console.log('\n  On the same Wi-Fi / hotspot (no internet needed):');
    for (const a of addrs) console.log('    http://' + a.address + ':' + PORT + '/admin   (' + a.iface + ')');
  } else {
    console.log('\n  No LAN interface found — connect this machine to a router or');
    console.log('  start a phone hotspot, then re-run to get a phone address.');
  }
  if (settings.security && settings.security.adminPin) {
    console.log('\n  Remote PIN    :  ' + settings.security.adminPin);
  }
  console.log('\n  Questions loaded: ' + bank.questions.length);
  console.log(line + '\n');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const res of clients) { try { res.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
