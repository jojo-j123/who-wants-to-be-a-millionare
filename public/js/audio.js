/* Show music and stings, generated live with the Web Audio API.
 *
 * Deliberately synthesised rather than shipped as .mp3 files: nothing to
 * download, nothing to license, and the repo stays tiny — which is what makes
 * the whole show run from a folder on a laptop with no internet. */
(function (global) {
  'use strict';

  var ctx = null;
  var master = null;
  var enabled = true;
  var volume = 0.7;
  var bedNodes = [];

  function ready() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(opts) {
    if (!enabled) return;
    var c = ready();
    if (!c) return;
    var t0 = c.currentTime + (opts.delay || 0);
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), t0 + (opts.dur || 0.3));

    var peak = (opts.gain == null ? 0.25 : opts.gain);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + (opts.dur || 0.3));

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + (opts.dur || 0.3) + 0.05);
  }

  function chord(freqs, dur, type, gain, spread) {
    freqs.forEach(function (f, i) {
      tone({ freq: f, dur: dur, type: type || 'triangle', gain: gain || 0.16, delay: (spread || 0) * i });
    });
  }

  function noise(dur, gainValue, filterFreq) {
    if (!enabled) return;
    var c = ready();
    if (!c) return;
    var frames = Math.floor(c.sampleRate * dur);
    var buffer = c.createBuffer(1, frames, c.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    var src = c.createBufferSource();
    src.buffer = buffer;
    var filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq || 1200;
    var g = c.createGain();
    g.gain.value = gainValue == null ? 0.2 : gainValue;
    src.connect(filter); filter.connect(g); g.connect(master);
    src.start();
  }

  /** Low pulsing "thinking" bed that runs while a question is live. */
  function startBed(level) {
    stopBed();
    if (!enabled) return;
    var c = ready();
    if (!c) return;
    var tempo = 0.85 - Math.min(0.45, (level || 1) * 0.03);
    var root = 55 * Math.pow(2, Math.min(2, Math.floor((level || 1) / 6)) / 12 + 0);
    var timer = setInterval(function () {
      tone({ freq: root, dur: tempo * 0.8, type: 'sine', gain: 0.16 });
      tone({ freq: root * 1.5, dur: tempo * 0.5, type: 'sine', gain: 0.05, delay: tempo * 0.45 });
    }, tempo * 1000);
    bedNodes.push({ stop: function () { clearInterval(timer); } });
  }

  function stopBed() {
    bedNodes.forEach(function (n) { n.stop(); });
    bedNodes = [];
  }

  var Sfx = {
    setEnabled: function (v) { enabled = !!v; if (!enabled) stopBed(); },
    isEnabled: function () { return enabled; },
    setVolume: function (v) { volume = Math.max(0, Math.min(1, v)); if (master) master.gain.value = volume; },
    unlock: function () { ready(); },

    questionIn: function () { chord([330, 415, 494], 0.5, 'triangle', 0.14, 0.06); },
    answersIn: function () { tone({ freq: 220, freqTo: 660, dur: 0.45, type: 'sawtooth', gain: 0.1 }); },
    select: function () { tone({ freq: 520, dur: 0.12, type: 'square', gain: 0.12 }); },
    lock: function () {
      tone({ freq: 110, freqTo: 55, dur: 0.9, type: 'sawtooth', gain: 0.2 });
      chord([146, 185], 1.1, 'triangle', 0.1, 0);
      stopBed();
    },
    correct: function (level) {
      stopBed();
      var base = 392;
      [0, 4, 7, 12].forEach(function (semi, i) {
        tone({ freq: base * Math.pow(2, semi / 12), dur: 0.7, type: 'triangle', gain: 0.2, delay: i * 0.09 });
      });
      if (level && level >= 10) chord([784, 988, 1175], 1.2, 'sine', 0.12, 0.12);
    },
    wrong: function () {
      stopBed();
      tone({ freq: 180, freqTo: 60, dur: 1.3, type: 'sawtooth', gain: 0.26 });
      tone({ freq: 92, freqTo: 40, dur: 1.5, type: 'square', gain: 0.16, delay: 0.05 });
    },
    timeout: function () {
      stopBed();
      tone({ freq: 440, dur: 0.18, type: 'square', gain: 0.2 });
      tone({ freq: 330, dur: 0.35, type: 'square', gain: 0.2, delay: 0.2 });
    },
    tick: function () { tone({ freq: 1400, dur: 0.05, type: 'square', gain: 0.07 }); },
    lifeline: function () {
      tone({ freq: 660, freqTo: 1320, dur: 0.35, type: 'triangle', gain: 0.16 });
      noise(0.3, 0.08, 2400);
    },
    audienceReveal: function () { noise(0.9, 0.14, 900); chord([294, 370, 440], 0.6, 'triangle', 0.1, 0.05); },
    /** The curtain coming off a mystery prize: a rising sparkle, then a chime. */
    prizeReveal: function () {
      tone({ freq: 440, freqTo: 1320, dur: 0.5, type: 'triangle', gain: 0.16 });
      noise(0.5, 0.07, 3200);
      chord([880, 1109, 1319], 1.1, 'sine', 0.13, 0.28);
    },
    phoneRing: function () {
      [0, 0.5].forEach(function (d) {
        tone({ freq: 480, dur: 0.35, type: 'sine', gain: 0.16, delay: d });
        tone({ freq: 620, dur: 0.35, type: 'sine', gain: 0.12, delay: d });
      });
    },
    win: function () {
      stopBed();
      var notes = [523, 587, 659, 784, 880, 1047];
      notes.forEach(function (f, i) { tone({ freq: f, dur: 0.5, type: 'triangle', gain: 0.22, delay: i * 0.13 }); });
      chord([523, 659, 784, 1047], 2.2, 'sine', 0.14, 0);
    },
    walkaway: function () {
      stopBed();
      chord([392, 466, 587], 1.1, 'triangle', 0.14, 0.1);
    },
    startBed: startBed,
    stopBed: stopBed
  };

  global.Sfx = Sfx;
})(window);
