'use strict';
/**
 * Authoritative game state + reducer.
 *
 * Every screen (stage display, phone remote, host monitor) renders from the
 * same state object, which only ever changes in here. The server broadcasts a
 * fresh snapshot after each action, so a phone that reconnects mid-show is
 * instantly back in sync.
 */

// Rewriting a prize mid-show has to read what the host typed the same way the
// settings form does, so the parsing lives in one place.
const api = require('./api');

const PHASES = ['idle', 'intro', 'question', 'locked', 'reveal', 'result', 'gameover'];
const LETTERS = ['A', 'B', 'C', 'D'];

function nowRev() {
  return Date.now();
}

function emptyLifelines(settings) {
  const out = {};
  for (const l of settings.lifelines) {
    out[l.id] = { id: l.id, label: l.label, icon: l.icon, enabled: l.enabled !== false, used: false };
  }
  return out;
}

function initialState(settings) {
  return {
    rev: nowRev(),
    phase: 'idle',
    outcome: null,
    level: 1,
    player: { name: settings.playerName || 'Contestant' },
    question: null,
    questionVisible: false,
    answersVisible: false,
    selected: null,
    locked: false,
    revealed: false,
    eliminated: [],
    lifelines: emptyLifelines(settings),
    overlay: null,
    timer: {
      enabled: settings.timer.enabled,
      duration: settings.timer.duration,
      // `remaining` is derived from startedAt/remainingAtPause on every read
      // (see settle) rather than decremented by a ticking loop, so the clock
      // stays correct with no long-lived process behind it.
      remaining: settings.timer.duration,
      remainingAtPause: settings.timer.duration,
      startedAt: null,
      running: false,
      expired: false
    },
    usedQuestionIds: [],
    flash: null,
    banked: 0,
    bankedLabel: null,
    bankedLevel: 0,
    // Levels whose mystery prize the host has shown the audience. Cleared with
    // the rest of the state, so every show starts with its secrets intact.
    revealedPrizes: []
  };
}

/* ---------------------------------------------------------------- helpers */

function rowAt(settings, level) {
  return settings.ladder.find(r => r.level === level) || null;
}

function levelValue(settings, level) {
  const row = rowAt(settings, level);
  return row ? row.value : 0;
}

/** The rung the contestant falls back to if they get the current one wrong. */
function safetyNetRow(settings, level) {
  let found = null;
  for (const row of settings.ladder) {
    if (row.level < level && row.safe) found = row;
  }
  return found;
}

/** Amount the contestant keeps if they get the current question wrong. */
function safetyNet(settings, level) {
  const row = safetyNetRow(settings, level);
  return row ? row.value : 0;
}

/**
 * Records what the contestant is holding. A rung can be an amount or a prize
 * name, so this keeps both: the number for the maths, the label for the stage.
 */
function setBanked(s, row) {
  s.banked = row ? row.value : 0;
  s.bankedLabel = row && row.label ? row.label : null;
  // Kept so the stage can tell whether what they are holding is still a
  // mystery: the label alone does not say which rung it came from.
  s.bankedLevel = row ? row.level : 0;
}

/**
 * True when a rung is a mystery prize the host has not shown the audience yet.
 * The stage renders the placeholder instead of the prize; the host's phone
 * always sees the real thing.
 */
function prizeHidden(state, row) {
  if (!row || !row.mystery) return false;
  return !(state.revealedPrizes || []).includes(row.level);
}

function difficultyForLevel(settings, level) {
  const total = settings.ladder.length || 15;
  const ratio = level / total;
  if (ratio <= 1 / 3) return 1;
  if (ratio <= 2 / 3) return 2;
  return 3;
}

function pickQuestion(bank, state, settings, level, opts) {
  opts = opts || {};
  const wanted = difficultyForLevel(settings, level);
  const exclude = new Set(state.usedQuestionIds);
  if (opts.excludeId) exclude.add(opts.excludeId);

  let pool = bank.questions.filter(q => !exclude.has(q.id) && q.difficulty === wanted);
  if (!pool.length) pool = bank.questions.filter(q => !exclude.has(q.id));
  if (!pool.length) pool = bank.questions.slice();
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Audience poll that leans on the right answer, less so as questions get harder. */
function generateAudience(question, eliminated, level, settings) {
  const alive = [0, 1, 2, 3].filter(i => !eliminated.includes(i));
  const difficulty = difficultyForLevel(settings, level);
  const confidence = { 1: 0.72, 2: 0.55, 3: 0.4 }[difficulty] || 0.5;

  const weights = {};
  let total = 0;
  for (const i of alive) {
    const base = i === question.correct
      ? confidence + Math.random() * 0.18
      : Math.random() * 0.28 + 0.04;
    weights[i] = base;
    total += base;
  }

  const result = [0, 0, 0, 0];
  let assigned = 0;
  for (const i of alive) {
    result[i] = Math.round((weights[i] / total) * 100);
    assigned += result[i];
  }
  // Rounding drift lands on the answer the crowd liked most.
  const top = alive.sort((a, b) => result[b] - result[a])[0];
  if (alive.length) result[top] += 100 - assigned;
  for (const i of [0, 1, 2, 3]) if (result[i] < 0) result[i] = 0;
  return result;
}

/** Suggested script for the phone-a-friend call; the host can overwrite it. */
function generatePhoneHint(question, eliminated, level, settings, friendName) {
  const difficulty = difficultyForLevel(settings, level);
  const rightOdds = { 1: 0.9, 2: 0.7, 3: 0.5 }[difficulty] || 0.7;
  const alive = [0, 1, 2, 3].filter(i => !eliminated.includes(i));
  const wrong = alive.filter(i => i !== question.correct);
  const knows = Math.random() < rightOdds;
  const pick = knows || !wrong.length ? question.correct : wrong[Math.floor(Math.random() * wrong.length)];
  const sure = knows && Math.random() < 0.6;

  const confident = [
    'That one is easy — it is ' + LETTERS[pick] + ', ' + question.answers[pick] + '. Lock it in.',
    'I know this. Definitely ' + LETTERS[pick] + ', ' + question.answers[pick] + '.',
    'No doubt at all: ' + LETTERS[pick] + '. Go for it.'
  ];
  const unsure = [
    'I am not certain, but I would lean towards ' + LETTERS[pick] + ', ' + question.answers[pick] + '.',
    'Hmm... I think it is ' + LETTERS[pick] + '. Maybe 60% sure — your call.',
    'It rings a bell. Probably ' + LETTERS[pick] + ', but do not bet the house on me.'
  ];
  const pool = sure ? confident : unsure;
  return {
    friend: friendName || (settings.phoneFriend && settings.phoneFriend.defaultName) || 'Sam',
    text: pool[Math.floor(Math.random() * pool.length)],
    suggested: pick,
    confidence: sure ? 'high' : 'low'
  };
}

/* ---------------------------------------------------------------- reducer */

/**
 * @param {object} ctx  { state, settings, bank }
 * @param {object} action { type, ... }
 * @returns {object} next state (mutated copy of ctx.state)
 */
function reduce(ctx, action) {
  const s = ctx.state;
  const settings = ctx.settings;
  const bank = ctx.bank;
  const type = action.type;

  switch (type) {
    /* ---- show flow ---- */
    case 'game/reset': {
      const fresh = initialState(settings);
      fresh.player.name = s.player.name;
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, fresh);
      break;
    }

    case 'game/start': {
      const name = action.playerName || s.player.name || settings.playerName;
      const fresh = initialState(settings);
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, fresh);
      s.player.name = name;
      s.phase = 'intro';
      break;
    }

    case 'question/load': {
      let q = null;
      if (action.questionId) q = bank.questions.find(x => x.id === action.questionId) || null;
      if (!q) q = pickQuestion(bank, s, settings, action.level || s.level);
      if (!q) break;
      if (action.level) s.level = clampLevel(settings, action.level);
      s.question = q;
      if (!s.usedQuestionIds.includes(q.id)) s.usedQuestionIds.push(q.id);
      s.phase = 'question';
      s.outcome = null;
      s.questionVisible = action.instant !== false;
      s.answersVisible = action.instant !== false;
      s.selected = null;
      s.locked = false;
      s.revealed = false;
      s.eliminated = [];
      s.overlay = null;
      s.flash = null;
      setBanked(s, safetyNetRow(settings, s.level));
      resetTimer(s, settings);
      if (settings.timer.enabled && settings.timer.autoStart && s.answersVisible) startClock(s.timer);
      break;
    }

    case 'question/showText':
      s.questionVisible = true;
      break;

    case 'question/showAnswers':
      s.questionVisible = true;
      s.answersVisible = true;
      if (s.timer.enabled && settings.timer.autoStart) startClock(s.timer);
      break;

    case 'answer/select':
      if (s.locked) break;
      s.selected = (s.selected === action.index) ? null : action.index;
      break;

    case 'answer/lock':
      if (s.selected === null || s.locked) break;
      s.locked = true;
      s.phase = 'locked';
      pauseClock(s.timer);
      break;

    case 'answer/unlock':
      if (s.revealed) break;
      s.locked = false;
      s.phase = 'question';
      break;

    case 'answer/reveal': {
      if (!s.question || s.selected === null) break;
      s.revealed = true;
      s.phase = 'reveal';
      pauseClock(s.timer);
      const right = s.selected === s.question.correct;
      s.outcome = right ? 'correct' : 'wrong';
      s.flash = right ? 'correct' : 'wrong';
      if (right) {
        setBanked(s, rowAt(settings, s.level));
        if (s.level >= settings.ladder.length) {
          s.outcome = 'win';
          s.phase = 'result';
        }
      } else {
        setBanked(s, safetyNetRow(settings, s.level));
        s.phase = 'result';
      }
      break;
    }

    case 'game/next': {
      // Straight after the intro there is no question on stage yet, so "next"
      // means "put the current level up", not "advance past it".
      const opening = s.phase === 'intro' || !s.question;

      if (!opening && s.level >= settings.ladder.length) {
        s.phase = 'gameover';
        s.outcome = 'win';
        break;
      }
      const nextLevel = opening ? s.level : s.level + 1;
      const q = pickQuestion(bank, s, settings, nextLevel);
      // With an empty bank there is nothing to move on to; hold the stage
      // where it is rather than showing an empty question frame.
      if (!q) break;
      s.level = nextLevel;
      s.question = q;
      if (!s.usedQuestionIds.includes(q.id)) s.usedQuestionIds.push(q.id);
      s.phase = 'question';
      s.outcome = null;
      s.selected = null;
      s.locked = false;
      s.revealed = false;
      s.eliminated = [];
      s.overlay = null;
      s.flash = null;
      s.questionVisible = true;
      s.answersVisible = true;
      setBanked(s, safetyNetRow(settings, s.level));
      resetTimer(s, settings);
      if (s.timer.enabled && settings.timer.autoStart) startClock(s.timer);
      break;
    }

    case 'game/walkaway':
      s.outcome = 'walkaway';
      s.phase = 'result';
      s.revealed = true;
      pauseClock(s.timer);
      setBanked(s, rowAt(settings, Math.max(1, s.level - 1)));
      break;

    case 'game/end':
      s.phase = 'gameover';
      pauseClock(s.timer);
      break;

    case 'game/setLevel':
      s.level = clampLevel(settings, action.level);
      setBanked(s, safetyNetRow(settings, s.level));
      break;

    case 'player/set':
      s.player.name = String(action.name || '').slice(0, 40) || 'Contestant';
      break;

    /* ---- prizes ---- */

    // Write a prize while the show is on air. Takes whatever the host typed:
    // "8000" is money, "A weekend in Rome" is a thing.
    case 'prize/set': {
      const level = clampLevel(settings, action.level);
      const row = settings.ladder[level - 1];
      if (!row) break;

      if (action.text !== undefined) {
        const parsed = api.parseRung({ value: action.text });
        row.value = parsed.value;
        if (parsed.label) row.label = parsed.label;
        else delete row.label;
        // A prize that has just been rewritten is a secret again — otherwise
        // the new one would appear on stage the instant it was typed.
        s.revealedPrizes = s.revealedPrizes.filter(l => l !== level);
      }
      if (action.mystery !== undefined) {
        if (action.mystery) row.mystery = true;
        else delete row.mystery;
      }

      // The banked figure may be quoting the rung that just changed.
      if (s.bankedLevel === level) setBanked(s, row);
      break;
    }

    // Show a mystery prize to the audience.
    case 'prize/reveal': {
      const level = clampLevel(settings, action.level);
      if (!s.revealedPrizes.includes(level)) s.revealedPrizes.push(level);
      s.flash = 'prize';
      break;
    }

    // Put it back behind the curtain (for a mis-tap, or a rehearsal).
    case 'prize/hide': {
      const level = clampLevel(settings, action.level);
      s.revealedPrizes = s.revealedPrizes.filter(l => l !== level);
      s.flash = null;
      break;
    }

    /* ---- lifelines ---- */
    case 'lifeline/use': {
      const ll = s.lifelines[action.id];
      if (!ll || !ll.enabled || ll.used || !s.question) break;
      ll.used = true;

      if (action.id === 'fifty') {
        const wrong = [0, 1, 2, 3].filter(i => i !== s.question.correct && !s.eliminated.includes(i));
        shuffle(wrong);
        s.eliminated = s.eliminated.concat(wrong.slice(0, 2));
        if (s.selected !== null && s.eliminated.includes(s.selected)) s.selected = null;
      } else if (action.id === 'audience') {
        const data = Array.isArray(action.results) && action.results.length === 4
          ? action.results.map(n => Math.max(0, Math.round(Number(n) || 0)))
          : generateAudience(s.question, s.eliminated, s.level, settings);
        s.overlay = { type: 'audience', results: data };
        pauseClock(s.timer);
      } else if (action.id === 'phone') {
        const hint = action.text
          ? { friend: action.friend || settings.phoneFriend.defaultName, text: String(action.text).slice(0, 400), suggested: null, confidence: 'custom' }
          : generatePhoneHint(s.question, s.eliminated, s.level, settings, action.friend);
        s.overlay = {
          type: 'phone',
          friend: hint.friend,
          text: hint.text,
          confidence: hint.confidence,
          seconds: (settings.phoneFriend && settings.phoneFriend.duration) || 30,
          startedAt: Date.now()
        };
        pauseClock(s.timer);
      } else if (action.id === 'switch') {
        const replacement = pickQuestion(bank, s, settings, s.level, { excludeId: s.question.id });
        if (replacement) {
          s.question = replacement;
          if (!s.usedQuestionIds.includes(replacement.id)) s.usedQuestionIds.push(replacement.id);
          s.selected = null;
          s.locked = false;
          s.revealed = false;
          s.eliminated = [];
          s.phase = 'question';
          s.overlay = { type: 'switch' };
          resetTimer(s, settings);
        }
      } else {
        // Custom lifeline defined by the host: just announce it on stage.
        s.overlay = { type: 'custom', id: action.id, label: ll.label, text: action.text || '' };
      }
      break;
    }

    case 'lifeline/reset':
      if (action.id && s.lifelines[action.id]) s.lifelines[action.id].used = false;
      else Object.values(s.lifelines).forEach(l => { l.used = false; });
      break;

    case 'lifeline/toggle':
      if (s.lifelines[action.id]) s.lifelines[action.id].enabled = !s.lifelines[action.id].enabled;
      break;

    case 'lifeline/sync':
      // Re-read lifeline definitions after the host edits them in settings.
      for (const def of settings.lifelines) {
        const prev = s.lifelines[def.id];
        s.lifelines[def.id] = {
          id: def.id,
          label: def.label,
          icon: def.icon,
          enabled: def.enabled !== false,
          used: prev ? prev.used : false
        };
      }
      for (const id of Object.keys(s.lifelines)) {
        if (!settings.lifelines.some(d => d.id === id)) delete s.lifelines[id];
      }
      // A state saved before mystery prizes existed has no reveal list, and a
      // reveal for a level the host has since deleted would never clear.
      if (!Array.isArray(s.revealedPrizes)) s.revealedPrizes = [];
      s.revealedPrizes = s.revealedPrizes.filter(l => l >= 1 && l <= settings.ladder.length);
      if (typeof s.bankedLevel !== 'number') s.bankedLevel = 0;
      break;

    /* ---- overlays ---- */
    case 'overlay/close':
      s.overlay = null;
      break;

    case 'overlay/set':
      s.overlay = action.overlay || null;
      break;

    /* ---- timer ---- */
    case 'timer/start':
      if (!s.timer.enabled) break;
      if (s.timer.remainingAtPause <= 0) s.timer.remainingAtPause = s.timer.duration;
      startClock(s.timer);
      break;

    case 'timer/pause':
      pauseClock(s.timer);
      break;

    case 'timer/reset':
      resetTimer(s, settings);
      break;

    case 'timer/set':
      // The host's choice is a show setting, not a one-off: keep it on the
      // settings object too so the next question does not snap back to 30s.
      s.timer.duration = Math.max(5, Math.min(600, Number(action.duration) || 30));
      s.timer.remainingAtPause = s.timer.duration;
      s.timer.remaining = s.timer.duration;
      s.timer.expired = false;
      if (s.timer.running) s.timer.startedAt = Date.now();
      settings.timer.duration = s.timer.duration;
      break;

    case 'timer/toggle':
      s.timer.enabled = !s.timer.enabled;
      if (!s.timer.enabled) pauseClock(s.timer);
      settings.timer.enabled = s.timer.enabled;
      break;

    case 'timer/tick':
      // Kept so the local server's one-second loop has something to call;
      // the real work is in settle(), which every snapshot runs anyway.
      settle(s);
      break;

    /* ---- stage effects ---- */
    case 'flash/clear':
      s.flash = null;
      break;

    case 'flash/set':
      s.flash = action.value || null;
      break;

    default:
      return null; // unknown action
  }

  s.rev = nowRev();
  return s;
}

function clampLevel(settings, level) {
  const n = Number(level) || 1;
  return Math.max(1, Math.min(settings.ladder.length, n));
}

function resetTimer(s, settings) {
  s.timer.enabled = settings.timer.enabled;
  s.timer.duration = settings.timer.duration;
  s.timer.remaining = settings.timer.duration;
  s.timer.remainingAtPause = settings.timer.duration;
  s.timer.startedAt = null;
  s.timer.running = false;
  s.timer.expired = false;
}

function startClock(t) {
  t.running = true;
  t.expired = false;
  t.startedAt = Date.now();
}

function pauseClock(t) {
  if (t.running) t.remainingAtPause = rawRemaining(t);
  t.running = false;
  t.startedAt = null;
}

/** Seconds left right now, as a float. */
function rawRemaining(t) {
  if (!t.running || !t.startedAt) return Math.max(0, t.remainingAtPause);
  return Math.max(0, t.remainingAtPause - (Date.now() - t.startedAt) / 1000);
}

/**
 * Brings the derived clock up to date. Every snapshot runs this, so the
 * countdown is correct whether it is read a second or an hour later — which
 * is what lets the same game state work on a serverless host with no ticking
 * process behind it.
 *
 * @returns {boolean} true if the timer just ran out on this call
 */
function settle(state) {
  const t = state.timer;
  if (!t) return false;
  const left = rawRemaining(t);
  t.remaining = Math.ceil(left);
  if (t.running && t.enabled && left <= 0) {
    t.running = false;
    t.startedAt = null;
    t.remainingAtPause = 0;
    t.remaining = 0;
    t.expired = true;
    state.flash = 'timeout';
    state.rev = nowRev();
    return true;
  }
  return false;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  settle,
  rowAt,
  safetyNetRow,
  prizeHidden,
  PHASES,
  LETTERS,
  initialState,
  reduce,
  levelValue,
  safetyNet,
  difficultyForLevel,
  generateAudience,
  generatePhoneHint
};
