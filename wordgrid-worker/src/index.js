/*
 * verdict-cat-wordgrid — online rooms for the Wordgrid game.
 *
 *   Auth model:
 *     sync key       the same key as the sync worker, checked by asking that worker (service
 *                    binding SYNC). Only the host ever holds it; it is needed only to CREATE a
 *                    room (and /ping). Nothing to configure on this Worker.
 *     invite token   in the invite link; lets a friend take a free seat.
 *     seat token     per seat; identifies that player for the WebSocket and rejoining.
 *
 *   POST /rooms           key    {seats, name, icon} -> {roomId, seat, token, invite}
 *   POST /r/:id/join      -      {invite | token, name, icon} -> {seat, token, name, icon}
 *   GET  /r/:id/ws?t=...  seat   WebSocket: server pushes {type:'state'}; client sends commands
 *   GET  /ping            key    check a key
 */
import { DurableObject } from 'cloudflare:workers';
import WORDS from '../../games/wordgrid/enable.txt';
import { newRoom, join, command, view, seatForToken } from './room.js';

// Dictionary lookup without parsing 173k words into a Set (a cold start would
// burn CPU): one substring scan of the newline-delimited, upper-case list.
const WORD_TEXT = '\n' + WORDS.trim() + '\n';
const isWord = (w) => WORD_TEXT.includes('\n' + w + '\n');

const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{24}$/;
const MAX_MESSAGE = 8 * 1024;

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return { origin: null, ok: true };
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { origin, ok: list.includes(origin) };
}

function corsHeaders(request, env) {
  const { origin, ok } = allowedOrigin(request, env);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (origin && ok) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request, env) }
  });
}

// Is the presented key the sync key? Returns 'ok' | 'bad' | 'down'.
//  - Normally the sync worker decides, through the SYNC service binding (its /ping checks the
//    bearer key). The key is never copied into this Worker, so there is no secret to set here
//    and rotating the sync key needs no change here.
//  - If a SYNC_KEY secret is set on this Worker it is compared directly instead (local dev, tests).
async function keyCheck(request, env) {
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given) return 'bad';
  if (env.SYNC_KEY) {
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
      crypto.subtle.digest('SHA-256', enc.encode(given)),
      crypto.subtle.digest('SHA-256', enc.encode(env.SYNC_KEY))
    ]);
    return crypto.subtle.timingSafeEqual(a, b) ? 'ok' : 'bad';
  }
  if (!env.SYNC) return 'down';
  try {
    const r = await env.SYNC.fetch('https://sync.internal/ping', { headers: { Authorization: 'Bearer ' + given } });
    if (r.status === 200) return 'ok';
    return r.status === 401 || r.status === 403 ? 'bad' : 'down';
  } catch {
    return 'down';
  }
}

// null when the key is fine, otherwise the error response to send.
async function rejectKey(request, env) {
  const k = await keyCheck(request, env);
  if (k === 'ok') return null;
  if (k === 'down') return json(request, env, { error: 'Could not check the key right now. Try again in a moment.' }, 503);
  return json(request, env, { error: 'Bad key.' }, 401);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: origin.ok ? 204 : 403, headers: corsHeaders(request, env) });
    if (!origin.ok) return json(request, env, { error: 'Origin not allowed.' }, 403);

    if (url.pathname === '/ping' && request.method === 'GET') {
      return (await rejectKey(request, env)) || json(request, env, { ok: true });
    }

    if (url.pathname === '/rooms' && request.method === 'POST') {
      const denied = await rejectKey(request, env);
      if (denied) return denied;
      let body;
      try { body = await request.json(); } catch { return json(request, env, { error: 'Bad JSON.' }, 400); }
      const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
      const roomId = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      const res = await stub.init(body || {});
      if (!res.ok) return json(request, env, { error: res.error }, 400);
      return json(request, env, { roomId, seat: res.seat, token: res.token, invite: res.invite, name: res.name, icon: res.icon }, 201);
    }

    const m = url.pathname.match(/^\/r\/([a-f0-9]{24})\/(join|ws)$/);
    if (m && ID_RE.test(m[1])) {
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      if (m[2] === 'join' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json(request, env, { error: 'Bad JSON.' }, 400); }
        const res = await stub.join(body || {});
        if (!res.ok) return json(request, env, { error: res.error }, res.status || 400);
        return json(request, env, res);
      }
      if (m[2] === 'ws') return stub.fetch(request);
    }

    return json(request, env, { error: 'Not found.' }, 404);
  }
};

export class Room extends DurableObject {
  async load() {
    if (this.room === undefined) this.room = (await this.ctx.storage.get('room')) || null;
    return this.room;
  }

  async save() {
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async init(body) {
    if (await this.load()) return { ok: false, error: 'Room already exists.' };
    const r = newRoom({ maxSeats: body.seats, name: body.name, icon: body.icon });
    if (!r.ok) return r;
    this.room = r.room;
    await this.save();
    const host = this.room.seats[0];
    return { ok: true, seat: r.seat, token: r.token, invite: r.inviteToken, name: host.name, icon: host.icon };
  }

  async join(body) {
    const room = await this.load();
    if (!room) return { ok: false, status: 404, error: 'Room not found.' };
    const res = join(room, body);
    if (res.ok) { await this.save(); this.broadcast(); }
    return res;
  }

  connectedSeats(exclude) {
    const set = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (a && Number.isInteger(a.seat)) set.add(a.seat);
    }
    return set;
  }

  broadcast(exclude) {
    if (!this.room) return;
    const connected = this.connectedSeats(exclude);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (!a) continue;
      try { ws.send(JSON.stringify(view(this.room, a.seat, connected))); } catch { /* socket gone */ }
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const room = await this.load();
    if (!room) return new Response('Room not found.', { status: 404 });
    const seat = seatForToken(room, new URL(request.url).searchParams.get('t'));
    if (seat < 0) return new Response('Bad seat token.', { status: 401 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ seat });
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment();
    const room = await this.load();
    if (!a || !room || typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg && msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
    const res = command(room, a.seat, msg, isWord);
    if (!res.ok) { ws.send(JSON.stringify({ type: 'error', message: res.error })); return; }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closed */ }
    this.broadcast(ws);
  }

  async webSocketError(ws) {
    this.broadcast(ws);
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'Room expired'); } catch { /* ignore */ } }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
