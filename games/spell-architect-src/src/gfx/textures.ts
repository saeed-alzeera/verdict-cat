// All art is generated procedurally at boot: pixel-art sprites from small ASCII maps plus a few
// soft-glow textures. No image files required.
import Phaser from 'phaser';

type Ctx = CanvasRenderingContext2D;

function canvasTex(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: Ctx) => void, smooth = false) {
  if (scene.textures.exists(key)) return;
  const t = scene.textures.createCanvas(key, w, h)!;
  const c = t.getContext();
  c.imageSmoothingEnabled = false;
  draw(c);
  t.refresh();
  t.setFilter(smooth ? Phaser.Textures.FilterMode.LINEAR : Phaser.Textures.FilterMode.NEAREST);
}

/** Mirrors an 8-wide left half into a 16-wide sprite. */
function halfSprite(rows: string[], pal: Record<string, string>, c: Ctx, ox = 0, oy = 0) {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const col = pal[ch];
      if (!col) continue;
      c.fillStyle = col;
      c.fillRect(ox + x, oy + y, 1, 1);
      c.fillRect(ox + 15 - x, oy + y, 1, 1);
    }
  });
}
const px = (c: Ctx, col: string, x: number, y: number, w = 1, h = 1) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
const sym = (c: Ctx, W: number, col: string, x: number, y: number, w: number, h: number) => {
  c.fillStyle = col; c.fillRect(x, y, w, h); c.fillRect(W - x - w, y, w, h);
};

function pixDisc(c: Ctx, cx: number, cy: number, r: number, col: string) {
  c.fillStyle = col;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + 0.5) c.fillRect(cx + x, cy + y, 1, 1);
}

function glow(c: Ctx, s: number, stops: [number, string][]) {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
}

export function generateTextures(scene: Phaser.Scene) {
  /* ---------------- wizard ---------------- */
  const wizPal = { h: '#5b3fa8', H: '#8366e0', B: '#3a2a78', s: '#f2c9a0', e: '#1a1030', b: '#ecebf6', r: '#3f6fd1', R: '#6a9bf0', g: '#ffd25a', k: '#4a3320' };
  const wizRows = [
    '.......h', '......hh', '......hH', '.....hhH', '.....hhh', '....hhHh', '..BBBBBB', '...sesss',
    '...sbbbb', '..rbbbbb', '..rRbbbb', '..rrRrrg', '..rrrrrr', '.rrrrrrr', '.rrrrrrr', '..kkkk..',
  ];
  for (let f = 0; f < 2; f++) {
    canvasTex(scene, `wiz${f}`, 16, 16, (c) => {
      halfSprite(wizRows, wizPal, c);
      // staff
      px(c, '#7a5530', 1, 6 + f, 1, 9);
      px(c, '#7ff3ff', 0, 4 + f, 3, 3);
      px(c, '#ffffff', 1, 5 + f, 1, 1);
      if (f) { px(c, '#4a3320', 5, 15, 2, 1); } else { px(c, '#4a3320', 9, 15, 2, 1); }
    });
  }

  /* ---------------- enemies ---------------- */
  canvasTex(scene, 'grunt', 16, 16, (c) => halfSprite([
    '........', '........', '....dddd', '...dGGGG', '..dGGGGG', 'gdGwewGG', 'gGGGGGGG', '.gGGmmmm',
    '..dGGGGG', '..dddddd', '.dggggGg', 'dggGgggg', 'dgGGgggg', 'dggggggg', '..dd.ddd', '..dd.ddd',
  ], { g: '#6fae4a', G: '#93d46a', d: '#2f5d24', w: '#fff7c0', e: '#c22', m: '#2a1a1a' }, c));

  canvasTex(scene, 'swarmer', 16, 16, (c) => halfSprite([
    '........', '........', '........', '........', 'p......p', 'pp....pP', 'ppp..pPP', 'pppPPPPP',
    'ppppPeeP', '.pppPPPP', '..pp.PPP', '...p..PP', '........', '........', '........', '........',
  ], { p: '#8d3fd1', P: '#b565ff', e: '#ffec3d' }, c));

  canvasTex(scene, 'archer', 16, 16, (c) => {
    halfSprite([
      '........', '....hhhh', '...hhhhh', '..hhhhhh', '..hhkkkk', '..hhkykk', '..hhkkkk', '...hhhhh',
      '..hhhHHH', '..hhHhhh', '..hhHhhh', '..hhhhhh', '..hhhhhh', '..hhhhhh', '..hh.hhh', '..dd.ddd',
    ], { h: '#2f7c8a', H: '#59b9c9', k: '#101820', y: '#ffe14d', d: '#14343b' }, c);
    px(c, '#c9a36b', 13, 3, 1, 10); px(c, '#e8e0c8', 12, 4, 1, 1); px(c, '#e8e0c8', 12, 11, 1, 1); px(c, '#e8e0c8', 12, 7, 1, 1);
  });

  canvasTex(scene, 'charger', 16, 16, (c) => halfSprite([
    '........', '........', '........', '.....ddd', '..ddbbbb', '.dbbbbbb', 'wdbbeebb', 'wwbbbbbb',
    '.wbbBBBB', '.dbbBBBB', 'dbbbbBBB', 'dbbbbbbb', 'dbbbbbbb', 'dd.dd.dd', 'd..d..d.', '........',
  ], { b: '#a05a2c', B: '#c9803f', d: '#4a2410', w: '#f3efe0', e: '#ff3b3b' }, c));

  canvasTex(scene, 'armored', 16, 16, (c) => halfSprite([
    '........', '...ddddd', '..daaAAA', '..daAAAA', '..dakkkk', '..daekek', '.dddaaaa', 'dAAAddaa',
    'dAaAAaaA', 'daaAaaaa', 'dAaAaaaa', 'dAaAaaaa', '.daaaaaa', '..ddaaaa', '..dAaAdd', '..dddd..',
  ], { a: '#8a93a6', A: '#c3cad8', d: '#363c4c', k: '#14161c', e: '#ff5a3c' }, c));

  canvasTex(scene, 'shaman', 16, 16, (c) => {
    halfSprite([
      'h......h', 'hh....hh', '.hh..hh.', '..hhhhhh', '..hrrrrr', '..rrkkkk', '..rrkyky', '..rrrrrr',
      '..rrRRRR', '.rrRrrrr', '.rrRrrrr', '.rrrrrrr', 'rrrrgrrr', 'rrrrrrrr', 'rr.rrr.r', '.....rrr',
    ], { h: '#ffe9a8', r: '#c2412d', R: '#e66a4c', k: '#26100d', y: '#ffe14d', g: '#ffd25a' }, c);
    pixDisc(c, 14, 3, 2, '#ffd25a'); px(c, '#fff', 14, 2, 1, 1);
  });

  /* ---------------- bosses (32x32, symmetric) ---------------- */
  canvasTex(scene, 'boss0', 32, 32, (c) => { // Stone Warden
    const W = 32;
    sym(c, W, '#3b4252', 5, 6, 8, 20); sym(c, W, '#5c667d', 6, 7, 7, 18);
    sym(c, W, '#3b4252', 9, 2, 7, 8); sym(c, W, '#8a93a6', 10, 3, 6, 6);
    px(c, '#2a2f3b', 12, 8, 8, 18); px(c, '#6e7890', 13, 9, 6, 16);
    sym(c, W, '#ff6a2a', 11, 5, 3, 2); px(c, '#ffd09a', 12, 5, 1, 1); px(c, '#ffd09a', 19, 5, 1, 1);
    sym(c, W, '#2a2f3b', 3, 12, 5, 12); sym(c, W, '#8a93a6', 4, 13, 3, 10);
    sym(c, W, '#3b4252', 8, 26, 5, 5); px(c, '#ff6a2a', 15, 14, 2, 4);
    sym(c, W, '#c3cad8', 9, 1, 2, 3);
  });
  canvasTex(scene, 'boss1', 32, 32, (c) => { // Plague Matron
    const W = 32;
    pixDisc(c, 16, 16, 11, '#2d5a1c'); pixDisc(c, 16, 15, 9, '#4f9a2c'); pixDisc(c, 14, 12, 4, '#7bd44a');
    sym(c, W, '#1d3b12', 4, 22, 3, 8); sym(c, W, '#1d3b12', 8, 25, 3, 6); sym(c, W, '#1d3b12', 12, 26, 3, 5);
    sym(c, W, '#e8ff7a', 10, 10, 3, 3); sym(c, W, '#102008', 11, 11, 1, 1);
    px(c, '#102008', 12, 18, 8, 2); px(c, '#e8ff7a', 13, 18, 1, 1); px(c, '#e8ff7a', 18, 18, 1, 1);
    sym(c, W, '#a6ff5a', 7, 5, 2, 2); sym(c, W, '#a6ff5a', 4, 14, 2, 2); px(c, '#a6ff5a', 15, 3, 2, 2);
  });
  canvasTex(scene, 'boss2', 32, 32, (c) => { // Storm Colossus
    const W = 32;
    sym(c, W, '#1e3a8a', 6, 9, 8, 18); sym(c, W, '#3b6fe0', 7, 10, 6, 16);
    px(c, '#16255e', 12, 8, 8, 20); px(c, '#2b4fb0', 13, 9, 6, 18);
    sym(c, W, '#16255e', 10, 2, 6, 8); sym(c, W, '#4f86ff', 11, 3, 5, 6);
    sym(c, W, '#fff35e', 12, 5, 3, 2); px(c, '#fff', 13, 5, 1, 1);
    sym(c, W, '#fff35e', 8, 0, 1, 4); sym(c, W, '#fff35e', 11, 0, 1, 3); px(c, '#fff35e', 15, 0, 2, 3);
    sym(c, W, '#16255e', 2, 12, 5, 14); sym(c, W, '#4f86ff', 3, 13, 3, 12);
    px(c, '#fff35e', 14, 14, 4, 6); px(c, '#fff', 15, 15, 2, 4);
    sym(c, W, '#16255e', 9, 27, 5, 4);
  });
  canvasTex(scene, 'boss3', 32, 32, (c) => { // Void Architect
    const W = 32;
    sym(c, W, '#1a0b3a', 6, 6, 6, 24); sym(c, W, '#3a1a78', 8, 8, 5, 20);
    px(c, '#10061f', 11, 4, 10, 26); px(c, '#2a1260', 12, 6, 8, 22);
    sym(c, W, '#10061f', 9, 1, 5, 8); sym(c, W, '#4a22a0', 10, 2, 4, 6);
    px(c, '#05020c', 12, 4, 8, 6);
    sym(c, W, '#e86bff', 12, 6, 2, 2); sym(c, W, '#ffffff', 12, 6, 1, 1);
    sym(c, W, '#c26bff', 3, 11, 2, 10); sym(c, W, '#e0b0ff', 3, 11, 1, 3);
    pixDisc(c, 16, 18, 3, '#c26bff'); pixDisc(c, 16, 18, 1, '#ffffff');
    sym(c, W, '#6a2fd0', 5, 28, 3, 3);
  });

  /* ---------------- spell visuals ---------------- */
  canvasTex(scene, 'proj_fire', 16, 16, (c) => { pixDisc(c, 8, 8, 6, '#ff3b0a'); pixDisc(c, 8, 8, 4, '#ff9a1a'); pixDisc(c, 8, 8, 2, '#fff2a0'); });
  canvasTex(scene, 'proj_ice', 16, 16, (c) => {
    for (let i = 0; i < 8; i++) { px(c, i < 4 ? '#66ddff' : '#66ddff', 8 - i, 8 - Math.min(i, 3), 1 + i * 2, 1 + Math.min(i, 3) * 2); }
    c.clearRect(0, 0, 16, 16);
    c.fillStyle = '#66ddff'; c.beginPath(); c.moveTo(1, 8); c.lineTo(8, 3); c.lineTo(15, 8); c.lineTo(8, 13); c.closePath(); c.fill();
    c.fillStyle = '#d8f8ff'; c.beginPath(); c.moveTo(4, 8); c.lineTo(8, 5); c.lineTo(12, 8); c.lineTo(8, 11); c.closePath(); c.fill();
  });
  canvasTex(scene, 'proj_lightning', 16, 16, (c) => {
    c.fillStyle = '#fff35e'; c.beginPath(); c.moveTo(9, 0); c.lineTo(3, 9); c.lineTo(7, 9); c.lineTo(5, 16); c.lineTo(13, 6); c.lineTo(9, 6); c.lineTo(11, 0); c.closePath(); c.fill();
    c.fillStyle = '#fff'; c.fillRect(7, 5, 2, 5);
  });
  canvasTex(scene, 'proj_poison', 16, 16, (c) => { pixDisc(c, 8, 8, 6, '#3f8f1a'); pixDisc(c, 8, 8, 4, '#7dff4a'); pixDisc(c, 6, 6, 1, '#e8ffd0'); px(c, '#3f8f1a', 12, 3, 2, 2); });
  canvasTex(scene, 'proj_water', 16, 16, (c) => {
    c.fillStyle = '#3d8bff'; c.beginPath(); c.moveTo(8, 1); c.lineTo(14, 10); c.arc(8, 10, 6, 0, Math.PI, false); c.closePath(); c.fill();
    c.fillStyle = '#9fd0ff'; c.fillRect(5, 8, 2, 4);
  });
  canvasTex(scene, 'proj_gravity', 16, 16, (c) => { pixDisc(c, 8, 8, 7, '#b36bff'); pixDisc(c, 8, 8, 5, '#2a0f55'); pixDisc(c, 8, 8, 2, '#05020c'); });
  canvasTex(scene, 'proj_arcane', 16, 16, (c) => {
    c.fillStyle = '#c9a6ff'; c.beginPath(); c.moveTo(8, 0); c.lineTo(10, 6); c.lineTo(16, 8); c.lineTo(10, 10); c.lineTo(8, 16); c.lineTo(6, 10); c.lineTo(0, 8); c.lineTo(6, 6); c.closePath(); c.fill();
    c.fillStyle = '#ffffff'; c.fillRect(6, 6, 4, 4);
  });
  canvasTex(scene, 'tail', 64, 16, (c) => {
    const g = c.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.9)');
    c.fillStyle = g; c.beginPath(); c.moveTo(0, 8); c.lineTo(64, 1); c.lineTo(64, 15); c.closePath(); c.fill();
  }, true);
  canvasTex(scene, 'runering', 128, 128, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.arc(64, 64, 61, 0, 6.2832); c.stroke();
    c.lineWidth = 1.5; c.beginPath(); c.arc(64, 64, 54, 0, 6.2832); c.stroke();
    c.lineWidth = 2;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * 6.2832, r0 = 54, r1 = i % 3 === 0 ? 47 : 51;
      c.beginPath(); c.moveTo(64 + Math.cos(a) * r0, 64 + Math.sin(a) * r0); c.lineTo(64 + Math.cos(a) * r1, 64 + Math.sin(a) * r1); c.stroke();
    }
    c.setLineDash([6, 5]); c.lineWidth = 1.5; c.beginPath(); c.arc(64, 64, 40, 0, 6.2832); c.stroke(); c.setLineDash([]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 6.2832 + 0.3, cx = 64 + Math.cos(a) * 33, cy = 64 + Math.sin(a) * 33;
      c.save(); c.translate(cx, cy); c.rotate(a + 1.57);
      c.beginPath(); c.moveTo(0, -5); c.lineTo(4, 4); c.lineTo(-4, 4); c.closePath(); c.fillStyle = '#fff'; c.globalAlpha = 0.7; c.fill(); c.restore();
    }
  }, true);
  canvasTex(scene, 'swirl', 128, 128, (c) => {
    for (let arm = 0; arm < 3; arm++) {
      for (let i = 0; i < 90; i++) {
        const t = i / 90, a = arm * 2.094 + t * 5.5, r = 6 + t * 56;
        c.fillStyle = `rgba(255,255,255,${(1 - t) * 0.55})`;
        c.beginPath(); c.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 1.5 + (1 - t) * 3, 0, 6.2832); c.fill();
      }
    }
  }, true);
  canvasTex(scene, 'orb_core', 16, 16, (c) => { pixDisc(c, 8, 8, 7, '#ffffff'); pixDisc(c, 8, 8, 4, '#ffffff'); });

  canvasTex(scene, 'dot', 32, 32, (c) => glow(c, 32, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]), true);
  canvasTex(scene, 'spark', 8, 8, (c) => { px(c, '#fff', 3, 0, 2, 8); px(c, '#fff', 0, 3, 8, 2); });
  canvasTex(scene, 'zone', 128, 128, (c) => {
    glow(c, 128, [[0, 'rgba(255,255,255,0.16)'], [0.8, 'rgba(255,255,255,0.22)'], [0.93, 'rgba(255,255,255,0.7)'], [0.97, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
  }, true);
  canvasTex(scene, 'ring', 128, 128, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.arc(64, 64, 60, 0, Math.PI * 2); c.stroke();
  }, true);
  canvasTex(scene, 'beam', 64, 16, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 16);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.35, 'rgba(255,255,255,0.7)'); g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 16);
  }, true);
  canvasTex(scene, 'puddle', 64, 64, (c) => {
    glow(c, 64, [[0, 'rgba(255,255,255,0.35)'], [0.7, 'rgba(255,255,255,0.35)'], [0.9, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]);
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1; c.beginPath(); c.arc(28, 30, 10, 0, 6.3); c.stroke(); c.beginPath(); c.arc(40, 38, 6, 0, 6.3); c.stroke();
  }, true);
  canvasTex(scene, 'shadow', 16, 8, (c) => { c.fillStyle = 'rgba(0,0,0,0.45)'; c.beginPath(); c.ellipse(8, 4, 7, 3, 0, 0, 6.3); c.fill(); });
  canvasTex(scene, 'gem', 8, 8, (c) => {
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(4, 0); c.lineTo(8, 4); c.lineTo(4, 8); c.lineTo(0, 4); c.closePath(); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(4, 3, 3, 3);
    c.fillStyle = 'rgba(255,255,255,0.9)'; c.fillRect(2, 3, 1, 1);
  });
  canvasTex(scene, 'coin', 8, 8, (c) => {
    pixDisc(c, 4, 4, 4, '#b8861a'); pixDisc(c, 4, 4, 3, '#ffd25a'); px(c, '#fff3b0', 2, 2, 1, 2); px(c, '#b8861a', 4, 2, 1, 4);
  });
  canvasTex(scene, 'heart', 10, 10, (c) => {
    px(c, '#ff4a6a', 1, 1, 3, 3); px(c, '#ff4a6a', 6, 1, 3, 3); px(c, '#ff4a6a', 0, 2, 10, 3); px(c, '#ff4a6a', 1, 5, 8, 2); px(c, '#ff4a6a', 2, 7, 6, 1); px(c, '#ff4a6a', 4, 8, 2, 1);
    px(c, '#ffc0cc', 2, 2, 1, 1);
  });
  canvasTex(scene, 'chest', 14, 12, (c) => {
    px(c, '#6b3b12', 0, 3, 14, 9); px(c, '#a8641f', 1, 4, 12, 7); px(c, '#6b3b12', 0, 0, 14, 4); px(c, '#c98a35', 1, 1, 12, 3);
    px(c, '#ffd25a', 6, 4, 2, 3); px(c, '#ffd25a', 0, 6, 14, 1);
  });
  canvasTex(scene, 'magnet', 10, 10, (c) => {
    px(c, '#ff4a4a', 0, 0, 3, 7); px(c, '#4a7aff', 7, 0, 3, 7); px(c, '#ddd', 0, 7, 10, 3); px(c, '#999', 3, 7, 4, 3);
  });
  canvasTex(scene, 'ebullet', 10, 10, (c) => { pixDisc(c, 5, 5, 4, '#ff2a4a'); pixDisc(c, 5, 5, 2, '#ffd0d8'); });
  canvasTex(scene, 'shard', 8, 8, (c) => { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(0, 4); c.lineTo(8, 0); c.lineTo(8, 8); c.closePath(); c.fill(); });

  canvasTex(scene, 'floor', 256, 256, (c) => {
    c.fillStyle = '#15111f'; c.fillRect(0, 0, 256, 256);
    const rnd = mulberry(7);
    for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) {
      const v = rnd();
      c.fillStyle = v < 0.5 ? '#181326' : v < 0.8 ? '#130f1d' : '#1b1530';
      c.fillRect(tx * 32 + 1, ty * 32 + 1, 30, 30);
      if (rnd() < 0.35) { c.fillStyle = '#0f0c18'; c.fillRect(tx * 32 + 1 + ((rnd() * 24) | 0), ty * 32 + 1 + ((rnd() * 24) | 0), 4 + ((rnd() * 6) | 0), 1); }
    }
    for (let i = 0; i < 120; i++) { c.fillStyle = rnd() < 0.5 ? '#1d1730' : '#0e0b16'; c.fillRect((rnd() * 256) | 0, (rnd() * 256) | 0, 2, 2); }
    // faint rune marks
    c.strokeStyle = 'rgba(120,90,200,0.14)'; c.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const x = 40 + rnd() * 170, y = 40 + rnd() * 170;
      c.beginPath(); c.arc(x, y, 9, 0, 6.3); c.stroke(); c.beginPath(); c.moveTo(x - 6, y + 4); c.lineTo(x, y - 6); c.lineTo(x + 6, y + 4); c.closePath(); c.stroke();
    }
  });
}

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
