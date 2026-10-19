/* Word database with per-position letter bitsets (as in Crosshare's worddb).
 *
 *   words[len]  = [[word, score], ...] sorted best-first
 *   bitmaps     = for each (len, pos, letter) a Uint32Array bitset over words[len];
 *                 bit i is set when words[len][i] has that letter at that position
 *
 * Pattern matching is then an AND of bitsets: no scan of the word list.
 * Loaded by both the page and the autofill worker (importScripts).
 */
(function (root) {
  'use strict';
  var A = 65;

  // Score (0-60 in our lists, 0 = banned) -> cost, log scale like Crosshare's 0..3 -> 10, 1, 0.1, 0.01.
  function costOf(score) {
    var s = score > 60 ? 60 : score;
    return Math.pow(10, 1 - 3 * s / 60);
  }

  function WordDB(text) {
    this.words = [];            // len -> [[word, score]]
    this.bm = [];               // len -> Uint32Array[pos * 26 + letter]
    this.nwords = [];           // len -> count
    this.index = new Map();     // word -> score
    this.total = 0;
    this.parse(text);
  }

  WordDB.prototype.parse = function (text) {
    var best = new Map(), lines = text.split('\n'), i, line, semi, w, sc, j, ch, clean;
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      if (!line || line.charCodeAt(0) === 35) continue;        // blank / '#'
      semi = line.lastIndexOf(';');
      sc = 90;
      if (semi >= 0) { sc = parseInt(line.slice(semi + 1), 10); w = line.slice(0, semi); if (isNaN(sc)) { sc = 90; w = line; } }
      else w = line;
      clean = '';
      for (j = 0; j < w.length; j++) { ch = w.charCodeAt(j); if (ch >= 97 && ch <= 122) ch -= 32; if (ch >= A && ch <= A + 25) clean += String.fromCharCode(ch); }
      if (clean.length < 2 || clean.length > 25) continue;
      if (sc <= 0) { best.set(clean, 0); continue; }            // ban
      if (best.get(clean) === 0) continue;
      if (!best.has(clean) || sc > best.get(clean)) best.set(clean, sc);
    }
    var byLen = [];
    best.forEach(function (s, w) { if (s > 0) { (byLen[w.length] = byLen[w.length] || []).push([w, s]); this.index.set(w, s); } }, this);
    for (var L = 0; L < byLen.length; L++) {
      var ws = byLen[L];
      if (!ws) continue;
      ws.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
      var n = ws.length, nb = (n + 31) >>> 5, maps = new Array(L * 26);
      for (var k = 0; k < maps.length; k++) maps[k] = new Uint32Array(nb);
      for (var x = 0; x < n; x++) {
        var wd = ws[x][0], word = x >>> 5, bit = 1 << (x & 31);
        for (var p = 0; p < L; p++) maps[p * 26 + wd.charCodeAt(p) - A][word] |= bit;
      }
      this.words[L] = ws; this.bm[L] = maps; this.nwords[L] = n; this.total += n;
    }
  };

  WordDB.prototype.has = function (len) { return !!this.words[len]; };

  // Bitmap of words matching pattern ("A?C"; '?', '.', ' ' are blanks). null if no words of that length.
  WordDB.prototype.matchingBitmap = function (pat) {
    var L = pat.length, n = this.nwords[L];
    if (!n) return null;
    var bm = new Uint32Array((n + 31) >>> 5), i, ch, maps = this.bm[L];
    bm.fill(0xffffffff);
    if (n & 31) bm[bm.length - 1] = (1 << (n & 31)) - 1;
    for (i = 0; i < L; i++) {
      ch = pat.charCodeAt(i);
      if (ch < A || ch > A + 25) continue;
      var m = maps[i * 26 + ch - A];
      for (var k = 0; k < bm.length; k++) bm[k] &= m[k];
    }
    return bm;
  };

  // A new bitmap with one more letter ANDed in (a crossing entry gained a letter).
  WordDB.prototype.updateBitmap = function (len, bm, pos, letter) {
    var m = this.bm[len][pos * 26 + letter - A], out = new Uint32Array(bm.length);
    for (var k = 0; k < bm.length; k++) out[k] = bm[k] & m[k];
    return out;
  };

  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  WordDB.prototype.numMatches = function (bm) {
    if (!bm) return 0;
    var c = 0;
    for (var k = 0; k < bm.length; k++) if (bm[k]) c += popcount(bm[k]);
    return c;
  };
  WordDB.prototype.anyMatch = function (bm) {
    if (!bm) return false;
    for (var k = 0; k < bm.length; k++) if (bm[k]) return true;
    return false;
  };

  // [[word, score]] for the set bits (best-first), up to limit.
  WordDB.prototype.matchingWords = function (len, bm, limit) {
    var out = [], ws = this.words[len];
    if (!bm || !ws) return out;
    for (var k = 0; k < bm.length; k++) {
      var v = bm[k];
      while (v) {
        var low = v & -v, i = (k << 5) + (31 - Math.clz32(low));
        out.push(ws[i]);
        if (limit && out.length >= limit) return out;
        v ^= low;
      }
    }
    return out;
  };

  WordDB.costOf = costOf;
  root.WordDB = WordDB;
})(typeof self !== 'undefined' ? self : this);
