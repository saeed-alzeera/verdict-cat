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

  // Crosshare worddb.json scores are tiers 0-3; map them onto the 0-60 scale so costOf gives 10, 1, 0.1, 0.01 (tier 0 is
  // the worst but still usable, so it maps to 1 rather than 0 = banned).
  var TIER_SCORE = [1, 20, 40, 60];

  // src: word list text ("WORD;score" lines) or a Crosshare worddb object ({words: {len: [[word, tier], ...]}}).
  // extra: optional text merged on top (custom words; score 0 bans).
  function WordDB(src, extra) {
    this.words = [];            // len -> [[word, score]]
    this.bm = [];               // len -> Uint32Array[pos * 26 + letter]
    this.nwords = [];           // len -> count
    this.total = 0;
    this.tiered = typeof src !== 'string';
    this._index = null;
    var best = new Map();
    if (typeof src === 'string') addText(best, src); else addObject(best, src);
    if (extra) addText(best, extra);
    this.build(best);
  }

  function clean(w) {
    var out = '', j, ch;
    for (j = 0; j < w.length; j++) { ch = w.charCodeAt(j); if (ch >= 97 && ch <= 122) ch -= 32; if (ch >= A && ch <= A + 25) out += String.fromCharCode(ch); }
    return out;
  }
  function put(best, w, sc) {
    if (w.length < 3 || w.length > 25) return;
    if (sc <= 0) { best.set(w, 0); return; }                  // ban
    if (best.get(w) === 0) return;
    if (!best.has(w) || sc > best.get(w)) best.set(w, sc);
  }
  function addObject(best, obj) {
    var ws = obj.words || obj;
    Object.keys(ws).forEach(function (len) {
      var arr = ws[len];
      for (var i = 0; i < arr.length; i++) put(best, clean(arr[i][0]), TIER_SCORE[arr[i][1]] || 1);
    });
  }
  function addText(best, text) {
    var lines = text.split('\n'), i, line, semi, w, sc;
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      if (!line || line.charCodeAt(0) === 35) continue;        // blank / '#'
      semi = line.lastIndexOf(';'); sc = 90; w = line;
      if (semi >= 0) { sc = parseInt(line.slice(semi + 1), 10); w = line.slice(0, semi); if (isNaN(sc)) { sc = 90; w = line; } }
      put(best, clean(w), sc);
    }
  }

  WordDB.prototype.build = function (best) {
    var byLen = [];
    best.forEach(function (s, w) { if (s > 0) (byLen[w.length] = byLen[w.length] || []).push([w, s]); });
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

  // Score of a word (0 if absent). The word -> score map is built on first use.
  WordDB.prototype.score = function (w) {
    if (!this._index) {
      this._index = new Map();
      for (var L = 0; L < this.words.length; L++) if (this.words[L]) for (var i = 0; i < this.words[L].length; i++) this._index.set(this.words[L][i][0], this.words[L][i][1]);
    }
    return this._index.get(w) || 0;
  };
  // Score as shown to the user: tier 0-3 for a Crosshare db, the raw score otherwise.
  WordDB.prototype.label = function (sc) { return this.tiered ? (sc >= 60 ? 3 : sc >= 40 ? 2 : sc >= 20 ? 1 : 0) : sc; };

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
