// World mirroring for co-op. The host simulates; each guest only draws. Instead of describing the game's entities, the host
// sends what is on screen: every visible Phaser image (texture, position, scale, rotation, tint, depth...) packed into a
// compact binary record, plus a small JSON block for floating text, floor tiles, telegraphs, the HUD and sound cues.
// The guest keeps a pool of images keyed by id, eases them towards the latest positions and draws the rest with its own code.
import Phaser from 'phaser';

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) { id = nextId++; if (nextId > 65534) nextId = 1; ids.set(o, id); }
  return id;
};

/** Texture names, sorted, so host and guest (which generate identical textures) agree on numeric ids. */
export function textureTable(scene: Phaser.Scene): string[] {
  return scene.textures.getTextureKeys().filter((k) => !k.startsWith('__')).sort();
}

export interface Rec {
  id: number; tex: number; x: number; y: number; sx: number; sy: number; rot: number; alpha: number;
  tint: number; tintMode: number; depth: number; add: boolean; flipX: boolean; flipY: boolean; origin: number;
}
export interface TextRec { x: number; y: number; s: string; color: string; size: number; alpha: number; scale: number; depth: number }
export interface Cull { x: number; y: number; w: number; h: number }

const REC_BYTES = 23;
const MAX_RECS = 1700;
const ORIGINS: [number, number][] = [[0.5, 0.5], [0, 0.5], [1, 0.5]];
const TWO_PI = Math.PI * 2;

/** Visible images (culled to a viewer's screen) and texts on the scene. */
export function collect(scene: Phaser.Scene, table: Map<string, number>, cull: Cull | null): { imgs: Phaser.GameObjects.Image[]; texts: Phaser.GameObjects.Text[] } {
  const imgs: Phaser.GameObjects.Image[] = [];
  const texts: Phaser.GameObjects.Text[] = [];
  for (const go of scene.children.list) {
    if (go instanceof Phaser.GameObjects.Image) {
      if (!go.visible || go.alpha < 0.02) continue;
      if (!table.has(go.texture.key)) continue;
      if (cull) {
        const r = Math.max(go.displayWidth, go.displayHeight) * 0.5 + 24;
        if (go.x < cull.x - r || go.x > cull.x + cull.w + r || go.y < cull.y - r || go.y > cull.y + cull.h + r) continue;
      }
      imgs.push(go);
    } else if (go instanceof Phaser.GameObjects.Text) {
      if (!go.visible || go.alpha < 0.02) continue;
      if (cull && (go.x < cull.x - 200 || go.x > cull.x + cull.w + 200 || go.y < cull.y - 100 || go.y > cull.y + cull.h + 100)) continue;
      texts.push(go);
    }
  }
  return { imgs, texts };
}

const hex = (n: number) => n & 0xffffff;

export function encodeFrame(scene: Phaser.Scene, table: Map<string, number>, meta: Record<string, unknown>, cull: Cull | null): ArrayBuffer {
  const { imgs, texts } = collect(scene, table, cull);
  let list = imgs;
  if (list.length > MAX_RECS) {
    // shed decorative sparks first
    const keep = list.filter((g) => g.texture.key !== 'dot');
    const dots = list.filter((g) => g.texture.key === 'dot');
    const room = Math.max(0, MAX_RECS - keep.length);
    const step = dots.length / Math.max(1, room);
    const kept: Phaser.GameObjects.Image[] = [];
    for (let i = 0; i < room && Math.floor(i * step) < dots.length; i++) kept.push(dots[Math.floor(i * step)]);
    list = [...keep, ...kept].slice(0, MAX_RECS);
  }
  const textRecs: TextRec[] = texts.slice(0, 60).map((t) => ({
    x: Math.round(t.x), y: Math.round(t.y), s: t.text, color: String(t.style.color), size: Math.round(parseFloat(String(t.style.fontSize))), alpha: Math.round(t.alpha * 100) / 100,
    scale: Math.round(t.scaleX * 100) / 100, depth: t.depth,
  }));
  const json = new TextEncoder().encode(JSON.stringify({ ...meta, texts: textRecs }));
  const buf = new ArrayBuffer(4 + json.length + 2 + list.length * REC_BYTES);
  const dv = new DataView(buf);
  dv.setUint32(0, json.length, true);
  new Uint8Array(buf, 4, json.length).set(json);
  let o = 4 + json.length;
  dv.setUint16(o, list.length, true); o += 2;
  for (const g of list) {
    dv.setUint16(o, idOf(g), true);
    dv.setUint16(o + 2, table.get(g.texture.key)!, true);
    dv.setInt16(o + 4, Phaser.Math.Clamp(Math.round(g.x * 8), -32768, 32767), true);
    dv.setInt16(o + 6, Phaser.Math.Clamp(Math.round(g.y * 8), -32768, 32767), true);
    dv.setInt16(o + 8, Phaser.Math.Clamp(Math.round(g.scaleX * 64), -32768, 32767), true);
    dv.setInt16(o + 10, Phaser.Math.Clamp(Math.round(g.scaleY * 64), -32768, 32767), true);
    let rot = g.rotation % TWO_PI; if (rot < 0) rot += TWO_PI;
    dv.setUint16(o + 12, Math.round((rot / TWO_PI) * 65535), true);
    dv.setUint8(o + 14, Math.round(Phaser.Math.Clamp(g.alpha, 0, 1) * 255));
    const tint = g.isTinted ? hex(g.tintTopLeft) : 0xffffff;
    dv.setUint8(o + 15, (tint >> 16) & 255); dv.setUint8(o + 16, (tint >> 8) & 255); dv.setUint8(o + 17, tint & 255);
    dv.setUint16(o + 18, Math.round(Phaser.Math.Clamp(g.depth, 0, 30) * 2000), true);
    const oi = g.originX === 0 ? 1 : g.originX === 1 ? 2 : 0;
    const flags = (g.blendMode === Phaser.BlendModes.ADD ? 1 : 0) | (g.flipX ? 2 : 0) | (g.flipY ? 4 : 0) | (g.isTinted ? (g.tintFill ? 16 : 8) : 0) | (oi << 5);
    dv.setUint8(o + 20, flags);
    dv.setUint16(o + 21, 0, true); // reserved
    o += REC_BYTES;
  }
  return buf;
}

export function decodeFrame(buf: ArrayBuffer): { meta: Record<string, unknown> & { texts: TextRec[] }; recs: Rec[] } {
  const dv = new DataView(buf);
  const jl = dv.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
  let o = 4 + jl;
  const n = dv.getUint16(o, true); o += 2;
  const recs: Rec[] = [];
  for (let i = 0; i < n; i++) {
    const flags = dv.getUint8(o + 20);
    recs.push({
      id: dv.getUint16(o, true), tex: dv.getUint16(o + 2, true), x: dv.getInt16(o + 4, true) / 8, y: dv.getInt16(o + 6, true) / 8,
      sx: dv.getInt16(o + 8, true) / 64, sy: dv.getInt16(o + 10, true) / 64, rot: (dv.getUint16(o + 12, true) / 65535) * TWO_PI, alpha: dv.getUint8(o + 14) / 255,
      tint: (dv.getUint8(o + 15) << 16) | (dv.getUint8(o + 16) << 8) | dv.getUint8(o + 17), tintMode: (flags & 8) ? 1 : (flags & 16) ? 2 : 0,
      depth: dv.getUint16(o + 18, true) / 2000, add: !!(flags & 1), flipX: !!(flags & 2), flipY: !!(flags & 4), origin: (flags >> 5) & 3,
    });
    o += REC_BYTES;
  }
  return { meta, recs };
}

/** Guest-side pool: images keyed by the host's ids, eased towards the latest snapshot. */
export class MirrorLayer {
  private imgs = new Map<number, { img: Phaser.GameObjects.Image; tx: number; ty: number; seen: number }>();
  private free: Phaser.GameObjects.Image[] = [];
  private texts: Phaser.GameObjects.Text[] = [];
  private frame = 0;

  constructor(private scene: Phaser.Scene, private names: string[]) {}

  apply(recs: Rec[], texts: TextRec[]) {
    this.frame++;
    for (const r of recs) {
      let e = this.imgs.get(r.id);
      if (!e) {
        const img = this.free.pop() ?? this.scene.add.image(0, 0, this.names[r.tex]);
        e = { img, tx: r.x, ty: r.y, seen: this.frame };
        img.setPosition(r.x, r.y);
        this.imgs.set(r.id, e);
      }
      const im = e.img;
      e.seen = this.frame; e.tx = r.x; e.ty = r.y;
      if (Math.abs(im.x - r.x) > 220 || Math.abs(im.y - r.y) > 220) im.setPosition(r.x, r.y);
      const name = this.names[r.tex];
      if (name && im.texture.key !== name) im.setTexture(name);
      const [ox, oy] = ORIGINS[r.origin] ?? ORIGINS[0];
      im.setVisible(true).setOrigin(ox, oy).setScale(r.sx, r.sy).setRotation(r.rot).setAlpha(r.alpha).setDepth(r.depth)
        .setFlip(r.flipX, r.flipY).setBlendMode(r.add ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL);
      if (r.tintMode === 2) im.setTintFill(r.tint); else if (r.tintMode === 1) im.setTint(r.tint); else im.clearTint();
    }
    for (const [id, e] of this.imgs) {
      if (e.seen !== this.frame) { e.img.setVisible(false); this.free.push(e.img); this.imgs.delete(id); }
    }
    // floating text
    while (this.texts.length < texts.length) {
      this.texts.push(this.scene.add.text(0, 0, '', { fontFamily: '"Press Start 2P", monospace', fontSize: '10px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setVisible(false));
    }
    this.texts.forEach((t, i) => {
      const r = texts[i];
      if (!r) { t.setVisible(false); return; }
      t.setText(r.s).setColor(r.color).setFontSize(r.size).setPosition(r.x, r.y).setAlpha(r.alpha).setScale(r.scale).setDepth(r.depth).setVisible(true);
    });
  }

  /** Ease the images towards their targets (called every rendered frame). */
  update(dt: number) {
    const k = 1 - Math.exp(-dt * 22);
    for (const e of this.imgs.values()) {
      e.img.x += (e.tx - e.img.x) * k;
      e.img.y += (e.ty - e.img.y) * k;
    }
  }

  clear() {
    for (const e of this.imgs.values()) { e.img.setVisible(false); this.free.push(e.img); }
    this.imgs.clear();
    for (const t of this.texts) t.setVisible(false);
  }

  destroy() {
    for (const e of this.imgs.values()) e.img.destroy();
    for (const i of this.free) i.destroy();
    for (const t of this.texts) t.destroy();
    this.imgs.clear(); this.free = []; this.texts = [];
  }
}
