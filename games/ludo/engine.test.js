// Run: node games/ludo/engine.test.js
const assert = require('assert');
const E = require('./engine.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }
function game(n = 4, seed = 1) {
  return E.newGame(['A', 'B', 'C', 'D'].slice(0, n).map(name => ({ name })), { seed });
}
// put the game in "current player has rolled v"
function setRoll(g, v) { g.roll = v; return g; }

test('ring has 52 unique, adjacent squares and closes up', () => {
  const R = E.RING_CELLS, key = c => c.join(',');
  assert.strictEqual(R.length, 52);
  assert.strictEqual(new Set(R.map(key)).size, 52);
  let diagonals = 0;
  for (let i = 0; i < 52; i++) {
    const a = R[i], b = R[(i + 1) % 52];
    const dr = Math.abs(a[0] - b[0]), dc = Math.abs(a[1] - b[1]);
    assert.ok(Math.max(dr, dc) === 1, 'gap at ' + i);
    if (dr + dc === 2) diagonals++;   // the four corner turns around the centre block
  }
  assert.strictEqual(diagonals, 4);
});

test('colours start 13 apart and every cell sits on a plus-shaped board', () => {
  E.COLORS.forEach((c, i) => assert.strictEqual(c.start, i * 13));
  E.RING_CELLS.forEach(([r, c]) => assert.ok((r >= 6 && r <= 8) || (c >= 6 && c <= 8)));
});

test('home columns are 5 distinct cells off the ring leading to the centre', () => {
  const ring = new Set(E.RING_CELLS.map(c => c.join(',')));
  E.COLORS.forEach((_, ci) => {
    const cells = [51, 52, 53, 54, 55].map(p => E.cellOf(ci, p));
    assert.strictEqual(new Set(cells.map(c => c.join(','))).size, 5);
    cells.forEach(c => assert.ok(!ring.has(c.join(','))));
    assert.deepStrictEqual(E.cellOf(ci, 56), [7, 7]);
    // the last column cell touches the 3x3 centre block
    const [r, c] = cells[4];
    assert.strictEqual(Math.abs(r - 7) + Math.abs(c - 7), 2);
  });
});

test('player counts: 2 players sit opposite, 5 is rejected', () => {
  const g = game(2);
  assert.deepStrictEqual(g.players.map(p => p.color), [0, 2]);
  assert.throws(() => game(1));
  assert.throws(() => E.newGame(new Array(5).fill({ name: 'x' })));
});

test('only a 6 releases a pawn, and it lands on the start square', () => {
  const g = game();
  assert.deepStrictEqual(E.legalMoves(setRoll(g, 5)), []);
  assert.deepStrictEqual(E.legalMoves(setRoll(g, 6)), [0, 1, 2, 3]);
  const r = E.move(g, 2);
  assert.strictEqual(g.players[0].pawns[2], 0);
  assert.strictEqual(r.again, true);
  assert.strictEqual(g.turn, 0);
});

test('no legal move passes the turn; a non-6 clears the roll', () => {
  const g = game();
  const r = E.roll(g, 3);
  assert.ok(r.passed);
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(g.roll, null);
});

test('a normal move advances and passes the turn', () => {
  const g = game();
  g.players[0].pawns[0] = 10;
  setRoll(g, 4);
  const r = E.move(g, 0);
  assert.strictEqual(g.players[0].pawns[0], 14);
  assert.strictEqual(r.again, false);
  assert.strictEqual(g.turn, 1);
});

test('three sixes in a row forfeit the turn', () => {
  const g = game();
  assert.ok(!E.roll(g, 6).forfeited); E.move(g, 0);
  assert.ok(!E.roll(g, 6).forfeited); E.move(g, 1);
  const third = E.roll(g, 6);
  assert.ok(third.forfeited);
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(g.roll, null);
  assert.strictEqual(g.sixes, 0);
});

test('capture on a non-safe square sends the enemy home and counts it', () => {
  const g = game();
  // blue pos 20 => ring 20. yellow (start 13) pos 7 => ring 20.
  g.players[0].pawns[0] = 17;
  g.players[1].pawns[0] = 7;
  setRoll(g, 3);
  const r = E.move(g, 0);
  assert.strictEqual(r.captured.length, 1);
  assert.strictEqual(g.players[1].pawns[0], -1);
  assert.strictEqual(g.players[0].captures, 1);
  assert.strictEqual(g.players[1].lost, 1);
});

test('safe squares never capture (stars and starts)', () => {
  [8, 21, 34, 47, 0, 13, 26, 39].forEach(i => assert.ok(E.isSafe(0, (i - 0 + 52) % 52 <= 50 ? i : 0) || i > 50));
  const g = game();
  g.players[0].pawns[0] = 5;           // ring 5
  g.players[1].pawns[0] = 8 - 13 + 52; // yellow pos 47 => ring (13+47)%52 = 8 (a star)
  setRoll(g, 3);                        // blue to ring 8
  const r = E.move(g, 0);
  assert.strictEqual(r.captured.length, 0);
  assert.strictEqual(g.players[1].pawns[0], 47);
});

test('own pawns stack and do not capture each other', () => {
  const g = game();
  g.players[0].pawns[0] = 10; g.players[0].pawns[1] = 14;
  setRoll(g, 4);
  const r = E.move(g, 0);
  assert.strictEqual(r.captured.length, 0);
  assert.strictEqual(g.players[0].pawns[1], 14);
});

test('pawns in the home column cannot be captured and never cross another colour', () => {
  const g = game();
  g.players[0].pawns[0] = 49;
  setRoll(g, 3); E.move(g, 0);          // to 52, home column
  assert.strictEqual(g.players[0].pawns[0], 52);
  // an enemy on ring square equal to blue's 52 does not exist: columns are off-ring
  assert.ok(g.players[0].pawns[0] > 50);
});

test('exact roll needed to finish', () => {
  const g = game();
  g.players[0].pawns = [54, -1, -1, -1];
  assert.deepStrictEqual(E.legalMoves(setRoll(g, 3)), []);
  assert.deepStrictEqual(E.legalMoves(setRoll(g, 2)), [0]);
  const r = E.move(g, 0);
  assert.strictEqual(r.finished, true);
  assert.strictEqual(g.players[0].pawns[0], 56);
});

test('winning needs all four pawns home and ends the game', () => {
  const g = game();
  g.players[0].pawns = [56, 56, 56, 55];
  setRoll(g, 1);
  const r = E.move(g, 3);
  assert.ok(r.won);
  assert.strictEqual(g.winner, 0);
  assert.deepStrictEqual(E.legalMoves(g), []);
  assert.throws(() => E.roll(g));
});

test('illegal moves are rejected', () => {
  const g = game();
  setRoll(g, 4);
  assert.throws(() => E.move(g, 0));
  g.roll = null;
  assert.throws(() => E.move(g, 0));
});

test('same seed gives the same rolls; state round-trips through JSON', () => {
  const a = game(4, 42), b = game(4, 42);
  const ra = [], rb = [];
  for (let i = 0; i < 20; i++) { ra.push(E.roll(a).value); rb.push(E.roll(b).value); if (a.roll) E.move(a, E.legalMoves(a)[0]); if (b.roll) E.move(b, E.legalMoves(b)[0]); }
  assert.deepStrictEqual(ra, rb);
  const c = E.restore(E.serialize(a));
  assert.deepStrictEqual(c, a);
});

test('die is fair-ish over many rolls', () => {
  const g = game(4, 7), counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6000; i++) { g.roll = null; g.sixes = 0; counts[E.roll(g).value]++; g.turn = 0; g.roll = null; }
  for (let v = 1; v <= 6; v++) assert.ok(counts[v] > 800 && counts[v] < 1200, 'face ' + v + ' ' + counts[v]);
});

test('bots always pick a legal move and capture when it is free (medium/hard)', () => {
  ['easy', 'medium', 'hard'].forEach(level => {
    const g = game(4, 3);
    for (let i = 0; i < 500 && g.winner === null; i++) {
      const r = E.roll(g);
      if (g.roll !== null) {
        const m = E.chooseMove(g, level);
        assert.ok(E.legalMoves(g).includes(m));
        E.move(g, m);
      }
    }
  });
  ['medium', 'hard'].forEach(level => {
    const g = game();
    g.players[0].pawns = [17, -1, -1, -1];
    g.players[1].pawns = [7, -1, -1, -1]; // ring 20, non-safe
    g.players[0].pawns[1] = 30;
    setRoll(g, 3);
    let hit = 0;
    for (let i = 0; i < 20; i++) if (E.chooseMove(g, level, () => 0.9) === 0) hit++;
    assert.strictEqual(hit, 20);
  });
});

test('bot-only games finish for every level and player count', () => {
  [2, 3, 4].forEach(n => ['easy', 'medium', 'hard'].forEach(level => {
    const g = E.newGame(new Array(n).fill(0).map((_, i) => ({ name: 'B' + i, bot: level })), { seed: n * 11 });
    let guard = 0;
    while (g.winner === null && guard++ < 20000) {
      E.roll(g);
      if (g.roll !== null) E.move(g, E.chooseMove(g, g.players[g.turn].bot));
    }
    assert.notStrictEqual(g.winner, null, n + ' players ' + level + ' did not finish');
  }));
});

console.log(passed + ' tests passed');
