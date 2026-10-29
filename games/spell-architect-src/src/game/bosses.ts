// Minibosses and the final boss: telegraphed multi-pattern attacks.
import type { Enemy } from './types';
import type { Run } from './run';
import { ARENA } from './run';
import { hpMul, ramp, spawnEnemy } from './enemies';
import { audio } from '../core/audio';

import { BOSS_RES } from './rounds';

interface BDef { name: string; tex: string; hp: number; r: number; sc: number; speed: number; dmg: number; color: number; attacks: string[]; xp: number }
const BOSSES: BDef[] = [
  { name: 'Stone Warden', tex: 'boss0', hp: 1800, r: 34, sc: 4.2, speed: 46, dmg: 16, color: 0xff8a3a, attacks: ['ring', 'slam', 'charge', 'summon'], xp: 80 },
  { name: 'Plague Matron', tex: 'boss1', hp: 3600, r: 36, sc: 4.2, speed: 42, dmg: 18, color: 0x7dff4a, attacks: ['aimed', 'pools', 'summon', 'spiral'], xp: 140 },
  { name: 'Storm Colossus', tex: 'boss2', hp: 6000, r: 38, sc: 4.4, speed: 50, dmg: 20, color: 0xfff35e, attacks: ['lines', 'spiral', 'ring', 'charge'], xp: 220 },
  { name: 'The Void Architect', tex: 'boss3', hp: 12000, r: 40, sc: 4.6, speed: 44, dmg: 24, color: 0xc26bff, attacks: ['ring', 'spiral', 'slam', 'lines', 'pull', 'summon', 'aimed'], xp: 600 },
];
export const BOSS_NAMES = BOSSES.map((b) => b.name);

export function spawnBoss(run: Run, kind: number) {
  const d = BOSSES[kind];
  const p = run.player;
  const a = Math.random() * 6.28;
  const x = Math.max(80, Math.min(ARENA - 80, p.x + Math.cos(a) * 380));
  const y = Math.max(80, Math.min(ARENA - 80, p.y + Math.sin(a) * 380));
  const e = spawnEnemy(run, 'grunt', x, y, false, 'neutral');
  // re-skin the placeholder grunt into a boss
  run.freeImg(e.spr); run.freeImg(e.shadow);
  e.type = 'boss';
  e.spr = run.img(d.tex, 6); e.shadow = run.img('shadow', 4).setScale(d.sc * 1.1).setAlpha(0.8);
  e.sc = d.sc; e.r = d.r; e.speed = d.speed * 1.35; e.elite = false;
  e.aff = 'neutral'; e.res = { ...BOSS_RES[kind] };
  e.maxHp = e.hp = d.hp * Math.pow(hpMul(run.dtime), 0.75) * (run.quick ? 0.8 : 1);
  e.dmg = d.dmg * (1 + 0.25 * ramp(run.dtime)) * (1 + run.dtime / 60 * 0.05);
  e.xp = d.xp; e.armor = 2 + kind * 2; e.spawnT = 0.5;
  e.boss = {
    kind, name: d.name, phase: 0, cd: 2.2, atk: '', atkT: 0, dash: 0, dx: 0, dy: 0, spiral: 0, spiralAng: 0, pull: 0, last: '', enraged: false,
  };
  e.spr.setScale(d.sc);
  run.boss = e;
  run.announce(`${d.name.toUpperCase()}`, '#ff6b6b', kind === 3 ? 'The final guardian awakens. Survive and destroy it!' : 'Defeat it to claim a Rune Cache.');
  audio.play('boss');
  run.fx.shake(8);
  run.fx.ring(x, y, d.color, 20, 300, 0.7);
  run.scene.cameras.main.flash(300, 80, 20, 20);
}

export function updateBoss(run: Run, e: Enemy, dt: number, mul: number, dist: number, nx: number, ny: number) {
  const b = e.boss!;
  const d = BOSSES[b.kind];
  const p = run.player;
  const frac = e.hp / e.maxHp;
  const phase = b.kind === 3 ? (frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2) : frac > 0.5 ? 0 : 1;
  if (phase !== b.phase) {
    b.phase = phase;
    run.announce(b.kind === 3 ? `PHASE ${phase + 1}` : 'ENRAGED', '#ff6b6b');
    run.fx.shake(7); run.fx.ring(e.x, e.y, d.color, 20, 280, 0.6); audio.play('boss');
  }
  e.face = nx > 0 ? 1 : -1;

  if (b.dash > 0) {
    b.dash -= dt;
    e.x += b.dx * 620 * dt; e.y += b.dy * 620 * dt;
    if (Math.random() < 0.8) run.fx.spark(e.x, e.y, 0, 0, d.color, 0.4, 1.8);
    if (b.dash <= 0 && b.kind === 3) ring(run, e, 12 + phase * 4, 190, Math.random());
    if (e.x < 60 || e.x > ARENA - 60 || e.y < 60 || e.y > ARENA - 60) b.dash = 0;
  } else if (b.atkT > 0) {
    b.atkT -= dt;
  } else {
    // drift toward preferred range
    if (dist > 260) { e.x += nx * e.speed * mul * dt; e.y += ny * e.speed * mul * dt; }
    else if (dist < 150) { e.x -= nx * e.speed * 0.6 * mul * dt; e.y -= ny * e.speed * 0.6 * mul * dt; }
  }
  e.x = Math.max(50, Math.min(ARENA - 50, e.x));
  e.y = Math.max(50, Math.min(ARENA - 50, e.y));

  if (b.spiral > 0) {
    b.spiral -= dt;
    b.spiralAng += dt * 2.8;
    e.stT -= dt;
    if (e.stT <= 0) {
      e.stT = 0.1;
      const arms = 2 + phase;
      for (let i = 0; i < arms; i++) run.fireBullet(e.x, e.y, b.spiralAng + (i / arms) * 6.2832, 190, e.dmg * 0.5, d.color);
    }
  }
  if (b.pull > 0) {
    b.pull -= dt;
    p.pullT = 0.1; p.pullX = e.x; p.pullY = e.y;
    e.atk -= dt;
    if (e.atk <= 0) { e.atk = 0.7; run.fireBullet(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), 240, e.dmg * 0.65, d.color); }
  }

  b.cd -= dt;
  if (b.cd <= 0 && b.atkT <= 0 && b.dash <= 0 && b.spiral <= 0 && b.pull <= 0) {
    const pool = d.attacks.filter((a) => a !== b.last);
    const atk = pool[(Math.random() * pool.length) | 0];
    b.last = atk;
    startAttack(run, e, atk, phase);
    b.cd = Math.max(1.4, 3.5 - phase * 0.7 - (b.kind === 3 ? 0.4 : 0));
  }
}

function ring(run: Run, e: Enemy, n: number, speed: number, off: number) {
  const d = BOSSES[e.boss!.kind];
  for (let i = 0; i < n; i++) run.fireBullet(e.x, e.y, off * 6.28 + (i / n) * 6.2832, speed, e.dmg * 0.62, d.color);
  run.fx.ring(e.x, e.y, d.color, 20, 90, 0.35);
  audio.play('boom');
}

function startAttack(run: Run, e: Enemy, atk: string, ph: number) {
  const b = e.boss!;
  const d = BOSSES[b.kind];
  const p = run.player;
  switch (atk) {
    case 'ring': {
      b.atkT = 1.0;
      run.addTelegraph({ shape: 'ring', x: e.x, y: e.y, r: 90, dur: 0.8, color: d.color, follow: e, onDone: () => {
        ring(run, e, 16 + ph * 6, 200, Math.random());
        if (ph > 0 || b.kind === 3) run.later(0.45, () => { if (!e.dead) ring(run, e, 16 + ph * 6, 170, Math.random()); });
      } });
      break;
    }
    case 'aimed': {
      b.atkT = 1.4;
      run.addTelegraph({ shape: 'ring', x: e.x, y: e.y, r: 50, dur: 0.5, color: d.color, follow: e, onDone: () => {
        for (let v = 0; v < 3; v++) run.later(v * 0.32, () => {
          if (e.dead) return;
          const a = Math.atan2(p.y - e.y, p.x - e.x);
          const n = 5 + ph * 2;
          for (let i = 0; i < n; i++) run.fireBullet(e.x, e.y, a + (i - (n - 1) / 2) * 0.17, 250, e.dmg * 0.62, d.color);
          audio.play('warn');
        });
      } });
      break;
    }
    case 'slam': {
      b.atkT = 1.0;
      const n = 3 + ph;
      for (let k = 0; k < n; k++) {
        const tx = k === 0 ? p.x : p.x + (Math.random() - 0.5) * 340;
        const ty = k === 0 ? p.y : p.y + (Math.random() - 0.5) * 340;
        run.later(k * 0.25, () => {
          if (e.dead) return;
          run.addTelegraph({ shape: 'circle', x: tx, y: ty, r: 70, dur: 1.0, color: 0xff4a4a, follow: null, onDone: () => {
            run.fx.ring(tx, ty, 0xff8a3a, 10, 70, 0.35);
            run.fx.burst(tx, ty, 0xff8a3a, 12, 220, 0.5, 1.3);
            run.fx.shake(4); audio.play('boom');
            if ((p.x - tx) ** 2 + (p.y - ty) ** 2 < (70 + p.r) ** 2) run.hurtPlayer(e.dmg * 1.3, tx, ty, `${e.boss?.name ?? 'Boss'} (slam)`);
          } });
        });
      }
      break;
    }
    case 'pools': {
      b.atkT = 1.0;
      const n = 3 + ph;
      for (let k = 0; k < n; k++) {
        const tx = k === 0 ? p.x : p.x + (Math.random() - 0.5) * 360;
        const ty = k === 0 ? p.y : p.y + (Math.random() - 0.5) * 360;
        run.later(k * 0.2, () => {
          if (e.dead) return;
          run.addTelegraph({ shape: 'circle', x: tx, y: ty, r: 75, dur: 1.2, color: 0x7dff4a, follow: null, onDone: () => {
            run.fx.burst(tx, ty, 0x7dff4a, 12, 160, 0.6, 1.4);
            run.addZone(tx, ty, 75, 5, e.dmg * 0.4);
          } });
        });
      }
      break;
    }
    case 'charge': {
      b.atkT = 1.4;
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      run.addTelegraph({ shape: 'line', x: e.x, y: e.y, r: 0, ang: a, len: 620, w: 70, dur: 0.9, color: 0xff4a4a, follow: e, onDone: () => {
        b.dash = 0.75; b.dx = Math.cos(a); b.dy = Math.sin(a); audio.play('boss');
      } });
      break;
    }
    case 'lines': {
      b.atkT = 1.4;
      const n = 3 + ph + (b.kind === 3 ? 1 : 0);
      const a0 = Math.atan2(p.y - e.y, p.x - e.x);
      for (let i = 0; i < n; i++) {
        const a = a0 + (i - (n - 1) / 2) * (0.5 + Math.random() * 0.12);
        run.addTelegraph({ shape: 'line', x: e.x, y: e.y, r: 0, ang: a, len: 1200, w: 46, dur: 1.15, color: 0xff4a4a, follow: e, onDone: () => {
          run.fx.bolt(e.x, e.y, e.x + Math.cos(a) * 1200, e.y + Math.sin(a) * 1200, d.color, 40, 0.3);
          run.fx.bolt(e.x, e.y, e.x + Math.cos(a) * 1200, e.y + Math.sin(a) * 1200, 0xffffff, 14, 0.25);
          run.fx.shake(5); audio.play('boom');
          const rx = p.x - e.x, ry = p.y - e.y;
          const along = rx * Math.cos(a) + ry * Math.sin(a);
          const perp = Math.abs(-rx * Math.sin(a) + ry * Math.cos(a));
          if (along > 0 && perp < 23 + p.r) run.hurtPlayer(e.dmg * 1.4, e.x, e.y, `${e.boss?.name ?? 'Boss'} (beam)`);
        } });
      }
      break;
    }
    case 'spiral': {
      b.atkT = 0.6;
      run.addTelegraph({ shape: 'ring', x: e.x, y: e.y, r: 60, dur: 0.6, color: d.color, follow: e, onDone: () => { b.spiral = 3.0 + ph * 0.6; b.spiralAng = Math.random() * 6.28; } });
      break;
    }
    case 'pull': {
      b.atkT = 0.8;
      run.addTelegraph({ shape: 'ring', x: e.x, y: e.y, r: 320, dur: 1.0, color: 0xb36bff, follow: e, onDone: () => { b.pull = 2.4; audio.play('boss'); } });
      break;
    }
    case 'summon': {
      b.atkT = 1.2;
      run.addTelegraph({ shape: 'ring', x: e.x, y: e.y, r: 100, dur: 0.8, color: d.color, follow: e, onDone: () => {
        const n = 5 + ph * 2;
        const type = b.kind === 1 ? 'swarmer' : b.kind === 3 ? 'armored' : 'grunt';
        const cnt = type === 'armored' ? Math.ceil(n / 3) : n;
        for (let i = 0; i < cnt; i++) {
          const a = (i / cnt) * 6.28;
          spawnEnemy(run, type, e.x + Math.cos(a) * 80, e.y + Math.sin(a) * 80);
        }
        run.fx.ring(e.x, e.y, d.color, 20, 110, 0.4);
      } });
      break;
    }
  }
}
