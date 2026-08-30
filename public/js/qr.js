/* Minimal QR encoder (byte mode, EC level L, versions 1-10).
 *
 * Written out in full rather than pulled from a CDN, because the whole point
 * of this project is that it works with no internet: the host needs to scan
 * the remote's LAN address off the stage laptop while offline. */
(function (global) {
  'use strict';

  /* ---- GF(256) ---- */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function generatorPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        // poly * (x + alpha^d), coefficients ordered highest degree first
        next[i] ^= poly[i];
        next[i + 1] ^= gmul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  function ecBytes(data, ecLen) {
    var gen = generatorPoly(ecLen);
    var rem = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (var j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ---- version tables (EC level L) ---- */
  // [ecPerBlock, blocksG1, dataG1, blocksG2, dataG2]
  var VERSIONS = [
    null,
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]
  ];
  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];
  var FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
  var VERSION_BITS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

  function dataCapacity(v) {
    var t = VERSIONS[v];
    return t[1] * t[2] + t[3] * t[4];
  }

  function utf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        i++;
        var cp = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }

  /* ---- encode ---- */
  function encode(text) {
    var bytes = utf8(text);
    var version = 0;
    for (var v = 1; v <= 10; v++) {
      var countBits = v < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Text too long for this QR encoder.');

    var bits = [];
    function push(value, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }
    push(0b0100, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });

    var capacityBits = dataCapacity(version) * 8;
    for (var t = 0; t < 4 && bits.length < capacityBits; t++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
      codewords.push(byte);
    }
    var pads = [0xec, 0x11];
    var p = 0;
    while (codewords.length < dataCapacity(version)) codewords.push(pads[p++ % 2]);

    // split into blocks, add EC, interleave
    var spec = VERSIONS[version];
    var blocks = [];
    var offset = 0;
    for (var g = 0; g < 2; g++) {
      var count = g === 0 ? spec[1] : spec[3];
      var size = g === 0 ? spec[2] : spec[4];
      for (var n = 0; n < count; n++) {
        var chunk = codewords.slice(offset, offset + size);
        offset += size;
        blocks.push({ data: chunk, ec: ecBytes(chunk, spec[0]) });
      }
    }

    var final = [];
    var maxData = Math.max.apply(null, blocks.map(function (bl) { return bl.data.length; }));
    for (var d = 0; d < maxData; d++) {
      blocks.forEach(function (bl) { if (d < bl.data.length) final.push(bl.data[d]); });
    }
    for (var e = 0; e < spec[0]; e++) {
      blocks.forEach(function (bl) { final.push(bl.ec[e]); });
    }

    return { version: version, codewords: final };
  }

  /* ---- matrix ---- */
  function build(text) {
    var enc = encode(text);
    var version = enc.version;
    var size = version * 4 + 17;
    var m = [], reserved = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }

    function setFn(r, c, value) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = value;
      reserved[r][c] = true;
    }

    function finder(row, col) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
          var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          setFn(row + r, col + c, (inRing || inCore) ? 1 : 0);
        }
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (var i = 8; i < size - 8; i++) {
      setFn(6, i, i % 2 === 0 ? 1 : 0);
      setFn(i, 6, i % 2 === 0 ? 1 : 0);
    }

    var centers = ALIGN[version];
    centers.forEach(function (cr) {
      centers.forEach(function (cc) {
        // Only the three centres that land on a finder pattern are skipped.
        // A centre sitting on a timing line is still drawn.
        var onFinder = (cr <= 8 && cc <= 8) ||
                       (cr <= 8 && cc >= size - 9) ||
                       (cr >= size - 9 && cc <= 8);
        if (onFinder) return;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            setFn(cr + r, cc + c, on ? 1 : 0);
          }
        }
      });
    });

    setFn(size - 8, 8, 1); // dark module

    // reserve format areas
    for (var f = 0; f < 9; f++) {
      if (f !== 6) { setFn(8, f, 0); setFn(f, 8, 0); }
    }
    for (var k = 0; k < 8; k++) { setFn(8, size - 1 - k, 0); setFn(size - 1 - k, 8, 0); }

    if (version >= 7) {
      var vbits = VERSION_BITS[version];
      for (var b = 0; b < 18; b++) {
        var bit = (vbits >> b) & 1;
        setFn(Math.floor(b / 3), size - 11 + (b % 3), bit);
        setFn(size - 11 + (b % 3), Math.floor(b / 3), bit);
      }
    }

    // data placement, zigzag from bottom-right
    var dataBits = [];
    enc.codewords.forEach(function (cw) {
      for (var b = 7; b >= 0; b--) dataBits.push((cw >> b) & 1);
    });

    var idx = 0, up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var step = 0; step < size; step++) {
        var row = up ? size - 1 - step : step;
        for (var pair = 0; pair < 2; pair++) {
          var cc2 = col - pair;
          if (reserved[row][cc2]) continue;
          m[row][cc2] = idx < dataBits.length ? dataBits[idx] : 0;
          idx++;
        }
      }
      up = !up;
    }

    // pick the mask with the lowest penalty
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = applyMask(m, reserved, size, mask);
      writeFormat(candidate, size, mask);
      var score = penalty(candidate, size);
      if (!best || score < best.score) best = { score: score, matrix: candidate };
    }

    return { size: size, modules: best.matrix, version: version };
  }

  function maskFn(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }

  function applyMask(m, reserved, size, mask) {
    var out = m.map(function (row) { return row.slice(); });
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!reserved[r][c] && maskFn(mask, r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  function writeFormat(m, size, mask) {
    var bits = FORMAT_L[mask];
    for (var i = 0; i < 15; i++) {
      // The 15 format bits are laid out most-significant first.
      var bit = (bits >> (14 - i)) & 1;

      // Copy 1, wrapped around the top-left finder.
      if (i < 6) m[8][i] = bit;
      else if (i === 6) m[8][7] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[7][8] = bit;
      else m[14 - i][8] = bit;

      // Copy 2: up the bottom-left edge, then along the top-right edge.
      // Note (size-8, 8) is the permanent dark module, not a format bit.
      if (i <= 6) m[size - 1 - i][8] = bit;
      else m[8][size - 15 + i] = bit;
    }
    m[size - 8][8] = 1;
  }

  function penalty(m, size) {
    var score = 0, r, c, run, i;
    // rule 1: runs of 5+
    for (r = 0; r < size; r++) {
      run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    // rule 2: 2x2 blocks
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    // rule 3: finder-like patterns
    var pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    function matches(get, len) {
      var hits = 0;
      for (var s = 0; s + 11 <= len; s++) {
        var ok = true, okRev = true;
        for (var k = 0; k < 11; k++) {
          if (get(s + k) !== pat[k]) ok = false;
          if (get(s + k) !== pat[10 - k]) okRev = false;
        }
        if (ok || okRev) hits++;
      }
      return hits;
    }
    for (r = 0; r < size; r++) score += 40 * matches(function (k) { return m[r][k]; }, size);
    for (c = 0; c < size; c++) score += 40 * matches(function (k) { return m[k][c]; }, size);
    // rule 4: balance of dark modules
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /** Renders the code into `container` as a crisp, scalable SVG. */
  function render(container, text, pixelSize) {
    container.innerHTML = '';
    var qr;
    try { qr = build(text); } catch (err) {
      container.textContent = err.message;
      return null;
    }
    var quiet = 4;
    var total = qr.size + quiet * 2;
    var scale = pixelSize || 6;

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
    svg.setAttribute('width', total * scale);
    svg.setAttribute('height', total * scale);
    svg.setAttribute('shape-rendering', 'crispEdges');

    var bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('width', total); bg.setAttribute('height', total); bg.setAttribute('fill', '#fff');
    svg.appendChild(bg);

    var d = '';
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      }
    }
    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.appendChild(path);
    container.appendChild(svg);
    return qr;
  }

  global.QR = { build: build, render: render };
})(window);
