'use strict';
/**
 * End-to-end test: boots the real server on a spare port and drives a whole
 * show through the HTTP API, exactly as the phone remote does.
 *
 *   node test/run-tests.js
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8199;
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(BASE + urlPath, {
      method,
      headers: Object.assign(
        { 'Accept': 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      )
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const act = a => request('POST', '/api/action', a);
const state = async () => (await request('GET', '/api/state')).body.state;

/* ---- run the suite against a throwaway copy of the data dir ---- */

async function main() {
  // Work on a scratch copy so the repo's own data files are untouched.
  const backupDir = path.join(os.tmpdir(), 'mm-test-data-' + Date.now());
  fs.cpSync(path.join(ROOT, 'data'), backupDir, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await waitForServer();
    await runTests();
  } catch (err) {
    failed++;
    failures.push('suite crashed: ' + err.message);
    console.error(err);
  } finally {
    server.kill('SIGINT');
    await new Promise(r => setTimeout(r, 300));
    server.kill('SIGKILL');
    // restore the pristine data dir
    fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
    fs.cpSync(backupDir, path.join(ROOT, 'data'), { recursive: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }

  console.log('\n' + '-'.repeat(52));
  console.log('  passed: ' + passed + '   failed: ' + failed);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   · ' + f));
    console.log('\n  Server output:\n' + serverLog);
  }
  console.log('-'.repeat(52));
  process.exit(failed ? 1 : 0);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    (function poll() {
      http.get(BASE + '/api/info', res => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() > deadline) return reject(new Error('server did not start'));
          setTimeout(poll, 120);
        });
    })();
  });
}

async function runTests() {
  console.log('\nSERVING PAGES');
  for (const [p, needle] of [['/', 'MILLIONAIRE'], ['/display', 'question-frame'], ['/admin', 'Host Remote']]) {
    const res = await request('GET', p);
    check('GET ' + p + ' serves html', res.status === 200 && String(res.body).includes(needle), 'status ' + res.status);
  }
  const css = await request('GET', '/css/display.css');
  check('static css served with right type', css.status === 200 && /text\/css/.test(css.headers['content-type']));
  const missing = await request('GET', '/nope.js');
  check('unknown file gives 404', missing.status === 404);
  const traversal = await request('GET', '/../server.js');
  check('path traversal blocked', traversal.status === 404 || traversal.status === 403, 'status ' + traversal.status);

  console.log('\nGAME FLOW');
  await act({ type: 'game/reset' });
  let s = await state();
  check('starts idle', s.phase === 'idle');

  await act({ type: 'game/start', playerName: 'Test Contestant' });
  s = await state();
  check('start puts show in intro', s.phase === 'intro');
  check('player name stored', s.player.name === 'Test Contestant');

  await act({ type: 'question/load', level: 1 });
  s = await state();
  check('question loads at level 1', s.phase === 'question' && !!s.question && s.level === 1);
  check('question has 4 answers', s.question.answers.length === 4);
  check('correct index in range', s.question.correct >= 0 && s.question.correct <= 3);

  await act({ type: 'answer/select', index: 2 });
  s = await state();
  check('answer selects', s.selected === 2);
  await act({ type: 'answer/select', index: 2 });
  s = await state();
  check('tapping the same answer deselects', s.selected === null);

  // walk the ladder correctly to the top
  await act({ type: 'question/load', level: 1 });
  s = await state();
  let climbed = 0;
  for (let i = 0; i < 15; i++) {
    s = await state();
    if (!s.question) break;
    await act({ type: 'answer/select', index: s.question.correct });
    await act({ type: 'answer/lock' });
    s = await state();
    if (i === 0) check('lock moves to locked phase', s.phase === 'locked');
    await act({ type: 'answer/reveal' });
    s = await state();
    if (s.outcome !== 'correct' && s.outcome !== 'win') break;
    climbed++;
    if (s.level >= 15) break;
    await act({ type: 'game/next' });
  }
  s = await state();
  check('climbed all 15 levels', climbed === 15, 'reached ' + climbed);
  check('final outcome is a win', s.outcome === 'win', 'outcome ' + s.outcome);
  check('banked the top prize', s.banked === 1000000, 'banked ' + s.banked);

  console.log('\nWRONG ANSWER + SAFE NET');
  await act({ type: 'game/start', playerName: 'Faller' });
  await act({ type: 'question/load', level: 8 });
  s = await state();
  const wrongIndex = [0, 1, 2, 3].find(i => i !== s.question.correct);
  await act({ type: 'answer/select', index: wrongIndex });
  await act({ type: 'answer/lock' });
  await act({ type: 'answer/reveal' });
  s = await state();
  check('wrong answer ends the run', s.outcome === 'wrong' && s.phase === 'result');
  check('falls back to the $1,000 safe level', s.banked === 1000, 'banked ' + s.banked);

  console.log('\nWALK AWAY');
  await act({ type: 'game/start', playerName: 'Walker' });
  await act({ type: 'question/load', level: 7 });
  await act({ type: 'game/walkaway' });
  s = await state();
  check('walk away keeps level 6 money', s.outcome === 'walkaway' && s.banked === 2000, 'banked ' + s.banked);

  console.log('\nLIFELINES');
  await act({ type: 'game/start', playerName: 'Lifeliner' });
  await act({ type: 'question/load', level: 3 });
  s = await state();
  const correct = s.question.correct;

  await act({ type: 'lifeline/use', id: 'fifty' });
  s = await state();
  check('50:50 removes exactly two answers', s.eliminated.length === 2, 'removed ' + s.eliminated.length);
  check('50:50 never removes the correct answer', s.eliminated.indexOf(correct) === -1);
  check('50:50 marked used', s.lifelines.fifty.used === true);

  await act({ type: 'lifeline/use', id: 'audience' });
  s = await state();
  check('audience poll shown', s.overlay && s.overlay.type === 'audience');
  const total = s.overlay.results.reduce((a, b) => a + b, 0);
  check('poll adds up to 100%', total === 100, 'total ' + total);
  check('poll gives 0% to eliminated answers',
    s.eliminated.every(i => s.overlay.results[i] === 0));

  await act({ type: 'overlay/close' });
  await act({ type: 'lifeline/use', id: 'phone', friend: 'Jo', text: 'I think it is B.' });
  s = await state();
  check('phone overlay carries the host script', s.overlay.type === 'phone' && s.overlay.text === 'I think it is B.');
  check('phone overlay uses the given name', s.overlay.friend === 'Jo');

  await act({ type: 'overlay/close' });
  const before = (await state()).question.id;
  await act({ type: 'lifeline/use', id: 'switch' });
  s = await state();
  check('switch swaps in a different question', s.question.id !== before);
  check('switch clears the 50:50 eliminations', s.eliminated.length === 0);

  await act({ type: 'lifeline/reset' });
  s = await state();
  check('reset frees every lifeline', Object.values(s.lifelines).every(l => !l.used));

  console.log('\nTIMER');
  await act({ type: 'timer/set', duration: 15 });
  await act({ type: 'timer/start' });
  s = await state();
  check('timer set and running', s.timer.duration === 15 && s.timer.running);
  await new Promise(r => setTimeout(r, 2200));
  s = await state();
  check('timer counts down on the server', s.timer.remaining < 15, 'remaining ' + s.timer.remaining);
  await act({ type: 'timer/pause' });
  const paused = (await state()).timer.remaining;
  await new Promise(r => setTimeout(r, 1200));
  check('pause stops the countdown', (await state()).timer.remaining === paused);
  await act({ type: 'timer/reset' });
  check('reset restores the full duration', (await state()).timer.remaining === 15);
  await act({ type: 'question/load', level: 2 });
  check('host timer length survives the next question', (await state()).timer.duration === 15,
    'duration ' + (await state()).timer.duration);
  await act({ type: 'timer/set', duration: 30 });

  console.log('\nQUESTION EDITING');
  const created = await request('POST', '/api/questions', {
    text: 'What is 2 + 2?', answers: ['3', '4', '5', '6'], correct: 1,
    category: 'Test', difficulty: 1
  });
  check('new question accepted', created.status === 200 && created.body.ok);
  const newId = created.body.question.id;

  const edited = await request('PUT', '/api/questions/' + newId, {
    text: 'What is 3 + 3?', answers: ['5', '6', '7', '8'], correct: 1,
    category: 'Test', difficulty: 2
  });
  check('question edited', edited.status === 200 && edited.body.question.text === 'What is 3 + 3?');

  const persisted = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
  check('edit written to disk', persisted.questions.some(q => q.id === newId && q.difficulty === 2));

  const bad = await request('POST', '/api/questions', { text: 'No answers here', answers: ['', '', '', ''], correct: 0 });
  check('blank answers rejected', bad.status === 400, 'status ' + bad.status);

  const badIdx = await request('POST', '/api/questions', { text: 'Bad index', answers: ['a', 'b', 'c', 'd'], correct: 9 });
  check('out-of-range correct index rejected', badIdx.status === 400, 'status ' + badIdx.status);

  const removed = await request('DELETE', '/api/questions/' + newId);
  check('question deleted', removed.status === 200);
  const after = await request('GET', '/api/questions');
  check('deleted question is gone', !after.body.questions.some(q => q.id === newId));

  console.log('\nSETTINGS');
  const settingsRes = await request('GET', '/api/settings');
  const cfg = settingsRes.body;
  cfg.showSubtitle = 'QUIZ NIGHT';
  cfg.ladder = [{ value: 500, safe: false }, { value: 5000, safe: true }, { value: 50000, safe: false }];
  cfg.lifelines = cfg.lifelines.concat([{ id: 'host', label: 'ASK THE HOST', icon: 'custom', enabled: true }]);
  const saved = await request('PUT', '/api/settings', cfg);
  check('settings saved', saved.status === 200 && saved.body.settings.showSubtitle === 'QUIZ NIGHT');
  check('ladder renumbered from 1', saved.body.settings.ladder[0].level === 1 && saved.body.settings.ladder[2].level === 3);
  check('custom lifeline kept', saved.body.settings.lifelines.some(l => l.id === 'host'));

  s = await state();
  check('custom lifeline appears in live state', !!s.lifelines.host);

  await act({ type: 'game/start' });
  await act({ type: 'question/load', level: 3 });
  await act({ type: 'lifeline/use', id: 'host', text: 'Have a free hint.' });
  s = await state();
  check('custom lifeline shows on stage', s.overlay && s.overlay.type === 'custom' && s.overlay.label === 'ASK THE HOST');

  await act({ type: 'game/setLevel', level: 99 });
  s = await state();
  check('level clamped to the ladder length', s.level === 3, 'level ' + s.level);

  const emptyLadder = await request('PUT', '/api/settings', Object.assign({}, cfg, { ladder: [] }));
  check('empty ladder rejected', emptyLadder.status === 400, 'status ' + emptyLadder.status);

  console.log('\nEXPORT / IMPORT');
  const exported = await request('GET', '/api/export');
  check('export contains questions and settings',
    Array.isArray(exported.body.questions) && !!exported.body.settings);

  const imported = await request('POST', '/api/import', {
    questions: [{ text: 'Imported one?', answers: ['a', 'b', 'c', 'd'], correct: 0, difficulty: 1, category: 'Imp' }],
    mode: 'replace'
  });
  check('import replaces the bank', imported.status === 200 && imported.body.questions === 1);
  const backups = fs.readdirSync(path.join(ROOT, 'data', 'backups'));
  check('import kept a backup', backups.length > 0);

  const appended = await request('POST', '/api/import', {
    questions: [{ text: 'Second one?', answers: ['a', 'b', 'c', 'd'], correct: 1, difficulty: 1, category: 'Imp' }],
    mode: 'append'
  });
  check('append adds to the bank', appended.body.questions === 2, 'count ' + appended.body.questions);

  console.log('\nLIVE SYNC (SSE)');
  const frames = await collectStream(2, async () => {
    await act({ type: 'player/set', name: 'Streamed' });
  });
  check('stream sends a snapshot on connect', frames.length >= 1);
  check('stream pushes updates after an action',
    frames.some(f => f.state && f.state.player.name === 'Streamed'), 'frames ' + frames.length);

  console.log('\nERROR HANDLING');
  const unknown = await request('POST', '/api/action', { type: 'nonsense/action' });
  check('unknown action rejected', unknown.status === 400);
  const malformed = await rawPost('/api/action', '{not json');
  check('malformed JSON rejected', malformed.status === 400, 'status ' + malformed.status);
  const noEndpoint = await request('GET', '/api/does-not-exist');
  check('unknown api endpoint gives 404', noEndpoint.status === 404);

  console.log('\nPIN PROTECTION');
  const withPin = Object.assign({}, saved.body.settings, { security: { adminPin: '4821' } });
  await request('PUT', '/api/settings', withPin);
  const blocked = await request('POST', '/api/action', { type: 'game/reset' });
  check('actions blocked without the PIN', blocked.status === 401, 'status ' + blocked.status);
  const readable = await request('GET', '/api/state');
  check('display can still read state without a PIN', readable.status === 200);
  const infoRes = await request('GET', '/api/info');
  check('info never leaks the PIN', JSON.stringify(infoRes.body).indexOf('4821') === -1);
  check('state never leaks the PIN', JSON.stringify(readable.body).indexOf('4821') === -1);
  const allowed = await postWithPin('/api/action', { type: 'game/reset' }, '4821');
  check('correct PIN is accepted', allowed.status === 200, 'status ' + allowed.status);
  await postWithPin('/api/settings', Object.assign({}, withPin, { security: { adminPin: '' } }), '4821');
}

function rawPost(urlPath, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

function postWithPin(urlPath, payload, pin) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(BASE + urlPath, {
      method: urlPath === '/api/settings' ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Admin-Pin': pin
      }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function collectStream(minFrames, trigger) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = http.get(BASE + '/api/stream', res => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (line) {
            try { frames.push(JSON.parse(line.slice(6))); } catch (_) {}
          }
        }
        if (frames.length >= minFrames) { req.destroy(); resolve(frames); }
      });
      setTimeout(async () => { await trigger(); }, 150);
      setTimeout(() => { req.destroy(); resolve(frames); }, 4000);
    });
    req.on('error', err => {
      if (frames.length) resolve(frames); else reject(err);
    });
  });
}

main();
