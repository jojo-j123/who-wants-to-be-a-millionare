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
 *
 * The API itself lives in lib/routes.js, shared with the Vercel deployment.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const store = require('./lib/store');
const game = require('./lib/game');
const apiValidate = require('./lib/api');
const { createRouter } = require('./lib/routes');

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

const ctx = {
  settings: apiValidate.sanitizeSettings({}, Object.assign({}, DEFAULT_SETTINGS, store.read('settings', DEFAULT_SETTINGS))),
  bank: apiValidate.sanitizeBank(store.read('questions', { version: 1, questions: [] })),
  state: null
};
ctx.state = game.initialState(ctx.settings);

const clients = new Set(); // open SSE responses

/* ------------------------------------------------------------ router */

const route = createRouter({
  load: () => Promise.resolve(ctx),

  persist: (_ctx, what) => {
    if (what.backup) store.backup(what.backup);
    if (what.settings) store.write('settings', ctx.settings);
    if (what.bank) store.write('questions', ctx.bank);
    // Game state is deliberately not written to disk: a show that crashes
    // should come back on the standby screen, not half way through a question.
    return Promise.resolve();
  },

  broadcast: () => broadcast('state'),
  openStream: openStream,
  clientCount: () => clients.size,
  canWrite: () => true,

  info: () => Promise.resolve({
    port: PORT,
    addresses: lanAddresses(),
    transport: 'sse',
    mode: 'local',
    version: require('./package.json').version
  })
});

function broadcast(event) {
  game.settle(ctx.state);
  const payload = JSON.stringify({
    state: ctx.state,
    settings: require('./lib/routes').publicSettings(ctx.settings),
    stats: { questions: ctx.bank.questions.length, clients: clients.size },
    serverTime: Date.now()
  });
  const frame = 'event: ' + (event || 'state') + '\ndata: ' + payload + '\n\n';
  for (const res of clients) {
    try { res.write(frame); } catch (_) { clients.delete(res); }
  }
}

/* ------------------------------------------------------------ timer loop */

// The clock itself is timestamp-derived, so this loop only exists to push a
// fresh snapshot once a second while a countdown is on screen.
setInterval(() => {
  if (ctx.state.timer.running && ctx.state.timer.enabled) broadcast('state');
}, 1000);

/* ------------------------------------------------------------ routing */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (pathname.startsWith('/api/')) return route(req, res, url, pathname);

  if (pathname === '/' || pathname === '/index.html') return sendFile(res, 'index.html');
  if (pathname === '/display') return sendFile(res, 'display.html');
  if (pathname === '/admin' || pathname === '/remote') return sendFile(res, 'admin.html');

  return sendStatic(res, pathname);
});

/* ------------------------------------------------------------ SSE */

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  res.write('retry: 1500\n\n');
  clients.add(res);
  broadcast('state');

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

/* ------------------------------------------------------------ static files */

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
  if (ctx.settings.security && ctx.settings.security.adminPin) {
    console.log('\n  Remote PIN    :  ' + ctx.settings.security.adminPin);
  }
  console.log('\n  Questions loaded: ' + ctx.bank.questions.length);
  console.log(line + '\n');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const res of clients) { try { res.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
