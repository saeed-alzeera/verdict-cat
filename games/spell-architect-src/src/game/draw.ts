// Shared drawing for boss/enemy attack telegraphs (used by the simulation and by co-op guests, who only get the numbers).
import type Phaser from 'phaser';

export interface TelView { shape: 'circle' | 'line' | 'ring' | 'windup'; x: number; y: number; r: number; ang: number; len: number; w: number; t: number; total: number; color: number }

export function drawTelegraph(g: Phaser.GameObjects.Graphics, t: TelView) {
  const k = 1 - t.t / t.total;
  if (t.shape === 'windup') {
    // regular enemies show intent without a long aim line: a contracting ring, a "!" and a short chevron towards the target
    const R = t.r * (2.1 - 1.0 * k);
    g.fillStyle(t.color, 0.08 + 0.16 * k);
    g.fillCircle(t.x, t.y, R);
    g.lineStyle(2, t.color, 0.4 + 0.5 * k);
    g.strokeCircle(t.x, t.y, R);
    const by = t.y - t.r * 2.1 - 12;
    g.fillStyle(t.color, 0.95);
    g.fillRect(t.x - 2, by - 10, 4, 10);
    g.fillRect(t.x - 2, by + 3, 4, 4);
    const nx = Math.cos(t.ang), ny = Math.sin(t.ang);
    const bx = t.x + nx * (R + 6), by2 = t.y + ny * (R + 6);
    g.fillStyle(t.color, 0.55 + 0.4 * k);
    g.fillPoints([{ x: bx + nx * 12, y: by2 + ny * 12 }, { x: bx - ny * 7, y: by2 + nx * 7 }, { x: bx + ny * 7, y: by2 - nx * 7 }], true);
    return;
  }
  if (t.shape === 'line') {
    const nx = Math.cos(t.ang), ny = Math.sin(t.ang);
    const px = -ny, py = nx;
    const draw = (w: number, a: number) => {
      g.fillStyle(t.color, a);
      g.fillPoints([
        { x: t.x + px * w / 2, y: t.y + py * w / 2 }, { x: t.x + nx * t.len + px * w / 2, y: t.y + ny * t.len + py * w / 2 },
        { x: t.x + nx * t.len - px * w / 2, y: t.y + ny * t.len - py * w / 2 }, { x: t.x - px * w / 2, y: t.y - py * w / 2 },
      ], true);
    };
    draw(t.w, 0.1 + 0.12 * k);
    draw(t.w * k, 0.28);
  } else {
    g.fillStyle(t.color, 0.08 + 0.12 * k);
    g.fillCircle(t.x, t.y, t.r);
    g.fillStyle(t.color, 0.2);
    g.fillCircle(t.x, t.y, t.r * k);
    g.lineStyle(2, t.color, 0.75);
    g.strokeCircle(t.x, t.y, t.r);
  }
}
