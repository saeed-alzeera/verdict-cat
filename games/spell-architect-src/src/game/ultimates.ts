// Ultimate abilities unlocked by forging an evolved core. Activated with Space; recharge over time and with kills.
import { ELEMENTS, ULTIMATES } from '../data/runes';
import { audio } from '../core/audio';
import type { ActiveSpell, Enemy } from './types';
import type { Run } from './run';
import { makeSrc, spawnEnv } from './casting';
import {
  dealDamage, explode, applyElement, applyPoison, applyWet, arc, envReact, freezeEnemy, gravityImpulse, reactDamage,
} from './combat';

export const ULT_COOLDOWN = 45;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const alive = (run: Run) => run.enemies.filter((e) => !e.dead);

function targetPoint(run: Run, spread: number): [number, number] {
  const list = alive(run);
  if (list.length && Math.random() < 0.8) { const e = list[(Math.random() * list.length) | 0]; return [e.x, e.y]; }
  const p = run.player;
  const a = Math.random() * 6.28, d = Math.random() * spread;
  return [p.x + Math.cos(a) * d, p.y + Math.sin(a) * d];
}

export function castUltimate(run: Run, sp: ActiveSpell) {
  const root = sp.c.root!;
  const el = root.element;
  const U = ULTIMATES[el];
  const p = run.player;
  const src = makeSrc(sp, root, 0);
  const dmg = (30 + run.round * 6) * p.dmgMul * 1.6;
  const color = ELEMENTS[el].color;
  run.announce(`${U.icon} ${U.name.toUpperCase()}`, ELEMENTS[el].css, 'ULTIMATE');
  run.fx.shake(10);
  run.fx.ring(p.x, p.y, color, 10, 520, 0.7);
  run.fx.ring(p.x, p.y, 0xffffff, 10, 320, 0.5);
  run.fx.flash(220, (color >> 16) & 255, (color >> 8) & 255, color & 255);
  audio.play('boom');
  audio.play('level');

  switch (el) {
    case 'fire':
      for (let i = 0; i < 14; i++) {
        run.later(i * 0.2, () => {
          const [x, y] = targetPoint(run, 360);
          run.addTelegraph({ shape: 'circle', x, y, r: 105, dur: 0.45, color: 0xff9a2a, follow: null, onDone: () => {
            explode(run, x, y, 105, dmg * 2.2, 'fire', src, { status: true, kb: 220 });
            envReact(run, 'fire', x, y, 105, src);
            run.fx.shake(4); audio.play('boom');
            run.fx.burst(x, y, 0xffd25a, 14, 260, 0.6, 1.6);
          } });
          for (let k = 0; k < 6; k++) run.fx.spark(x - k * 14, y - k * 40, 100, 280, 0xff7a1a, 0.4, 2);
        });
      }
      break;
    case 'ice':
      for (const e of alive(run)) {
        reactDamage(run, e, dmg * 0.8, ['ice'], src);
        if (e.dead) continue;
        if (e.type === 'boss') { e.chill = 2; e.slowT = 3.5; e.slowMul = 0.3; }
        else freezeEnemy(run, e, src, false, dmg * 1.4);
      }
      run.fx.burst(p.x, p.y, 0xd8f8ff, 40, 500, 0.9, 2);
      break;
    case 'lightning': {
      const n = 32;
      for (let i = 0; i < n; i++) {
        run.later(i * 0.16, () => {
          const [x, y] = targetPoint(run, 300);
          run.fx.bolt(x + rand(-30, 30), y - 260, x, y, 0xfff35e, 12, 0.22);
          run.fx.bolt(x + rand(-30, 30), y - 260, x, y, 0xffffff, 5, 0.18);
          audio.play('lightning');
          explode(run, x, y, 70, dmg * 1.5, 'lightning', src, { status: true, noTrig: false, kb: 60 });
          envReact(run, 'lightning', x, y, 60, src);
          const t = run.nearest(x, y, 90);
          if (t) arc(run, t, dmg * 0.8, 'lightning', src, 3, 180, [t]);
        });
      }
      break;
    }
    case 'poison':
      for (let k = 0; k < 5; k++) run.later(k * 0.15, () => run.fx.ring(p.x, p.y, 0x7dff4a, 20, 900, 0.9, 0.8));
      for (const e of alive(run)) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        run.later(Math.min(1, d / 900), () => {
          if (e.dead) return;
          reactDamage(run, e, dmg * 0.7, ['poison'], src);
          if (e.dead) return;
          for (let i = 0; i < 5; i++) applyPoison(run, e, Math.max(2, dmg * 0.08), src, 6);
        });
      }
      for (let i = 0; i < 10; i++) {
        const [x, y] = targetPoint(run, 400);
        run.later(0.2 + i * 0.08, () => spawnEnv(run, src, 'poison', x, y, 90, 6, 4));
      }
      break;
    case 'water':
      for (let k = 0; k < 4; k++) run.later(k * 0.12, () => run.fx.ring(p.x, p.y, 0x7fb8ff, 20, 900, 0.9, 0.8));
      for (const e of alive(run)) {
        const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1;
        applyWet(run, e, src);
        reactDamage(run, e, dmg * 0.8, ['water'], src);
        if (!e.dead && e.type !== 'boss') { e.vx += (dx / d) * 900; e.vy += (dy / d) * 900; }
      }
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * 6.28, d = rand(120, 420);
        spawnEnv(run, src, 'water', p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 95, 9, 0);
      }
      break;
    case 'gravity': {
      const cx = p.x, cy = p.y;
      const t0 = run.time;
      const tickFn = () => {
        const t = run.time - t0;
        if (run.over) return;
        if (t < 2.8) {
          for (const e of alive(run)) {
            const dx = cx - e.x, dy = cy - e.y, d = Math.hypot(dx, dy);
            if (d > 14) { const k = (e.type === 'boss' ? 0.3 : 1) * 520 * 0.05; e.x += (dx / d) * k * Math.min(2, 1 + 120 / d); e.y += (dy / d) * k * Math.min(2, 1 + 120 / d); }
            e.pulled = 0.2;
          }
          const a = Math.random() * 6.28;
          run.fx.spark(cx + Math.cos(a) * 300, cy + Math.sin(a) * 300, -Math.cos(a) * 340, -Math.sin(a) * 340, 0xd9a8ff, 0.8, 1.6);
          if (Math.random() < 0.3) run.fx.ring(cx, cy, 0xb36bff, 300, 20, 0.5, 0.7);
          run.later(0.05, tickFn);
        } else {
          const list = run.query(cx, cy, 360);
          const dd = dmg * (3 + 0.3 * list.length) * sp.mut.collapse;
          for (const e of list) reactDamage(run, e, dd, ['gravity'], src);
          run.fx.ring(cx, cy, 0xe0b0ff, 360, 6, 0.4);
          run.fx.burst(cx, cy, 0xe0b0ff, 30, 400, 0.8, 2);
          run.fx.shake(12); audio.play('boom');
        }
      };
      tickFn();
      break;
    }
  }
  void dealDamage; void applyElement; void gravityImpulse; void (null as Enemy | null);
}
