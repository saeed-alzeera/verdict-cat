// Client-side prediction for the joiner's own wizard. Every rendered frame the joiner turns its keys into an input command,
// applies it immediately with the same stepMove the host uses, and sends the command to the host. When the host's
// authoritative state arrives (stamped with the last command it applied) the joiner re-applies the commands the host has not
// seen yet on top of it. If the result differs from what is on screen, the difference becomes a visual offset that melts away
// over ~100 ms, so a correction never shows up as a snap or an oscillation; only a large error (a fall into the void,
// a teleport) snaps.
import type { Arena } from '../game/arena';
import { stepMove, type Mover } from '../game/move';
import type { Cmd } from '../game/run';
import type { MeMsg } from './proto';

const SNAP_DIST = 96;
const MAX_HIST = 90;

export interface PredictStats { corrections: number; errSum: number; errMax: number; snaps: number; lastErr: number; cmds: number }

export class Predictor {
  s: Mover = { x: 550, y: 550, vx: 0, vy: 0, speed: 330, pullX: 0, pullY: 0, pullT: 0, faceX: 1, walkT: 0 };
  /** Visual error offset, decays to zero. The wizard and the camera are drawn at s + off. */
  off = { x: 0, y: 0 };
  hist: Cmd[] = [];
  seq = 0;
  moving = false;
  ready = false;
  stats: PredictStats = { corrections: 0, errSum: 0, errMax: 0, snaps: 0, lastErr: 0, cmds: 0 };

  reset() { this.hist.length = 0; this.off.x = this.off.y = 0; this.ready = false; this.moving = false; }

  get x() { return this.s.x + this.off.x; }
  get y() { return this.s.y + this.off.y; }

  /** Take the authoritative position (round start, or first snapshot of a round). */
  place(me: MeMsg) {
    const s = this.s;
    s.x = me.x; s.y = me.y; s.vx = me.vx; s.vy = me.vy; s.speed = me.speed; s.pullT = me.pullT; s.pullX = me.pullX; s.pullY = me.pullY;
    this.hist.length = 0; this.off.x = this.off.y = 0; this.ready = true;
  }

  /** One rendered frame: make the command, apply it now, remember it until the host acknowledges it. */
  step(dtRaw: number, ix: number, iy: number, arena: Arena): Cmd | null {
    if (!this.ready) return null;
    const dq = Math.max(1, Math.min(200, Math.round(Math.min(dtRaw, 0.05) * 4000)));
    const c: Cmd = { seq: (this.seq = (this.seq + 1) & 0xffff), ix: Math.round(Math.max(-1, Math.min(1, ix)) * 127), iy: Math.round(Math.max(-1, Math.min(1, iy)) * 127), dt: dq / 4000 };
    stepMove(this.s, arena, c.ix / 127, c.iy / 127, c.dt);
    this.moving = Math.hypot(c.ix, c.iy) > 12;
    this.hist.push(c);
    if (this.hist.length > MAX_HIST) this.hist.shift();
    this.stats.cmds++;
    // fade the correction offset
    const m = Math.hypot(this.off.x, this.off.y);
    if (m > 0) {
      const tau = 0.07 + Math.min(0.12, m / 400);
      const k = Math.exp(-dtRaw / tau);
      this.off.x *= k; this.off.y *= k;
      if (m < 0.05) this.off.x = this.off.y = 0;
    }
    return c;
  }

  /** The host's newest word on where this wizard is. */
  reconcile(me: MeMsg, arena: Arena) {
    if (!this.ready) { this.place(me); return; }
    // drop what the host has applied (16-bit sequence arithmetic)
    let n = 0;
    while (n < this.hist.length && ((me.ack - this.hist[n].seq) & 0xffff) < 0x8000) n++;
    if (n) this.hist.splice(0, n);
    const a: Mover = { x: me.x, y: me.y, vx: me.vx, vy: me.vy, speed: me.speed, pullX: me.pullX, pullY: me.pullY, pullT: me.pullT, faceX: this.s.faceX, walkT: this.s.walkT };
    for (const c of this.hist) stepMove(a, arena, c.ix / 127, c.iy / 127, c.dt);
    const s = this.s;
    const ex = a.x - s.x, ey = a.y - s.y;
    const err = Math.hypot(ex, ey);
    const st = this.stats;
    st.lastErr = err;
    if (err > 0.25) { st.corrections++; st.errSum += err; if (err > st.errMax) st.errMax = err; }
    if (err > SNAP_DIST) { st.snaps++; this.off.x = this.off.y = 0; }
    else { this.off.x -= ex; this.off.y -= ey; } // what is drawn stays put; the offset melts away
    s.x = a.x; s.y = a.y; s.vx = a.vx; s.vy = a.vy; s.speed = a.speed; s.pullT = a.pullT; s.pullX = a.pullX; s.pullY = a.pullY;
  }
}
