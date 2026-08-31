'use strict';
/** Question-bank + settings validation and CRUD, shared by the HTTP routes. */

const DIFFICULTIES = [1, 2, 3];

function sanitizeQuestion(input, existing) {
  const q = Object.assign({}, existing || {}, input || {});
  const answers = Array.isArray(q.answers) ? q.answers.slice(0, 4) : [];
  while (answers.length < 4) answers.push('');

  const text = String(q.text || '').trim();
  if (!text) throw httpError(400, 'Question text is required.');
  const clean = answers.map(a => String(a == null ? '' : a).trim());
  if (clean.some(a => !a)) throw httpError(400, 'All four answers are required.');

  const correct = Number(q.correct);
  if (!(correct >= 0 && correct <= 3)) throw httpError(400, 'Correct answer must be A, B, C or D.');

  let difficulty = Number(q.difficulty) || 1;
  if (!DIFFICULTIES.includes(difficulty)) difficulty = 1;

  return {
    id: q.id || nextId(),
    text: text.slice(0, 400),
    answers: clean.map(a => a.slice(0, 160)),
    correct,
    difficulty,
    category: String(q.category || 'General').trim().slice(0, 40) || 'General',
    note: q.note ? String(q.note).slice(0, 400) : undefined
  };
}

function nextId() {
  return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitizeBank(input) {
  const src = Array.isArray(input) ? input : (input && input.questions) || [];
  if (!Array.isArray(src)) throw httpError(400, 'Expected an array of questions.');
  const seen = new Set();
  const questions = src.map(q => {
    const clean = sanitizeQuestion(q);
    while (seen.has(clean.id)) clean.id = nextId();
    seen.add(clean.id);
    return clean;
  });
  return { version: 1, questions };
}

function sanitizeSettings(input, current) {
  const s = Object.assign({}, current, input || {});

  s.showTitle = String(s.showTitle || '').slice(0, 60);
  s.showSubtitle = String(s.showSubtitle || '').slice(0, 60);
  s.currency = String(s.currency || '$').slice(0, 4);
  s.playerName = String(s.playerName || 'Contestant').slice(0, 40);

  s.timer = Object.assign({ enabled: true, duration: 30, autoStart: true }, current.timer, input && input.timer);
  s.timer.enabled = !!s.timer.enabled;
  s.timer.autoStart = !!s.timer.autoStart;
  s.timer.duration = clampNum(s.timer.duration, 5, 600, 30);

  const ladderIn = (input && input.ladder) || current.ladder || [];
  if (!Array.isArray(ladderIn) || !ladderIn.length) throw httpError(400, 'The prize ladder needs at least one level.');
  s.ladder = ladderIn.slice(0, 30).map((row, i) => {
    const rung = parseRung(row);
    rung.level = i + 1;
    rung.safe = !!row.safe;
    // Left off entirely on an ordinary rung, so a cash-only show's settings
    // file stays as plain as it was before mystery prizes existed.
    if (row.mystery) rung.mystery = true;
    return rung;
  });

  const lifelinesIn = (input && input.lifelines) || current.lifelines || [];
  const ids = new Set();
  s.lifelines = lifelinesIn.slice(0, 8).map(l => {
    let id = String(l.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'custom';
    while (ids.has(id)) id = id + '2';
    ids.add(id);
    return {
      id,
      label: String(l.label || id).slice(0, 30),
      icon: String(l.icon || 'custom').slice(0, 20),
      enabled: l.enabled !== false,
      auto: !!l.auto
    };
  });

  s.audio = Object.assign({ enabled: true, masterVolume: 0.7 }, current.audio, input && input.audio);
  s.audio.enabled = !!s.audio.enabled;
  s.audio.masterVolume = clampNum(s.audio.masterVolume, 0, 1, 0.7);

  s.display = Object.assign(
    { showLadder: true, showTimer: true, showLifelines: true, showProgressDots: true, questionsPerGame: s.ladder.length },
    current.display, input && input.display
  );
  ['showLadder', 'showTimer', 'showLifelines', 'showProgressDots'].forEach(k => { s.display[k] = !!s.display[k]; });
  s.display.questionsPerGame = clampNum(s.display.questionsPerGame, 1, s.ladder.length, s.ladder.length);
  // What the audience sees in place of a prize the host has not revealed yet.
  s.display.mysteryLabel = String(s.display.mysteryLabel || '???').slice(0, 24) || '???';

  s.phoneFriend = Object.assign({ duration: 30, defaultName: 'Sam' }, current.phoneFriend, input && input.phoneFriend);
  s.phoneFriend.duration = clampNum(s.phoneFriend.duration, 5, 300, 30);
  s.phoneFriend.defaultName = String(s.phoneFriend.defaultName || 'Sam').slice(0, 30);

  s.security = Object.assign({ adminPin: '' }, current.security, input && input.security);
  s.security.adminPin = String(s.security.adminPin || '').replace(/\s/g, '').slice(0, 12);

  return s;
}

const AMOUNT = /^-?\d+(\.\d+)?$/;

/**
 * A ladder rung holds either an amount or a prize name, because not every show
 * plays for cash — "A new car" is as valid a rung as 32000.
 *
 * `value` is always a number: it drives the safety-net maths and keeps the
 * rungs ordered. `label`, when present, is what the audience actually sees.
 * Money typed with decoration ("$1,500") still reads as money.
 */
function parseRung(row) {
  const raw = row ? row.value : undefined;
  let value = 0;
  let label = row && row.label != null ? String(row.label).trim() : '';

  if (typeof raw === 'number' && isFinite(raw)) {
    value = raw;
  } else if (typeof raw === 'string') {
    const stripped = raw.replace(/[\s,]/g, '').replace(/^[^\d.-]+/, '');
    if (stripped && AMOUNT.test(stripped)) value = Number(stripped);
    else if (raw.trim() && !label) label = raw.trim();
  }

  const rung = { level: 0, value: Math.max(0, Math.round(value)), safe: false };
  if (label) rung.label = label.slice(0, 40);
  return rung;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { sanitizeQuestion, sanitizeBank, sanitizeSettings, parseRung, httpError, nextId };
