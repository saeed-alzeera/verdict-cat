/*
 * Ludo room logic: lobby, seats (people and bots), tokens, commands and the automatic
 * steps (bot turns, auto-roll for idle players). Pure functions over a JSON-safe `room`
 * object, with the clock passed in, so it is unit-testable in Node. The Durable Object in
 * ludo-do.js loads/saves the room, runs `tick` from its alarm and fans out views.
 *
 * The server is the referee: it rolls the die (seeded RNG kept server-side), validates every
 * move and never sends the RNG state to clients.
 *
 * Credentials (random, 128-bit): same model as the Scrabble rooms.
 *   inviteToken  in the invite link; lets a new player take a free seat (lobby only)
 *   seat token   per human seat; identifies it for the WebSocket and lets it rejoin
 */
import Engine from '../../games/ludo/engine.js';

export const MAX_NAME = 14;
export const TURN_MS = 30000;          // an idle human is auto-played after this long
export const BOT_NAMES = ['Rex', 'Pip', 'Nova', 'Zed'];
export const LEVELS = ['easy', 'medium', 'hard'];

export function randomToken(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function cleanName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, MAX_NAME).join('');
}

function uniqueName(room, name, exceptSeat) {
  const taken = new Set(room.seats.filter((s) => s.seat !== exceptSeat).map((s) => s.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 10; n++) {
    const cand = Array.from(name).slice(0, MAX_NAME - 2).join('') + ' ' + n;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return name;
}

function addSeat(room, name, bot) {
  const seat = room.seats.length;
  const entry = {
    seat,
    token: bot ? null : randomToken(),
    name: uniqueName(room, cleanName(name) || (bot ? BOT_NAMES[seat % BOT_NAMES.length] : 'Player ' + (seat + 1)), seat),
    bot: bot || null
  };
  room.seats.push(entry);
  return entry;
}

export function newRoom({ maxSeats = Engine.MAX_PLAYERS, name, easyStart = false } = {}) {
  const seats = Number(maxSeats);
  if (!Number.isInteger(seats) || seats < Engine.MIN_PLAYERS || seats > Engine.MAX_PLAYERS)
    return { ok: false, error: 'Rooms hold ' + Engine.MIN_PLAYERS + '–' + Engine.MAX_PLAYERS + ' players.' };
  const room = { phase: 'lobby', maxSeats: seats, easyStart: easyStart === true, inviteToken: randomToken(), seats: [], game: null, seq: 0, ev: null, due: null, chat: [], createdAt: Date.now() };
  const host = addSeat(room, name, null);
  return { ok: true, room, seat: host.seat, token: host.token, inviteToken: room.inviteToken };
}

/* req: { invite?, token?, name }. A matching seat token always reclaims its seat (the name
 * may be edited in the lobby); otherwise a valid invite takes the next free seat. */
export function join(room, req) {
  req = req || {};
  const existing = room.seats.find((s) => !s.bot && same(s.token, req.token));
  if (existing) {
    if (room.phase === 'lobby') {
      const nm = cleanName(req.name);
      if (nm) existing.name = uniqueName(room, nm, existing.seat);
    }
    return { ok: true, seat: existing.seat, token: existing.token, name: existing.name, rejoined: true };
  }
  if (!same(room.inviteToken, req.invite)) return { ok: false, status: 403, error: 'This invite link is not valid.' };
  if (room.phase !== 'lobby') return { ok: false, status: 409, error: 'This game has already started.' };
  if (room.seats.length >= room.maxSeats) return { ok: false, status: 409, error: 'This room is full.' };
  const e = addSeat(room, req.name, null);
  return { ok: true, seat: e.seat, token: e.token, name: e.name, rejoined: false };
}

export function seatForToken(room, token) {
  const s = room.seats.find((x) => !x.bot && same(x.token, token));
  return s ? s.seat : -1;
}

function startGame(room, now) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] | 0;
  const g = Engine.newGame(room.seats.map((s) => ({ name: s.name, bot: s.bot })), { seed, easyStart: room.easyStart });
  room.game = Engine.serialize(g);
  room.phase = 'playing';
  room.ev = { seq: ++room.seq, type: 'start' };
  schedule(room, g, now, 600);
}

/* Decide when the next automatic step is due: bots, forced single moves and idle humans. */
function schedule(room, g, now, gap) {
  room.due = null;
  if (room.phase !== 'playing' || g.winner !== null) return;
  const p = g.players[g.turn];
  if (g.roll === null) {
    room.due = p.bot ? now + gap + 700 : now + TURN_MS;
  } else {
    const legal = Engine.legalMoves(g);
    room.due = p.bot || legal.length === 1 ? now + gap + 600 : now + TURN_MS;
  }
}

function doRoll(room, g, now) {
  const r = Engine.roll(g);
  room.ev = { seq: ++room.seq, type: 'roll', player: r.player, value: r.value, forfeited: !!r.forfeited, passed: !!r.passed, again: !!r.again };
  finishStep(room, g, now, 700);
}

function doMove(room, g, pawn, now) {
  const r = Engine.move(g, pawn);
  room.ev = {
    seq: ++room.seq, type: 'move', player: r.player, pawn: r.pawn, from: r.from, to: r.to, roll: r.roll,
    captured: r.captured, finished: r.finished, won: r.won, again: r.again
  };
  const steps = r.from < 0 ? 1 : r.to - r.from;
  finishStep(room, g, now, steps * 150 + (r.captured.length ? 700 : 300));
}

function finishStep(room, g, now, gap) {
  room.game = Engine.serialize(g);
  if (g.winner !== null) room.phase = 'over';
  schedule(room, g, now, gap);
}

/* msg: {type: start|addBot|removeBot|roll|move|rematch, ...}. Mutates room on success.
 * Returns {ok:true} or {ok:false, error}. */
export function command(room, seat, msg, now = Date.now()) {
  if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'Bad message.' };
  const host = seat === 0;

  if (msg.type === 'chat') {
    const clean = String(msg.text == null ? '' : msg.text).replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim();
    const t = Array.from(clean).slice(0, 120).join('');
    if (!t) return { ok: false, error: 'Say something first.' };
    const me = room.seats[seat];
    if (me.lastChat && now - me.lastChat < 600) return { ok: false, error: 'Slow down a little.' };
    me.lastChat = now;
    room.chat = (room.chat || []).concat([{ seat, name: me.name, text: t, ts: now }]).slice(-40);
    return { ok: true, chat: true };
  }
  if (msg.type === 'addBot') {
    if (!host) return { ok: false, error: 'Only the host can do that.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'The game has already started.' };
    if (room.seats.length >= room.maxSeats) return { ok: false, error: 'The room is full.' };
    const level = LEVELS.includes(msg.level) ? msg.level : 'medium';
    addSeat(room, BOT_NAMES[(room.seats.length - 1) % BOT_NAMES.length], level);
    return { ok: true };
  }
  if (msg.type === 'removeBot') {
    if (!host) return { ok: false, error: 'Only the host can do that.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'The game has already started.' };
    const s = room.seats[msg.seat];
    if (!s || !s.bot) return { ok: false, error: 'That seat is not a bot.' };
    room.seats.splice(s.seat, 1);
    room.seats.forEach((x, i) => { x.seat = i; });
    return { ok: true };
  }
  if (msg.type === 'start' || msg.type === 'rematch') {
    if (!host) return { ok: false, error: 'Only the host can do that.' };
    if (msg.type === 'start' && room.phase !== 'lobby') return { ok: false, error: 'The game has already started.' };
    if (msg.type === 'rematch' && room.phase !== 'over') return { ok: false, error: 'The game is not over yet.' };
    if (room.seats.length < Engine.MIN_PLAYERS) return { ok: false, error: 'Add a bot or wait for another player.' };
    startGame(room, now);
    return { ok: true };
  }

  if (room.phase !== 'playing') return { ok: false, error: 'There is no game in progress.' };
  const g = Engine.restore(room.game);
  if (g.turn !== seat) return { ok: false, error: 'It is not your turn.' };
  if (g.players[seat].bot) return { ok: false, error: 'Bad seat.' };

  if (msg.type === 'roll') {
    if (g.roll !== null) return { ok: false, error: 'Move a pawn first.' };
    doRoll(room, g, now);
    return { ok: true };
  }
  if (msg.type === 'move') {
    if (g.roll === null) return { ok: false, error: 'Roll the die first.' };
    if (!Number.isInteger(msg.pawn) || !Engine.legalMoves(g).includes(msg.pawn)) return { ok: false, error: 'That pawn cannot move.' };
    doMove(room, g, msg.pawn, now);
    return { ok: true };
  }
  return { ok: false, error: 'Unknown command.' };
}

/* Run the automatic step if it is due. Returns true when the room changed. */
export function tick(room, now = Date.now()) {
  if (room.phase !== 'playing' || !room.due || now < room.due) return false;
  const g = Engine.restore(room.game);
  const p = g.players[g.turn];
  if (g.roll === null) { doRoll(room, g, now); return true; }
  const legal = Engine.legalMoves(g);
  const pick = legal.length === 1 ? legal[0] : Engine.chooseMove(g, p.bot || 'medium');
  doMove(room, g, pick, now);
  return true;
}

/* The view for one seat. `connected` is a Set of seat numbers with an open socket. */
export function view(room, seat, connected) {
  const conn = connected || new Set();
  const v = {
    type: 'state',
    phase: room.phase,
    you: seat,
    host: 0,
    maxSeats: room.maxSeats,
    seats: room.seats.map((s) => ({ seat: s.seat, name: s.name, bot: s.bot, connected: s.bot ? true : conn.has(s.seat) })),
    game: null,
    ev: room.ev,
    due: room.due,
    turnMs: TURN_MS,
    easyStart: !!room.easyStart,
    chat: room.chat || []
  };
  if (seat === 0 && room.phase === 'lobby') v.invite = room.inviteToken;
  if (room.game) {
    const g = Engine.restore(room.game);
    v.game = {
      turn: g.turn, roll: g.roll, sixes: g.sixes, winner: g.winner,
      players: g.players.map((p, i) => ({ name: room.seats[i] ? room.seats[i].name : p.name, color: p.color, bot: p.bot, pawns: p.pawns, captures: p.captures, lost: p.lost })),
      legal: g.turn === seat && g.roll !== null ? Engine.legalMoves(g) : []
    };
  }
  return v;
}
