/* Host remote — runs the show and edits the content, from a phone. */
(function () {
  'use strict';

  var LETTERS = ['A', 'B', 'C', 'D'];
  var snap = null;      // latest server snapshot
  var bank = [];        // question bank
  var draft = null;     // settings being edited in the Setup tab
  var editing = null;   // question open in the editor sheet

  document.addEventListener('DOMContentLoaded', boot);

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ boot */

  function boot() {
    wireTabs();
    wireControl();
    wireQuestions();
    wireSetup();
    wireScreens();

    Bus.onConnection(function (ok) {
      $('status').classList.toggle('on', ok);
    });

    Bus.get('/api/info').then(function (info) {
      if (info.pinRequired && !Bus.pin()) openGate();
      else start();
    }).catch(function () { start(); });
  }

  function start() {
    Bus.onState(function (s) {
      snap = s;
      if (!draft) draft = JSON.parse(JSON.stringify(s.settings));
      renderControl();
      renderTopbar();
    });
    Bus.connect();
    loadBank();
  }

  function openGate() {
    $('gate').hidden = false;
    $('gate-go').addEventListener('click', tryPin);
    $('gate-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryPin(); });
    $('gate-pin').focus();
  }

  function tryPin() {
    var value = $('gate-pin').value.trim();
    Bus.setPin(value);
    Bus.post('/api/auth', {}).then(function () {
      $('gate').hidden = true;
      start();
    }).catch(function (err) {
      Bus.setPin('');
      $('gate-err').textContent = err.message || 'Wrong PIN';
    });
  }

  /* ------------------------------------------------------------ tabs */

  function wireTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
        tab.classList.add('active');
        $('view-' + tab.dataset.view).classList.add('active');
        window.scrollTo(0, 0);
        if (tab.dataset.view === 'setup') fillSetup();
        if (tab.dataset.view === 'screens') fillScreens();
      });
    });
  }

  /* ------------------------------------------------------------ topbar */

  function renderTopbar() {
    var s = snap.state, cfg = snap.settings;
    $('chip-level').textContent = 'Q' + s.level + '/' + cfg.ladder.length;
    var row = cfg.ladder[s.level - 1];
    $('chip-money').textContent = row ? rungText(row, cfg.currency) : money(0, cfg.currency);
    $('topbar-title').textContent = s.player.name || 'Host Remote';
  }

  /* ------------------------------------------------------------ control */

  function wireControl() {
    $('btn-start').addEventListener('click', function () {
      act({ type: 'game/start', playerName: $('player-input').value.trim() });
    });
    $('btn-reset').addEventListener('click', function () {
      if (confirm('Reset the whole show back to the standby screen?')) act({ type: 'game/reset' });
    });
    $('btn-shuffle').addEventListener('click', function () {
      act({ type: 'question/load', level: snap.state.level });
    });
    $('btn-lock').addEventListener('click', function () { act({ type: 'answer/lock' }); });
    $('btn-reveal').addEventListener('click', function () { act({ type: 'answer/reveal' }); });
    $('btn-next').addEventListener('click', function () { act({ type: 'game/next' }); });
    $('btn-walk').addEventListener('click', function () {
      if (confirm('Contestant walks away with the money so far?')) act({ type: 'game/walkaway' });
    });
    $('btn-reset-lifelines').addEventListener('click', function () { act({ type: 'lifeline/reset' }); });

    $('btn-timer-start').addEventListener('click', function () { act({ type: 'timer/start' }); });
    $('btn-timer-pause').addEventListener('click', function () { act({ type: 'timer/pause' }); });
    $('btn-timer-reset').addEventListener('click', function () { act({ type: 'timer/reset' }); });
    $('toggle-timer').addEventListener('change', function () { act({ type: 'timer/toggle' }); });
    $('timer-secs').addEventListener('input', function () {
      $('timer-secs-label').textContent = this.value;
    });
    $('timer-secs').addEventListener('change', function () {
      act({ type: 'timer/set', duration: Number(this.value) });
    });
    $('player-input').addEventListener('change', function () {
      act({ type: 'player/set', name: this.value.trim() });
    });
    $('level-select').addEventListener('change', function () {
      act({ type: 'game/setLevel', level: Number(this.value) });
    });
  }

  function renderControl() {
    var s = snap.state, cfg = snap.settings;

    // question preview
    if (s.question) {
      $('preview-meta').textContent = s.question.category + ' · ' + diffLabel(s.question.difficulty);
      $('preview-q').textContent = s.question.text;
    } else {
      $('preview-meta').textContent = 'No question loaded';
      $('preview-q').textContent = 'Press Start show, then Next question.';
    }

    var grid = $('answer-grid');
    if (!s.question) grid.innerHTML = '';
    else {
      if (grid.dataset.qid !== s.question.id) {
        grid.dataset.qid = s.question.id;
        grid.innerHTML = '';
        for (var i = 0; i < 4; i++) {
          var b = document.createElement('button');
          b.className = 'ans';
          b.dataset.index = i;
          b.innerHTML = '<b>' + LETTERS[i] + '</b><span></span>';
          b.addEventListener('click', onAnswerTap);
          grid.appendChild(b);
        }
      }
      Array.prototype.forEach.call(grid.children, function (node, idx) {
        node.querySelector('span').textContent = s.question.answers[idx];
        node.className = 'ans';
        if (idx === s.question.correct) node.classList.add('right-answer');
        if (s.eliminated.indexOf(idx) >= 0) node.classList.add('gone');
        if (s.selected === idx && !s.revealed) node.classList.add('chosen');
        if (s.revealed) {
          if (idx === s.question.correct) node.classList.add('reveal-correct');
          else if (idx === s.selected) node.classList.add('reveal-wrong');
        }
      });
    }

    $('preview-hint').textContent = hintFor(s);
    $('btn-lock').disabled = s.selected === null || s.locked || s.revealed;
    $('btn-reveal').disabled = s.selected === null || s.revealed;

    // From the intro screen this button opens the show; after a correct
    // answer it climbs the ladder.
    var opening = s.phase === 'intro' || (s.phase !== 'idle' && !s.question);
    $('btn-next').textContent = opening ? 'Start first question' : 'Next question \u2192';
    $('btn-next').disabled = opening
      ? false
      : !(s.outcome === 'correct') || s.level >= cfg.ladder.length;
    $('btn-walk').disabled = s.phase === 'idle' || s.revealed;

    // lifelines
    var lg = $('lifeline-grid');
    var key = cfg.lifelines.map(function (l) { return l.id; }).join(',');
    if (lg.dataset.key !== key) {
      lg.dataset.key = key;
      lg.innerHTML = '';
      cfg.lifelines.forEach(function (def) {
        var b = document.createElement('button');
        b.className = 'll';
        b.dataset.id = def.id;
        b.innerHTML = escapeHtml(def.label) + '<small></small>';
        b.addEventListener('click', function () { useLifeline(def.id); });
        lg.appendChild(b);
      });
    }
    Array.prototype.forEach.call(lg.children, function (node) {
      var ll = s.lifelines[node.dataset.id];
      node.classList.toggle('used', !!(ll && ll.used));
      node.classList.toggle('off', !(ll && ll.enabled));
      node.querySelector('small').textContent = !ll ? '' : (!ll.enabled ? 'off' : ll.used ? 'used' : 'ready');
    });

    // timer
    $('timer-readout').textContent = s.timer.remaining + 's' + (s.timer.running ? ' ▶' : '');
    $('toggle-timer').checked = s.timer.enabled;
    if (document.activeElement !== $('timer-secs')) {
      $('timer-secs').value = s.timer.duration;
      $('timer-secs-label').textContent = s.timer.duration;
    }

    // player + level
    if (document.activeElement !== $('player-input')) $('player-input').value = s.player.name;

    var sel = $('level-select');
    if (sel.childElementCount !== cfg.ladder.length) {
      sel.innerHTML = '';
      cfg.ladder.forEach(function (row) {
        var o = document.createElement('option');
        o.value = row.level;
        o.textContent = 'Level ' + row.level + ' — ' + rungText(row, cfg.currency) + (row.safe ? '  ◆' : '');
        sel.appendChild(o);
      });
    }
    sel.value = s.level;
  }

  function hintFor(s) {
    if (s.phase === 'idle') return 'Enter the contestant name below, then Start show.';
    if (s.phase === 'intro') return 'The stage is on the welcome screen. Press Next question to begin.';
    if (s.revealed && s.outcome === 'correct') return 'Correct — press Next question.';
    if (s.revealed && s.outcome === 'wrong') return 'Wrong answer. Reset to play again.';
    if (s.locked) return 'Locked in. Build the tension, then Reveal answer.';
    if (s.selected !== null) return 'Selected ' + LETTERS[s.selected] + '. Press Lock it in.';
    return 'Tap the answer the contestant chose (✓ marks the right one — only you see it).';
  }

  function onAnswerTap() {
    act({ type: 'answer/select', index: Number(this.dataset.index) });
  }

  function useLifeline(id) {
    var ll = snap.state.lifelines[id];
    if (ll && ll.used && !confirm('That lifeline is already used. Use it again anyway?')) return;
    if (ll && ll.used) act({ type: 'lifeline/reset', id: id });

    if (id === 'phone') {
      var friend = prompt('Friend\'s name (blank = default)', snap.settings.phoneFriend.defaultName) || '';
      var text = prompt('What does the friend say? Leave blank to auto-generate a hint.', '') || '';
      act({ type: 'lifeline/use', id: id, friend: friend.trim(), text: text.trim() });
    } else {
      act({ type: 'lifeline/use', id: id });
    }
  }

  function act(action) {
    return Bus.send(action).catch(function (err) { toast(err.message, 'err'); });
  }

  /* ------------------------------------------------------------ questions */

  function wireQuestions() {
    $('q-search').addEventListener('input', renderBank);
    $('q-filter-diff').addEventListener('change', renderBank);
    $('q-filter-cat').addEventListener('change', renderBank);
    $('btn-add-q').addEventListener('click', function () { openEditor(null); });
    $('q-cancel').addEventListener('click', closeEditor);
    $('q-save').addEventListener('click', saveQuestion);
    $('qf-delete').addEventListener('click', deleteQuestion);
    $('btn-export').addEventListener('click', exportBank);
    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', importBank);

    var wrap = $('qf-answers');
    for (var i = 0; i < 4; i++) {
      var row = document.createElement('div');
      row.className = 'qf-answer';
      row.innerHTML = '<button type="button" data-i="' + i + '">' + LETTERS[i] + '</button>' +
                      '<input type="text" maxlength="160" placeholder="Answer ' + LETTERS[i] + '">';
      wrap.appendChild(row);
    }
    wrap.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-i]');
      if (!btn) return;
      wrap.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
    });
  }

  function loadBank() {
    Bus.get('/api/questions').then(function (data) {
      bank = data.questions || [];
      fillCategories();
      renderBank();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function fillCategories() {
    var cats = {};
    bank.forEach(function (q) { cats[q.category] = true; });
    var names = Object.keys(cats).sort();
    var sel = $('q-filter-cat');
    var current = sel.value;
    sel.innerHTML = '<option value="">All categories</option>';
    names.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    sel.value = current;

    var list = $('cat-list');
    list.innerHTML = '';
    names.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      list.appendChild(o);
    });
  }

  function renderBank() {
    var term = $('q-search').value.trim().toLowerCase();
    var diff = $('q-filter-diff').value;
    var cat = $('q-filter-cat').value;

    var rows = bank.filter(function (q) {
      if (diff && String(q.difficulty) !== diff) return false;
      if (cat && q.category !== cat) return false;
      if (!term) return true;
      return (q.text + ' ' + q.answers.join(' ') + ' ' + q.category).toLowerCase().indexOf(term) >= 0;
    });

    $('q-count').textContent = rows.length + ' of ' + bank.length + ' questions';

    var list = $('q-list');
    list.innerHTML = '';
    rows.forEach(function (q) {
      var item = document.createElement('div');
      item.className = 'q-item';
      item.innerHTML =
        '<div class="q-top">' +
          '<span class="q-badge d' + q.difficulty + '">' + diffLabel(q.difficulty) + '</span>' +
          '<span class="q-badge">' + escapeHtml(q.category) + '</span>' +
        '</div>' +
        '<p class="q-text">' + escapeHtml(q.text) + '</p>' +
        '<div class="q-ans">Answer: <b>' + LETTERS[q.correct] + '. ' + escapeHtml(q.answers[q.correct]) + '</b></div>' +
        '<div class="q-actions">' +
          '<button class="btn small" data-act="edit">Edit</button>' +
          '<button class="btn small primary" data-act="play">Put on stage</button>' +
        '</div>';
      item.querySelector('[data-act="edit"]').addEventListener('click', function () { openEditor(q); });
      item.querySelector('[data-act="play"]').addEventListener('click', function () {
        act({ type: 'question/load', questionId: q.id }).then(function () {
          toast('Sent to the stage display', 'ok');
        });
      });
      list.appendChild(item);
    });

    if (!rows.length) {
      list.innerHTML = '<div class="card"><p class="hint">No questions match. ' +
        'Try clearing the filters, or tap <b>+ New</b> to write one.</p></div>';
    }
  }

  function openEditor(q) {
    editing = q;
    $('q-sheet').hidden = false;
    $('q-sheet-title').textContent = q ? 'Edit question' : 'New question';
    $('qf-delete').style.display = q ? '' : 'none';
    $('qf-text').value = q ? q.text : '';
    $('qf-category').value = q ? q.category : 'General';
    $('qf-difficulty').value = q ? q.difficulty : 1;
    var rows = $('qf-answers').querySelectorAll('.qf-answer');
    rows.forEach(function (row, i) {
      row.querySelector('input').value = q ? q.answers[i] : '';
      row.querySelector('button').classList.toggle('on', q ? q.correct === i : i === 0);
    });
  }

  function closeEditor() {
    $('q-sheet').hidden = true;
    editing = null;
  }

  function saveQuestion() {
    var rows = $('qf-answers').querySelectorAll('.qf-answer');
    var answers = [], correct = 0;
    rows.forEach(function (row, i) {
      answers.push(row.querySelector('input').value.trim());
      if (row.querySelector('button').classList.contains('on')) correct = i;
    });
    var payload = {
      text: $('qf-text').value.trim(),
      answers: answers,
      correct: correct,
      category: $('qf-category').value.trim() || 'General',
      difficulty: Number($('qf-difficulty').value)
    };
    if (!payload.text) return toast('Write the question first', 'err');
    if (answers.some(function (a) { return !a; })) return toast('Fill in all four answers', 'err');

    var req = editing
      ? Bus.put('/api/questions/' + encodeURIComponent(editing.id), payload)
      : Bus.post('/api/questions', payload);

    req.then(function () {
      closeEditor();
      toast('Saved', 'ok');
      loadBank();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function deleteQuestion() {
    if (!editing) return;
    if (!confirm('Delete this question for good?')) return;
    Bus.del('/api/questions/' + encodeURIComponent(editing.id)).then(function () {
      closeEditor();
      toast('Deleted', 'ok');
      loadBank();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function exportBank() {
    Bus.get('/api/export').then(function (data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'millionaire-show-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function importBank(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(reader.result); }
      catch (e) { return toast('That file is not valid JSON', 'err'); }

      var append = confirm('OK = add these to the current bank.\nCancel = replace the bank entirely.');
      var body = Array.isArray(parsed) ? { questions: parsed } : parsed;
      body.mode = append ? 'append' : 'replace';

      Bus.post('/api/import', body).then(function (res) {
        toast('Imported — ' + res.questions + ' questions now in the bank', 'ok');
        loadBank();
      }).catch(function (err) { toast(err.message, 'err'); });
    };
    reader.readAsText(file);
    ev.target.value = '';
  }

  /* ------------------------------------------------------------ setup */

  function wireSetup() {
    $('btn-save-settings').addEventListener('click', saveSettings);
    $('btn-add-rung').addEventListener('click', function () {
      var last = draft.ladder[draft.ladder.length - 1];
      draft.ladder.push({
        level: draft.ladder.length + 1,
        value: last && last.value ? last.value * 2 : 100,
        safe: false
      });
      renderLadderEditor();
    });
    $('btn-add-lifeline').addEventListener('click', function () {
      draft.lifelines.push({
        id: 'custom' + (draft.lifelines.length + 1),
        label: 'NEW LIFELINE', icon: 'custom', enabled: true, auto: false
      });
      renderLifelineEditor();
    });
    $('btn-ladder-preset-classic').addEventListener('click', function () {
      draft.ladder = [100, 200, 300, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 125000, 250000, 500000, 1000000]
        .map(function (v, i) { return { level: i + 1, value: v, label: null, safe: i === 4 || i === 9 }; });
      renderLadderEditor();
    });
    $('btn-ladder-preset-short').addEventListener('click', function () {
      draft.ladder = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]
        .map(function (v, i) { return { level: i + 1, value: v, label: null, safe: i === 3 || i === 6 }; });
      renderLadderEditor();
    });
    $('disp-volume').addEventListener('input', function () { draft.audio.masterVolume = Number(this.value) / 100; });
  }

  function fillSetup() {
    if (!draft) return;
    $('set-title').value = draft.showTitle;
    $('set-subtitle').value = draft.showSubtitle;
    $('set-currency').value = draft.currency;
    $('disp-ladder').checked = draft.display.showLadder;
    $('disp-timer').checked = draft.display.showTimer;
    $('disp-lifelines').checked = draft.display.showLifelines;
    $('disp-dots').checked = draft.display.showProgressDots;
    $('disp-audio').checked = draft.audio.enabled;
    $('disp-volume').value = Math.round(draft.audio.masterVolume * 100);
    $('set-friend').value = draft.phoneFriend.defaultName;
    $('set-friend-secs').value = draft.phoneFriend.duration;
    $('set-pin').value = (draft.security && draft.security.adminPin) || '';
    renderLadderEditor();
    renderLifelineEditor();
  }

  function renderLadderEditor() {
    var wrap = $('ladder-editor');
    wrap.innerHTML = '';
    draft.ladder.forEach(function (row, i) {
      var div = document.createElement('div');
      div.className = 'rung';
      div.innerHTML =
        '<span class="lvl">' + (i + 1) + '</span>' +
        '<input type="text" inputmode="text" maxlength="40" ' +
          'placeholder="Amount or prize" value="' + escapeAttr(rungText(row, draft.currency)) + '">' +
        '<button class="safe-btn' + (row.safe ? ' on' : '') + '" title="Guaranteed level">◆</button>' +
        '<button class="del-btn" title="Remove">✕</button>';
      div.querySelector('input').addEventListener('change', function () {
        applyRungInput(draft.ladder[i], this.value);
        // Echo back what was understood, so "1500" tidies up to "$1,500"
        // and a prize name stays exactly as typed.
        this.value = rungText(draft.ladder[i], draft.currency);
      });
      div.querySelector('.safe-btn').addEventListener('click', function () {
        draft.ladder[i].safe = !draft.ladder[i].safe;
        this.classList.toggle('on', draft.ladder[i].safe);
      });
      div.querySelector('.del-btn').addEventListener('click', function () {
        if (draft.ladder.length <= 1) return toast('Keep at least one level', 'err');
        draft.ladder.splice(i, 1);
        renderLadderEditor();
      });
      wrap.appendChild(div);
    });
  }

  function renderLifelineEditor() {
    var wrap = $('lifeline-editor');
    wrap.innerHTML = '';
    draft.lifelines.forEach(function (ll, i) {
      var div = document.createElement('div');
      div.className = 'll-edit';
      div.innerHTML =
        '<input type="text" value="' + escapeAttr(ll.label) + '" maxlength="30">' +
        '<input type="checkbox"' + (ll.enabled ? ' checked' : '') + ' title="Enabled">' +
        '<button class="del-btn" title="Remove">✕</button>';
      div.querySelector('input[type="text"]').addEventListener('change', function () {
        draft.lifelines[i].label = this.value;
      });
      div.querySelector('input[type="checkbox"]').addEventListener('change', function () {
        draft.lifelines[i].enabled = this.checked;
      });
      div.querySelector('.del-btn').addEventListener('click', function () {
        draft.lifelines.splice(i, 1);
        renderLifelineEditor();
      });
      wrap.appendChild(div);
    });
  }

  function saveSettings() {
    draft.showTitle = $('set-title').value;
    draft.showSubtitle = $('set-subtitle').value;
    draft.currency = $('set-currency').value || '$';
    draft.display.showLadder = $('disp-ladder').checked;
    draft.display.showTimer = $('disp-timer').checked;
    draft.display.showLifelines = $('disp-lifelines').checked;
    draft.display.showProgressDots = $('disp-dots').checked;
    draft.audio.enabled = $('disp-audio').checked;
    draft.audio.masterVolume = Number($('disp-volume').value) / 100;
    draft.phoneFriend.defaultName = $('set-friend').value || 'Sam';
    draft.phoneFriend.duration = Number($('set-friend-secs').value) || 30;

    var newPin = $('set-pin').value.trim();
    draft.security = draft.security || {};
    draft.security.adminPin = newPin;

    Bus.put('/api/settings', draft).then(function (res) {
      draft = JSON.parse(JSON.stringify(res.settings));
      // Keep controlling the show without being locked out by the new PIN.
      Bus.setPin(newPin);
      $('save-note').textContent = 'Saved at ' + new Date().toLocaleTimeString();
      toast('Settings saved', 'ok');
      fillSetup();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  /* ------------------------------------------------------------ screens */

  function wireScreens() {
    $('btn-forget-pin').addEventListener('click', function () {
      Bus.setPin('');
      toast('PIN forgotten on this device', 'ok');
    });
  }

  function fillScreens() {
    Bus.get('/api/info').then(function (info) {
      var list = $('addr-list');
      list.innerHTML = '';
      var hosted = info.mode === 'vercel';

      var blurb = document.querySelector('#view-screens .card:nth-child(2) .hint');
      if (blurb) {
        blurb.textContent = hosted
          ? (info.readOnly
              ? 'This is the hosted copy. It is in demo mode: connect a KV store in Vercel to drive the show from a second device and to save question edits.'
              : 'This is the hosted copy — share these links with anyone, anywhere.')
          : 'Everything runs on this machine — no internet required. Any phone or tablet on the same Wi-Fi (or a phone hotspot) can open these addresses:';
      }

      var urls = [];
      if (!hosted) {
        (info.addresses || []).forEach(function (a) {
          urls.push('http://' + a.address + ':' + info.port);
        });
      }
      if (!urls.length) urls.push(location.origin);

      urls.forEach(function (base) {
        ['/admin', '/display'].forEach(function (path) {
          var row = document.createElement('div');
          row.className = 'addr';
          row.innerHTML = '<span>' + (path === '/admin' ? 'Remote' : 'Display') + '</span>' +
                          '<code>' + base + path + '</code>';
          row.addEventListener('click', function () { copy(base + path); });
          list.appendChild(row);
        });
      });

      var qrTarget = urls[0] + '/admin';
      $('qr-box').innerHTML = '';
      var holder = document.createElement('div');
      $('qr-box').appendChild(holder);
      QR.render(holder, qrTarget, 6);
      var cap = document.createElement('div');
      cap.className = 'qr-cap';
      cap.textContent = 'Scan to open the remote: ' + qrTarget;
      $('qr-box').appendChild(cap);

      var kv = $('status-kv');
      kv.innerHTML = '';
      addKv(kv, 'Questions in bank', snap ? snap.stats.questions : '–');
      if (!hosted) addKv(kv, 'Screens connected', snap ? snap.stats.clients : '–');
      addKv(kv, 'PIN protection', info.pinRequired ? 'On' : 'Off');
      addKv(kv, 'Running on', hosted ? 'Vercel (hosted)' : 'This machine (offline capable)');
      addKv(kv, 'Live updates', info.transport === 'poll' ? 'Polling' : 'Push (SSE)');
      if (hosted) addKv(kv, 'Storage', storageLabel(info));
      if (!hosted) addKv(kv, 'Server port', info.port);
      addKv(kv, 'Version', info.version);
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  /** Names the store behind a hosted deployment, or says there isn't one. */
  function storageLabel(info) {
    if (info.storage !== 'kv') return 'Ephemeral — demo only';
    if (info.driver === 'supabase') return 'Supabase — full control';
    if (info.driver === 'upstash') return 'Upstash KV — full control';
    return 'Connected — full control';
  }

  function addKv(dl, key, value) {
    var row = document.createElement('div');
    row.innerHTML = '<dt>' + key + '</dt><dd>' + escapeHtml(String(value)) + '</dd>';
    dl.appendChild(row);
  }

  function copy(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied', 'ok'); },
        function () { toast(text); });
    } else {
      toast(text);
    }
  }

  /* ------------------------------------------------------------ utils */

  var toastTimer = null;
  function toast(message, kind) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2600);
  }

  function money(value, currency) {
    return (currency || '$') + Number(value || 0).toLocaleString('en-US');
  }

  /** A rung shows its prize name when it has one, otherwise the amount. */
  function rungText(row, currency) {
    return row.label ? row.label : money(row.value, currency);
  }

  /**
   * The rung field takes either an amount or a prize name — "5000" and
   * "$5,000" are money, "A new car" is a prize. The number is kept either way
   * so the safety-net maths and the rung order still work.
   */
  function applyRungInput(row, raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) { row.value = 0; row.label = null; return; }

    var stripped = text.replace(/[\s,]/g, '').replace(/^[^\d.-]+/, '');
    if (stripped && /^-?\d+(\.\d+)?$/.test(stripped)) {
      row.value = Math.max(0, Math.round(Number(stripped)));
      row.label = null;
    } else {
      row.label = text.slice(0, 40);
    }
  }

  function diffLabel(d) {
    return d === 3 ? 'Hard' : d === 2 ? 'Medium' : 'Easy';
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeAttr(str) { return escapeHtml(str); }
})();
