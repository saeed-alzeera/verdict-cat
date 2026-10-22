// Run: node wordgrid-worker/src/room.test.js
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Engine from '../../games/wordgrid/engine.js';
import { newRoom, join, command, view, seatForToken, cleanName } from './room.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TEXT = '\n' + fs.readFileSync(path.join(dir, '../../games/wordgrid/enable.txt'), 'utf8').trim() + '\n';
const isWord = (w) => TEXT.includes('\n' + w + '\n');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

function lobby(seats = 4) {
  const r = newRoom({ maxSeats: seats, name: 'Host', icon: '🦊' });
  assert.ok(r.ok);
  return { room: r.room, hostToken: r.token, invite: r.inviteToken };
}

test('room sizes limited to 2–4', () => {
  assert.ok(!newRoom({ maxSeats: 1 }).ok);
  assert.ok(!newRoom({ maxSeats: 5 }).ok);
  assert.ok(newRoom({ maxSeats: 3, name: 'a' }).ok);
});

test('join needs the invite, fills seats in order, rejects when full', () => {
  const { room, invite } = lobby(3);
  assert.strictEqual(join(room, { invite: 'nope', name: 'x' }).status, 403);
  const a = join(room, { invite, name: 'Bea', icon: '🐼' });
  const b = join(room, { invite, name: 'Cy', icon: '🐙' });
  assert.deepStrictEqual([a.seat, b.seat], [1, 2]);
  const full = join(room, { invite, name: 'Dee' });
  assert.strictEqual(full.status, 409);
});

test('names are sanitised and made unique; taken icons are swapped for a free one', () => {
  const { room, invite } = lobby(4);
  const a = join(room, { invite, name: '  <b>Host</b> ', icon: '🦊' });
  assert.ok(!/[<>]/.test(a.name));
  const dup = join(room, { invite, name: 'Host', icon: '🦊' });
  assert.notStrictEqual(dup.name.toLowerCase(), 'host');
  assert.notStrictEqual(dup.icon, '🦊');
  assert.strictEqual(cleanName('x'.repeat(40)).length, 14);
  assert.strictEqual(cleanName(null), '');
});

test('a seat token reclaims the seat; invite not needed; lobby allows profile edits', () => {
  const { room, invite } = lobby(4);
  const a = join(room, { invite, name: 'Bea', icon: '🐼' });
  const again = join(room, { token: a.token, name: 'Beatrice', icon: '🐝' });
  assert.ok(again.ok && again.rejoined && again.seat === a.seat);
  assert.strictEqual(again.name, 'Beatrice');
  assert.strictEqual(room.seats.length, 2);
  assert.strictEqual(seatForToken(room, a.token), 1);
  assert.strictEqual(seatForToken(room, 'bad'), -1);
});

test('only host starts; needs 2+; no new joins after start but rejoin works', () => {
  const { room, invite, hostToken } = lobby(4);
  assert.ok(!command(room, 0, { type: 'start' }, isWord).ok);           // alone
  const a = join(room, { invite, name: 'Bea' });
  assert.ok(!command(room, 1, { type: 'start' }, isWord).ok);           // not host
  assert.ok(command(room, 0, { type: 'start' }, isWord).ok);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(join(room, { invite, name: 'Late' }).status, 409);
  const back = join(room, { token: a.token, name: 'Renamed' });
  assert.ok(back.ok && back.name === 'Bea');                           // profile locked once playing
  assert.strictEqual(seatForToken(room, hostToken), 0);
});

test('turn enforcement and a full move through the command layer', () => {
  const { room, invite } = lobby(4);
  join(room, { invite, name: 'B' }); join(room, { invite, name: 'C' }); join(room, { invite, name: 'D' });
  command(room, 0, { type: 'start' }, isWord);
  const turn = room.game.turn, other = (turn + 1) % 4;
  assert.ok(!command(room, other, { type: 'pass' }, isWord).ok);
  assert.ok(!command(room, turn, { type: 'play', placements: [{ r: 0, c: 0, ch: 'Q' }] }, isWord).ok);
  assert.ok(!command(room, turn, { type: 'play', placements: 'junk' }, isWord).ok);
  assert.ok(!command(room, turn, { type: 'play', placements: [{ r: '7', c: 7, ch: 'A' }] }, isWord).ok);
  assert.ok(command(room, turn, { type: 'pass' }, isWord).ok);
  assert.strictEqual(room.game.turn, other);
});

test('a real word can be played using the tiles dealt to that seat', () => {
  const { room, invite } = lobby(2);
  join(room, { invite, name: 'B' });
  command(room, 0, { type: 'start' }, isWord);
  const g = Engine.restore(room.game);
  g.players[g.turn].rack = 'CATSXYZ'.split('');
  room.game = Engine.serialize(g);
  const t = room.game.turn;
  const pl = [...'CAT'].map((ch, i) => ({ r: 7, c: 6 + i, ch }));
  const res = command(room, t, { type: 'play', placements: pl }, isWord);
  assert.ok(res.ok, res.error);
  assert.strictEqual(room.game.players[t].score, 10);
});

test('views hide other racks, the seed and the bag; host alone sees the invite in the lobby', () => {
  const { room, invite } = lobby(3);
  join(room, { invite, name: 'B' });
  assert.ok(view(room, 0).invite && !view(room, 1).invite);
  command(room, 0, { type: 'start' }, isWord);
  const v1 = view(room, 1, new Set([0, 1]));
  const raw = JSON.stringify(v1);
  assert.ok(!raw.includes('seed') && !raw.includes('"bag"') && !raw.includes(room.inviteToken));
  assert.strictEqual(v1.game.rack.length, 7);
  v1.game.players.forEach((p) => assert.ok(!('rack' in p)));
  assert.deepStrictEqual(v1.seats.map((s) => s.connected), [true, true]);
  assert.ok(!view(room, 0).invite);                                    // invite hidden once playing
});

test('resign works out of turn; game over then host can rematch', () => {
  const { room, invite } = lobby(2);
  join(room, { invite, name: 'B' });
  command(room, 0, { type: 'start' }, isWord);
  const notTurn = (room.game.turn + 1) % 2;
  assert.ok(command(room, notTurn, { type: 'resign' }, isWord).ok);
  assert.strictEqual(room.phase, 'over');
  assert.ok(!command(room, 1, { type: 'rematch' }, isWord).ok);
  assert.ok(command(room, 0, { type: 'rematch' }, isWord).ok);
  assert.strictEqual(room.phase, 'playing');
  assert.ok(room.game.players.every((p) => !p.resigned && p.score === 0));
});

test('room survives a JSON round trip (as the Durable Object stores it)', () => {
  const { room, invite } = lobby(4);
  join(room, { invite, name: 'B' });
  command(room, 0, { type: 'start' }, isWord);
  const copy = JSON.parse(JSON.stringify(room));
  const t = copy.game.turn;
  assert.ok(command(copy, t, { type: 'pass' }, isWord).ok);
});

console.log('\n' + n + ' tests passed');
