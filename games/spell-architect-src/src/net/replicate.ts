// Host side of the world replication. Every SNAP_HZ the host describes the simulation to each joiner:
//   * one `Me` datagram per joiner: its own authoritative state (for prediction and the HUD) plus the globals
//   * the shared `World` datagrams (floor, telegraphs, wizards, enemies, spell/bullet/pickup/zone sprites), cut into
//     independent <= DGRAM byte slices; every record carries a stable id, so a lost slice only delays those entities
//   * the cosmetic effects recorded since the last tick (particles, rings, damage numbers, sounds) on the `fx` channel
// Nothing here looks at the Phaser scene graph: records come from the simulation's own entities, so there is one source of
// truth for what exists and which sprite it uses (ids are stable per entity, not per pooled image).
import Phaser from 'phaser';
import { audio } from '../core/audio';
import { BOSSES } from '../game/bosses';
import { FxKind, type FxEv } from '../game/fx';
import { tintKey } from '../game/render';
import type { Run } from '../game/run';
import type { Img } from '../game/types';
import { TEXTURE_ID } from '../gfx/textures';
import { BOSS_BASE, DGRAM, E, ELEMENT_IDS, ETYPES, HDR, K, O, PHASES, POS, S, SFX_IDS, SFX_NET, SNAP_HZ } from './proto';
import { clamp, Writer } from './wire';

void BOSSES;

export interface GuestView { id: string; shell: Run; echo: number; echoAt: number }
export interface Out { st(id: string, buf: ArrayBuffer): void; fx(id: string, buf: ArrayBuffer): void; ready(id: string): boolean }

const TWO_PI = Math.PI * 2;
const MAX_FX_QUEUE = 400;
const q = (v: number) => clamp(Math.round(v * POS), -32768, 32767);

/** Splits records into datagrams of at most DGRAM bytes, grouped in blocks of one section. */
class Packer {
  out: Uint8Array[] = [];
  private w = new Writer(DGRAM + 64);
  private blockAt = -1; private blockSec = 0; private blockN = 0;
  constructor(private kind: K, private seq: number, private ts: number) { this.begin(); }
  private begin() {
    this.w.reset();
    this.w.u8(this.kind); this.w.u16(this.seq); this.w.u32(this.ts); this.w.u8(0); this.w.u8(0);
    this.blockAt = -1;
  }
  private closeBlock() {
    if (this.blockAt >= 0) this.w.buf[this.blockAt + 1] = this.blockN;
    this.blockAt = -1;
  }
  private flush() {
    this.closeBlock();
    if (this.w.pos > HDR) { const b = this.w.buf.slice(0, this.w.pos); b[7] = this.out.length; this.out.push(b); }
    this.begin();
  }
  rec(sec: number, size: number, write: (w: Writer) => void) {
    if (this.blockAt < 0 || this.blockSec !== sec || this.blockN >= 255 || this.w.pos + size > DGRAM) {
      this.closeBlock();
      if (this.w.pos + 2 + size > DGRAM) this.flush();
      this.blockAt = this.w.pos; this.blockSec = sec; this.blockN = 0;
      this.w.u8(sec); this.w.u8(0);
    }
    write(this.w);
    this.blockN++;
  }
  finish(): ArrayBuffer[] {
    this.flush();
    const n = this.out.length;
    return this.out.map((b) => { b[8] = n; return b.buffer as ArrayBuffer; }); // flush() already copied each datagram into its own buffer
  }
}

export class Replicator {
  seq = 0;
  private acc = 0;
  private fxQ: FxEv[] = [];
  private sfxQ: number[] = [];
  /** Bytes sent since the last stats reset, by class (for the net HUD / tests). */
  stats = { snaps: 0, stBytes: 0, fxBytes: 0, meBytes: 0, worldBytes: 0, worldDgrams: 0, skipped: 0, lastWorld: 0, lastDgrams: 0, enemies: 0, imgs: 0, fxEvents: 0, fxDropped: 0, cpuSum: 0, cpuMax: 0 };

  constructor(private run: Run, private out: Out) {
    run.fx.rec = (ev) => { if (this.fxQ.length < MAX_FX_QUEUE || (ev[0] !== FxKind.Spark && this.fxQ.length < 4 * MAX_FX_QUEUE)) this.fxQ.push(ev); else this.stats.fxDropped++; };
    audio.tap = (n) => { if (SFX_NET.has(n) && this.sfxQ.length < 24) { const i = SFX_IDS.indexOf(n); if (i >= 0 && !this.sfxQ.includes(i)) this.sfxQ.push(i); } };
  }

  destroy() { this.run.fx.rec = null; audio.tap = null; }

  /** Called once per host frame with the real elapsed time (seconds). Sends a snapshot when one is due. */
  frame(dt: number, now: number, guests: GuestView[]) {
    this.acc += dt;
    const step = 1 / SNAP_HZ;
    if (this.acc < step * 0.98) return;
    this.acc = Math.min(this.acc - step, step); // keep the cadence but never build a burst after a hitch
    if (!guests.length) { this.fxQ.length = 0; this.sfxQ.length = 0; return; }
    const t0 = performance.now();
    this.send(now, guests);
    const ms = performance.now() - t0;
    this.stats.cpuSum += ms; if (ms > this.stats.cpuMax) this.stats.cpuMax = ms;
  }

  private send(now: number, guests: GuestView[]) {
    const seq = (this.seq = (this.seq + 1) & 0xffff);
    const ts = now >>> 0;
    const st = this.stats;
    st.snaps++;
    // ---- shared world slices
    const pk = new Packer(K.World, seq, ts);
    this.packWorld(pk);
    const world = pk.finish();
    st.lastWorld = world.reduce((n, b) => n + b.byteLength, 0); st.lastDgrams = world.length; st.worldDgrams += world.length;
    // ---- effects
    const fx = this.packFx(ts);
    for (const g of guests) {
      if (!this.out.ready(g.id)) { st.skipped++; continue; } // channel backed up: a stale frame is worth nothing
      for (const b of world) { this.out.st(g.id, b); st.stBytes += b.byteLength; st.worldBytes += b.byteLength; }
      const me = this.packMe(g, seq, ts, now);
      this.out.st(g.id, me); st.stBytes += me.byteLength; st.meBytes += me.byteLength;
      for (const b of fx) { this.out.fx(g.id, b); st.fxBytes += b.byteLength; }
    }
  }

  /* ---------------------------------------------------------------- world */

  private packWorld(pk: Packer) {
    const run = this.run;
    const a = run.arena;
    // floor: 2 bits per tile + timers of the tiles that are cracking
    const n = a.state.length;
    const timers: number[] = [];
    for (let i = 0; i < n; i++) if (a.state[i] === 1 || a.state[i] === 2) timers.push(i);
    pk.rec(S.Floor, 31 + 1 + timers.length * 2, (w) => {
      const bytes = new Uint8Array(31);
      for (let i = 0; i < n; i++) bytes[i >> 2] |= (a.state[i] & 3) << ((i & 3) * 2);
      for (const b of bytes) w.u8(b);
      w.u8(a.active ? 1 : 0);
      w.u8(timers.length);
      for (const i of timers) { w.u8(i); w.u8(clamp(Math.round(a.timer[i] * 50), 0, 255)); }
    });
    for (const t of run.tels) {
      if (t.dead) continue;
      pk.rec(S.Tels, 22, (w) => {
        w.u16(t.id); w.u8(['circle', 'line', 'ring', 'windup'].indexOf(t.shape)); w.i16(q(t.x)); w.i16(q(t.y));
        w.u16(clamp(Math.round(t.r * 4), 0, 65535)); w.i16(clamp(Math.round(t.ang * 8000), -32768, 32767));
        w.u16(clamp(Math.round(t.len * 4), 0, 65535)); w.u16(clamp(Math.round(t.w * 4), 0, 65535));
        w.u16(clamp(Math.round(t.t * 1000), 0, 65535)); w.u16(clamp(Math.round(t.total * 1000), 0, 65535)); w.u24(t.color);
      });
    }
    for (const pr of run.players) {
      const p = pr.player;
      pk.rec(S.Players, 6, (w) => {
        w.u8(pr.pid);
        w.u8((pr.down ? 1 : 0) | (Math.hypot(pr.input.x, pr.input.y) > 0.1 ? 2 : 0) | (p.hurtFlash > 0 ? 4 : 0) | (p.inv > 0 ? 8 : 0) | (p.faceX < 0 ? 16 : 0));
        w.i16(q(p.x)); w.i16(q(p.y));
      });
    }
    let ne = 0;
    for (const e of run.enemies) {
      if (e.dead) continue;
      ne++;
      pk.rec(S.Enemies, 12, (w) => {
        w.u16(e.id);
        w.u8(e.type === 'boss' && e.boss ? BOSS_BASE + e.boss.kind : Math.max(0, ETYPES.indexOf(e.type as typeof ETYPES[number])));
        w.u8((e.face < 0 ? 1 : 0) | (e.elite ? 2 : 0) | (e.badge ? 4 : 0));
        w.u8(tintKey(e));
        w.u8(e.aff === 'neutral' ? 0 : ELEMENT_IDS.indexOf(e.aff) + 1);
        w.i16(q(e.x)); w.i16(q(e.y));
        w.u8(clamp(Math.round(e.sc * 32), 0, 255));
        w.u8(clamp(Math.round(e.spawnT * 500), 0, 255));
      });
    }
    this.stats.enemies = ne;
    let ni = 0;
    for (const e of run.ents) {
      if (e.dead) continue;
      ni += this.img(pk, O.Ent, e.id, 0, e.spr);
      ni += this.img(pk, O.Ent, e.id, 1, e.spr2);
      for (let i = 0; i < e.deco.length && i < 6; i++) ni += this.img(pk, O.Ent, e.id, 2 + i, e.deco[i]);
    }
    for (const b of run.bullets) if (!b.dead) ni += this.img(pk, O.Bullet, b.id, 0, b.spr);
    for (const k of run.pickups) if (!k.dead) ni += this.img(pk, O.Pickup, k.id, 0, k.spr);
    for (const z of run.zones) if (!z.dead) ni += this.img(pk, O.Zone, z.id, 0, z.spr);
    this.stats.imgs = ni;
  }

  /** One sprite owned by a world object. Returns 1 when it was written. */
  private img(pk: Packer, kind: O, id: number, slot: number, im: Img | null): number {
    if (!im || !im.visible || im.alpha < 0.02) return 0;
    const tex = TEXTURE_ID.get(im.texture.key);
    if (tex === undefined) return 0;
    const sy = im.scaleY !== im.scaleX;
    let rot = im.rotation % TWO_PI; if (rot < 0) rot += TWO_PI;
    const hasRot = rot > 0.0005 && rot < TWO_PI - 0.0005;
    const tinted = im.isTinted;
    const origin = im.originX === 0 ? 1 : im.originX === 1 ? 2 : 0;
    pk.rec(S.Imgs, 13 + (sy ? 2 : 0) + (hasRot ? 2 : 0) + (tinted ? 3 : 0), (w) => {
      w.u16(id);
      w.u8(kind | (slot << 2) | (origin << 5));
      w.u8(tex);
      w.u8(clamp(Math.round(im.depth * 8), 0, 255));
      w.i16(q(im.x)); w.i16(q(im.y));
      w.i16(clamp(Math.round(im.scaleX * 128), -32768, 32767));
      w.u8((im.blendMode === Phaser.BlendModes.ADD ? 1 : 0) | (im.flipX ? 2 : 0) | (im.flipY ? 4 : 0) | (sy ? 8 : 0) | (hasRot ? 16 : 0) | (tinted ? 32 : 0) | (tinted && im.tintFill ? 64 : 0));
      w.u8(Math.round(clamp(im.alpha, 0, 1) * 255));
      if (sy) w.i16(clamp(Math.round(im.scaleY * 128), -32768, 32767));
      if (hasRot) w.u16(Math.round((rot / TWO_PI) * 65535));
      if (tinted) w.u24(im.tintTopLeft & 0xffffff);
    });
    return 1;
  }

  /* ---------------------------------------------------------------- me */

  private packMe(g: GuestView, seq: number, ts: number, now: number): ArrayBuffer {
    const run = this.run;
    const sh = g.shell;
    const p = sh.player;
    const w = new Writer(256);
    w.u8(K.Me); w.u16(seq); w.u32(ts); w.u8(0); w.u8(1);
    const boss = run.boss && !run.boss.dead && run.boss.boss ? run.boss : null;
    const pull = p.pullT > 0;
    w.u8((run.frozen && run.phase === 'fight' && !run.over ? 1 : 0) | (sh.down ? 2 : 0) | (run.quick ? 4 : 0) | (run.arena.active ? 8 : 0) | (boss ? 16 : 0) | (p.hurtFlash > 0 ? 32 : 0) | (p.inv > 0 ? 64 : 0) | (pull ? 128 : 0));
    w.u32(g.echo); w.u16(clamp(Math.round(now - g.echoAt), 0, 65535)); w.u16(sh.cmdAck);
    w.f32(p.x); w.f32(p.y); w.f32(p.vx); w.f32(p.vy); w.f32(p.speed);
    if (pull) { w.f32(p.pullT); w.f32(p.pullX); w.f32(p.pullY); }
    w.f32(p.hp); w.f32(p.maxHp); w.f32(p.xp); w.f32(p.xpNeed); w.u16(p.level); w.f32(sh.coins);
    w.f32(run.time); w.f32(run.roundElapsed); w.u8(run.round); w.u8(Math.max(0, PHASES.indexOf(run.phase))); w.u16(Math.min(65535, run.players.reduce((n, q2) => n + q2.kills, 0)));
    if (boss) { w.u8(boss.boss!.kind); w.f32(boss.hp); w.f32(boss.maxHp); }
    w.u8(sh.spells.length);
    for (const s of sh.spells) { w.u16(clamp(Math.round(s.cd * 100), 0, 65535)); w.u8(clamp(s.live, 0, 255)); w.u16(clamp(Math.round(s.ultCd * 10), 0, 65535)); }
    w.u8(run.players.length);
    for (const pr of run.players) { w.u8(pr.pid); w.u16(clamp(Math.round(pr.player.hp), 0, 65535)); w.u16(clamp(Math.round(pr.player.maxHp), 0, 65535)); w.u8(pr.down ? 1 : 0); }
    return w.bytes();
  }

  /* ---------------------------------------------------------------- effects */

  private packFx(ts: number): ArrayBuffer[] {
    const evs = this.fxQ; this.fxQ = [];
    const sfx = this.sfxQ; this.sfxQ = [];
    if (!evs.length && !sfx.length) return [];
    this.stats.fxEvents += evs.length;
    const outs: ArrayBuffer[] = [];
    let w = new Writer(DGRAM + 64);
    let nAt = 0, n = 0;
    const begin = () => { w.reset(); w.u8(K.Fx); w.u32(ts); nAt = w.pos; w.u8(0); n = 0; };
    const flush = () => { if (!n) return; w.buf[nAt] = n; outs.push(w.bytes()); begin(); };
    begin();
    const room = (need: number) => { if (w.pos + need > DGRAM || n >= 255) flush(); };
    for (const s of sfx) { room(2); w.u8(E.Sfx); w.u8(s); n++; }
    for (const ev of evs) {
      room(40);
      switch (ev[0]) {
        case FxKind.Burst:
          w.u8(ev[0]); w.i16(q(ev[1])); w.i16(q(ev[2])); w.u24(ev[3]); w.u8(clamp(ev[4], 0, 255)); w.u16(clamp(Math.round(ev[5]), 0, 65535));
          w.u8(clamp(Math.round(ev[6] * 100), 0, 255)); w.u8(clamp(Math.round(ev[7] * 40), 0, 255)); w.i16(clamp(Math.round(ev[8]), -32768, 32767)); w.u8(clamp(Math.round(ev[9] * 10), 0, 255)); break;
        case FxKind.Spark:
          w.u8(ev[0]); w.i16(q(ev[1])); w.i16(q(ev[2])); w.i16(clamp(Math.round(ev[3]), -32768, 32767)); w.i16(clamp(Math.round(ev[4]), -32768, 32767));
          w.u24(ev[5]); w.u8(clamp(Math.round(ev[6] * 100), 0, 255)); w.u8(clamp(Math.round(ev[7] * 40), 0, 255)); w.i16(clamp(Math.round(ev[8]), -32768, 32767)); w.u8(TEXTURE_ID.get(ev[9]) ?? 0); break;
        case FxKind.Ring:
          w.u8(ev[0]); w.i16(q(ev[1])); w.i16(q(ev[2])); w.u24(ev[3]); w.u16(clamp(Math.round(ev[4]), 0, 65535)); w.u16(clamp(Math.round(ev[5]), 0, 65535));
          w.u8(clamp(Math.round(ev[6] * 100), 0, 255)); w.u8(clamp(Math.round(ev[7] * 255), 0, 255)); break;
        case FxKind.Bolt:
          w.u8(ev[0]); w.i16(q(ev[1])); w.i16(q(ev[2])); w.i16(q(ev[3])); w.i16(q(ev[4])); w.u24(ev[5]); w.u8(clamp(Math.round(ev[6]), 0, 255)); w.u8(clamp(Math.round(ev[7] * 100), 0, 255)); break;
        case FxKind.Text:
          w.u8(ev[0]); w.i16(q(ev[1])); w.i16(q(ev[2])); w.u24(ev[4]); w.u8(clamp(Math.round(ev[5]), 0, 255)); w.u8(clamp(Math.round(ev[6] * 50), 0, 255)); w.i8(clamp(Math.round(ev[7]), -128, 127)); w.str(ev[3].slice(0, 40)); break;
        case FxKind.Shake: w.u8(ev[0]); w.u8(clamp(Math.round(ev[1] * 10), 0, 255)); break;
        case FxKind.Flash: w.u8(ev[0]); w.u16(clamp(ev[1], 0, 65535)); w.u24(ev[2]); break;
      }
      n++;
    }
    flush();
    return outs;
  }
}
