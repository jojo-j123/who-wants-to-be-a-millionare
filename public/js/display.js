/* Stage display renderer — draws whatever state the server broadcasts. */
(function () {
  'use strict';

  var LETTERS = ['A', 'B', 'C', 'D'];
  var el = {};
  var prev = { questionId: null, phase: null, flashSeen: null, overlayKey: null, lastTick: null };
  var soundOn = true;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    [
      'player-initial', 'player-name', 'player-money', 'brand-top', 'brand-main',
      'timer', 'timer-value', 'ring-fill', 'q-index', 'q-total', 'progress-dots',
      'progress-wrap', 'question-frame', 'question-text', 'answers', 'lifelines',
      'ladder', 'ladder-wrap', 'overlay', 'overlay-card', 'standby', 'standby-sub',
      'result-banner', 'result-text', 'btn-sound', 'btn-fullscreen', 'conn', 'conn-text'
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    try { soundOn = localStorage.getItem('mm-display-sound') !== 'off'; } catch (e) {}
    applySoundButton();

    el['btn-sound'].addEventListener('click', function () {
      soundOn = !soundOn;
      try { localStorage.setItem('mm-display-sound', soundOn ? 'on' : 'off'); } catch (e) {}
      applySoundButton();
      if (soundOn) Sfx.unlock();
    });

    el['btn-fullscreen'].addEventListener('click', toggleFullscreen);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'f' || ev.key === 'F') toggleFullscreen();
    });
    // Browsers block audio until the page is touched once.
    ['click', 'keydown', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, function once() {
        Sfx.unlock();
        document.removeEventListener(evt, once);
      });
    });

    Bus.onConnection(function (ok) {
      el.conn.hidden = ok;
      el['conn-text'].textContent = Bus.isLocal ? 'Local mode' : 'Reconnecting…';
    });
    Bus.onState(render);
    Bus.connect();
  }

  function applySoundButton() {
    el['btn-sound'].classList.toggle('off', !soundOn);
    Sfx.setEnabled(soundOn);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () {});
  }

  /* ------------------------------------------------------------ render */

  function render(snap) {
    var s = snap.state;
    var cfg = snap.settings;

    Sfx.setVolume(cfg.audio.masterVolume);
    if (!cfg.audio.enabled) Sfx.setEnabled(false);
    else Sfx.setEnabled(soundOn);

    el['brand-top'].textContent = cfg.showTitle;
    el['brand-main'].textContent = cfg.showSubtitle;
    document.querySelectorAll('.standby-logo .brand-top').forEach(function (n) { n.textContent = cfg.showTitle; });
    document.querySelectorAll('.standby-logo .brand-main').forEach(function (n) { n.textContent = cfg.showSubtitle; });

    renderPlayer(s, cfg);
    renderProgress(s, cfg);
    renderQuestion(s, cfg);
    renderLifelines(s, cfg);
    renderLadder(s, cfg);
    renderTimer(s, cfg);
    renderOverlay(s, cfg);
    renderPhase(s, cfg);
    handleCues(s, cfg);

    prev.phase = s.phase;
    prev.questionId = s.question ? s.question.id : null;
  }

  function renderPlayer(s, cfg) {
    var name = s.player.name || 'Contestant';
    el['player-name'].textContent = name;
    el['player-initial'].textContent = (name.trim()[0] || 'M').toUpperCase();
    el['player-money'].textContent = currentPrize(s, cfg);

    var label = document.querySelector('.player-label');
    if (label) label.textContent = hasPrizes(cfg) ? 'CURRENT PRIZE' : 'CURRENT WINNINGS';
  }

  /** What the header shows as "current winnings": the rung in play. */
  function currentPrize(s, cfg) {
    if (s.outcome === 'walkaway' || s.outcome === 'wrong') return bankedText(s, cfg);
    if (s.phase === 'idle' || s.phase === 'intro') {
      // "$0" reads oddly on a ladder of prizes rather than cash.
      return hasPrizes(cfg) ? '—' : money(0, cfg.currency);
    }
    var row = cfg.ladder.find(function (r) { return r.level === s.level; });
    return row ? prizeText(row, s, cfg) : money(0, cfg.currency);
  }

  function bankedText(s, cfg) {
    var row = cfg.ladder.find(function (r) { return r.level === s.bankedLevel; });
    if (hiddenPrize(row, s)) return mysteryLabel(cfg);
    return s.bankedLabel || money(s.banked, cfg.currency);
  }

  function hasPrizes(cfg) {
    return cfg.ladder.some(function (r) { return !!r.label || !!r.mystery; });
  }

  /**
   * A mystery rung stays hidden from the audience until the host reveals it.
   * The host's own screen never calls this — the phone always shows the truth.
   */
  function hiddenPrize(row, s) {
    if (!row || !row.mystery) return false;
    return (s.revealedPrizes || []).indexOf(row.level) < 0;
  }

  function mysteryLabel(cfg) {
    return (cfg.display && cfg.display.mysteryLabel) || '???';
  }

  /** What the audience is allowed to see for a rung. */
  function prizeText(row, s, cfg) {
    if (!row) return money(0, cfg.currency);
    return hiddenPrize(row, s) ? mysteryLabel(cfg) : rungText(row, cfg.currency);
  }

  function renderProgress(s, cfg) {
    var total = cfg.ladder.length;
    el['progress-wrap'].hidden = !cfg.display.showProgressDots;
    el['q-index'].textContent = s.level;
    el['q-total'].textContent = total;

    if (el['progress-dots'].childElementCount !== total) {
      el['progress-dots'].innerHTML = '';
      for (var i = 0; i < total; i++) el['progress-dots'].appendChild(document.createElement('i'));
    }
    Array.prototype.forEach.call(el['progress-dots'].children, function (dot, i) {
      dot.className = '';
      if (i + 1 < s.level) dot.classList.add('done');
      if (i + 1 === s.level) dot.classList.add('active');
    });
  }

  function renderQuestion(s, cfg) {
    var q = s.question;
    el['question-frame'].classList.toggle('hidden', !s.questionVisible || !q);
    el['question-text'].textContent = q ? q.text : '';

    if (!q) { el.answers.innerHTML = ''; return; }

    // Rebuild only when the question itself changes; otherwise just restyle.
    if (el.answers.childElementCount !== 4 || el.answers.dataset.qid !== q.id) {
      el.answers.dataset.qid = q.id;
      el.answers.innerHTML = '';
      for (var i = 0; i < 4; i++) {
        var wrap = document.createElement('div');
        wrap.className = 'answer';
        wrap.innerHTML =
          '<div class="answer-inner">' +
            '<span class="answer-letter">' + LETTERS[i] + '</span>' +
            '<span class="answer-divider"></span>' +
            '<span class="answer-text"></span>' +
          '</div>';
        el.answers.appendChild(wrap);
      }
    }

    Array.prototype.forEach.call(el.answers.children, function (node, i) {
      node.querySelector('.answer-text').textContent = q.answers[i];
      node.className = 'answer';
      if (!s.answersVisible) node.classList.add('hidden');
      if (s.eliminated.indexOf(i) >= 0) node.classList.add('eliminated');
      if (s.selected === i && !s.revealed) node.classList.add('selected');
      if (s.locked && s.selected === i && !s.revealed) node.classList.add('locked');
      if (s.revealed) {
        if (i === q.correct) node.classList.add('correct');
        else if (i === s.selected) node.classList.add('wrong');
        else if (s.selected === i) node.classList.add('selected');
      }
    });
  }

  var ICONS = {
    '5050': '<span class="ll-text">50:50</span>',
    phone: '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11.4 11.4 0 0 0 3.6.58 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .58 3.6 1 1 0 0 1-.25 1z"/></svg>',
    audience: '<svg viewBox="0 0 24 24"><path d="M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.5 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 19v-1.2C2 15.4 5 14 8.5 14s6.5 1.4 6.5 3.8V19zm14.2 0v-1.4c0-1.3-.6-2.4-1.6-3.2 2.9.2 5.4 1.4 5.4 3.4V19z"/></svg>',
    switch: '<svg viewBox="0 0 24 24"><path d="M17 3l4 4-4 4V8H8a3 3 0 0 0-3 3H3a5 5 0 0 1 5-5h9zM7 21l-4-4 4-4v3h9a3 3 0 0 0 3-3h2a5 5 0 0 1-5 5H7z"/></svg>',
    custom: '<svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.5L21 9.6l-4.8 4.4 1.3 6.6L12 17.4 6.5 20.6l1.3-6.6L3 9.6l6.4-1.1z"/></svg>'
  };

  function renderLifelines(s, cfg) {
    el.lifelines.classList.toggle('hidden', !cfg.display.showLifelines);
    var defs = cfg.lifelines;
    var key = defs.map(function (d) { return d.id + d.label; }).join('|');

    if (el.lifelines.dataset.key !== key) {
      el.lifelines.dataset.key = key;
      el.lifelines.innerHTML = '';
      defs.forEach(function (d) {
        var node = document.createElement('div');
        node.className = 'lifeline';
        node.dataset.id = d.id;
        node.innerHTML =
          '<div class="lifeline-btn">' + (ICONS[d.icon] || ICONS.custom) + '</div>' +
          '<div class="lifeline-label">' + escapeHtml(d.label) + '</div>';
        el.lifelines.appendChild(node);
      });
    }

    Array.prototype.forEach.call(el.lifelines.children, function (node) {
      var ll = s.lifelines[node.dataset.id];
      node.classList.toggle('used', !!(ll && ll.used));
      node.classList.toggle('disabled', !(ll && ll.enabled));
    });
  }

  function renderLadder(s, cfg) {
    el['ladder-wrap'].classList.toggle('hidden', !cfg.display.showLadder);
    // Revealing a prize rewrites a rung's text, so the reveal list is part of
    // what decides whether the ladder needs rebuilding.
    var key = cfg.ladder.map(function (r) {
      return prizeText(r, s, cfg) + (r.safe ? 's' : '') + (r.mystery ? '?' : '');
    }).join(',');

    if (el.ladder.dataset.key !== key) {
      el.ladder.dataset.key = key;
      el.ladder.innerHTML = '';
      cfg.ladder.forEach(function (row) {
        var li = document.createElement('li');
        li.dataset.level = row.level;
        li.innerHTML = '<span class="lvl">' + row.level + '</span><span class="amt">' +
          escapeHtml(prizeText(row, s, cfg)) + '</span>';
        el.ladder.appendChild(li);
      });
    }

    Array.prototype.forEach.call(el.ladder.children, function (li) {
      var level = Number(li.dataset.level);
      var row = cfg.ladder[level - 1];
      li.className = '';
      if (row.safe) li.classList.add('safe');
      if (hiddenPrize(row, s)) li.classList.add('mystery');
      if (level < s.level) li.classList.add('passed');
      if (level === s.level && s.phase !== 'idle') li.classList.add('current');
    });
  }

  function renderTimer(s, cfg) {
    var show = cfg.display.showTimer && s.timer.enabled;
    el.timer.classList.toggle('hidden', !show);
    if (!show) return;

    var remaining = s.timer.remaining;
    el['timer-value'].textContent = remaining;

    var pct = s.timer.duration ? remaining / s.timer.duration : 0;
    var circumference = 2 * Math.PI * 52;
    el['ring-fill'].style.strokeDasharray = circumference;
    el['ring-fill'].style.strokeDashoffset = circumference * (1 - pct);

    el.timer.classList.toggle('warn', remaining <= 10 && remaining > 5);
    el.timer.classList.toggle('danger', remaining <= 5);

    if (s.timer.running && remaining <= 5 && remaining > 0 && prev.lastTick !== remaining) {
      Sfx.tick();
    }
    prev.lastTick = remaining;
  }

  function renderOverlay(s, cfg) {
    var o = s.overlay;
    if (!o) {
      el.overlay.hidden = true;
      prev.overlayKey = null;
      return;
    }
    var key = o.type + ':' + (o.startedAt || '') + ':' + JSON.stringify(o.results || o.text || '');
    if (prev.overlayKey === key) {
      if (o.type === 'phone') updatePhoneClock(o);
      return;
    }
    prev.overlayKey = key;
    el.overlay.hidden = false;

    if (o.type === 'audience') drawAudience(o, cfg);
    else if (o.type === 'phone') drawPhone(o, cfg);
    else if (o.type === 'switch') drawSimple('SWITCH QUESTION', 'A brand new question coming up…');
    else drawSimple(o.label || 'LIFELINE', o.text || '');
  }

  function drawAudience(o) {
    var html = '<h2 class="overlay-title">ASK THE AUDIENCE</h2><div class="poll">';
    for (var i = 0; i < 4; i++) {
      html += '<div class="poll-col">' +
        '<div class="poll-pct">' + o.results[i] + '%</div>' +
        '<div class="poll-bar" data-pct="' + o.results[i] + '"></div>' +
        '<div class="poll-letter">' + LETTERS[i] + '</div>' +
      '</div>';
    }
    html += '</div>';
    el['overlay-card'].innerHTML = html;
    Sfx.audienceReveal();
    // Bars grow after paint so the transition actually runs.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el['overlay-card'].querySelectorAll('.poll-bar').forEach(function (bar) {
          bar.style.height = Math.max(2, Number(bar.dataset.pct) * 0.9) + '%';
        });
      });
    });
  }

  var phoneTimer = null;

  function drawPhone(o) {
    el['overlay-card'].innerHTML =
      '<h2 class="overlay-title">PHONE A FRIEND</h2>' +
      '<div class="phone-body">' +
        '<div class="phone-friend">CALLING ' + escapeHtml((o.friend || 'FRIEND').toUpperCase()) + '</div>' +
        '<p class="phone-quote">' + escapeHtml(o.text || '') + '</p>' +
        '<div class="phone-clock" id="phone-clock">' + (o.seconds || 30) + '</div>' +
      '</div>';
    Sfx.phoneRing();
    updatePhoneClock(o);
  }

  function updatePhoneClock(o) {
    var node = document.getElementById('phone-clock');
    if (!node) return;
    if (phoneTimer) clearInterval(phoneTimer);
    var tickIt = function () {
      var elapsed = Math.floor((Date.now() - (o.startedAt || Date.now())) / 1000);
      var left = Math.max(0, (o.seconds || 30) - elapsed);
      node.textContent = left;
      node.classList.toggle('low', left <= 10);
      if (left <= 0) clearInterval(phoneTimer);
    };
    tickIt();
    phoneTimer = setInterval(tickIt, 250);
  }

  function drawSimple(title, message) {
    el['overlay-card'].innerHTML =
      '<h2 class="overlay-title">' + escapeHtml(title) + '</h2>' +
      '<p class="simple-msg">' + escapeHtml(message) + '</p>';
    Sfx.lifeline();
  }

  function renderPhase(s, cfg) {
    el.standby.hidden = !(s.phase === 'idle' || s.phase === 'intro');
    if (s.phase === 'intro') {
      el['standby-sub'].textContent = 'Please welcome ' + (s.player.name || 'our contestant') + '!';
    } else {
      el['standby-sub'].textContent = 'Waiting for the host…';
    }

    var banner = el['result-banner'];
    if (s.outcome === 'win' || (s.phase === 'gameover' && s.outcome === 'win')) {
      show(banner, 'win', topPrizeCry(cfg) + '  ' + bankedText(s, cfg));
    } else if (s.outcome === 'wrong') {
      show(banner, 'lose', 'That is the wrong answer — leaving with ' + bankedText(s, cfg));
    } else if (s.outcome === 'walkaway') {
      show(banner, 'neutral', 'Walked away with ' + bankedText(s, cfg));
    } else if (s.outcome === 'correct') {
      show(banner, 'win', 'CORRECT!  ' + currentPrize(s, cfg));
    } else {
      banner.hidden = true;
    }
  }

  function show(node, cls, text) {
    node.hidden = false;
    node.className = 'result-banner ' + cls;
    document.getElementById('result-text').textContent = text;
  }

  /* ------------------------------------------------------------ audio cues */

  function handleCues(s, cfg) {
    var qid = s.question ? s.question.id : null;

    if (qid && qid !== prev.questionId && s.questionVisible) {
      Sfx.questionIn();
      if (s.answersVisible) Sfx.answersIn();
      Sfx.startBed(s.level);
    }

    if (s.phase === 'locked' && prev.phase !== 'locked') Sfx.lock();

    if (s.flash && s.flash !== prev.flashSeen) {
      prev.flashSeen = s.flash;
      document.body.classList.remove('flash-correct', 'flash-wrong', 'flash-timeout', 'flash-prize');
      void document.body.offsetWidth; // restart the CSS animation
      document.body.classList.add('flash-' + s.flash);
      if (s.flash === 'correct') Sfx.correct(s.level);
      if (s.flash === 'wrong') Sfx.wrong();
      if (s.flash === 'timeout') Sfx.timeout();
      if (s.flash === 'prize') Sfx.prizeReveal();
      setTimeout(function () {
        document.body.classList.remove('flash-correct', 'flash-wrong', 'flash-timeout', 'flash-prize');
      }, 1400);
    }
    if (!s.flash) prev.flashSeen = null;

    if (s.outcome === 'win' && prev.phase !== s.phase) Sfx.win();
    if (s.outcome === 'walkaway' && prev.phase !== s.phase) Sfx.walkaway();
    if (s.phase === 'idle' || s.phase === 'result' || s.phase === 'gameover') Sfx.stopBed();
  }

  /* ------------------------------------------------------------ utils */

  function money(value, currency) {
    return (currency || '$') + Number(value || 0).toLocaleString('en-US');
  }

  /** A rung shows its prize name when it has one, otherwise the amount. */
  function rungText(row, currency) {
    return row.label ? row.label : money(row.value, currency);
  }

  /** "MILLIONAIRE!" only makes sense on a cash ladder. */
  function topPrizeCry(cfg) {
    return hasPrizes(cfg) ? 'WINNER!' : 'MILLIONAIRE!';
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
