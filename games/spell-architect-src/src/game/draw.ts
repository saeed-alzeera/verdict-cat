// Shared drawing for boss/enemy attack telegraphs (used by the simulation and by co-op guests, who only get the numbers).
import type Phaser from 'phaser';

export interface TelView { shape: 'circle' | 'line' | 'ring'; x: number; y: number; r: number; ang: number; len: number; w: number; t: number; total: number; color: number }

export function drawTelegraph(g: Phaser.GameObjects.Graphics, t: TelView) {
  const k = 1 - t.t / t.total;
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
