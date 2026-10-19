/* Autofill worker: best-first, cost-minimising backtracking over the word DB.
 *
 * In:   {type:'loaddb', text} · {type:'autofill', id, grid, width, height} · {type:'cancel'}
 * Out:  {type:'dbloaded', total} · {type:'autofill-result', id, grid, cost, forGrid}
 *       · {type:'autofill-complete', id, ok, forGrid, nodes}
 *
 * grid is an array of row strings: '#' black, '.' blank, A-Z letter.
 * The search runs in 50ms slices through a MessageChannel so a new grid (or
 * 'cancel') can interrupt it; the old search is simply dropped.
 */
importScripts('worddb.js');

var db = null;
var solver = null;           // active generator
var cache = null;            // {blacks, sol:Uint8Array(letters), cost} of the last complete solution
var chan = new MessageChannel();
var SLICE_MS = 50;

chan.port1.onmessage = function () {
  if (!solver) return;
  var t = performance.now(), r;
  do { r = solver.next(); } while (!r.done && performance.now() - t < SLICE_MS);
  if (r.done) solver = null; else chan.port2.postMessage(0);
};

self.onmessage = function (e) {
  var m = e.data;
  if (m.type === 'loaddb') {
    solver = null; cache = null;
    db = new WordDB(m.text);
    self.postMessage({ type: 'dbloaded', total: db.total });
  } else if (m.type === 'cancel') {
    solver = null;
  } else if (m.type === 'autofill') {
    solver = null;                                  // drop any previous search
    if (!db) { self.postMessage({ type: 'autofill-complete', id: m.id, ok: false, forGrid: m.grid.join('/'), nodes: 0, reason: 'nodb' }); return; }
    solver = run(m);
    chan.port2.postMessage(0);
  }
};

/* ---------- grid -> entries ---------- */

function parseGrid(grid, w, h) {
  var g = new Uint8Array(w * h), black = new Uint8Array(w * h), r, c;
  for (r = 0; r < h; r++) for (c = 0; c < w; c++) {
    var ch = grid[r].charAt(c);
    if (ch === '#') black[r * w + c] = 1;
    else if (ch >= 'A' && ch <= 'Z') g[r * w + c] = ch.charCodeAt(0);
  }
  var ents = [];
  function add(cells) { if (cells.length >= 3) ents.push({ len: cells.length, cells: cells }); }
  for (r = 0; r < h; r++) { var run = []; for (c = 0; c <= w; c++) { if (c < w && !black[r * w + c]) run.push(r * w + c); else { add(run); run = []; } } }
  for (c = 0; c < w; c++) { var run2 = []; for (r = 0; r <= h; r++) { if (r < h && !black[r * w + c]) run2.push(r * w + c); else { add(run2); run2 = []; } } }
  // crossing tables: for entry e, position p -> [other entry, position in it] or null
  var at = new Map();                                // cell -> [[e,p],...]
  ents.forEach(function (en, e) { en.cells.forEach(function (cell, p) { var a = at.get(cell); if (!a) at.set(cell, a = []); a.push([e, p]); }); });
  ents.forEach(function (en, e) {
    en.cross = en.cells.map(function (cell, p) {
      var a = at.get(cell), o = null;
      for (var i = 0; i < a.length; i++) if (a[i][0] !== e) o = a[i];
      return o;
    });
  });
  return { g: g, black: black, ents: ents };
}

function patternOf(g, en) {
  var s = '';
  for (var i = 0; i < en.len; i++) { var v = g[en.cells[i]]; s += v ? String.fromCharCode(v) : '?'; }
  return s;
}

function gridRows(g, black, w, h) {
  var rows = [], r, c;
  for (r = 0; r < h; r++) {
    var s = '';
    for (c = 0; c < w; c++) { var i = r * w + c; s += black[i] ? '#' : g[i] ? String.fromCharCode(g[i]) : '.'; }
    rows.push(s);
  }
  return rows;
}

/* ---------- the search ---------- */

function* run(m) {
  var w = m.width, h = m.height, forGrid = m.grid.join('/');
  var P = parseGrid(m.grid, w, h), g = P.g, ents = P.ents, black = P.black;
  var blacks = Array.from(black).join('');
  var nodes = 0;

  // Reuse a cached solution when the new grid only adds letters it already contains.
  if (!m.fresh && cache && cache.blacks === blacks) {
    var okc = true;
    for (var i = 0; i < g.length; i++) if (g[i] && g[i] !== cache.sol[i]) { okc = false; break; }
    if (okc) {
      self.postMessage({ type: 'autofill-result', id: m.id, grid: gridRows(cache.sol, black, w, h), cost: cache.cost, forGrid: forGrid, cached: true });
      self.postMessage({ type: 'autofill-complete', id: m.id, ok: true, forGrid: forGrid, nodes: 0, cached: true });
      return;
    }
  }

  var used = new Set(), todo = [], bm = new Array(ents.length), cnt = new Int32Array(ents.length), e;
  for (e = 0; e < ents.length; e++) {
    var pat = patternOf(g, ents[e]);
    if (pat.indexOf('?') < 0) used.add(pat);
    else {
      var b = db.matchingBitmap(pat), n = db.numMatches(b);
      if (!n) { self.postMessage({ type: 'autofill-complete', id: m.id, ok: false, forGrid: forGrid, nodes: 0, reason: 'dead:' + pat }); return; }
      bm[e] = b; cnt[e] = n; todo.push(e);
    }
  }
  if (!todo.length) { self.postMessage({ type: 'autofill-complete', id: m.id, ok: true, forGrid: forGrid, nodes: 0 }); return; }

  // Independent regions: unfilled entries that share no empty crossing cell.
  var parent = {};
  todo.forEach(function (x) { parent[x] = x; });
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  todo.forEach(function (x) {
    ents[x].cross.forEach(function (o, p) {
      if (o && !g[ents[x].cells[p]] && parent[o[0]] !== undefined) parent[find(x)] = find(o[0]);
    });
  });
  var regions = {};
  todo.forEach(function (x) { var r = find(x); (regions[r] = regions[r] || []).push(x); });
  var regionList = Object.keys(regions).map(function (k) { return regions[k]; })
    .sort(function (a, b) { return a.length - b.length; });          // small, cheap regions first

  var placed = new Uint8Array(ents.length);
  for (e = 0; e < ents.length; e++) placed[e] = bm[e] ? 0 : 1;
  var total = 0, solved = {};            // solved: cell -> letter for finished regions

  function post(extra, cost) {
    var out = g.slice(), k;
    for (k in solved) out[k] = solved[k];
    if (extra) for (k in extra) out[k] = extra[k];
    self.postMessage({ type: 'autofill-result', id: m.id, grid: gridRows(out, black, w, h), cost: cost, forGrid: forGrid });
  }

  for (var ri = 0; ri < regionList.length; ri++) {
    var region = regionList[ri], best = { cost: Infinity, sol: null }, attempt = 0, maxAttempts = 8, t0 = Date.now();
    while (attempt < maxAttempts && Date.now() - t0 < 30000) {
      var st = { cap: 20000 * Math.pow(2, attempt), count: 0, disc: attempt === 0 ? 10 : 10 + 4 * attempt, K: 120 + 100 * attempt, capped: false };
      var snap = { bm: bm.slice(), cnt: cnt.slice(), placed: placed.slice() };
      yield* dfs(0, 0, st, 0);
      bm = snap.bm; cnt = snap.cnt; placed = snap.placed;
      attempt++;
      if (best.sol && !st.capped) break;               // search space exhausted under the bound: optimal for this ordering
      if (best.sol && attempt >= 3) break;
    }
    if (!best.sol) { self.postMessage({ type: 'autofill-complete', id: m.id, ok: false, forGrid: forGrid, nodes: nodes, reason: 'nofill' }); return; }
    for (var k in best.sol) { solved[k] = best.sol[k]; }
    region.forEach(function (x) { for (var q = 0; q < ents[x].len; q++) { var c = ents[x].cells[q]; g[c] = solved[c]; } });
    region.forEach(function (x) { used.add(patternOf(g, ents[x])); placed[x] = 1; });
    total += best.cost;
    post(null, total);
  }
  cache = { blacks: blacks, sol: (function () { var s = g.slice(); return s; })(), cost: total };
  self.postMessage({ type: 'autofill-complete', id: m.id, ok: true, forGrid: forGrid, nodes: nodes });

  function* dfs(depth, cost, st, disc) {
    var region_ = region;
    // most constrained unplaced entry in this region
    var pick = -1, pc = 1e9, i, x;
    for (i = 0; i < region_.length; i++) {
      x = region_[i];
      if (placed[x]) continue;
      var c0 = cnt[x] + Math.random() * 0.5;           // random tie-break
      if (c0 < pc) { pc = c0; pick = x; }
    }
    if (pick < 0) {                                    // every entry placed
      if (cost < best.cost) {
        var sol = {};
        region_.forEach(function (y) { for (var q = 0; q < ents[y].len; q++) { var c = ents[y].cells[q]; sol[c] = g[c]; } });
        best.cost = cost; best.sol = sol;
        post(sol, total + cost);                       // first (and every cheaper) solution goes out immediately
      }
      return;
    }
    if ((++nodes & 255) === 0) yield;
    if (++st.count > st.cap) { st.capped = true; return; }

    var en = ents[pick], len = en.len;
    var cands = db.matchingWords(len, bm[pick], st.K), noisy = [], j;
    for (j = 0; j < cands.length; j++) noisy.push([cands[j][0], WordDB.costOf(cands[j][1]), WordDB.costOf(cands[j][1]) + 0.01 * Math.random()]);
    noisy.sort(function (a, b) { return a[2] - b[2]; });

    var dead = {}, taken = 0;
    cand: for (j = 0; j < noisy.length; j++) {
      var word = noisy[j][0], wc = noisy[j][1];
      if (used.has(word) || cost + wc >= best.cost) continue;
      var upd = [], p, cell, ch, cr;
      for (p = 0; p < len; p++) {                      // letters must agree with what is placed
        cell = en.cells[p]; ch = word.charCodeAt(p);
        if (g[cell] && g[cell] !== ch) continue cand;
      }
      for (p = 0; p < len; p++) {
        cell = en.cells[p]; if (g[cell]) continue;
        ch = word.charCodeAt(p);
        if (dead[cell] && dead[cell][ch]) continue cand;   // this letter already emptied a crossing here
        cr = en.cross[p];
        if (cr && !placed[cr[0]]) {
          var nb = db.updateBitmap(ents[cr[0]].len, bm[cr[0]], cr[1], ch), nn = db.numMatches(nb);
          if (!nn) { (dead[cell] = dead[cell] || {})[ch] = 1; continue cand; }
          upd.push([cr[0], nb, nn]);
        }
      }
      var nd = disc + (taken > 0 ? 1 : 0);              // every choice after the best costs one discrepancy
      if (nd > st.disc) break;
      taken++;

      // place
      var oldBm = [], oldCnt = [], pl = [];
      for (p = 0; p < len; p++) { cell = en.cells[p]; if (!g[cell]) { g[cell] = word.charCodeAt(p); pl.push(cell); } }
      for (i = 0; i < upd.length; i++) { oldBm.push(bm[upd[i][0]]); oldCnt.push(cnt[upd[i][0]]); bm[upd[i][0]] = upd[i][1]; cnt[upd[i][0]] = upd[i][2]; }
      placed[pick] = 1; used.add(word);

      yield* dfs(depth + 1, cost + wc, st, nd);

      // undo
      used.delete(word); placed[pick] = 0;
      for (i = 0; i < upd.length; i++) { bm[upd[i][0]] = oldBm[i]; cnt[upd[i][0]] = oldCnt[i]; }
      for (i = 0; i < pl.length; i++) g[pl[i]] = 0;
      if (st.capped) return;
    }
  }
}
