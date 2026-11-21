/* Ludo engine — rules for a 2–4 player race game (classic 15x15 board).
 * Pure logic, no DOM. Works in the browser (window.LudoEngine) and Node (module.exports).
 *
 * Positions of one pawn (relative to its own colour):
 *   -1        in base
 *   0..50     on the shared 52-square ring (0 = the colour's start square)
 *   51..55    in the colour's home column
 *   56        home (finished)
 * Rules: a 6 releases a pawn and grants a bonus roll; three 6s in a row forfeit the turn;
 * landing on an enemy pawn on a non-safe ring square sends it to base; finishing needs the
 * exact roll; first colour with all four pawns home wins.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LudoEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RING = 52, HOME_COL_START = 51, FINISH = 56, PAWNS = 4;
  var MIN_PLAYERS = 2, MAX_PLAYERS = 4;

  // The 52 ring squares as [row, col] on a 15x15 grid, clockwise, index 0 = blue's start.
  var RING_CELLS = (function () {
    var c = [], i;
    for (i = 1; i <= 5; i++) c.push([6, i]);
    for (i = 5; i >= 0; i--) c.push([i, 6]);
    c.push([0, 7], [0, 8]);
    for (i = 1; i <= 5; i++) c.push([i, 8]);
    for (i = 9; i <= 14; i++) c.push([6, i]);
    c.push([7, 14], [8, 14]);
    for (i = 13; i >= 9; i--) c.push([8, i]);
    for (i = 9; i <= 14; i++) c.push([i, 8]);
    c.push([14, 7], [14, 6]);
    for (i = 13; i >= 9; i--) c.push([i, 6]);
    for (i = 5; i >= 0; i--) c.push([8, i]);
    c.push([7, 0], [6, 0]);
    return c;
  })();

  // Colours in clockwise (turn) order.
  var COLORS = [
    { id: 'blue',   start: 0,  col: function (k) { return [7, 1 + k]; },  base: [[2, 2], [2, 4], [4, 2], [4, 4]] },
    { id: 'yellow', start: 13, col: function (k) { return [1 + k, 7]; },  base: [[2, 10], [2, 12], [4, 10], [4, 12]] },
    { id: 'green',  start: 26, col: function (k) { return [7, 13 - k]; }, base: [[10, 10], [10, 12], [12, 10], [12, 12]] },
    { id: 'red',    start: 39, col: function (k) { return [13 - k, 7]; }, base: [[10, 2], [10, 4], [12, 2], [12, 4]] }
  ];
  var SAFE = {}; [0, 8, 13, 21, 26, 34, 39, 47].forEach(function (i) { SAFE[i] = true; });
  // Which colours play, by player count (opposite corners for two).
  var SEATING = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

  function ringIndex(color, pos) { return (COLORS[color].start + pos) % RING; }

  /** [row, col] of a pawn on the 15x15 grid. Pawn index only matters for base slots. */
  function cellOf(color, pos, pawn) {
    if (pos < 0) return COLORS[color].base[pawn || 0];
    if (pos <= 50) return RING_CELLS[ringIndex(color, pos)];
    if (pos < FINISH) return COLORS[color].col(pos - HOME_COL_START);
    return [7, 7];
  }
  function isSafe(color, pos) { return pos >= 0 && pos <= 50 && !!SAFE[ringIndex(color, pos)]; }

  // ---- deterministic RNG (mulberry32), state kept inside the game so it serializes ----
  function rand(g) {
    g.rng = (g.rng + 0x6D2B79F5) | 0;
    var t = g.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * players: array of 2–4 { name, bot } where bot is null/undefined (human) or 'easy'|'medium'|'hard'.
   */
  function newGame(players, opts) {
    opts = opts || {};
    var n = players.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error('Ludo needs 2–4 players.');
    var seats = SEATING[n];
    var g = {
      rng: (opts.seed === undefined ? (Math.random() * 4294967296) | 0 : opts.seed | 0),
      players: players.map(function (p, i) {
        return { name: p.name, bot: p.bot || null, color: seats[i], pawns: [-1, -1, -1, -1], captures: 0, lost: 0, rolls: 0 };
      }),
      turn: 0, roll: null, sixes: 0, winner: null, moves: 0, last: null,
      easyStart: !!opts.easyStart      // everyone's very first roll is a 6
    };
    return g;
  }

  function homeCount(p) { return p.pawns.filter(function (x) { return x === FINISH; }).length; }

  /** Pawn indexes the current player may move with the current roll. */
  function legalMoves(g) {
    if (g.winner !== null || g.roll === null) return [];
    var p = g.players[g.turn], out = [];
    for (var i = 0; i < PAWNS; i++) {
      var pos = p.pawns[i];
      if (pos === FINISH) continue;
      if (pos < 0) { if (g.roll === 6) out.push(i); }
      else if (pos + g.roll <= FINISH) out.push(i);
    }
    return out;
  }

  function nextTurn(g) {
    g.turn = (g.turn + 1) % g.players.length;
    g.roll = null; g.sixes = 0;
  }

  /**
   * Roll the die for the current player.
   * Returns { value, forfeited, passed } — forfeited: third 6 in a row (turn ends);
   * passed: no legal move (turn passes, or the bonus roll after a 6 is simply unused).
   */
  function roll(g, forced) {
    if (g.winner !== null) throw new Error('Game is over.');
    if (g.roll !== null) throw new Error('Move first.');
    var me = g.players[g.turn];
    var v = forced || ((g.easyStart && !me.rolls) ? 6 : 1 + Math.floor(rand(g) * 6));
    me.rolls = (me.rolls || 0) + 1;
    g.last = null;
    if (v === 6) {
      g.sixes++;
      if (g.sixes >= 3) { var who = g.turn; nextTurn(g); return { value: 6, forfeited: true, passed: false, player: who }; }
    }
    g.roll = v;
    if (!legalMoves(g).length) {
      var p = g.turn;
      if (v === 6) { g.roll = null; /* bonus roll with nothing to move: roll again */ return { value: v, forfeited: false, passed: true, player: p, again: true }; }
      nextTurn(g);
      return { value: v, forfeited: false, passed: true, player: p };
    }
    return { value: v, forfeited: false, passed: false, player: g.turn };
  }

  /**
   * Move one pawn by the current roll. Returns
   * { pawn, from, to, captured: [{player,pawn}], finished, won, again }.
   */
  function move(g, pawn) {
    if (legalMoves(g).indexOf(pawn) < 0) throw new Error('Illegal move.');
    var me = g.players[g.turn], from = me.pawns[pawn], to = from < 0 ? 0 : from + g.roll;
    var captured = [];
    me.pawns[pawn] = to;
    if (to <= 50 && !SAFE[ringIndex(me.color, to)]) {
      var ri = ringIndex(me.color, to);
      g.players.forEach(function (op, oi) {
        if (oi === g.turn) return;
        op.pawns.forEach(function (pos, pi) {
          if (pos >= 0 && pos <= 50 && ringIndex(op.color, pos) === ri) {
            op.pawns[pi] = -1; op.lost++; me.captures++;
            captured.push({ player: oi, pawn: pi });
          }
        });
      });
    }
    g.moves++;
    var finished = to === FINISH;
    var won = homeCount(me) === PAWNS;
    var res = { player: g.turn, pawn: pawn, from: from, to: to, roll: g.roll, captured: captured, finished: finished, won: won, again: false };
    if (won) { g.winner = g.turn; g.roll = null; g.last = res; return res; }
    var bonus = g.roll === 6;
    g.roll = null;
    if (bonus) res.again = true; else nextTurn(g);
    g.last = res;
    return res;
  }

  // ---- bots ----
  /** Heuristic value of moving a pawn; used by medium (captures/exits first) and hard. */
  function scoreMove(g, pawn, level) {
    var me = g.players[g.turn], from = me.pawns[pawn], to = from < 0 ? 0 : from + g.roll, s = 0;
    var ri = to <= 50 ? ringIndex(me.color, to) : -1, i, j;
    if (ri >= 0 && !SAFE[ri]) {
      g.players.forEach(function (op, oi) {
        if (oi === g.turn) return;
        op.pawns.forEach(function (pos) { if (pos >= 0 && pos <= 50 && ringIndex(op.color, pos) === ri) s += 60 + pos; });
      });
    }
    if (to === FINISH) s += 50;
    if (from < 0) s += 35;
    if (to > 50) s += 20;
    if (level === 'medium') return s;
    // hard: progress, safety and danger
    s += g.roll;
    if (ri >= 0 && SAFE[ri]) s += 12;
    function danger(rIdx) {
      var d = 0;
      g.players.forEach(function (op, oi) {
        if (oi === g.turn) return;
        op.pawns.forEach(function (pos) {
          if (pos < 0 || pos > 50) return;
          var oIdx = ringIndex(op.color, pos), dist = (rIdx - oIdx + RING) % RING;
          if (dist >= 1 && dist <= 6) d += 1;
        });
      });
      return d;
    }
    if (from >= 0 && from <= 50 && !SAFE[ringIndex(me.color, from)]) s += 10 * danger(ringIndex(me.color, from)); // escaping danger
    if (ri >= 0 && !SAFE[ri]) s -= 12 * danger(ri);                                                               // walking into it
    s += (from < 0 ? 0 : from) * 0.05;                                                                            // slightly prefer the leader
    return s;
  }

  /** Pick a pawn for the current (bot) player. rnd: () => [0,1), defaults to the game's RNG. */
  function chooseMove(g, level, rnd) {
    var moves = legalMoves(g), r = rnd || function () { return rand(g); };
    if (!moves.length) return null;
    if (level === 'easy') return moves[Math.floor(r() * moves.length)];
    if (level === 'medium' && r() < 0.3) return moves[Math.floor(r() * moves.length)];
    var best = -Infinity, pick = moves[0];
    moves.forEach(function (m) {
      var s = scoreMove(g, m, level === 'hard' ? 'hard' : 'medium') + r() * 0.01;
      if (s > best) { best = s; pick = m; }
    });
    return pick;
  }

  function serialize(g) { return JSON.stringify(g); }
  function restore(s) { return typeof s === 'string' ? JSON.parse(s) : s; }

  return {
    RING: RING, FINISH: FINISH, PAWNS: PAWNS, MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS,
    RING_CELLS: RING_CELLS, COLORS: COLORS, SEATING: SEATING,
    cellOf: cellOf, isSafe: isSafe, ringIndex: ringIndex, homeCount: homeCount,
    newGame: newGame, roll: roll, legalMoves: legalMoves, move: move, chooseMove: chooseMove,
    serialize: serialize, restore: restore
  };
});
