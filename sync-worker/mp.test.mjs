// node --test sync-worker/mp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MPRoomCore, handleMp, MAX_PLAYERS } from './mp.js';

function memStorage() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, deleteAll: async () => m.clear(), setAlarm: async () => {}, m };
}
// A fake Durable Object namespace: one MPRoomCore per name.
function fakeEnv() {
  const rooms = new Map();
  return { rooms, MP: { idFromName: (n) => n, get: (id) => { if (!rooms.has(id)) rooms.set(id, new MPRoomCore(memStorage())); return rooms.get(id); } } };
}
const call = async (env, method, path, body) => {
  const url = 'https://x.test' + path;
  const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'CF-Connecting-IP': '1.2.3.' + Math.floor(Math.random() * 250) } });
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const res = await handleMp(req, env, parts);
  return { status: res.status, body: await res.json() };
};

test('create, info, join, signal both ways', async () => {
  const env = fakeEnv();
  const c = await call(env, 'POST', '/mp/rooms');
  assert.equal(c.status, 200);
  assert.match(c.body.code, /^[A-Z2-9]{5}$/);
  const { code, hostKey } = c.body;
  const info = await call(env, 'GET', `/mp/rooms/${code}`);
  assert.deepEqual(info.body, { open: true, players: 1, max: MAX_PLAYERS, names: [] });
  const j = await call(env, 'POST', `/mp/rooms/${code}/join`, { name: '<b>Bob</b>' });
  assert.equal(j.status, 200);
  assert.equal(j.body.peerId, '1');
  // guest -> host offer, host sees it and the peer name (sanitised)
  const off = await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: '1', key: j.body.peerKey, to: 'host', kind: 'offer', data: 'SDP-OFFER' });
  assert.equal(off.status, 200);
  const hp = await call(env, 'GET', `/mp/rooms/${code}/signal?as=host&key=${hostKey}&after=0`);
  assert.equal(hp.body.msgs.length, 1);
  assert.equal(hp.body.msgs[0].data, 'SDP-OFFER');
  assert.equal(hp.body.msgs[0].from, '1');
  assert.deepEqual(hp.body.peers, { 1: 'bBob/b' });
  // host answers; guest polls with `after` so it never sees old messages
  await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: 'host', key: hostKey, to: '1', kind: 'answer', data: 'SDP-ANSWER' });
  const gp = await call(env, 'GET', `/mp/rooms/${code}/signal?as=1&key=${j.body.peerKey}&after=0`);
  assert.equal(gp.body.msgs[0].data, 'SDP-ANSWER');
  const again = await call(env, 'GET', `/mp/rooms/${code}/signal?as=1&key=${j.body.peerKey}&after=${gp.body.msgs[0].n}`);
  assert.equal(again.body.msgs.length, 0);
});

test('keys, kinds, sizes and routing are enforced', async () => {
  const env = fakeEnv();
  const { code, hostKey } = (await call(env, 'POST', '/mp/rooms')).body;
  const a = (await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'A' })).body;
  const b = (await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'B' })).body;
  assert.equal((await call(env, 'GET', `/mp/rooms/${code}/signal?as=host&key=nope&after=0`)).status, 401);
  assert.equal((await call(env, 'GET', `/mp/rooms/${code}/signal?as=${a.peerId}&key=${b.peerKey}&after=0`)).status, 401, 'a guest cannot read another guest\'s mailbox');
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: a.peerId, key: a.peerKey, to: b.peerId, kind: 'ice', data: 'x' })).status, 403, 'guests may not signal each other');
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: 'host', key: hostKey, to: a.peerId, kind: 'evil', data: 'x' })).status, 400);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: 'host', key: hostKey, to: a.peerId, kind: 'ice', data: 'x'.repeat(30000) })).status, 400);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: 'host', key: hostKey, to: '99', kind: 'ice', data: 'x' })).status, 404);
  assert.equal((await call(env, 'GET', '/mp/rooms/abc')).status, 400);
  assert.equal((await call(env, 'GET', '/mp/rooms/ZZZZZ')).status, 404);
});

test('room fills up at the player cap and can be closed by the host only', async () => {
  const env = fakeEnv();
  const { code, hostKey } = (await call(env, 'POST', '/mp/rooms')).body;
  for (let i = 0; i < MAX_PLAYERS - 1; i++) assert.equal((await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'p' + i })).status, 200);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'late' })).status, 409);
  assert.equal((await call(env, 'GET', `/mp/rooms/${code}`)).body.open, false);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/close`, { key: 'wrong' })).status, 401);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/close`, { key: hostKey })).status, 200);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'x' })).status, 410);
});

test('a locked room refuses newcomers but lets existing players keep signalling', async () => {
  const env = fakeEnv();
  const { code, hostKey } = (await call(env, 'POST', '/mp/rooms')).body;
  const a = (await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'A' })).body;
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/lock`, { key: 'wrong' })).status, 401);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/lock`, { key: hostKey })).status, 200);
  assert.equal((await call(env, 'GET', `/mp/rooms/${code}`)).body.open, false);
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'late' })).status, 410);
  // the player who was already in can still send an offer (a reconnect) and the host receives it
  assert.equal((await call(env, 'POST', `/mp/rooms/${code}/signal`, { as: a.peerId, key: a.peerKey, to: 'host', kind: 'offer', data: 'again' })).status, 200);
  const r = await call(env, 'GET', `/mp/rooms/${code}/signal?as=host&key=${hostKey}&after=0`);
  assert.equal(r.body.msgs.length, 1);
  assert.equal(r.body.closed, false, 'a locked room is not a closed room');
});

test('long-poll wakes as soon as something happens, and times out otherwise', async () => {
  const env = fakeEnv();
  const { code, hostKey } = (await call(env, 'POST', '/mp/rooms')).body;
  const t0 = Date.now();
  const waiting = call(env, 'GET', `/mp/rooms/${code}/signal?as=host&key=${hostKey}&after=0&wait=5000`);
  let guest;
  setTimeout(async () => { guest = (await call(env, 'POST', `/mp/rooms/${code}/join`, { name: 'Z' })).body; }, 50);
  const joined = await waiting;
  assert.deepEqual(joined.body.peers, { 1: 'Z' }, 'a join wakes the host so it sees the new peer');
  assert.ok(Date.now() - t0 < 2000, 'woke early');
  // now wait for the offer
  const waiting2 = call(env, 'GET', `/mp/rooms/${code}/signal?as=host&key=${hostKey}&after=0&wait=5000`);
  setTimeout(() => call(env, 'POST', `/mp/rooms/${code}/signal`, { as: guest.peerId, key: guest.peerKey, to: 'host', kind: 'offer', data: 'hi' }), 50);
  const r = await waiting2;
  assert.equal(r.body.msgs.length, 1);
  const t1 = Date.now();
  const none = await call(env, 'GET', `/mp/rooms/${code}/signal?as=host&key=${hostKey}&after=99&wait=150`);
  assert.equal(none.body.msgs.length, 0);
  assert.ok(Date.now() - t1 >= 140);
});

test('expiry wipes the room', async () => {
  const env = fakeEnv();
  const { code } = (await call(env, 'POST', '/mp/rooms')).body;
  await env.rooms.get(code).expire();
  assert.equal((await call(env, 'GET', `/mp/rooms/${code}`)).status, 404);
});
