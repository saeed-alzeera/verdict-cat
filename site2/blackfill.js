/* Black-square autofiller: finds an NYT-style pattern whose entry lengths give a custom word list the most places to go.
 *
 * Rules enforced (NYT standard): 180-degree rotational symmetry, every entry at least 3 letters (so no unchecked
 * squares), all white squares connected, no 2x2 blocks of black, and no more than 78 entries on a 15x15 (140 on a 21x21).
 *
 * Search: simulated annealing over symmetric black-square patterns. A pattern scores for the number of slots of each
 * length (across only) the custom words need (diminishing returns, big penalty for having fewer slots than words), minus small
 * penalties for atypical grids (too few entries, long entries nobody asked for, too many 3-letter entries). The best
 * pattern of each restart is then checked exactly: how many of the words can sit in the grid at the same time with
 * their crossings agreeing (and no down entry taking more than three words, or two in neighbouring rows, which would usually leave it unfillable), and how many (word, slot) placements belong to such an arrangement.
 *
 * Loaded by the page; also usable from Node for tests.
 */
(function (root) {
  'use strict';

  function maxEntries(N) {
    const n = N <= 15 ? 78 * (N / 15) ** 2 : N <= 21 ? 78 + 62 * (N - 15) / 6 : 140 * (N / 21) ** 2;
    return Math.max(2 * N, Math.round(n));
  }

  // b: Uint8Array(N*N), 1 = black. Returns null when the pattern breaks a rule, else {m: across slots per length, entries (across + down), blacks}.
  function analyze(b, N, cap) {
    const m = new Int16Array(N + 1); let entries = 0, blacks = 0, whites = 0, first = -1;
    for (let i = 0; i < N * N; i++) { if (b[i]) blacks++; else { whites++; if (first < 0) first = i; } }
    for (let r = 0; r < N; r++) for (let d = 0; d < 2; d++) {
      let run = 0;
      for (let k = 0; k <= N; k++) {
        if (k < N && !b[d ? k * N + r : r * N + k]) { run++; continue; }
        if (run) { if (run < 3) return null; if (!d) m[run]++; entries++; }
        run = 0;
      }
    }
    if (entries > cap) return null;
    for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) {
      const i = r * N + c; if (b[i] && b[i + 1] && b[i + N] && b[i + N + 1]) return null;
    }
    if (whites) {
      const seen = new Uint8Array(N * N), stack = [first]; let n = 0; seen[first] = 1;
      while (stack.length) {
        const i = stack.pop(), r = (i / N) | 0, c = i % N; n++;
        for (const j of [c > 0 ? i - 1 : -1, c < N - 1 ? i + 1 : -1, r > 0 ? i - N : -1, r < N - 1 ? i + N : -1]) {
          if (j >= 0 && !b[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (n !== whites) return null;
    }
    return { m, entries, blacks };
  }

  // Every across entry as {dir: 'A', len, cells: [index, ...]}; downs are never candidates for words.
  function slotsOf(b, N) {
    const out = [];
    for (let r = 0; r < N; r++) for (let d = 0; d < 1; d++) {
      let cells = [];
      for (let k = 0; k <= N; k++) {
        const i = d ? k * N + r : r * N + k;
        if (k < N && !b[i]) { cells.push(i); continue; }
        if (cells.length >= 3) out.push({ dir: d ? 'D' : 'A', len: cells.length, cells });
        cells = [];
      }
    }
    // down entry id of every cell (-1 if none): words never go down, but crowding a down entry with word letters usually leaves it unfillable
    const down = new Int32Array(N * N).fill(-1); let id = 0;
    for (let c = 0; c < N; c++) {
      let cells = [];
      for (let k = 0; k <= N; k++) {
        if (k < N && !b[k * N + c]) { cells.push(k * N + c); continue; }
        if (cells.length >= 3) { cells.forEach(i => { down[i] = id; }); id++; }
        cells = [];
      }
    }
    out.down = down; out.downCount = id;
    return out;
  }

  // Most words that can sit in the grid at once (distinct entries, crossing letters agree). `fixed` = [wordIndex, slotIndex]
  // forces one placement. Returns {best, exact}; exact is false when the node limit cut the search short.
  function pack(words, slots, N, fixed, nodeLimit) {
    const byLen = new Map();
    slots.forEach((s, i) => { if (!byLen.has(s.len)) byLen.set(s.len, []); byLen.get(s.len).push(i); });
    const order = words.map((w, i) => i).filter(i => !fixed || i !== fixed[0])
      .sort((a, b) => (byLen.get(words[a].length) || []).length - (byLen.get(words[b].length) || []).length);
    const letters = new Uint8Array(N * N), used = new Uint8Array(slots.length);
    const down = slots.down, cnt = new Uint8Array(slots.downCount || 0), rows = new Int32Array((slots.downCount || 0) * 3).fill(-9);
    let best = 0, nodes = 0, cut = false;
    const put = (w, s) => {
      const cells = slots[s].cells, changed = [];
      if (down) for (const i of cells) {                    // a down entry may take at most three words, none in neighbouring rows
        const d = down[i], r = (i / N) | 0;
        if (cnt[d] >= 3) return null;
        for (let j = 0; j < cnt[d]; j++) if (Math.abs(rows[3 * d + j] - r) < 2) return null;
      }
      for (let k = 0; k < cells.length; k++) {
        const ch = w.charCodeAt(k), cur = letters[cells[k]];
        if (cur && cur !== ch) { changed.forEach(i => { letters[i] = 0; }); return null; }
        if (!cur) { letters[cells[k]] = ch; changed.push(cells[k]); }
      }
      if (down) for (const i of cells) { const d = down[i]; rows[3 * d + cnt[d]++] = (i / N) | 0; }
      used[s] = 1; return changed;
    };
    const unput = (s, changed) => {
      changed.forEach(c => { letters[c] = 0; }); used[s] = 0;
      if (down) for (const i of slots[s].cells) cnt[down[i]]--;
    };
    const dfs = (i, placed) => {
      if (placed > best) best = placed;
      if (i === order.length || best === words.length || placed + order.length - i <= best) return;
      if (++nodes > nodeLimit) { cut = true; return; }
      const w = words[order[i]];
      for (const s of byLen.get(w.length) || []) {
        if (used[s]) continue;
        const changed = put(w, s); if (!changed) continue;
        dfs(i + 1, placed + 1);
        unput(s, changed);
        if (cut || best === words.length) return;
      }
      dfs(i + 1, placed);
    };
    let base = 0;
    if (fixed) { if (!put(words[fixed[0]], fixed[1])) return { best: 0, exact: true }; base = 1; }
    dfs(0, base);
    return { best, exact: !cut };
  }

  // Exact check of one pattern against the word list.
  function evaluate(b, N, words) {
    const slots = slotsOf(b, N);
    if (!words.length) return { maxPlaced: 0, live: 0, pairs: 0 };
    const top = pack(words, slots, N, null, 60000), maxPlaced = top.best;
    let live = 0, pairs = 0;
    words.forEach((w, wi) => slots.forEach((s, si) => {
      if (s.len !== w.length) return;
      pairs++;
      if (pack(words, slots, N, [wi, si], 4000).best >= maxPlaced) live++;       // belongs to an arrangement as good as the best
    }));
    return { maxPlaced, live, pairs };
  }

  function* search(o) {
    const N = o.N, rng = o.rng || Math.random, restarts = o.restarts || 8, iters = o.iters || 14000;
    const cap = maxEntries(N), total = Math.ceil(N * N / 2);
    const words = [...new Set((o.words || []).map(w => w.toUpperCase().replace(/[^A-Z]/g, '')))].filter(w => w.length >= 3 && w.length <= N);
    const need = new Int16Array(N + 1); words.forEach(w => need[w.length]++);
    const target = 0.92 * cap;

    const score = a => {
      let s = 0;
      for (let L = 3; L <= N; L++) {
        const k = need[L], m = a.m[L];
        if (k) { s += k * Math.log(1 + m); if (m < k) s -= 50 * (k - m); }
        if (L > 9 && m > k) s -= 1.5 * (m - k);
      }
      s -= 400 * ((a.entries - target) / cap) ** 2;
      s -= 0.5 * Math.max(0, a.m[3] - need[3] - 0.28 * a.entries);
      s -= 0.5 * Math.max(0, a.blacks - 0.18 * N * N);
      return s;
    };
    const flip = (b, i) => { b[i] ^= 1; const j = N * N - 1 - i; if (j !== i) b[j] ^= 1; };

    const cands = [];
    for (let rs = 0; rs < restarts; rs++) {
      const b = new Uint8Array(N * N);
      let curS = score(analyze(b, N, cap)), best = b.slice(), bestS = curS;
      for (let it = 0; it < iters; it++) {
        if (it % 250 === 0) yield (rs + it / iters) / (restarts + 1);
        const T = 1.5 * (1 - it / iters) + 0.05, picks = [];
        for (let k = rng() < 0.75 ? 1 : 2; k > 0; k--) { const i = Math.floor(rng() * total); picks.push(i); flip(b, i); }
        const a = analyze(b, N, cap), s = a ? score(a) : -Infinity;
        if (a && (s >= curS || rng() < Math.exp((s - curS) / T))) {
          curS = s;
          if (s > bestS) { bestS = s; best = b.slice(); }
        } else picks.forEach(i => flip(b, i));
      }
      cands.push({ b: best, s: bestS });
    }

    let pick = null;
    for (let i = 0; i < cands.length; i++) {
      yield (restarts + (i + 1) / cands.length) / (restarts + 1);
      const c = cands[i], ev = evaluate(c.b, N, words), rank = ev.maxPlaced * 1e4 + c.s + 2 * Math.log(1 + ev.live);
      if (!pick || rank > pick.rank) pick = { b: c.b, s: c.s, ev, rank };
    }

    // Crossing clashes between the words are invisible to the length counts: nudge the winner (staying close to its
    // score) until every word fits at once, or give up after a few hundred tries.
    if (words.length && pick.ev.maxPlaced < words.length) {
      const b = pick.b.slice(); let have = pick.ev.maxPlaced, curS = pick.s;
      for (let t = 0; t < 400 && have < words.length; t++) {
        if (t % 20 === 0) yield 0.97 + 0.03 * t / 400;
        const picks = [];
        for (let k = rng() < 0.75 ? 1 : 2; k > 0; k--) { const i = Math.floor(rng() * total); picks.push(i); flip(b, i); }
        const a = analyze(b, N, cap), s = a ? score(a) : -Infinity;
        const p = a && s >= pick.s - 4 ? pack(words, slotsOf(b, N), N, null, 60000).best : -1;
        if (p >= have) { curS = s; have = p; } else picks.forEach(i => flip(b, i));
      }
      if (have > pick.ev.maxPlaced) pick = { b, s: curS, ev: evaluate(b, N, words) };
    }
    const a = analyze(pick.b, N, cap);
    return { black: pick.b, words, blacks: a.blacks, entries: a.entries, lengths: Array.from(a.m), ...pick.ev };
  }

  // Resolves with {black, words, blacks, entries, lengths, maxPlaced, live, pairs}. Works in time slices so the page stays responsive.
  function run(o) {
    return new Promise(resolve => {
      const gen = search(o);
      (function pump() {
        const t = Date.now(); let r;
        do { r = gen.next(); } while (!r.done && Date.now() - t < 30);
        if (r.done) resolve(r.value); else { if (o.onProgress) o.onProgress(r.value); setTimeout(pump, 0); }
      })();
    });
  }

  root.BlackFill = { run, search, analyze, slotsOf, pack, evaluate, maxEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BlackFill;
})(typeof self !== 'undefined' ? self : this);
