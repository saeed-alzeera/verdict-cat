// Joiner side of the world replication: a view-only copy of the host's world.
//   * decodes `World` slices into per-entity sample tracks (stable ids; entities missing from a *complete* snapshot are removed)
//   * draws everything slightly in the past (a short, adaptive interpolation buffer), except the joiner's own wizard, which is
//     predicted locally (predict.ts) and therefore never waits for the network
//   * plays the host's recorded effects (particles, rings, damage numbers, sounds) on its own Fx, at the moment the interpolated
//     world reaches them
// Receiving a packet only decodes numbers into plain arrays; Phaser objects are touched once per rendered frame, from a pool.
import Phaser from 'phaser';
import { audio } from '../core/audio';
import { drawTelegraph, type TelView } from '../game/draw';
import { BOSSES } from '../game/bosses';
import { EDEFS } from '../game/enemies';
import { FxKind, type FxEv } from '../game/fx';
import { applyTint, poseEnemy, poseWizard } from '../game/render';
import type { Run } from '../game/run';
import type { Img } from '../game/types';
import { TEXTURE_KEYS } from '../gfx/textures';
import { BOSS_BASE, E, ELEMENT_IDS, ETYPES, HDR, K, PHASES, POS, S, SFX_IDS, type MeMsg } from './proto';
import { ELEMENTS } from '../data/runes';
import { Reader } from './wire';

const TWO_PI = Math.PI * 2;
const newer = (a: number, b: number) => a !== b && ((a - b) & 0xffff) < 0x8000;
const newerEq = (a: number, b: number) => ((a - b) & 0xffff) < 0x8000;
const SHAPES = ['circle', 'line', 'ring', 'windup'] as const;
/** Scratch values for Track.push (no array per record per snapshot). */
const SC = new Float64Array(6);

/** Three most recent samples of F numbers each, stamped with the host clock. */
class Track {
  ts = new Float64Array(3);
  v: Float64Array;
  n = 0;
  constructor(public F: number) { this.v = new Float64Array(3 * F); }
  push(ts: number, vals: ArrayLike<number>) {
    const F = this.F, v = this.v;
    if (this.n && ts <= this.ts[Math.min(this.n, 3) - 1]) return; // late duplicate
    if (this.n < 3) { this.ts[this.n] = ts; for (let i = 0; i < F; i++) v[this.n * F + i] = vals[i]; this.n++; return; }
    this.ts[0] = this.ts[1]; this.ts[1] = this.ts[2]; this.ts[2] = ts;
    for (let i = 0; i < 2 * F; i++) v[i] = v[i + F];
    for (let i = 0; i < F; i++) v[2 * F + i] = vals[i];
  }
  get last() { return this.ts[this.n - 1]; }
  /** Value at host time T: interpolated between the two samples around it; just past the newest, extrapolated briefly. */
  sample(T: number, out: Float64Array, angleAt = -1, snap = 400) {
    const F = this.F, v = this.v, n = this.n;
    if (n === 1 || T <= this.ts[0]) { for (let i = 0; i < F; i++) out[i] = v[i]; return; }
    let i1 = 1;
    while (i1 < n - 1 && T > this.ts[i1]) i1++;
    const i0 = i1 - 1;
    const t0 = this.ts[i0], t1 = this.ts[i1];
    let k = (T - t0) / Math.max(1, t1 - t0);
    if (k > 1) k = Math.min(1 + 120 / Math.max(1, t1 - t0), k); // starved: coast on the last velocity for at most ~120 ms
    const jump = Math.abs(v[i1 * F] - v[i0 * F]) > snap || Math.abs(v[i1 * F + 1] - v[i0 * F + 1]) > snap;
    if (jump) k = 1;
    for (let i = 0; i < F; i++) {
      const a = v[i0 * F + i], b = v[i1 * F + i];
      if (i === angleAt) { let d = b - a; if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI; out[i] = a + d * k; } else out[i] = a + (b - a) * k;
    }
  }
}

interface EnemyObj { id: number; tr: Track; kind: number; flags: number; tint: number; aff: number; sc: number; spawnT: number; seq: number; spr: Img; shadow: Img; badge: Img | null; curTint: number }
interface ImgObj { key: number; tr: Track; tex: number; depth: number; flags: number; origin: number; tint: number; seq: number; img: Img; dirty: boolean }
interface PlayerObj { pid: number; tr: Track; flags: number; seq: number; spr: Img; shadow: Img; label: Phaser.GameObjects.Text; walkT: number; lx: number }
interface TelObj { id: number; tr: Track; shape: number; r: number; ang: number; len: number; w: number; t: number; total: number; color: number; at: number; seq: number }

export interface NetStats {
  stPackets: number; stBytes: number; fxPackets: number; fxBytes: number; lost: number; dropped: number; incomplete: number; complete: number;
  stalls: number; rtt: number; delay: number; jitter: number; decodeMs: number; decodeMax: number; renderMs: number; renderMax: number; renders: number; datagrams: number;
}

export class Replica {
  me: MeMsg | null = null;
  /** Called with each new `Me` message (newest first wins). */
  onMe: ((m: MeMsg) => void) | null = null;
  private enemies = new Map<number, EnemyObj>();
  private imgs = new Map<number, ImgObj>();
  private players = new Map<number, PlayerObj>();
  private tels = new Map<number, TelObj>();
  private partial = new Map<number, { cnt: number; got: Set<number> }>();
  private fxQ: { ts: number; evs: FxEv[]; sfx: number[] }[] = [];
  private lastMeSeq = -1;
  private newestSeq = -1;
  private newestTs = 0;
  private floorSeq = -1;
  // clock
  private offWin: { at: number; d: number }[] = [];
  private jitter = 0;
  private lastTs = 0;
  private gap = 33;
  private playT: number | null = null;
  private lastNow = 0;
  delay = 90;
  private animT = 0;
  private out = new Float64Array(6);
  private seqSeen = new Set<number>();
  stats: NetStats = { stPackets: 0, stBytes: 0, fxPackets: 0, fxBytes: 0, lost: 0, dropped: 0, incomplete: 0, complete: 0, stalls: 0, rtt: 0, delay: 0, jitter: 0, decodeMs: 0, decodeMax: 0, renderMs: 0, renderMax: 0, renders: 0, datagrams: 0 };
  private rttSamples: number[] = [];

  constructor(private run: Run, private scene: Phaser.Scene, private names: Map<number, string>, public selfPid: () => number) {}

  /* ------------------------------------------------------------------ receive */

  /** A datagram from the `st` channel. */
  onSt(buf: ArrayBuffer, now: number) {
    const t0 = performance.now();
    this.stats.stPackets++; this.stats.stBytes += buf.byteLength;
    let r: Reader;
    try { r = new Reader(buf); } catch { return; }
    try {
      const kind = r.u8(), seq = r.u16(), ts = r.u32(), idx = r.u8(), cnt = r.u8();
      this.clock(seq, ts, now);
      if (kind === K.Me) this.readMe(r, seq, ts, now);
      else if (kind === K.World) this.readWorld(r, seq, ts, idx, cnt);
    } catch { this.stats.dropped++; }
    const ms = performance.now() - t0;
    this.stats.decodeMs += ms; this.stats.datagrams++; if (ms > this.stats.decodeMax) this.stats.decodeMax = ms;
  }

  /** A datagram from the `fx` channel. */
  onFx(buf: ArrayBuffer) {
    this.stats.fxPackets++; this.stats.fxBytes += buf.byteLength;
    try {
      const r = new Reader(buf);
      if (r.u8() !== K.Fx) return;
      const ts = r.u32(), n = r.u8();
      const evs: FxEv[] = [], sfx: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = r.u8();
        switch (t) {
          case FxKind.Burst: evs.push([t, r.i16() / POS, r.i16() / POS, r.u24(), r.u8(), r.u16(), r.u8() / 100, r.u8() / 40, r.i16(), r.u8() / 10]); break;
          case FxKind.Spark: evs.push([t, r.i16() / POS, r.i16() / POS, r.i16(), r.i16(), r.u24(), r.u8() / 100, r.u8() / 40, r.i16(), TEXTURE_KEYS[r.u8()] ?? 'dot']); break;
          case FxKind.Ring: evs.push([t, r.i16() / POS, r.i16() / POS, r.u24(), r.u16(), r.u16(), r.u8() / 100, r.u8() / 255]); break;
          case FxKind.Bolt: evs.push([t, r.i16() / POS, r.i16() / POS, r.i16() / POS, r.i16() / POS, r.u24(), r.u8(), r.u8() / 100]); break;
          case FxKind.Text: { const x = r.i16() / POS, y = r.i16() / POS, c = r.u24(), sz = r.u8(), life = r.u8() / 50, vy = r.i8(); evs.push([t, x, y, r.str(), c, sz, life, vy]); break; }
          case FxKind.Shake: evs.push([t, r.u8() / 10]); break;
          case FxKind.Flash: evs.push([t, r.u16(), r.u24()]); break;
          case E.Sfx: sfx.push(r.u8()); break;
          default: throw new RangeError('unknown effect');
        }
      }
      if (this.fxQ.length < 200) this.fxQ.push({ ts, evs, sfx });
    } catch { this.stats.dropped++; }
  }

  /** Clock offset between the host's timestamps and our own (the fastest packets in a sliding window show the true offset). */
  private clock(seq: number, ts: number, now: number) {
    if (this.seqSeen.has(seq)) return; // every datagram of a snapshot carries the same stamp
    this.seqSeen.add(seq); if (this.seqSeen.size > 64) this.seqSeen.delete(this.seqSeen.values().next().value as number);
    const d = now - ts;
    this.offWin.push({ at: now, d });
    while (this.offWin.length && now - this.offWin[0].at > 4000) this.offWin.shift();
    if (this.lastTs) {
      const g = ts - this.lastTs;
      if (g > 0 && g < 400) this.gap += (g - this.gap) * 0.1;
      const j = Math.abs(d - this.minOffset());
      this.jitter += (j - this.jitter) * 0.1;
    }
    this.lastTs = ts;
    if (newer(seq, this.newestSeq) || this.newestSeq < 0) { this.newestSeq = seq; this.newestTs = ts; }
    this.delay = Math.max(45, Math.min(200, 1.6 * this.gap + 2.5 * this.jitter + 10));
  }
  private minOffset(): number { let m = Infinity; for (const o of this.offWin) if (o.d < m) m = o.d; return m === Infinity ? 0 : m; }

  private readMe(r: Reader, seq: number, ts: number, now: number) {
    if (this.lastMeSeq >= 0 && !newer(seq, this.lastMeSeq)) return;
    if (this.lastMeSeq >= 0) this.stats.lost += (seq - this.lastMeSeq - 1) & 0xffff;
    this.lastMeSeq = seq;
    const f = r.u8();
    const m: MeMsg = {
      seq, ts, paused: !!(f & 1), down: !!(f & 2), quick: !!(f & 4), tilesActive: !!(f & 8), hurt: !!(f & 32), inv: !!(f & 64),
      echo: r.u32(), hold: r.u16(), ack: r.u16(), x: 0, y: 0, vx: 0, vy: 0, speed: 0, pullT: 0, pullX: 0, pullY: 0, hp: 0, mh: 0, xp: 0, xn: 0, lv: 1, coins: 0,
      t: 0, el: 0, round: 1, phase: 'prep', kills: 0, boss: null, spells: [], party: [],
    };
    m.x = r.f32(); m.y = r.f32(); m.vx = r.f32(); m.vy = r.f32(); m.speed = r.f32();
    if (f & 128) { m.pullT = r.f32(); m.pullX = r.f32(); m.pullY = r.f32(); }
    m.hp = r.f32(); m.mh = r.f32(); m.xp = r.f32(); m.xn = r.f32(); m.lv = r.u16(); m.coins = r.f32();
    m.t = r.f32(); m.el = r.f32(); m.round = r.u8(); m.phase = PHASES[r.u8()] ?? 'fight'; m.kills = r.u16();
    if (f & 16) m.boss = { kind: r.u8(), hp: r.f32(), mh: r.f32() };
    const ns = r.u8();
    for (let i = 0; i < ns; i++) m.spells.push({ cd: r.u16() / 100, live: r.u8(), ult: r.u16() / 10 });
    const np = r.u8();
    for (let i = 0; i < np; i++) m.party.push({ pid: r.u8(), hp: r.u16(), mh: r.u16(), down: !!r.u8() });
    if (m.echo) { const rtt = now - m.echo - m.hold; if (rtt >= 0 && rtt < 5000) { this.rttSamples.push(rtt); if (this.rttSamples.length > 30) this.rttSamples.shift(); this.stats.rtt = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length; } }
    this.me = m;
    this.onMe?.(m);
  }

  private readWorld(r: Reader, seq: number, ts: number, idx: number, cnt: number) {
    // ---- completeness bookkeeping
    let p = this.partial.get(seq);
    if (!p) {
      p = { cnt, got: new Set() }; this.partial.set(seq, p);
      if (this.partial.size > 8) { const old = [...this.partial.keys()].sort((a, b) => (newer(a, b) ? 1 : -1))[0]; if (this.partial.get(old)!.got.size < this.partial.get(old)!.cnt) this.stats.incomplete++; this.partial.delete(old); }
    }
    if (p.got.has(idx)) return;
    p.got.add(idx);
    // ---- records
    while (r.left >= 2) {
      const sec = r.u8(), n = r.u8();
      for (let i = 0; i < n; i++) {
        switch (sec) {
          case S.Floor: this.readFloor(r, seq); break;
          case S.Tels: this.readTel(r, seq, ts); break;
          case S.Players: this.readPlayer(r, seq, ts); break;
          case S.Enemies: this.readEnemy(r, seq, ts); break;
          case S.Imgs: this.readImg(r, seq, ts); break;
          default: throw new RangeError('unknown section');
        }
      }
    }
    if (p.got.size === p.cnt) { this.stats.complete++; this.complete(seq); this.partial.delete(seq); }
  }

  private readFloor(r: Reader, seq: number) {
    const bytes: number[] = [];
    for (let i = 0; i < 31; i++) bytes.push(r.u8());
    const active = r.u8(), nt = r.u8();
    const timers: [number, number][] = [];
    for (let i = 0; i < nt; i++) timers.push([r.u8(), r.u8() / 50]);
    if (this.floorSeq >= 0 && !newer(seq, this.floorSeq)) return;
    this.floorSeq = seq;
    const a = this.run.arena;
    a.active = !!active;
    const len = a.state.length;
    let changed = false;
    for (let i = 0; i < len; i++) { const s = (bytes[i >> 2] >> ((i & 3) * 2)) & 3; if (a.state[i] !== s) { a.state[i] = s; changed = true; } }
    a.timer.fill(0);
    for (const [i, t] of timers) a.timer[i] = t;
    if (changed) a.version++;
  }

  private readTel(r: Reader, seq: number, ts: number) {
    const id = r.u16(), shape = r.u8(), x = r.i16() / POS, y = r.i16() / POS;
    const rr = r.u16() / 4, ang = r.i16() / 8000, len = r.u16() / 4, w = r.u16() / 4, t = r.u16() / 1000, total = r.u16() / 1000, color = r.u24();
    let o = this.tels.get(id);
    if (!o) { o = { id, tr: new Track(2), shape, r: rr, ang, len, w, t, total, color, at: ts, seq }; this.tels.set(id, o); }
    SC[0] = x; SC[1] = y; o.tr.push(ts, SC);
    if (!newerEq(seq, o.seq)) return;
    o.seq = seq; o.shape = shape; o.r = rr; o.ang = ang; o.len = len; o.w = w; o.t = t; o.total = total; o.color = color; o.at = ts;
  }

  private readPlayer(r: Reader, seq: number, ts: number) {
    const pid = r.u8(), f = r.u8(), x = r.i16() / POS, y = r.i16() / POS;
    let o = this.players.get(pid);
    if (!o) {
      const label = this.scene.add.text(0, 0, this.names.get(pid) ?? `P${pid}`, { fontFamily: '"Press Start 2P", monospace', fontSize: '8px', color: '#9fd8ff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(15);
      o = { pid, tr: new Track(2), flags: f, seq, spr: this.run.img('wiz0', 8), shadow: this.run.img('shadow', 4).setScale(3), label, walkT: 0, lx: x };
      o.spr.setScale(3); this.players.set(pid, o);
    }
    SC[0] = x; SC[1] = y; o.tr.push(ts, SC);
    if (newerEq(seq, o.seq)) { o.seq = seq; o.flags = f; }
  }

  private readEnemy(r: Reader, seq: number, ts: number) {
    const id = r.u16(), kind = r.u8(), flags = r.u8(), tint = r.u8(), aff = r.u8(), x = r.i16() / POS, y = r.i16() / POS, sc = r.u8() / 32, spawnT = r.u8() / 500;
    let o = this.enemies.get(id);
    if (!o) {
      const boss = kind >= BOSS_BASE;
      const tex = boss ? BOSSES[kind - BOSS_BASE]?.tex ?? 'boss0' : EDEFS[ETYPES[kind] ?? 'grunt'].tex;
      const spr = this.run.img(tex, boss ? 6 : 5);
      const shadow = this.run.img('shadow', 4).setScale(sc * (boss ? 1.1 : 0.9)).setAlpha(0.8);
      const badge = flags & 4 ? this.run.img('dot', 6, true).setScale(0.85).setAlpha(0.9) : null;
      if (badge && aff) badge.setTint(this.elementColor(aff));
      o = { id, tr: new Track(2), kind, flags, tint, aff, sc, spawnT, seq, spr, shadow, badge, curTint: -1 };
      this.enemies.set(id, o);
    }
    SC[0] = x; SC[1] = y; o.tr.push(ts, SC);
    if (newerEq(seq, o.seq)) { o.seq = seq; o.flags = flags; o.tint = tint; o.aff = aff; o.sc = sc; o.spawnT = spawnT; }
  }

  private elementColor(aff: number): number { return elementColors[ELEMENT_IDS[aff - 1]] ?? 0xffffff; }

  private readImg(r: Reader, seq: number, ts: number) {
    const id = r.u16(), ks = r.u8(), tex = r.u8(), depth = r.u8() / 8, x = r.i16() / POS, y = r.i16() / POS, sx = r.i16() / 128, flags = r.u8(), alpha = r.u8() / 255;
    const sy = flags & 8 ? r.i16() / 128 : sx;
    const rot = flags & 16 ? (r.u16() / 65535) * TWO_PI : 0;
    const tint = flags & 32 ? r.u24() : 0xffffff;
    const kind = ks & 3, slot = (ks >> 2) & 7, origin = (ks >> 5) & 3;
    const key = id | (slot << 16) | (kind << 19);
    let o = this.imgs.get(key);
    if (!o) {
      const name = TEXTURE_KEYS[tex];
      if (!name) return;
      o = { key, tr: new Track(6), tex, depth, flags, origin, tint, seq, img: this.run.img(name, depth), dirty: true };
      this.imgs.set(key, o);
    }
    SC[0] = x; SC[1] = y; SC[2] = sx; SC[3] = sy; SC[4] = rot; SC[5] = alpha; o.tr.push(ts, SC);
    if (newerEq(seq, o.seq)) { if (o.tex !== tex || o.flags !== flags || o.tint !== tint || o.depth !== depth || o.origin !== origin) o.dirty = true; o.seq = seq; o.tex = tex; o.flags = flags; o.tint = tint; o.depth = depth; o.origin = origin; }
  }

  /** A whole snapshot has arrived: anything not updated since is gone. */
  private complete(seq: number) {
    const gone = <T extends { seq: number }>(m: Map<number, T>, drop: (o: T) => void) => { for (const [k, o] of m) if (!newerEq(o.seq, seq)) { drop(o); m.delete(k); } };
    gone(this.enemies, (o) => { this.run.freeImg(o.spr); this.run.freeImg(o.shadow); this.run.freeImg(o.badge); });
    gone(this.imgs, (o) => this.run.freeImg(o.img));
    gone(this.players, (o) => { this.run.freeImg(o.spr); this.run.freeImg(o.shadow); o.label.destroy(); });
    gone(this.tels, () => {});
  }

  /* ------------------------------------------------------------------ render */

  /** Host time we are drawing at (valid after the first packet). */
  get time(): number { return this.playT ?? 0; }
  get hasData() { return this.offWin.length > 0; }

  /** Draw the world as it was `delay` ms ago on the host. `now` is performance.now(). */
  render(dt: number, now: number, selfPid: number, tel: Phaser.GameObjects.Graphics) {
    const t0 = performance.now();
    this.draw(dt, now, selfPid, tel);
    const ms = performance.now() - t0;
    this.stats.renderMs += ms; this.stats.renders++; if (ms > this.stats.renderMax) this.stats.renderMax = ms;
  }

  private draw(dt: number, now: number, selfPid: number, tel: Phaser.GameObjects.Graphics) {
    const run = this.run;
    if (!this.hasData) return;
    const target = now - this.minOffset() - this.delay;
    if (this.playT === null || Math.abs(target - this.playT) > 500) this.playT = target;
    else { this.playT += now - this.lastNow; this.playT += (target - this.playT) * 0.06; }
    this.lastNow = now;
    const T = this.playT;
    this.animT += dt;
    const out = this.out;
    const stale = this.newestTs - 2500;
    if (this.stats.delay !== this.delay) { this.stats.delay = this.delay; }
    this.stats.jitter = this.jitter;
    // starvation: the interpolation clock ran past the newest sample
    if (this.newestTs && T > this.newestTs + 20) this.stats.stalls++;

    for (const [id, o] of this.enemies) {
      if (o.tr.last < stale) { this.run.freeImg(o.spr); this.run.freeImg(o.shadow); this.run.freeImg(o.badge); this.enemies.delete(id); continue; }
      o.tr.sample(T, out);
      poseEnemy({ id, x: out[0], y: out[1], sc: o.sc, r: ENEMY_R(o), face: o.flags & 1 ? -1 : 1, spawnT: o.spawnT }, o.spr, o.shadow, o.badge, this.animT);
      if (o.tint !== o.curTint) { o.curTint = o.tint; applyTint(o.spr, o.tint, o.aff ? ELEMENT_IDS[o.aff - 1] : 'neutral'); }
    }
    for (const [id, o] of this.imgs) {
      if (o.tr.last < stale) { this.run.freeImg(o.img); this.imgs.delete(id); continue; }
      o.tr.sample(T, out, 4, 500);
      const im = o.img;
      if (o.dirty) {
        o.dirty = false;
        const name = TEXTURE_KEYS[o.tex];
        if (name && im.texture.key !== name) im.setTexture(name);
        const f = o.flags;
        im.setDepth(o.depth).setOrigin(o.origin === 1 ? 0 : o.origin === 2 ? 1 : 0.5, 0.5).setFlip(!!(f & 2), !!(f & 4))
          .setBlendMode(f & 1 ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL);
        if (f & 32) { if (f & 64) im.setTintFill(o.tint); else im.setTint(o.tint); } else im.clearTint();
      }
      im.setVisible(true).setPosition(out[0], out[1]).setScale(out[2], out[3]).setRotation(out[4]).setAlpha(out[5]);
    }
    for (const [pid, o] of this.players) {
      if (o.tr.last < stale) { this.run.freeImg(o.spr); this.run.freeImg(o.shadow); o.label.destroy(); this.players.delete(pid); continue; }
      o.tr.sample(T, out);
      const f = o.flags;
      const mine = pid === selfPid;
      o.spr.setVisible(!mine); o.shadow.setVisible(!mine); o.label.setVisible(!mine);
      if (mine) continue;
      if (f & 2) o.walkT += dt;
      poseWizard(o.spr, o.shadow, { x: out[0], y: out[1], faceX: f & 16 ? -1 : 1, walking: !!(f & 2), walkT: o.walkT, hurt: !!(f & 4), inv: !!(f & 8), down: !!(f & 1) }, this.animT, 0x9fd8ff);
      o.label.setPosition(out[0], out[1] - 38).setText(f & 1 ? `${this.names.get(pid) ?? 'P' + pid} (down)` : this.names.get(pid) ?? `P${pid}`).setAlpha(f & 1 ? 0.6 : 1);
    }
    // telegraphs
    tel.clear();
    for (const [id, o] of this.tels) {
      if (o.tr.last < stale) { this.tels.delete(id); continue; }
      o.tr.sample(T, out);
      const left = o.t - (T - o.at) / 1000;
      if (left <= 0) continue;
      const v: TelView = { shape: SHAPES[o.shape] ?? 'circle', x: out[0], y: out[1], r: o.r, ang: o.ang, len: o.len, w: o.w, t: left, total: o.total, color: o.color };
      drawTelegraph(tel, v);
    }
    // effects whose moment has come
    while (this.fxQ.length) {
      let bi = 0;
      for (let i = 1; i < this.fxQ.length; i++) if (this.fxQ[i].ts < this.fxQ[bi].ts) bi = i;
      const b = this.fxQ[bi];
      if (b.ts > T) break;
      this.fxQ.splice(bi, 1);
      const late = T - b.ts > 300;
      for (const ev of b.evs) { if (late && (ev[0] === FxKind.Spark || ev[0] === FxKind.Burst)) continue; run.fx.play(ev); }
      for (const s of b.sfx) if (!late) audio.play((SFX_IDS[s] ?? 'hit') as never);
    }
    void now;
  }

  /** Position of another player at the current render time (for the spectator camera). */
  playerPos(pid: number): { x: number; y: number; down: boolean } | null {
    const o = this.players.get(pid);
    if (!o || this.playT === null) return null;
    o.tr.sample(this.playT, this.out);
    return { x: this.out[0], y: this.out[1], down: !!(o.flags & 1) };
  }
  otherPids(self: number): number[] { return [...this.players.keys()].filter((p) => p !== self); }

  counts() { return { enemies: this.enemies.size, imgs: this.imgs.size, players: this.players.size, tels: this.tels.size }; }

  clear() {
    for (const o of this.enemies.values()) { this.run.freeImg(o.spr); this.run.freeImg(o.shadow); this.run.freeImg(o.badge); }
    for (const o of this.imgs.values()) this.run.freeImg(o.img);
    for (const o of this.players.values()) { this.run.freeImg(o.spr); this.run.freeImg(o.shadow); o.label.destroy(); }
    this.enemies.clear(); this.imgs.clear(); this.players.clear(); this.tels.clear(); this.partial.clear(); this.fxQ = [];
    this.lastMeSeq = -1; this.newestSeq = -1; this.floorSeq = -1; this.offWin = []; this.jitter = 0; this.lastTs = 0; this.gap = 33; this.playT = null; this.me = null; this.seqSeen.clear();
  }

  destroy() { this.clear(); }
}

const ENEMY_R = (o: EnemyObj) => {
  if (o.kind >= BOSS_BASE) return BOSSES[o.kind - BOSS_BASE]?.r ?? 34;
  return (EDEFS[ETYPES[o.kind] ?? 'grunt'].r) * (o.flags & 2 ? 1.3 : 1);
};

const elementColors: Record<string, number> = Object.fromEntries(Object.entries(ELEMENTS).map(([k, v]) => [k, v.color]));

void HDR;
