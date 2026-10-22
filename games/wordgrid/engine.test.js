// Run: node games/wordgrid/engine.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const words = new Set(fs.readFileSync(path.join(__dirname, 'enable.txt'), 'utf8').split('\n').filter(Boolean));
const isWord = w => words.has(w);
const H = (word, r, c) => [...word].map((ch, i) => ({ r, c: c + i, ch }));
const V = (word, r, c) => [...word].map((ch, i) => ({ r: r + i, c, ch }));
function give(g, i, letters) { g.players[i].rack = letters.split(''); }
function fresh(n = 4, seed = 1) { const g = E.newGame(['A','B','C','D'].slice(0, n), { seed }); return g; }

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('bag has 100 tiles and sums to standard distribution', () => {
  assert.strictEqual(Object.values(E.DIST).reduce((a, b) => a + b, 0), 100);
  const g = fresh(4);
  assert.strictEqual(g.bag.length + g.players.reduce((s, p) => s + p.rack.length, 0), 100);
});

test('premium squares: counts and symmetry', () => {
  const count = k => E.PREMIUM.flat().filter(x => x === k).length;
  assert.deepStrictEqual([count('TW'), count('DW'), count('TL'), count('DL')], [8, 17, 12, 24]);
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++)
    assert.strictEqual(E.PREMIUM[r][c], E.PREMIUM[c][r]);
});

test('2–4 players only', () => {
  assert.throws(() => E.newGame(['x']));
  assert.throws(() => E.newGame(['a','b','c','d','e']));
  for (const n of [2, 3, 4]) assert.strictEqual(E.newGame(['a','b','c','d'].slice(0, n)).players.length, n);
});

test('first word: must cover centre, >=2 letters, scores with centre DW', () => {
  const g = fresh(); give(g, g.turn, 'CATSXYZ');
  assert.ok(!E.evaluate(g, H('CAT', 0, 0), isWord).ok);
  assert.ok(!E.evaluate(g, H('C', 7, 7), isWord).ok);
  const r = E.evaluate(g, H('CAT', 7, 6), isWord); // C(7,6) A(7,7 DW) T(7,8)
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.score, (3 + 1 + 1) * 2);
});

test('turn passes around four players in order, skipping resigned', () => {
  const g = fresh(4); const start = g.turn;
  give(g, start, 'CATSXYZ');
  assert.ok(E.play(g, H('CAT', 7, 6), isWord).ok);
  assert.strictEqual(g.turn, (start + 1) % 4);
  E.resign(g, (start + 2) % 4);
  E.pass(g);
  assert.strictEqual(g.turn, (start + 3) % 4);
  E.pass(g);
  assert.strictEqual(g.turn, start);
});

test('cross-words are formed and scored; invalid cross-word rejected', () => {
  const g = fresh(); const a = g.turn;
  give(g, a, 'CATSXYZ'); E.play(g, H('CAT', 7, 6), isWord);
  const b = g.turn;
  give(g, b, 'AEIOUNS');
  // Hang "AN" down from the A at (7,7)? place N below A -> "AN"
  const r = E.evaluate(g, [{ r: 8, c: 7, ch: 'N' }], isWord);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.words.map(w => w.word), ['AN']);
  const bad = E.evaluate(g, [{ r: 8, c: 7, ch: 'Q' }], isWord);
  assert.ok(!bad.ok);
});

test('premium only counts for freshly placed tiles', () => {
  const g = fresh(); const a = g.turn;
  give(g, a, 'CATSXYZ'); E.play(g, H('CAT', 7, 6), isWord); // DW on (7,7) used
  give(g, g.turn, 'ASEIOUN');
  // extend CAT -> CATS: S at (7,9); no premium there; score = 3+1+1+1 = 6, no DW again
  const r = E.evaluate(g, [{ r: 7, c: 9, ch: 'S' }], isWord);
  assert.ok(r.ok, r.error); assert.strictEqual(r.score, 6);
});

test('blank scores zero but forms a letter', () => {
  const g = fresh(); give(g, g.turn, 'C?TSXYZ');
  const r = E.evaluate(g, [{ r: 7, c: 6, ch: 'C' }, { r: 7, c: 7, ch: 'A', blank: true }, { r: 7, c: 8, ch: 'T' }], isWord);
  assert.ok(r.ok, r.error); assert.strictEqual(r.score, (3 + 0 + 1) * 2);
  const played = E.play(g, [{ r: 7, c: 6, ch: 'C' }, { r: 7, c: 7, ch: 'A', blank: true }, { r: 7, c: 8, ch: 'T' }], isWord);
  assert.ok(played.ok);
});

test('rejects tiles not in rack, gaps, non-collinear, disconnected', () => {
  const g = fresh(); give(g, g.turn, 'CATSXYZ');
  assert.ok(!E.play(g, H('DOG', 7, 6), isWord).ok);
  assert.ok(!E.evaluate(g, [{ r: 7, c: 6, ch: 'C' }, { r: 7, c: 8, ch: 'T' }], isWord).ok);
  assert.ok(!E.evaluate(g, [{ r: 7, c: 7, ch: 'A' }, { r: 8, c: 8, ch: 'T' }], isWord).ok);
  E.play(g, H('CAT', 7, 6), isWord);
  give(g, g.turn, 'DOGSXYZ');
  assert.ok(!E.evaluate(g, H('DOG', 0, 0), isWord).ok);
});

test('bingo bonus with seven tiles', () => {
  const g = fresh(); give(g, g.turn, 'QUARTER'.slice(0, 0) + 'STRANGE');
  const r = E.evaluate(g, H('STRANGE', 7, 1), isWord);
  assert.ok(r.ok, r.error); assert.ok(r.bingo); assert.ok(r.score >= 50);
});

test('swap needs 7 in bag; stall ends game after 2 rounds of passes with all racks deducted', () => {
  const g = fresh(4);
  assert.ok(E.swap(g, [0, 1]).ok);
  const g2 = fresh(4);
  for (let i = 0; i < 8; i++) { assert.ok(!g2.over); E.pass(g2); }
  assert.ok(g2.over); assert.strictEqual(g2.endReason, 'stalled');
  g2.players.forEach(p => assert.ok(p.score <= 0));
  const g3 = fresh(4); g3.bag = g3.bag.slice(0, 3);
  assert.ok(!E.swap(g3, [0]).ok);
});

test('going out ends the game: others deducted, out-player collects', () => {
  const g = fresh(4); g.bag = [];
  const a = g.turn;
  give(g, a, 'AT'); g.players.forEach((p, i) => { if (i !== a) p.rack = ['Q', 'Z']; });
  g.history.push({ type: 'play' }); // pretend board has had a play
  g.board[7][7] = { ch: 'C', blank: false };
  const r = E.play(g, [{ r: 7, c: 8, ch: 'A' }, { r: 7, c: 9, ch: 'T' }], isWord);
  assert.ok(r.ok, r.error); assert.ok(g.over); assert.strictEqual(g.endReason, 'out');
  const others = g.players.filter((_, i) => i !== a);
  others.forEach(p => assert.strictEqual(p.score, -20));
  assert.strictEqual(g.players[a].score, r.score + 60);
});

test('resign returns tiles to bag; last one standing ends the game', () => {
  const g = fresh(3); const before = g.bag.length;
  E.resign(g, 0);
  assert.strictEqual(g.bag.length, before + 7);
  assert.ok(!g.over);
  E.resign(g, 1);
  assert.ok(g.over); assert.strictEqual(g.endReason, 'resigned');
});

test('standings handle ties and resigned players', () => {
  const g = fresh(4);
  g.players[0].score = 30; g.players[1].score = 30; g.players[2].score = 10; g.players[3].score = 99; g.players[3].resigned = true;
  const s = E.standings(g);
  assert.deepStrictEqual(s.map(x => x.rank), [1, 1, 3, null]);
});

test('full random 4-player game with a greedy bot terminates and conserves tiles', () => {
  const g = fresh(4, 42); let guard = 0;
  while (!g.over && guard++ < 400) {
    const p = g.players[g.turn];
    let moved = false;
    // try a handful of single-tile and two-tile extensions from letters on board; otherwise pass
    outer: for (let r = 0; r < 15 && !moved; r++) for (let c = 0; c < 15 && !moved; c++) {
      if (g.board[r][c]) continue;
      for (const t of new Set(p.rack)) {
        if (t === '?') continue;
        const pl = [{ r, c, ch: t }];
        if (E.evaluate(g, pl, isWord).ok && E.play(g, pl, isWord).ok) { moved = true; break outer; }
      }
    }
    if (!moved && g.history.every(h => h.type !== 'play')) {
      const rk = p.rack.join(''); for (const w of ['CAT','AT','TO','IN','ON','AN','IT','OR','ARE','EAR']) {
        const pl = H(w, 7, 6); if (E.evaluate(g, pl, isWord).ok && E.play(g, pl, isWord).ok) { moved = true; break; }
      }
    }
    if (!moved) E.pass(g);
  }
  assert.ok(g.over, 'game should end');
  const onBoard = g.board.flat().filter(Boolean).length;
  const held = g.players.reduce((s, p) => s + p.rack.length, 0);
  assert.strictEqual(onBoard + held + g.bag.length, 100);
});

console.log('\n' + passed + ' tests passed');
