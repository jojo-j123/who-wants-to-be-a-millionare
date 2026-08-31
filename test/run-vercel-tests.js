'use strict';
/**
 * Exercises the Vercel serverless entry point without deploying.
 *
 * Mounts api/[[...path]].js behind a plain Node server (the same contract
 * Vercel gives a Node function) and checks both deployment modes:
 *
 *   · no KV connected  -> the show is readable but read-only
 *   · KV connected     -> full control, and two *separate* function instances
 *                         see each other's state, which is what makes the
 *                         phone-drives-the-TV feature work when serverless
 *                         has no shared memory
 *
 *   node test/run-vercel-tests.js
 */

const http = require('http');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

/* ---------------- a stand-in for Upstash's REST API ---------------- */

function startFakeKv() {
  const data = new Map();
  const server = http.createServer((req, res) => {
    if (!/^Bearer /.test(req.headers.authorization || '')) {
      res.writeHead(401); return res.end('no token');
    }
    const parts = req.url.split('/').filter(Boolean).map(decodeURIComponent);
    const [op, key] = parts;
    if (op === 'get') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: data.has(key) ? data.get(key) : null }));
    }
    if (op === 'set') {
      let raw = '';
      req.on('data', c => { raw += c; });
      return req.on('end', () => {
        data.set(key, raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      });
    }
    res.writeHead(400); res.end('bad op');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, data }));
  });
}

/* ---------------- a stand-in for Supabase's PostgREST API ---------------- */

function startFakeSupabase() {
  const data = new Map();          // key -> value, as the jsonb column would hold it
  const state = { down: false };   // flip to simulate a paused/unreachable project
  const server = http.createServer((req, res) => {
    if (state.down) {
      res.writeHead(503); return res.end('{"message":"database is paused"}');
    }
    // PostgREST wants the key in both places; the driver must send both.
    if (!req.headers.apikey || !/^Bearer /.test(req.headers.authorization || '')) {
      res.writeHead(401); return res.end('{"message":"no key"}');
    }
    const [pathname, query] = req.url.split('?');
    if (pathname !== '/rest/v1/millionaire_kv') {
      res.writeHead(404); return res.end('{"message":"no such table"}');
    }
    const params = new URLSearchParams(query || '');

    if (req.method === 'GET') {
      const filter = params.get('key') || '';             // "eq.mm:state"
      const key = filter.replace(/^eq\./, '');
      const rows = data.has(key) ? [{ value: data.get(key) }] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rows));
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      return req.on('end', () => {
        if (!/merge-duplicates/.test(req.headers.prefer || '')) {
          res.writeHead(409); return res.end('{"message":"duplicate key"}');
        }
        let rows;
        try { rows = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end('{}'); }
        (Array.isArray(rows) ? rows : [rows]).forEach(r => { data.set(r.key, r.value); });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('');
      });
    }
    res.writeHead(405); res.end('{}');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, data, state }));
  });
}

/* ---------------- mount the function like Vercel does ---------------- */

function mountFunction() {
  // Fresh module graph so env vars are read as a cold start would read them.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('who-wants-to-be-a-millionare')) &&
        !key.includes('node_modules') && !key.includes('run-vercel-tests')) {
      delete require.cache[key];
    }
  }
  const handler = require('../api/[[...path]].js');

  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/')) { res.writeHead(404); return res.end('static'); }
    handler(req, res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function call(port, method, urlPath, body, pin) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (pin) headers['X-Admin-Pin'] = pin;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ---------------- the suite ---------------- */

async function main() {
  const openHandles = [];
  try {
    console.log('\nDEPLOYED WITHOUT A KV STORE (read-only demo)');
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    // config/store.json ships credentials, so ask for the storeless mode.
    process.env.MM_NO_STORE = '1';

    let fn = await mountFunction();
    openHandles.push(fn.server);

    let info = await call(fn.port, 'GET', '/api/info');
    check('info responds', info.status === 200, 'status ' + info.status);
    check('tells clients to poll', info.body.transport === 'poll', String(info.body.transport));
    check('reports itself read-only', info.body.readOnly === true);
    check('reports ephemeral storage', info.body.storage === 'ephemeral');

    let st = await call(fn.port, 'GET', '/api/state');
    check('state readable', st.status === 200 && st.body.state.phase === 'idle');
    check('seed questions bundled with the function', st.body.stats.questions > 0, 'count ' + st.body.stats.questions);

    const stream = await call(fn.port, 'GET', '/api/stream');
    check('SSE endpoint refuses cleanly instead of hanging', stream.status === 501, 'status ' + stream.status);

    const write = await call(fn.port, 'POST', '/api/questions', {
      text: 'Should not save?', answers: ['a', 'b', 'c', 'd'], correct: 0, difficulty: 1
    });
    check('editing blocked with a clear message', write.status === 503 && /read-only/i.test(write.body.error), 'status ' + write.status);

    const play = await call(fn.port, 'POST', '/api/action', { type: 'game/start', playerName: 'Demo' });
    check('the show can still be played on one instance', play.status === 200 && play.body.state.phase === 'intro');

    fn.server.close();

    console.log('\nDEPLOYED WITH A KV STORE (full control)');
    const kvStub = await startFakeKv();
    openHandles.push(kvStub.server);
    delete process.env.MM_NO_STORE;
    process.env.KV_REST_API_URL = 'http://127.0.0.1:' + kvStub.port;
    process.env.KV_REST_API_TOKEN = 'test-token';

    const phone = await mountFunction();      // instance A — the host's phone
    openHandles.push(phone.server);

    info = await call(phone.port, 'GET', '/api/info');
    check('reports kv storage', info.body.storage === 'kv', String(info.body.storage));
    check('no longer read-only', info.body.readOnly === false);

    const started = await call(phone.port, 'POST', '/api/action', { type: 'game/start', playerName: 'Priya' });
    check('show starts', started.status === 200 && started.body.state.player.name === 'Priya');
    await call(phone.port, 'POST', '/api/action', { type: 'question/load', level: 4 });

    // A genuinely separate instance: fresh module graph, no shared memory.
    const tv = await mountFunction();         // instance B — the stage display
    openHandles.push(tv.server);

    const seen = await call(tv.port, 'GET', '/api/state');
    check('a second instance sees the running show',
      seen.body.state.player.name === 'Priya' && seen.body.state.level === 4,
      'saw ' + seen.body.state.player.name + ' at level ' + seen.body.state.level);
    check('the second instance sees the same question',
      seen.body.state.question && seen.body.state.question.id === started.body.state.question ?
        true : !!seen.body.state.question);

    const q = seen.body.state.question;
    await call(phone.port, 'POST', '/api/action', { type: 'answer/select', index: q.correct });
    await call(phone.port, 'POST', '/api/action', { type: 'answer/lock' });
    let tvView = await call(tv.port, 'GET', '/api/state');
    check('locking on the phone shows on the display instance',
      tvView.body.state.locked === true && tvView.body.state.selected === q.correct);

    await call(phone.port, 'POST', '/api/action', { type: 'answer/reveal' });
    tvView = await call(tv.port, 'GET', '/api/state');
    check('reveal crosses instances', tvView.body.state.outcome === 'correct');

    await call(phone.port, 'POST', '/api/action', { type: 'lifeline/use', id: 'fifty' });
    tvView = await call(tv.port, 'GET', '/api/state');
    check('lifeline use crosses instances', tvView.body.state.lifelines.fifty.used === true);

    console.log('\nTIMER WITHOUT A TICKING PROCESS');
    await call(phone.port, 'POST', '/api/action', { type: 'timer/set', duration: 10 });
    await call(phone.port, 'POST', '/api/action', { type: 'timer/start' });
    const t0 = (await call(tv.port, 'GET', '/api/state')).body.state.timer.remaining;
    await new Promise(r => setTimeout(r, 2100));
    const t1 = (await call(tv.port, 'GET', '/api/state')).body.state.timer.remaining;
    check('clock counts down with no server tick', t1 < t0, t0 + ' -> ' + t1);
    check('countdown is read consistently by another instance', t1 <= 8 && t1 >= 7, 'remaining ' + t1);

    await call(phone.port, 'POST', '/api/action', { type: 'timer/pause' });
    const p0 = (await call(tv.port, 'GET', '/api/state')).body.state.timer.remaining;
    await new Promise(r => setTimeout(r, 1200));
    const p1 = (await call(tv.port, 'GET', '/api/state')).body.state.timer.remaining;
    check('pausing freezes the clock across instances', p0 === p1, p0 + ' -> ' + p1);

    await call(phone.port, 'POST', '/api/action', { type: 'timer/set', duration: 5 });
    await call(phone.port, 'POST', '/api/action', { type: 'timer/start' });
    await new Promise(r => setTimeout(r, 5400));
    const expired = (await call(tv.port, 'GET', '/api/state')).body.state;
    check('the clock expires on read, with no tick loop',
      expired.timer.remaining === 0 && expired.timer.expired === true && expired.timer.running === false,
      JSON.stringify(expired.timer));

    console.log('\nEDITING A HOSTED SHOW');
    const added = await call(phone.port, 'POST', '/api/questions', {
      text: 'Saved to KV?', answers: ['yes', 'no', 'maybe', 'never'], correct: 0, difficulty: 1, category: 'Hosted'
    });
    check('question saved', added.status === 200);
    const fromOther = await call(tv.port, 'GET', '/api/questions');
    check('another instance reads the new question',
      fromOther.body.questions.some(x => x.text === 'Saved to KV?'));
    check('it really went to the KV store', kvStub.data.has('mm:questions'));

    const cfg = (await call(phone.port, 'GET', '/api/settings')).body;
    cfg.showSubtitle = 'HOSTED EDITION';
    const savedCfg = await call(phone.port, 'PUT', '/api/settings', cfg);
    check('settings saved', savedCfg.status === 200);
    const cfgElsewhere = await call(tv.port, 'GET', '/api/state');
    check('branding change reaches other instances',
      cfgElsewhere.body.settings.showSubtitle === 'HOSTED EDITION');

    console.log('\nPIN PROTECTION ON A PUBLIC URL');
    const withPin = Object.assign({}, cfg, { security: { adminPin: '9137' } });
    await call(phone.port, 'PUT', '/api/settings', withPin);
    const blocked = await call(tv.port, 'POST', '/api/action', { type: 'game/reset' });
    check('a stranger with the URL cannot drive the show', blocked.status === 401, 'status ' + blocked.status);
    const stillReadable = await call(tv.port, 'GET', '/api/state');
    check('the display still renders without the PIN', stillReadable.status === 200);
    check('the PIN is not in the public snapshot', JSON.stringify(stillReadable.body).indexOf('9137') === -1);
    const withRight = await call(tv.port, 'POST', '/api/action', { type: 'game/reset' }, '9137');
    check('the host with the PIN gets through', withRight.status === 200);
    await call(phone.port, 'PUT', '/api/settings', Object.assign({}, cfg, { security: { adminPin: '' } }), '9137');

    phone.server.close();
    tv.server.close();

    console.log('\nDEPLOYED ON SUPABASE INSTEAD OF UPSTASH');
    const sb = await startFakeSupabase();
    openHandles.push(sb.server);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.SUPABASE_URL = 'http://127.0.0.1:' + sb.port;
    process.env.SUPABASE_KEY = 'sb_publishable_test';

    const sbPhone = await mountFunction();
    const sbTv = await mountFunction();
    openHandles.push(sbPhone.server, sbTv.server);

    info = await call(sbPhone.port, 'GET', '/api/info');
    check('supabase counts as a store', info.body.storage === 'kv', String(info.body.storage));
    check('names supabase as the driver', info.body.driver === 'supabase', String(info.body.driver));
    check('not read-only on supabase', info.body.readOnly === false);

    const sbStart = await call(sbPhone.port, 'POST', '/api/action', {
      type: 'game/start', playerName: 'Postgres Pat'
    });
    check('show starts on supabase', sbStart.status === 200, 'status ' + sbStart.status);
    check('state written to the table', sb.data.has('mm:state'));

    const sbSeen = await call(sbTv.port, 'GET', '/api/state');
    check('a second instance sees the contestant',
      sbSeen.body.state.player.name === 'Postgres Pat', JSON.stringify(sbSeen.body.state.player));

    // jsonb holds an object, so nothing should arrive double-encoded.
    check('value stored as an object, not a JSON string',
      sb.data.get('mm:state') && typeof sb.data.get('mm:state') === 'object',
      typeof sb.data.get('mm:state'));

    const sbQ = await call(sbPhone.port, 'POST', '/api/questions', {
      text: 'Saved to Postgres?', answers: ['yes', 'no', 'maybe', 'never'], correct: 0, difficulty: 1
    });
    check('question saved to supabase', sbQ.status === 200, 'status ' + sbQ.status);
    const sbBank = await call(sbTv.port, 'GET', '/api/questions');
    check('the other instance reads it back',
      sbBank.body.questions.some(x => x.text === 'Saved to Postgres?'));

    const sbCfg = (await call(sbPhone.port, 'GET', '/api/settings')).body;
    sbCfg.ladder[1] = { level: 2, value: 0, label: 'A games console', safe: false };
    const sbSaved = await call(sbPhone.port, 'PUT', '/api/settings', sbCfg);
    check('prize ladder saves on supabase', sbSaved.status === 200, 'status ' + sbSaved.status);
    const sbLadder = (await call(sbTv.port, 'GET', '/api/settings')).body.ladder;
    check('the prize survives the round trip',
      sbLadder[1].label === 'A games console', JSON.stringify(sbLadder[1]));

    // A mystery prize written on the phone must stay secret on the television
    // until the host reveals it — and both are separate function instances.
    console.log('\nMYSTERY PRIZES ACROSS INSTANCES');
    await call(sbPhone.port, 'POST', '/api/action', {
      type: 'prize/set', level: 3, text: 'A speedboat', mystery: true
    });

    const tvCfg = (await call(sbTv.port, 'GET', '/api/settings')).body;
    check('the other instance sees the new prize',
      tvCfg.ladder[2].label === 'A speedboat' && tvCfg.ladder[2].mystery === true,
      JSON.stringify(tvCfg.ladder[2]));

    let tvState = (await call(sbTv.port, 'GET', '/api/state')).body.state;
    check('and knows it is still a secret',
      (tvState.revealedPrizes || []).indexOf(3) < 0, JSON.stringify(tvState.revealedPrizes));

    await call(sbPhone.port, 'POST', '/api/action', { type: 'prize/reveal', level: 3 });
    tvState = (await call(sbTv.port, 'GET', '/api/state')).body.state;
    check('a reveal on the phone reaches the television',
      (tvState.revealedPrizes || []).indexOf(3) >= 0, JSON.stringify(tvState.revealedPrizes));

    check('the prize edit really went to the store', sb.data.has('mm:settings'));

    // A database that goes away mid-episode must not take the television with
    // it. Reads fall back to what the instance already has; only writes fail.
    console.log('\nTHE STORE GOES DOWN MID-SHOW');
    sb.state.down = true;

    const duringOutage = await call(sbTv.port, 'GET', '/api/state');
    check('the display keeps rendering', duringOutage.status === 200, 'status ' + duringOutage.status);
    check('the contestant is still on screen',
      duringOutage.body.state.player.name === 'Postgres Pat',
      JSON.stringify(duringOutage.body.state.player));

    const blockedWrite = await call(sbPhone.port, 'POST', '/api/questions', {
      text: 'Lost to the outage?', answers: ['a', 'b', 'c', 'd'], correct: 0, difficulty: 1
    });
    check('a save fails loudly instead of silently vanishing',
      blockedWrite.status === 503, 'status ' + blockedWrite.status);
    check('and says the show carries on',
      /keeps running/i.test(blockedWrite.body.error || ''), blockedWrite.body.error);

    const sickInfo = await call(sbPhone.port, 'GET', '/api/info');
    check('info surfaces the store error', !!sickInfo.body.storeError, String(sickInfo.body.storeError));

    sb.state.down = false;
    const resumed = await call(sbPhone.port, 'POST', '/api/action', { type: 'game/next' });
    check('control resumes once the store is back', resumed.status === 200, 'status ' + resumed.status);
    const wellInfo = await call(sbPhone.port, 'GET', '/api/info');
    check('the error clears itself', !wellInfo.body.storeError, String(wellInfo.body.storeError));

  } catch (err) {
    failed++; failures.push('suite crashed: ' + err.message);
    console.error(err);
  } finally {
    openHandles.forEach(h => { try { h.close(); } catch (_) {} });
  }

  console.log('\n' + '-'.repeat(52));
  console.log('  passed: ' + passed + '   failed: ' + failed);
  if (failures.length) { console.log('\n  Failures:'); failures.forEach(f => console.log('   · ' + f)); }
  console.log('-'.repeat(52));
  process.exit(failed ? 1 : 0);
}

main();
