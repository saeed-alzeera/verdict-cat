// Lightweight pooled particles, rings, lightning bolts and floating damage numbers.
import Phaser from 'phaser';
import type { Img } from './types';
import { store } from '../core/save';

interface P { img: Img; on: boolean; vx: number; vy: number; life: number; max: number; s0: number; s1: number; a0: number; drag: number; grav: number }
interface Ring { img: Img; on: boolean; life: number; max: number; s0: number; s1: number }
interface Bolt { img: Img; on: boolean; life: number; max: number }
interface Txt { t: Phaser.GameObjects.Text; on: boolean; life: number; vy: number }

const NP = 700, NR = 70, NB = 150, NT = 36;

/** Every cosmetic effect call, as plain numbers. The co-op host records these (instead of sending particles) and each joiner
 *  replays them on its own Fx, so sparks, rings, bolts and damage numbers cost a few bytes each and are never out of sync with
 *  the joiner's own frame rate. Colours are 0xRRGGBB numbers. */
export const enum FxKind { Burst = 1, Spark = 2, Ring = 3, Bolt = 4, Text = 5, Shake = 6, Flash = 7 }
export type FxEv =
  | [FxKind.Burst, number, number, number, number, number, number, number, number, number]
  | [FxKind.Spark, number, number, number, number, number, number, number, number, string]
  | [FxKind.Ring, number, number, number, number, number, number, number]
  | [FxKind.Bolt, number, number, number, number, number, number, number]
  | [FxKind.Text, number, number, string, number, number, number, number]
  | [FxKind.Shake, number]
  | [FxKind.Flash, number, number];

export class Fx {
  parts: P[] = [];
  rings: Ring[] = [];
  bolts: Bolt[] = [];
  texts: Txt[] = [];
  active = 0;
  pc = 0; rc = 0; bc = 0; tc = 0;
  shakeMag = 0;
  /** Host: receives every effect call before it is thinned or filtered by this machine's own settings. */
  rec: ((ev: FxEv) => void) | null = null;
  constructor(private scene: Phaser.Scene) {
    for (let i = 0; i < NP; i++) {
      const img = scene.add.image(0, 0, 'dot').setBlendMode(Phaser.BlendModes.ADD).setDepth(12).setVisible(false);
      this.parts.push({ img, on: false, vx: 0, vy: 0, life: 0, max: 1, s0: 1, s1: 0, a0: 1, drag: 0, grav: 0 });
    }
    for (let i = 0; i < NR; i++) {
      const img = scene.add.image(0, 0, 'ring').setBlendMode(Phaser.BlendModes.ADD).setDepth(11).setVisible(false);
      this.rings.push({ img, on: false, life: 0, max: 1, s0: 0, s1: 1 });
    }
    for (let i = 0; i < NB; i++) {
      const img = scene.add.image(0, 0, 'beam').setBlendMode(Phaser.BlendModes.ADD).setDepth(11).setOrigin(0, 0.5).setVisible(false);
      this.bolts.push({ img, on: false, life: 0, max: 1 });
    }
    for (let i = 0; i < NT; i++) {
      const t = scene.add.text(0, 0, '', {
        fontFamily: '"Press Start 2P", monospace', fontSize: '10px', color: '#fff', stroke: '#000', strokeThickness: 4,
      }).setDepth(14).setOrigin(0.5).setVisible(false);
      this.texts.push({ t, on: false, life: 0, vy: 0 });
    }
  }

  reset() {
    for (const p of this.parts) { p.on = false; p.img.setVisible(false); }
    for (const r of this.rings) { r.on = false; r.img.setVisible(false); }
    for (const b of this.bolts) { b.on = false; b.img.setVisible(false); }
    for (const t of this.texts) { t.on = false; t.t.setVisible(false); }
    this.active = 0; this.shakeMag = 0;
  }

  burst(x: number, y: number, color: number, n: number, speed: number, life: number, size: number, grav = 0, drag = 3) {
    this.rec?.([FxKind.Burst, x, y, color, n, speed, life, size, grav, drag]);
    // thin out under heavy load
    if (this.active > 520) n = Math.ceil(n * 0.3);
    else if (this.active > 380) n = Math.ceil(n * 0.6);
    for (let i = 0; i < n; i++) {
      const p = this.parts[this.pc]; this.pc = (this.pc + 1) % NP;
      if (!p.on) this.active++;
      const a = Math.random() * 6.2832;
      const s = speed * (0.3 + Math.random() * 0.7);
      p.on = true; p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
      p.life = p.max = life * (0.6 + Math.random() * 0.6);
      p.s0 = size * (0.6 + Math.random() * 0.6); p.s1 = 0; p.a0 = 1; p.drag = drag; p.grav = grav;
      p.img.setTexture('dot').setPosition(x, y).setTint(color).setVisible(true).setAlpha(1).setScale(p.s0).setRotation(0);
    }
  }

  /** Single directional particle (trails, embers). */
  spark(x: number, y: number, vx: number, vy: number, color: number, life: number, size: number, grav = 0, tex = 'dot') {
    this.rec?.([FxKind.Spark, x, y, vx, vy, color, life, size, grav, tex]);
    if (this.active > 480) return;
    const p = this.parts[this.pc]; this.pc = (this.pc + 1) % NP;
    if (!p.on) this.active++;
    p.on = true; p.vx = vx; p.vy = vy; p.life = p.max = life; p.s0 = size; p.s1 = 0; p.a0 = 0.9; p.drag = 2; p.grav = grav;
    p.img.setTexture(tex).setPosition(x, y).setTint(color).setVisible(true).setAlpha(0.9).setScale(tex === 'dot' ? size : size * 0.8).setRotation(Math.random() * 3);
  }

  ring(x: number, y: number, color: number, r0: number, r1: number, life = 0.35, alpha = 1) {
    this.rec?.([FxKind.Ring, x, y, color, r0, r1, life, alpha]);
    const g = this.rings[this.rc]; this.rc = (this.rc + 1) % NR;
    g.on = true; g.life = g.max = life; g.s0 = r0 / 60; g.s1 = r1 / 60;
    g.img.setPosition(x, y).setTint(color).setVisible(true).setAlpha(alpha).setScale(g.s0);
  }

  bolt(x1: number, y1: number, x2: number, y2: number, color: number, width = 8, life = 0.16) {
    this.rec?.([FxKind.Bolt, x1, y1, x2, y2, color, width, life]);
    const segs = 3;
    let px = x1, py = y1;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const off = i === segs ? 0 : (Math.random() - 0.5) * Math.min(26, len * 0.3);
      const tx = x1 + dx * t + nx * off, ty = y1 + dy * t + ny * off;
      const b = this.bolts[this.bc]; this.bc = (this.bc + 1) % NB;
      b.on = true; b.life = b.max = life;
      const l = Math.hypot(tx - px, ty - py);
      b.img.setPosition(px, py).setRotation(Math.atan2(ty - py, tx - px)).setScale(l / 64, width / 16).setTint(color).setVisible(true).setAlpha(1);
      px = tx; py = ty;
    }
  }

  text(x: number, y: number, s: string, color = '#ffffff', size = 16, life = 0.7, vy = -55) {
    this.rec?.([FxKind.Text, x, y, s, parseInt(color.slice(1), 16) || 0xffffff, size, life, vy]);
    if (!store.settings.numbers && size < 20) return;
    const t = this.texts[this.tc]; this.tc = (this.tc + 1) % NT;
    t.on = true; t.life = life; t.vy = vy;
    t.t.setText(s).setColor(color).setFontSize(Math.round(size * 0.72)).setPosition(x, y).setVisible(true).setAlpha(1).setScale(1.25);
  }

  flash(ms: number, r: number, g: number, b: number) {
    this.rec?.([FxKind.Flash, ms, (r << 16) | (g << 8) | b]);
    this.scene.cameras.main.flash(ms, r, g, b);
  }

  shake(mag: number) {
    this.rec?.([FxKind.Shake, mag]);
    if (!store.settings.shake) return;
    this.shakeMag = Math.min(14, Math.max(this.shakeMag, mag));
  }

  /** Joiner: play an effect the host recorded. */
  play(ev: FxEv) {
    switch (ev[0]) {
      case FxKind.Burst: this.burst(ev[1], ev[2], ev[3], ev[4], ev[5], ev[6], ev[7], ev[8], ev[9]); break;
      case FxKind.Spark: this.spark(ev[1], ev[2], ev[3], ev[4], ev[5], ev[6], ev[7], ev[8], ev[9]); break;
      case FxKind.Ring: this.ring(ev[1], ev[2], ev[3], ev[4], ev[5], ev[6], ev[7]); break;
      case FxKind.Bolt: this.bolt(ev[1], ev[2], ev[3], ev[4], ev[5], ev[6], ev[7]); break;
      case FxKind.Text: this.text(ev[1], ev[2], ev[3], '#' + ev[4].toString(16).padStart(6, '0'), ev[5], ev[6], ev[7]); break;
      case FxKind.Shake: this.shake(ev[1]); break;
      case FxKind.Flash: this.flash(ev[1], (ev[2] >> 16) & 255, (ev[2] >> 8) & 255, ev[2] & 255); break;
    }
  }

  update(dt: number) {
    let n = 0;
    for (const p of this.parts) {
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) { p.on = false; p.img.setVisible(false); continue; }
      n++;
      const k = p.life / p.max;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vy = p.vy * d + p.grav * dt;
      p.img.x += p.vx * dt; p.img.y += p.vy * dt;
      p.img.setScale(p.s1 + (p.s0 - p.s1) * k).setAlpha(k * p.a0);
    }
    this.active = n;
    for (const r of this.rings) {
      if (!r.on) continue;
      r.life -= dt;
      if (r.life <= 0) { r.on = false; r.img.setVisible(false); continue; }
      const k = 1 - r.life / r.max;
      r.img.setScale(r.s0 + (r.s1 - r.s0) * (1 - (1 - k) * (1 - k))).setAlpha(1 - k);
    }
    for (const b of this.bolts) {
      if (!b.on) continue;
      b.life -= dt;
      if (b.life <= 0) { b.on = false; b.img.setVisible(false); continue; }
      b.img.setAlpha(b.life / b.max);
    }
    for (const t of this.texts) {
      if (!t.on) continue;
      t.life -= dt;
      if (t.life <= 0) { t.on = false; t.t.setVisible(false); continue; }
      t.t.y += t.vy * dt;
      t.vy *= 1 - 2 * dt;
      const s = t.t.scale; if (s > 1) t.t.setScale(Math.max(1, s - 4 * dt));
      t.t.setAlpha(Math.min(1, t.life * 3));
    }
    this.shakeMag *= Math.pow(0.001, dt);
    if (this.shakeMag < 0.2) this.shakeMag = 0;
  }
}
