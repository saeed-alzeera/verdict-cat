/*
 * Multiplayer signaling for Spell Architect (public, no sync key).
 *
 * The game's co-op mode is peer-to-peer over WebRTC; this only hands out room
 * codes and carries the connection handshake (SDP offers/answers) between the
 * host and each guest. No game data ever passes through here.
 *
 *   POST /mp/rooms                       -> { code, hostKey }
 *   GET  /mp/rooms/:code                 -> { open, players, max, names }
 *   POST /mp/rooms/:code/join            { name } -> { peerId, peerKey, hostName }
 *   POST /mp/rooms/:code/signal          { as, key, to, kind, data }
 *   GET  /mp/rooms/:code/signal?as=&key=&after=&wait=   -> { msgs, peers, closed }
 *   POST /mp/rooms/:code/close           { key }          (host only)
 *
 * `as` / `to` are "host" or a peer id. The host authenticates with the
 * `hostKey` it got at creation, each guest with the `peerKey` it got at join.
 * Rooms expire two hours after creation.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_RE = /^[A-Z2-9]{5}$/;
export const MAX_PLAYERS = 4; // host + 3 guests
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SIGNAL_BYTES = 24 * 1024;
const MAILBOX_CAP = 60;
const MAX_WAIT_MS = 20000;
const KINDS = new Set(['offer', 'answer', 'ice', 'bye']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
}
const fail = (status, message) => json({ error: message }, status);

const randHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
function randCode() {
  const r = crypto.getRandomValues(new Uint8Array(5));
  return [...r].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, 16) || 'Mage';

/** Room logic, independent of the Durable Object so it can be unit-tested. `storage` needs get/put/deleteAll/setAlarm. */
export class MPRoomCore {
  constructor(storage) {
    this.storage = storage;
    this.room = null;
    this.loaded = false;
    this.waiters = [];
  }

  async load() {
    if (this.loaded) return;
    this.room = (await this.storage.get('room')) || null;
    this.loaded = true;
  }
  async save() { await this.storage.put('room', this.room); }

  async create(hostKey, now = Date.now()) {
    await this.load();
    if (this.room) return { ok: false };
    this.room = { hostKey, created: now, closed: false, nextId: 1, seq: 0, peers: {}, boxes: { host: [] } };
    await this.save();
    await this.storage.setAlarm(now + ROOM_TTL_MS);
    return { ok: true };
  }

  async info() {
    await this.load();
    const r = this.room;
    if (!r) return null;
    const names = Object.values(r.peers).map((p) => p.name);
    return { open: !r.closed && Object.keys(r.peers).length + 1 < MAX_PLAYERS, players: names.length + 1, max: MAX_PLAYERS, names };
  }

  async join(name) {
    await this.load();
    const r = this.room;
    if (!r) return { error: 'No such room', status: 404 };
    if (r.closed) return { error: 'Room is closed', status: 410 };
    if (Object.keys(r.peers).length + 1 >= MAX_PLAYERS) return { error: 'Room is full', status: 409 };
    const peerId = String(r.nextId++);
    const peerKey = randHex(16);
    r.peers[peerId] = { name: cleanName(name), key: peerKey };
    r.boxes[peerId] = [];
    await this.save();
    this.wake('host');
    return { peerId, peerKey };
  }

  authed(as, key) {
    const r = this.room;
    if (!r) return false;
    if (as === 'host') return same(key, r.hostKey);
    const p = r.peers[as];
    return !!p && same(key, p.key);
  }

  async signal(as, key, to, kind, data) {
    await this.load();
    const r = this.room;
    if (!r) return { error: 'No such room', status: 404 };
    if (!this.authed(as, key)) return { error: 'Bad key', status: 401 };
    if (!KINDS.has(kind)) return { error: 'Bad kind', status: 400 };
    if (typeof data !== 'string' || data.length > MAX_SIGNAL_BYTES) return { error: 'Bad data', status: 400 };
    if (!r.boxes[to]) return { error: 'No such peer', status: 404 };
    // guests only talk to the host; the host talks to anyone
    if (as !== 'host' && to !== 'host') return { error: 'Guests signal the host only', status: 403 };
    const box = r.boxes[to];
    box.push({ n: ++r.seq, from: as, kind, data });
    while (box.length > MAILBOX_CAP) box.shift();
    await this.save();
    this.wake(to);
    return { ok: true };
  }

  view(as, after) {
    const r = this.room;
    const msgs = (r.boxes[as] || []).filter((m) => m.n > after);
    const out = { msgs, closed: r.closed };
    if (as === 'host') out.peers = Object.fromEntries(Object.entries(r.peers).map(([id, p]) => [id, p.name]));
    return out;
  }

  wake(to) {
    this.waiters = this.waiters.filter((w) => { if (w.to === to) { w.done(); return false; } return true; });
  }

  async poll(as, key, after = 0, waitMs = 0) {
    await this.load();
    const r = this.room;
    if (!r) return { error: 'No such room', status: 404 };
    if (!this.authed(as, key)) return { error: 'Bad key', status: 401 };
    let v = this.view(as, after);
    if (!v.msgs.length && !v.closed && waitMs > 0) {
      await new Promise((resolve) => {
        const w = { to: as, done: () => { clearTimeout(t); resolve(); } };
        const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(); }, Math.min(MAX_WAIT_MS, waitMs));
        this.waiters.push(w);
      });
      v = this.view(as, after);
    }
    return v;
  }

  async close(key) {
    await this.load();
    const r = this.room;
    if (!r) return { error: 'No such room', status: 404 };
    if (!this.authed('host', key)) return { error: 'Bad key', status: 401 };
    r.closed = true;
    await this.save();
    for (const id of Object.keys(r.boxes)) this.wake(id);
    return { ok: true };
  }

  async expire() {
    await this.load();
    this.room = null;
    await this.storage.deleteAll();
  }
}

// Crude per-isolate throttle on room creation (a determined abuser can spread over isolates; rooms are tiny and expire).
const creates = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (creates.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 12) { creates.set(ip, list); return true; }
  list.push(now); creates.set(ip, list);
  if (creates.size > 5000) creates.clear();
  return false;
}

/** Routes /mp/*. `env.MP` is the MPRoom Durable Object namespace. */
export async function handleMp(request, env, parts) {
  const method = request.method;
  if (parts[1] !== 'rooms') return fail(404, 'Not found');
  const stubFor = (code) => env.MP.get(env.MP.idFromName(code));

  if (parts.length === 2 && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (throttled(ip)) return fail(429, 'Too many rooms created, try again later');
    for (let i = 0; i < 6; i++) {
      const code = randCode();
      const hostKey = randHex(16);
      const res = await stubFor(code).create(hostKey, Date.now());
      if (res.ok) return json({ code, hostKey });
    }
    return fail(503, 'Could not allocate a room');
  }

  const code = (parts[2] || '').toUpperCase();
  if (!CODE_RE.test(code)) return fail(400, 'Bad room code');
  const stub = stubFor(code);
  const sub = parts[3];

  const body = async () => { try { return await request.json(); } catch { return null; } };
  const reply = (r) => (r && r.error ? fail(r.status || 400, r.error) : json(r));

  if (parts.length === 3 && method === 'GET') {
    const info = await stub.info();
    return info ? json(info) : fail(404, 'No such room');
  }
  if (sub === 'join' && method === 'POST') {
    const b = await body();
    const r = await stub.join(b && b.name);
    return reply(r);
  }
  if (sub === 'signal' && method === 'POST') {
    const b = await body();
    if (!b) return fail(400, 'Invalid JSON');
    return reply(await stub.signal(String(b.as ?? ''), String(b.key ?? ''), String(b.to ?? ''), String(b.kind ?? ''), b.data));
  }
  if (sub === 'signal' && method === 'GET') {
    const u = new URL(request.url);
    const after = Math.max(0, Number(u.searchParams.get('after')) || 0);
    const wait = Math.max(0, Number(u.searchParams.get('wait')) || 0);
    return reply(await stub.poll(u.searchParams.get('as') || '', u.searchParams.get('key') || '', after, wait));
  }
  if (sub === 'close' && method === 'POST') {
    const b = await body();
    return reply(await stub.close(String((b && b.key) ?? '')));
  }
  return fail(404, 'Not found');
}
