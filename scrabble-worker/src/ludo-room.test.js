// Run: node scrabble-worker/src/ludo-room.test.js
import assert from 'node:assert';
import Engine from '../../games/ludo/engine.js';
import { newRoom, join, command, tick, view, seatForToken, TURN_MS } from './ludo-room.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

function lobby(maxSeats = 4) {
  const r = newRoom({ maxSeats, name: 'Host' });
  assert.ok(r.ok);
  return { room: r.room, host: r };
}
function guest(room, name = 'Guest') {
  const j = join(room, { invite: room.inviteToken, name });
  assert.ok(j.ok, j.error);
  return j;
}
const T0 = 1_000_000;

test('rooms hold 2 to 4 seats', () => {
  assert.ok(!newRoom({ maxSeats: 5 }).ok);
  assert.ok(!newRoom({ maxSeats: 1 }).ok);
  assert.ok(newRoom({ maxSeats: 2 }).ok);
});

test('joining needs the invite; a seat token rejoins; full and started rooms refuse', () => {
  const { room } = lobby(2);
  assert.strictEqual(join(room, { invite: 'nope', name: 'X' }).ok, false);
  const g = guest(room);
  assert.strictEqual(g.seat, 1);
  assert.strictEqual(join(room, { token: g.token }).seat, 1);        // rejoin by token
  assert.strictEqual(join(room, { invite: room.inviteToken, name: 'Late' }).status, 409); // full
  assert.strictEqual(seatForToken(room, g.token), 1);
  assert.strictEqual(seatForToken(room, 'bad'), -1);
});

test('names are cleaned and made unique', () => {
  const { room } = lobby();
  const a = guest(room, '<b>Host</b>');
  assert.ok(!/[<>]/.test(a.name));
  assert.notStrictEqual(a.name.toLowerCase(), 'host');
});

test('only the host can add bots, start, or rematch', () => {
  const { room } = lobby();
  const g = guest(room);
  assert.strictEqual(command(room, g.seat, { type: 'addBot' }, T0).ok, false);
  assert.strictEqual(command(room, g.seat, { type: 'start' }, T0).ok, false);
  assert.ok(command(room, 0, { type: 'addBot', level: 'hard' }, T0).ok);
  assert.strictEqual(room.seats[2].bot, 'hard');
});

test('starting needs two seats; bots count as seats', () => {
  const { room } = lobby();
  assert.strictEqual(command(room, 0, { type: 'start' }, T0).ok, false);
  command(room, 0, { type: 'addBot' }, T0);
  assert.ok(command(room, 0, { type: 'start' }, T0).ok);
  assert.strictEqual(room.phase, 'playing');
});

test('bots can be removed in the lobby and seats renumber', () => {
  const { room } = lobby();
  command(room, 0, { type: 'addBot' }, T0); command(room, 0, { type: 'addBot' }, T0);
  const g = guest(room);
  assert.strictEqual(g.seat, 3);
  assert.ok(command(room, 0, { type: 'removeBot', seat: 1 }, T0).ok);
  assert.deepStrictEqual(room.seats.map((s) => s.seat), [0, 1, 2]);
  assert.strictEqual(seatForToken(room, g.token), 2);
  assert.strictEqual(command(room, 0, { type: 'removeBot', seat: 0 }, T0).ok, false);
});

function started(extra = 1) {
  const { room, host } = lobby();
  for (let i = 0; i < extra; i++) command(room, 0, { type: 'addBot', level: 'easy' }, T0);
  command(room, 0, { type: 'start' }, T0);
  return { room, host };
}

test('commands out of turn or out of order are refused', () => {
  const { room } = started(1);          // seat 0 human, seat 1 bot
  assert.strictEqual(command(room, 0, { type: 'move', pawn: 0 }, T0).ok, false); // must roll first
  assert.strictEqual(command(room, 1, { type: 'roll' }, T0).ok, false);          // a bot seat cannot be driven
  assert.ok(command(room, 0, { type: 'roll' }, T0).ok);
  assert.strictEqual(command(room, 0, { type: 'roll' }, T0).ok === true && Engine.restore(room.game).roll !== null, false);
});

test('human roll then move works and the view lists legal pawns only to the mover', () => {
  const { room } = started(1);
  // force a 6 for seat 0 by retrying seeds
  let g;
  for (let i = 0; i < 500; i++) {
    const s = started(1); g = Engine.restore(s.room.game);
    if (command(s.room, 0, { type: 'roll' }, T0).ok && Engine.restore(s.room.game).roll === 6) {
      const v0 = view(s.room, 0);
      assert.deepStrictEqual(v0.game.legal, [0, 1, 2, 3]);
      assert.deepStrictEqual(view(s.room, 1).game.legal, []);
      assert.strictEqual(command(s.room, 0, { type: 'move', pawn: 9 }, T0).ok, false);
      assert.ok(command(s.room, 0, { type: 'move', pawn: 2 }, T0).ok);
      assert.strictEqual(s.room.ev.type, 'move');
      assert.strictEqual(Engine.restore(s.room.game).players[0].pawns[2], 0);
      return;
    }
  }
  assert.fail('never rolled a 6');
});

test('the view never leaks the RNG or tokens', () => {
  const { room } = started(1);
  const v = JSON.stringify(view(room, 0));
  assert.ok(!v.includes('rng'));
  assert.ok(!v.includes(room.seats[0].token));
  assert.ok(!v.includes(room.inviteToken));      // host sees it only in the lobby
});

test('the invite token is shown to the host in the lobby only', () => {
  const { room } = lobby();
  assert.strictEqual(view(room, 0).invite, room.inviteToken);
  const g = guest(room);
  assert.strictEqual(view(room, g.seat).invite, undefined);
});

test('tick does nothing before the due time and runs bot turns after it', () => {
  const { room } = started(1);
  const g0 = Engine.restore(room.game);
  assert.strictEqual(g0.turn, 0);        // human first
  assert.strictEqual(tick(room, T0), false);   // not due yet (human has TURN_MS)
  // idle human gets auto-played
  const due = room.due;
  assert.ok(due > T0 && due <= Date.now() + TURN_MS + 10);
  assert.strictEqual(tick(room, due - 1), false);
  assert.strictEqual(tick(room, due), true);
  assert.ok(room.ev.type === 'roll');
});

test('bot-only follow-up: after the human, bots act on ticks until it is a human turn again', () => {
  const { room } = started(1);
  let now = room.due, guard = 0, bot_acted = false;
  while (room.phase === 'playing' && guard++ < 50000) {
    const g = Engine.restore(room.game);
    if (g.turn === 1) bot_acted = true;
    assert.ok(room.due, 'a due time is always set while playing');
    now = Math.max(now, room.due);
    tick(room, now);
  }
  assert.ok(bot_acted);
  assert.strictEqual(room.phase, 'over');
  assert.strictEqual(room.due, null);
  assert.ok(view(room, 0).game.winner !== null);
});

test('only the host can rematch, and only after the game is over', () => {
  const { room } = started(1);
  assert.strictEqual(command(room, 0, { type: 'rematch' }, T0).ok, false);
  let now = room.due;
  while (room.phase === 'playing') { now = Math.max(now, room.due); tick(room, now); }
  assert.ok(command(room, 0, { type: 'rematch' }, now).ok);
  assert.strictEqual(room.phase, 'playing');
});

test('four seats mixing a joined player and bots play to the end', () => {
  const { room } = lobby();
  const g = guest(room);
  command(room, 0, { type: 'addBot', level: 'hard' }, T0);
  command(room, 0, { type: 'addBot', level: 'medium' }, T0);
  assert.ok(command(room, 0, { type: 'start' }, T0).ok);
  assert.strictEqual(Engine.restore(room.game).players.length, 4);
  let now = T0, guard = 0;
  while (room.phase === 'playing' && guard++ < 50000) { now = Math.max(now, room.due); tick(room, now); }
  assert.strictEqual(room.phase, 'over');
  assert.ok([0, 1, 2, 3].includes(Engine.restore(room.game).winner));
});

console.log(passed + ' tests passed');
