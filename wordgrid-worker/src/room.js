/*
 * Wordgrid room logic: lobby, seats, tokens and commands. Pure functions over a
 * JSON-safe `room` object — no Cloudflare APIs — so it is unit-testable in Node.
 * The Durable Object in index.js loads/saves the room and fans out views.
 *
 * Credentials (all random, 128-bit):
 *   inviteToken  in the invite link; lets a new player take a free seat (lobby only)
 *   seat token   issued per seat on join; identifies that seat for the WebSocket and
 *                lets the same browser rejoin after the game starts
 */
import Engine from '../../games/wordgrid/engine.js';
import ICONS from '../../games/wordgrid/icons.js';

export const MAX_NAME = 14;

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

function pickIcon(room, wanted, exceptSeat) {
  const taken = new Set(room.seats.filter((s) => s.seat !== exceptSeat).map((s) => s.icon));
  if (ICONS.includes(wanted) && !taken.has(wanted)) return wanted;
  return ICONS.find((i) => !taken.has(i)) || ICONS[0];
}

export function newRoom({ maxSeats, name, icon }) {
  const seats = Number(maxSeats);
  if (!Number.isInteger(seats) || seats < Engine.MIN_PLAYERS || seats > Engine.MAX_PLAYERS)
    return { ok: false, error: 'Rooms hold ' + Engine.MIN_PLAYERS + '–' + Engine.MAX_PLAYERS + ' players.' };
  const room = { phase: 'lobby', maxSeats: seats, inviteToken: randomToken(), seats: [], game: null, createdAt: Date.now() };
  const host = addSeat(room, name, icon);
  return { ok: true, room, seat: host.seat, token: host.token, inviteToken: room.inviteToken };
}

function addSeat(room, name, icon) {
  const seat = room.seats.length;
  const entry = {
    seat,
    token: randomToken(),
    name: uniqueName(room, cleanName(name) || 'Player ' + (seat + 1), seat),
    icon: pickIcon(room, icon, seat)
  };
  room.seats.push(entry);
  return entry;
}

/* req: { invite?, token?, name, icon }. A matching seat token always reclaims its seat
 * (name/icon may be edited in the lobby); otherwise a valid invite takes the next free seat. */
export function join(room, req) {
  req = req || {};
  const existing = room.seats.find((s) => same(s.token, req.token));
  if (existing) {
    if (room.phase === 'lobby') {
      const nm = cleanName(req.name);
      if (nm) existing.name = uniqueName(room, nm, existing.seat);
      existing.icon = pickIcon(room, req.icon || existing.icon, existing.seat);
    }
    return { ok: true, seat: existing.seat, token: existing.token, name: existing.name, icon: existing.icon, rejoined: true };
  }
  if (!same(room.inviteToken, req.invite)) return { ok: false, status: 403, error: 'This invite link is not valid.' };
  if (room.phase !== 'lobby') return { ok: false, status: 409, error: 'This game has already started.' };
  if (room.seats.length >= room.maxSeats) return { ok: false, status: 409, error: 'This room is full.' };
  const e = addSeat(room, req.name, req.icon);
  return { ok: true, seat: e.seat, token: e.token, name: e.name, icon: e.icon, rejoined: false };
}

export function seatForToken(room, token) {
  const s = room.seats.find((x) => same(x.token, token));
  return s ? s.seat : -1;
}

function sanitizePlacements(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > Engine.RACK) return null;
  const out = [];
  for (const p of raw) {
    if (!p || !Number.isInteger(p.r) || !Number.isInteger(p.c) || typeof p.ch !== 'string' || !/^[A-Z]$/.test(p.ch)) return null;
    out.push({ r: p.r, c: p.c, ch: p.ch, blank: p.blank === true });
  }
  return out;
}

function startGame(room) {
  const g = Engine.newGame(room.seats.map((s) => s.name));
  room.game = Engine.serialize(g);
  room.phase = 'playing';
}

/* msg: {type: start|play|pass|swap|resign|rematch, ...}. Mutates room on success.
 * Returns {ok:true, event?} or {ok:false, error}. */
export function command(room, seat, msg, isWord) {
  if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'Bad message.' };

  if (msg.type === 'start' || msg.type === 'rematch') {
    if (seat !== 0) return { ok: false, error: 'Only the host can do that.' };
    if (msg.type === 'start' && room.phase !== 'lobby') return { ok: false, error: 'The game has already started.' };
    if (msg.type === 'rematch' && room.phase !== 'over') return { ok: false, error: 'The game is not over yet.' };
    if (room.seats.length < Engine.MIN_PLAYERS) return { ok: false, error: 'Wait for at least one more player.' };
    startGame(room);
    return { ok: true };
  }

  if (room.phase !== 'playing') return { ok: false, error: 'There is no game in progress.' };
  const g = Engine.restore(room.game);
  let res;

  if (msg.type === 'resign') {
    res = Engine.resign(g, seat);
  } else {
    if (g.turn !== seat) return { ok: false, error: 'It is not your turn.' };
    if (msg.type === 'play') {
      const pl = sanitizePlacements(msg.placements);
      if (!pl) return { ok: false, error: 'Bad placement.' };
      res = Engine.play(g, pl, isWord);
    } else if (msg.type === 'pass') {
      res = Engine.pass(g);
    } else if (msg.type === 'swap') {
      const idx = Array.isArray(msg.indices) ? msg.indices.filter((i) => Number.isInteger(i)) : [];
      res = Engine.swap(g, idx);
    } else {
      return { ok: false, error: 'Unknown command.' };
    }
  }
  if (!res.ok) return { ok: false, error: res.error };
  room.game = Engine.serialize(g);
  if (g.over) room.phase = 'over';
  return { ok: true };
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
    seats: room.seats.map((s) => ({ seat: s.seat, name: s.name, icon: s.icon, connected: conn.has(s.seat) })),
    game: null
  };
  if (seat === 0 && room.phase === 'lobby') v.invite = room.inviteToken;
  if (room.game) v.game = Engine.publicView(Engine.restore(room.game), seat);
  return v;
}
