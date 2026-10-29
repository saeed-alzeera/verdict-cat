import Phaser from 'phaser';

/** Animated backdrop for the main menu: drifting rune motes and slow rings. */
export class MenuScene extends Phaser.Scene {
  motes: { s: Phaser.GameObjects.Image; vx: number; vy: number; ph: number }[] = [];
  rings: Phaser.GameObjects.Image[] = [];
  constructor() { super('Menu'); }
  create() {
    this.cameras.main.setBackgroundColor('#0a0714');
    const w = this.scale.width, h = this.scale.height;
    const cols = [0xff7a1a, 0x66ddff, 0xfff35e, 0x7dff4a, 0x3d8bff, 0xb36bff];
    this.motes = [];
    for (let i = 0; i < 70; i++) {
      const s = this.add.image(Math.random() * w, Math.random() * h, 'dot').setTint(cols[i % cols.length]).setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(0.15 + Math.random() * 0.4).setScale(0.4 + Math.random() * 1.3);
      this.motes.push({ s, vx: (Math.random() - 0.5) * 14, vy: -6 - Math.random() * 18, ph: Math.random() * 6 });
    }
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      this.rings.push(this.add.image(w / 2, h * 0.5, 'ring').setTint(cols[i * 2]).setAlpha(0.12).setScale(3 + i * 2.2).setBlendMode(Phaser.BlendModes.ADD));
    }
    this.scale.on('resize', () => { this.rings.forEach((r) => r.setPosition(this.scale.width / 2, this.scale.height * 0.5)); });
  }
  update(_t: number, dtMs: number) {
    const dt = dtMs / 1000, w = this.scale.width, h = this.scale.height;
    for (const m of this.motes) {
      m.ph += dt;
      m.s.x += (m.vx + Math.sin(m.ph) * 6) * dt; m.s.y += m.vy * dt;
      if (m.s.y < -20) { m.s.y = h + 20; m.s.x = Math.random() * w; }
      if (m.s.x < -20) m.s.x = w + 20; if (m.s.x > w + 20) m.s.x = -20;
    }
    this.rings.forEach((r, i) => { r.rotation += dt * (0.05 + i * 0.03) * (i % 2 ? -1 : 1); });
  }
}
