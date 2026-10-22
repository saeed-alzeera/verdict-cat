/* Wordgrid engine — rules for a 2–4 player crossword tile game.
 * Pure logic, no DOM. Works in the browser (window.WordgridEngine) and Node (module.exports).
 * The caller supplies the dictionary as an isWord(string) predicate (upper-case input).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WordgridEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 15, CENTER = 7, RACK = 7, BINGO = 50;
  var MIN_PLAYERS = 2, MAX_PLAYERS = 4;

  var DIST = { A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1,'?':2 };
  var VALUE = { A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'?':0 };

  // Premium squares: base coordinates in one octant, expanded by the board's 8-fold symmetry.
  var BASE = {
    TW: [[0,0],[0,7]],
    DW: [[1,1],[2,2],[3,3],[4,4]],
    TL: [[1,5],[5,5]],
    DL: [[0,3],[2,6],[3,7],[6,6]]
  };
  var PREMIUM = (function () {
    var grid = [], r, c;
    for (r = 0; r < SIZE; r++) { grid.push([]); for (c = 0; c < SIZE; c++) grid[r].push(''); }
    Object.keys(BASE).forEach(function (kind) {
      BASE[kind].forEach(function (p) {
        var a = p[0], b = p[1];
        [[a,b],[b,a]].forEach(function (q) {
          [q[0], SIZE - 1 - q[0]].forEach(function (rr) {
            [q[1], SIZE - 1 - q[1]].forEach(function (cc) { grid[rr][cc] = kind; });
          });
        });
      });
    });
    grid[CENTER][CENTER] = 'DW';
    return grid;
  })();

  // Seedable PRNG whose position can be saved (getState) and resumed (pass it back as the seed).
  function mulberry32(seed) {
    var a = seed >>> 0;
    var fn = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fn.getState = function () { return a; };
    return fn;
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function makeBag() {
    var bag = [];
    Object.keys(DIST).forEach(function (ch) { for (var i = 0; i < DIST[ch]; i++) bag.push(ch); });
    return bag;
  }

  function rackValue(rack) {
    return rack.reduce(function (s, t) { return s + VALUE[t]; }, 0);
  }

  function newGame(names, opts) {
    opts = opts || {};
    if (!Array.isArray(names) || names.length < MIN_PLAYERS || names.length > MAX_PLAYERS)
      throw new Error('Wordgrid supports ' + MIN_PLAYERS + '–' + MAX_PLAYERS + ' players');
    var seed = opts.seed != null ? opts.seed : (Math.random() * 4294967296) >>> 0;
    var rng = mulberry32(seed);
    var board = [];
    for (var r = 0; r < SIZE; r++) { board.push([]); for (var c = 0; c < SIZE; c++) board[r].push(null); }
    var g = {
      seed: seed,
      rng: rng,
      board: board,
      bag: shuffle(makeBag(), rng),
      players: names.map(function (n) { return { name: n, rack: [], score: 0, resigned: false }; }),
      turn: 0,
      scoreless: 0,
      over: false,
      endReason: null,
      history: []
    };
    g.players.forEach(function (p) { draw(g, p); });
    g.turn = Math.floor(rng() * g.players.length);
    return g;
  }

  function draw(g, p) {
    while (p.rack.length < RACK && g.bag.length) p.rack.push(g.bag.pop());
  }

  function activePlayers(g) {
    return g.players.filter(function (p) { return !p.resigned; });
  }

  function advanceTurn(g) {
    var n = g.players.length;
    for (var i = 1; i <= n; i++) {
      var idx = (g.turn + i) % n;
      if (!g.players[idx].resigned) { g.turn = idx; return; }
    }
  }

  function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

  // Collect the contiguous run through (r,c) along (dr,dc) in `cells` (a grid of {ch,blank,fresh}|null).
  function runAt(cells, r, c, dr, dc) {
    var sr = r, sc = c;
    while (inBounds(sr - dr, sc - dc) && cells[sr - dr][sc - dc]) { sr -= dr; sc -= dc; }
    var out = [], rr = sr, cc = sc;
    while (inBounds(rr, cc) && cells[rr][cc]) { out.push({ r: rr, c: cc, cell: cells[rr][cc] }); rr += dr; cc += dc; }
    return out;
  }

  function scoreRun(run) {
    var sum = 0, mult = 1;
    run.forEach(function (x) {
      var v = x.cell.blank ? 0 : VALUE[x.cell.ch];
      if (x.cell.fresh) {
        var p = PREMIUM[x.r][x.c];
        if (p === 'DL') v *= 2; else if (p === 'TL') v *= 3;
        else if (p === 'DW') mult *= 2; else if (p === 'TW') mult *= 3;
      }
      sum += v;
    });
    return sum * mult;
  }

  /* placements: [{r, c, ch, blank}] — ch is the letter shown (for a blank, the chosen letter).
   * Returns {ok:true, score, words:[{word,score}], bingo} or {ok:false, error}. Does not mutate g. */
  function evaluate(g, placements, isWord) {
    var i, p;
    if (!placements || !placements.length) return { ok: false, error: 'Place at least one tile.' };

    var seen = {};
    for (i = 0; i < placements.length; i++) {
      p = placements[i];
      if (!inBounds(p.r, p.c)) return { ok: false, error: 'Tile is off the board.' };
      if (g.board[p.r][p.c]) return { ok: false, error: 'Square already occupied.' };
      if (!/^[A-Z]$/.test(p.ch)) return { ok: false, error: 'Invalid tile.' };
      var key = p.r + ',' + p.c;
      if (seen[key]) return { ok: false, error: 'Two tiles on one square.' };
      seen[key] = true;
    }

    var rows = {}, cols = {};
    placements.forEach(function (q) { rows[q.r] = 1; cols[q.c] = 1; });
    var sameRow = Object.keys(rows).length === 1, sameCol = Object.keys(cols).length === 1;
    if (!sameRow && !sameCol) return { ok: false, error: 'Tiles must be in a single row or column.' };

    // Build a working grid: existing tiles plus fresh ones.
    var cells = g.board.map(function (row) {
      return row.map(function (t) { return t ? { ch: t.ch, blank: t.blank, fresh: false } : null; });
    });
    placements.forEach(function (q) { cells[q.r][q.c] = { ch: q.ch, blank: !!q.blank, fresh: true }; });

    // No gaps between the outermost placed tiles.
    if (placements.length > 1) {
      var dr0 = sameRow ? 0 : 1, dc0 = sameRow ? 1 : 0;
      var lo = placements.reduce(function (m, q) { return (q.r * dr0 + q.c * dc0) < (m.r * dr0 + m.c * dc0) ? q : m; });
      var hi = placements.reduce(function (m, q) { return (q.r * dr0 + q.c * dc0) > (m.r * dr0 + m.c * dc0) ? q : m; });
      for (var rr = lo.r, cc = lo.c; rr <= hi.r && cc <= hi.c; rr += dr0, cc += dc0)
        if (!cells[rr][cc]) return { ok: false, error: 'Tiles must be connected without gaps.' };
    }

    var empty = g.history.every(function (h) { return h.type !== 'play'; });
    if (empty) {
      if (!placements.some(function (q) { return q.r === CENTER && q.c === CENTER; }))
        return { ok: false, error: 'The first word must cover the centre star.' };
      if (placements.length < 2) return { ok: false, error: 'The first word needs at least two letters.' };
    } else {
      var touches = placements.some(function (q) {
        return [[1,0],[-1,0],[0,1],[0,-1]].some(function (d) {
          var nr = q.r + d[0], nc = q.c + d[1];
          return inBounds(nr, nc) && g.board[nr][nc];
        });
      });
      if (!touches) return { ok: false, error: 'The word must connect to tiles already on the board.' };
    }

    // Gather every word formed: along the line, plus cross-words for each fresh tile.
    var runs = [];
    function addRun(run) {
      if (run.length < 2) return;
      var id = run[0].r + ',' + run[0].c + ',' + run.length + ',' + (run[0].r === run[run.length - 1].r ? 'h' : 'v');
      if (!runs.some(function (x) { return x.id === id; })) runs.push({ id: id, run: run });
    }
    placements.forEach(function (q) {
      addRun(runAt(cells, q.r, q.c, 0, 1));
      addRun(runAt(cells, q.r, q.c, 1, 0));
    });
    if (!runs.length) return { ok: false, error: 'No word formed.' };

    var words = [], total = 0;
    for (i = 0; i < runs.length; i++) {
      var w = runs[i].run.map(function (x) { return x.cell.ch; }).join('');
      if (!isWord(w)) return { ok: false, error: '“' + w + '” is not in the dictionary.', word: w };
      var s = scoreRun(runs[i].run);
      words.push({ word: w, score: s });
      total += s;
    }
    var bingo = placements.length === RACK;
    if (bingo) total += BINGO;
    return { ok: true, score: total, words: words, bingo: bingo };
  }

  function takeFromRack(rack, placements) {
    var copy = rack.slice();
    for (var i = 0; i < placements.length; i++) {
      var t = placements[i].blank ? '?' : placements[i].ch;
      var idx = copy.indexOf(t);
      if (idx < 0) return null;
      copy.splice(idx, 1);
    }
    return copy;
  }

  function finish(g, reason) {
    g.over = true;
    g.endReason = reason;
    var out = null;
    if (reason === 'out') {
      out = g.players[g.turn];
      var bonus = 0;
      g.players.forEach(function (p) {
        if (p === out || p.resigned) return;
        var v = rackValue(p.rack);
        p.score -= v; bonus += v;
      });
      out.score += bonus;
    } else if (reason === 'stalled') {
      g.players.forEach(function (p) { if (!p.resigned) p.score -= rackValue(p.rack); });
    }
  }

  function play(g, placements, isWord) {
    if (g.over) return { ok: false, error: 'The game is over.' };
    var p = g.players[g.turn];
    var rack = takeFromRack(p.rack, placements || []);
    if (!rack) return { ok: false, error: 'You do not hold those tiles.' };
    var res = evaluate(g, placements, isWord);
    if (!res.ok) return res;

    placements.forEach(function (q) { g.board[q.r][q.c] = { ch: q.ch, blank: !!q.blank }; });
    p.rack = rack;
    p.score += res.score;
    draw(g, p);
    g.scoreless = 0;
    g.history.push({ type: 'play', player: g.turn, score: res.score, words: res.words, tiles: placements.length,
      cells: placements.map(function (q) { return [q.r, q.c]; }), bingo: res.bingo });
    if (!p.rack.length && !g.bag.length) finish(g, 'out');
    else advanceTurn(g);
    return res;
  }

  function checkStall(g) {
    // Everyone still in has passed or swapped twice running.
    if (g.scoreless >= 2 * activePlayers(g).length) finish(g, 'stalled');
  }

  function pass(g) {
    if (g.over) return { ok: false, error: 'The game is over.' };
    g.history.push({ type: 'pass', player: g.turn });
    g.scoreless++;
    checkStall(g);
    if (!g.over) advanceTurn(g);
    return { ok: true };
  }

  // indices: positions in the current player's rack to exchange. Needs a full rack's worth left in the bag.
  function swap(g, indices) {
    if (g.over) return { ok: false, error: 'The game is over.' };
    if (g.bag.length < RACK) return { ok: false, error: 'Not enough tiles left in the bag to swap.' };
    var uniq = Array.from(new Set(indices || []));
    var p = g.players[g.turn];
    if (!uniq.length || uniq.some(function (i) { return i < 0 || i >= p.rack.length; }))
      return { ok: false, error: 'Choose tiles to swap.' };
    var out = uniq.map(function (i) { return p.rack[i]; });
    p.rack = p.rack.filter(function (_, i) { return uniq.indexOf(i) < 0; });
    draw(g, p);
    g.bag = shuffle(g.bag.concat(out), g.rng);
    g.history.push({ type: 'swap', player: g.turn, count: out.length });
    g.scoreless++;
    checkStall(g);
    if (!g.over) advanceTurn(g);
    return { ok: true };
  }

  // A resigned player's tiles go back in the bag; the game goes on while two or more remain.
  function resign(g, idx) {
    if (g.over) return { ok: false, error: 'The game is over.' };
    var p = g.players[idx];
    if (!p || p.resigned) return { ok: false, error: 'Unknown player.' };
    p.resigned = true;
    g.bag = shuffle(g.bag.concat(p.rack), g.rng);
    p.rack = [];
    g.history.push({ type: 'resign', player: idx });
    if (activePlayers(g).length < 2) { g.over = true; g.endReason = 'resigned'; return { ok: true }; }
    if (g.turn === idx) advanceTurn(g);
    return { ok: true };
  }

  function standings(g) {
    var list = g.players.map(function (p, i) { return { index: i, name: p.name, score: p.score, resigned: p.resigned }; });
    list.sort(function (a, b) { return (a.resigned - b.resigned) || (b.score - a.score); });
    var rank = 0, last = null;
    list.forEach(function (x, i) {
      if (x.resigned) { x.rank = null; return; }
      if (last === null || x.score !== last) rank = i + 1;
      x.rank = rank; last = x.score;
    });
    return list;
  }

  // JSON-safe snapshot (drops the rng function, keeps its position) and the inverse.
  function serialize(g) {
    var o = JSON.parse(JSON.stringify(g, function (k, v) { return k === 'rng' ? undefined : v; }));
    o.rngState = g.rng.getState();
    return o;
  }
  function restore(o) {
    var g = JSON.parse(JSON.stringify(o));
    g.rng = mulberry32(g.rngState);
    delete g.rngState;
    return g;
  }

  // What one seat may see: the board and scores, its own rack, and only the *count* of everything else.
  // Never includes the seed, the bag contents, or another player's rack (until the game is over).
  function publicView(g, seat, historyLimit) {
    return {
      board: g.board,
      bagCount: g.bag.length,
      turn: g.turn,
      over: g.over,
      endReason: g.endReason,
      scoreless: g.scoreless,
      players: g.players.map(function (p, i) {
        var o = { name: p.name, score: p.score, resigned: p.resigned, rackCount: p.rack.length };
        if (g.over) o.rack = p.rack.slice();
        return o;
      }),
      rack: g.players[seat] ? g.players[seat].rack.slice() : [],
      history: g.history.slice(-(historyLimit || 40)),
      standings: g.over ? standings(g) : null
    };
  }

  return {
    SIZE: SIZE, CENTER: CENTER, RACK: RACK, MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS,
    VALUE: VALUE, DIST: DIST, PREMIUM: PREMIUM,
    newGame: newGame, evaluate: evaluate, play: play, pass: pass, swap: swap, resign: resign,
    standings: standings, rackValue: rackValue, activePlayers: activePlayers,
    serialize: serialize, restore: restore, publicView: publicView
  };
});
