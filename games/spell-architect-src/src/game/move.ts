// The one movement step. The host runs it for every player; a co-op joiner runs the very same function on its own
// character to predict the result of its input before the host has answered (see net/predict.ts).
import { ARENA, type Arena } from './arena';

export interface Mover { x: number; y: number; vx: number; vy: number; speed: number; pullX: number; pullY: number; pullT: number; faceX: number; walkT: number }

/** Move `p` by input (ix, iy) for `dt` seconds: speed, knockback decay, gravity pulls, arena bounds and crumbled floor. */
export function stepMove(p: Mover, arena: Arena, ix: number, iy: number, dt: number) {
  const ox = p.x, oy = p.y;
  const il = Math.hypot(ix, iy);
  if (il > 1) { ix /= il; iy /= il; }
  p.x += (ix * p.speed + p.vx) * dt;
  p.y += (iy * p.speed + p.vy) * dt;
  const decay = Math.pow(0.002, dt);
  p.vx *= decay; p.vy *= decay;
  if (p.pullT > 0) {
    p.pullT -= dt;
    const dx = p.pullX - p.x, dy = p.pullY - p.y, d = Math.hypot(dx, dy) || 1;
    p.x += (dx / d) * 150 * dt; p.y += (dy / d) * 150 * dt;
  }
  p.x = Math.max(24, Math.min(ARENA - 24, p.x));
  p.y = Math.max(24, Math.min(ARENA - 24, p.y));
  arena.constrain(p, ox, oy);
  if (ix !== 0) p.faceX = ix > 0 ? 1 : -1;
  if (il > 0.1) p.walkT += dt;
}
