/* One Durable Object per Ludo room: stores the room, fans out per-seat views over WebSockets
 * and runs the automatic steps (bots, forced moves, idle players) from its alarm. */
import { DurableObject } from 'cloudflare:workers';
import { newRoom, join, command, tick, view, seatForToken } from './ludo-room.js';

const ROOM_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE = 2 * 1024;

export class LudoRoom extends DurableObject {
  async load() {
    if (this.room === undefined) this.room = (await this.ctx.storage.get('room')) || null;
    return this.room;
  }

  async save() {
    this.room.expireAt = Date.now() + ROOM_TTL_MS;
    await this.ctx.storage.put('room', this.room);
    const next = this.room.due && this.room.phase === 'playing' ? Math.min(this.room.due, this.room.expireAt) : this.room.expireAt;
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  async inviteFor(token) {
    const room = await this.load();
    if (!room) return { ok: false, status: 404, error: 'Room not found.' };
    const seat = seatForToken(room, token);
    if (seat < 0) return { ok: false, status: 403, error: 'Not your room.' };
    if (room.phase !== 'lobby') return { ok: false, status: 409, error: 'The game has already started.' };
    return { ok: true, invite: room.inviteToken, from: room.seats[seat].name };
  }

  async init(body) {
    if (await this.load()) return { ok: false, error: 'Room already exists.' };
    const r = newRoom({ maxSeats: body.seats, name: body.name });
    if (!r.ok) return r;
    this.room = r.room;
    await this.save();
    return { ok: true, seat: r.seat, token: r.token, invite: r.inviteToken, name: this.room.seats[0].name };
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
      const seat = seatForToken(this.room, a.token);   // seats renumber when a bot is removed
      if (seat < 0) continue;
      try { ws.send(JSON.stringify(view(this.room, seat, connected))); } catch { /* socket gone */ }
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const room = await this.load();
    if (!room) return new Response('Room not found.', { status: 404 });
    const token = new URL(request.url).searchParams.get('t');
    const seat = seatForToken(room, token);
    if (seat < 0) return new Response('Bad seat token.', { status: 401 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ seat, token });
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
    const seat = seatForToken(room, a.token);
    if (seat < 0) return;
    const res = command(room, seat, msg, Date.now());
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
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    if (room.due && room.phase === 'playing' && now >= room.due) {
      if (tick(room, now)) { await this.save(); this.broadcast(); }
      return;
    }
    if (now >= (room.expireAt || 0)) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'Room expired'); } catch { /* ignore */ } }
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.save();
  }
}
