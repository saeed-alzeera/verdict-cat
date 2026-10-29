// Enemy archetypes, AI, spawning director.
import type { EType, Enemy } from './types';
import type { Run } from './run';
import { ARENA } from './run';
import { updateStatus } from './combat';
import { audio } from '../core/audio';
import { spawnBoss, updateBoss } from './bosses';
import { resFor, roundLen, isBossRound, bossKind, type Aff } from './rounds';
import { ELEMENTS } from '../data/runes';

export interface EDef { tex: string; hp: number; speed: number; r: number; dmg: number; xp: number; armor: number; sc: number }
export const EDEFS: Record<Exclude<EType, 'boss'>, EDef> = {
  grunt: { tex: 'grunt', hp: 14, speed: 125, r: 11, dmg: 9, xp: 1, armor: 0, sc: 2.6 },
  swarmer: { tex: 'swarmer', hp: 6, speed: 235, r: 8, dmg: 5, xp: 0.6, armor: 0, sc: 2.2 },
  archer: { tex: 'archer', hp: 16, speed: 105, r: 10, dmg: 10, xp: 2, armor: 0, sc: 2.6 },
  charger: { tex: 'charger', hp: 36, speed: 140, r: 13, dmg: 15, xp: 2.5, armor: 0, sc: 3 },
  armored: { tex: 'armored', hp: 110, speed: 85, r: 15, dmg: 14, armor: 5, xp: 4, sc: 3.2 },
  shaman: { tex: 'shaman', hp: 30, speed: 115, r: 10, dmg: 6, xp: 3, armor: 0, sc: 2.6 },
};

export const hpMul = (t: number) => 1 + (t / 60) * 0.45 + (t / 60) ** 2 * 0.06;
const dmgMulT = (t: number) => 1 + (t / 60) * 0.07;
let eid = 1;

function pickAff(run: Run, elite: boolean): Aff {
  const shares = run.plan.shares.filter((s) => !(elite && s.aff === 'neutral' && run.plan.shares.length > 1));
  let tot = 0; for (const x of shares) tot += x.pct;
  let r = Math.random() * tot;
  for (const x of shares) { r -= x.pct; if (r <= 0) return x.aff; }
  return 'neutral';
}

export function spawnEnemy(run: Run, type: Exclude<EType, 'boss'>, x: number, y: number, elite = false, forceAff?: Aff): Enemy {
  const d = EDEFS[type];
  const t = run.dtime;
  const hpm = hpMul(t) * (elite ? 6 : 1) * (run.quick ? 0.55 : 1);
  let sc = d.sc * (elite ? 1.4 : 1);
  let hp = d.hp * hpm;
  // speed variety: every enemy has its own pace, a few grunts are fast "sprinters", and later rounds run faster
  let speed = d.speed * (elite ? 1.1 : 1) * (0.85 + Math.random() * 0.3) * (1 + 0.018 * run.round);
  if (type === 'grunt' && !elite && Math.random() < 0.14) { speed *= 1.7; hp *= 0.65; sc *= 0.9; }
  const aff = forceAff ?? pickAff(run, elite);
  const e: Enemy = {
    id: eid++, type, x, y, vx: 0, vy: 0, hp, maxHp: hp, r: d.r * (elite ? 1.3 : 1), speed,
    dmg: d.dmg * dmgMulT(t) * (elite ? 1.3 : 1), armor: d.armor * (1 + t / 700), xp: d.xp * (elite ? 6 : 1), elite, sc,
    spr: run.img(d.tex, 5), shadow: run.img('shadow', 4).setScale(sc * 0.9).setAlpha(0.8),
    flash: 0, face: 1, wob: Math.random() * 6, wet: 0, burn: 0, burnDps: 0, burnSrc: null, chill: 0, chillT: 0,
    freeze: 0, freezeImm: 0, poison: 0, poisonT: 0, poisonDps: 0, poisonSrc: null, tickT: 0, burnT: 0, dotAcc: 0, dotShow: 0,
    slowT: 0, slowMul: 1, buff: 0, capT: 0, pulled: 0, tint: -1, conductCd: 0,
    atk: 1 + Math.random() * 2, st: 0, stT: 0, dx: 0, dy: 0, contact: 0, spawnT: 0.3, dashes: 0, dead: false, boss: null,
    aff, res: resFor(aff, run.plan), badge: null, resTxt: 0, hitOnce: false,
  };
  if (aff !== 'neutral') e.badge = run.img('dot', 6, true).setTint(ELEMENTS[aff].color).setScale(0.85).setAlpha(0.9);
  e.spr.setScale(sc);
  run.enemies.push(e);
  return e;
}

function spawnPoint(run: Run): [number, number] {
  const w = run.viewW, h = run.viewH;
  const R = Math.hypot(w, h) / 2 + 70;
  const p = run.player;
  let x = p.x, y = p.y;
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * 6.2832;
    x = p.x + Math.cos(a) * R; y = p.y + Math.sin(a) * R;
    x = Math.max(40, Math.min(ARENA - 40, x)); y = Math.max(40, Math.min(ARENA - 40, y));
    if ((x - p.x) ** 2 + (y - p.y) ** 2 > 330 * 330) break;
  }
  return [x, y];
}

type W = [Exclude<EType, 'boss'>, number][];
function weights(t: number): W {
  if (t < 60) return [['grunt', 8], ['swarmer', 2]];
  if (t < 150) return [['grunt', 6], ['swarmer', 3], ['archer', 2]];
  if (t < 300) return [['grunt', 5], ['swarmer', 3], ['archer', 2], ['charger', 2]];
  if (t < 480) return [['grunt', 4], ['swarmer', 3], ['archer', 2], ['charger', 2], ['armored', 2], ['shaman', 1]];
  return [['grunt', 3], ['swarmer', 3], ['archer', 2], ['charger', 2], ['armored', 3], ['shaman', 2]];
}
function pick(w: W): Exclude<EType, 'boss'> {
  let tot = 0; for (const x of w) tot += x[1];
  let r = Math.random() * tot;
  for (const x of w) { r -= x[1]; if (r <= 0) return x[0]; }
  return w[0][0];
}

function spawnWave(run: Run, t: number) {
  const type = pick(weights(t));
  const [x, y] = spawnPoint(run);
  if (type === 'swarmer') {
    const n = 3 + ((Math.random() * (3 + t / 200)) | 0);
    for (let i = 0; i < n; i++) spawnEnemy(run, 'swarmer', x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60);
  } else if (type === 'grunt' && t > 100 && Math.random() < 0.4) {
    for (let i = 0; i < 3; i++) spawnEnemy(run, 'grunt', x + (Math.random() - 0.5) * 50, y + (Math.random() - 0.5) * 50);
  } else spawnEnemy(run, type, x, y);
}

function spawnElite(run: Run) {
  const t = run.dtime;
  const pool: Exclude<EType, 'boss'>[] = t < 200 ? ['grunt', 'charger'] : t < 400 ? ['grunt', 'charger', 'armored', 'archer'] : ['charger', 'armored', 'archer', 'shaman', 'grunt'];
  const type = pool[(Math.random() * pool.length) | 0];
  const [x, y] = spawnPoint(run);
  const e = spawnEnemy(run, type, x, y, true);
  const tag = e.aff === 'neutral' ? 'Neutral' : `${ELEMENTS[e.aff].name}-attuned`;
  run.announce('ELITE APPROACHES', '#ffd25a', `${tag} ${type}. Slay it for a healing orb and rich experience.`);
  audio.play('warn');
}

/** Called when a fight round begins. */
export function openRound(run: Run) {
  const r = run.round;
  if (isBossRound(r)) {
    spawnBoss(run, bossKind(r));
    for (let i = 0; i < 6; i++) { const [x, y] = spawnPoint(run); spawnEnemy(run, 'grunt', x, y); }
    return;
  }
  const n = 3 + r;
  for (let i = 0; i < n; i++) { const [x, y] = spawnPoint(run); spawnEnemy(run, i % 4 === 3 ? 'swarmer' : 'grunt', x, y); }
}

export function updateDirector(run: Run, dt: number) {
  const t = run.dtime;
  const bossOn = !!run.boss;
  let rate = (0.95 + t * 0.0065) * (run.quick ? 2 : 1);
  let cap = Math.min(200, 16 + t * 0.11) * (run.quick ? 1.1 : 1);
  if (bossOn) { rate *= 0.15; cap = Math.min(cap * 0.5, 28); }
  run.spawnAcc += rate * dt;
  const alive = run.enemies.length;
  let guard = 0;
  while (run.spawnAcc >= 1 && alive + guard < cap && guard < 6) { run.spawnAcc--; spawnWave(run, t); guard++; }
  if (run.spawnAcc > 3) run.spawnAcc = 3;
  if (bossOn || isBossRound(run.round)) return;

  // one-off set pieces, placed at fixed fractions of each round
  const f = run.roundElapsed / roundLen(run.quick);
  const once = (id: string, at: number, fn: () => void) => { if (f >= at && !run.pieces.has(id)) { run.pieces.add(id); fn(); } };
  const r = run.round;
  if (r >= 2 && r % 2 === 0) once('swarm', 0.15, () => {
    const n = Math.min(36, 14 + r * 2);
    const p = run.player;
    const a0 = Math.random() * 6.28;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * 6.2832, R = 420;
      const x = Math.max(40, Math.min(ARENA - 40, p.x + Math.cos(a) * R)), y = Math.max(40, Math.min(ARENA - 40, p.y + Math.sin(a) * R));
      spawnEnemy(run, 'swarmer', x, y);
    }
    run.announce('SWARM', '#c26bff', 'A ring of fast enemies closes in!');
    audio.play('warn');
  });
  if (r % 3 === 0) once('stampede', 0.35, () => {
    const [x, y] = spawnPoint(run);
    const n = 3 + Math.floor(r / 3);
    for (let i = 0; i < n; i++) spawnEnemy(run, 'charger', x + (Math.random() - 0.5) * 120, y + (Math.random() - 0.5) * 120);
    run.announce('STAMPEDE', '#ff8a4a', 'Chargers incoming. Keep moving!');
    audio.play('warn');
  });
  if (r >= 3) once('elite', 0.55, () => { const n = 1 + Math.floor(r / 8); for (let i = 0; i < n; i++) spawnElite(run); });
}

/* ---------------------------------- AI ---------------------------------- */

export function updateEnemies(run: Run, dt: number) {
  const p = run.player;
  const enemies = run.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    updateStatus(run, e, dt);
    if (e.dead) continue;
    if (e.slowT <= 0) e.slowMul = 1;
    if (e.spawnT > 0) e.spawnT -= dt;
    if (e.flash > 0) e.flash -= dt;
    if (e.contact > 0) e.contact -= dt;
    if (e.capT > 0) e.capT -= dt;
    let mul = 1;
    if (e.freeze > 0) mul = 0;
    else {
      mul = 1 - 0.18 * e.chill;
      if (e.slowT > 0) mul *= e.slowMul;
      if (e.buff > 0) mul *= 1.3;
    }
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist, ny = dy / dist;
    if (run.dummy) { e.x += e.vx * dt; e.y += e.vy * dt; e.vx *= Math.pow(0.003, dt); e.vy *= Math.pow(0.003, dt); continue; }
    if (e.freeze <= 0) {
      if (e.type === 'boss') updateBoss(run, e, dt, mul, dist, nx, ny);
      else aiFor(run, e, dt, mul, dist, nx, ny);
    }
    // knockback & integration
    e.x += e.vx * dt; e.y += e.vy * dt;
    const decay = Math.pow(0.003, dt);
    e.vx *= decay; e.vy *= decay;
    // soft separation using the grid
    if (e.pulled <= 0 && e.type !== 'boss') separate(run, e, dt);
    e.x = Math.max(20, Math.min(ARENA - 20, e.x));
    e.y = Math.max(20, Math.min(ARENA - 20, e.y));
    // contact damage
    if (e.contact <= 0 && e.freeze <= 0 && e.spawnT <= 0) {
      const rr = e.r + p.r;
      if (dx * dx + dy * dy < rr * rr) {
        const dashing = e.type === 'charger' && e.st === 2 || e.type === 'boss' && !!e.boss && e.boss.dash > 0;
        run.hurtPlayer(e.dmg * (dashing ? 1.6 : 1), e.x, e.y, e.type);
        e.contact = 0.7;
      }
    }
  }
}

function separate(run: Run, e: Enemy, dt: number) {
  const g = run.grid;
  const cx = Math.floor(e.x / 64), cy = Math.floor(e.y / 64);
  let n = 0;
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= run.gridN) continue;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= run.gridN) continue;
      const cell = g[gy * run.gridN + gx];
      for (let k = 0; k < cell.length && n < 6; k++) {
        const o = cell[k];
        if (o === e || o.dead) continue;
        const dx = e.x - o.x, dy = e.y - o.y;
        const rr = (e.r + o.r) * 0.85;
        const d2 = dx * dx + dy * dy;
        if (d2 < rr * rr && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = ((rr - d) / rr) * 120 * dt * (o.type === 'boss' ? 2 : 1);
          e.x += (dx / d) * push; e.y += (dy / d) * push;
          n++;
        }
      }
    }
  }
}

function step(e: Enemy, tx: number, ty: number, speed: number, dt: number) {
  const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy) || 1;
  e.x += (dx / d) * speed * dt; e.y += (dy / d) * speed * dt;
  if (Math.abs(dx) > 2) e.face = dx > 0 ? 1 : -1;
}

function aiFor(run: Run, e: Enemy, dt: number, mul: number, dist: number, nx: number, ny: number) {
  const p = run.player;
  const sp = e.speed * mul;
  switch (e.type) {
    case 'grunt': {
      step(e, p.x, p.y, sp, dt);
      if (e.elite) {
        e.atk -= dt;
        if (e.atk <= 0 && dist < 260) {
          e.atk = 5.5;
          const R = 115;
          run.addTelegraph({ shape: 'circle', x: e.x, y: e.y, r: R, dur: 0.85, color: 0xff4a4a, follow: e, onDone: () => {
            run.fx.ring(e.x, e.y, 0xff6a4a, 10, R, 0.35);
            run.fx.burst(e.x, e.y, 0xff6a4a, 14, 200, 0.5, 1.2);
            run.fx.shake(5);
            audio.play('boom');
            if ((p.x - e.x) ** 2 + (p.y - e.y) ** 2 < (R + p.r) ** 2) run.hurtPlayer(e.dmg * 1.4, e.x, e.y, `${e.type} blast`);
          } });
        }
      }
      break;
    }
    case 'swarmer': {
      e.wob += dt * 7;
      const side = Math.sin(e.wob) * 0.7;
      const ax = nx - ny * side, ay = ny + nx * side;
      const l = Math.hypot(ax, ay) || 1;
      e.x += (ax / l) * sp * dt; e.y += (ay / l) * sp * dt;
      e.face = nx > 0 ? 1 : -1;
      break;
    }
    case 'archer': {
      e.atk -= dt;
      if (dist > 280) step(e, p.x, p.y, sp, dt);
      else if (dist < 200) step(e, e.x - nx * 100, e.y - ny * 100, sp, dt);
      else { e.x += -ny * sp * 0.5 * dt * (e.id % 2 ? 1 : -1); e.y += nx * sp * 0.5 * dt * (e.id % 2 ? 1 : -1); }
      e.face = nx > 0 ? 1 : -1;
      if (e.atk <= 0 && dist < 520 && e.st === 0) {
        e.st = 1;
        const ang = Math.atan2(ny, nx);
        run.addTelegraph({ shape: 'line', x: e.x, y: e.y, r: 0, ang, len: 520, w: 6, dur: 0.6, color: 0xff4a4a, follow: e, onDone: () => {
          e.st = 0; e.atk = 2.6 + Math.random();
          const shots = e.elite ? [-0.22, 0, 0.22] : [0];
          for (const o of shots) run.fireBullet(e.x, e.y, ang + o, 230, e.dmg);
        } });
      }
      break;
    }
    case 'charger': {
      e.atk -= dt;
      if (e.st === 0) {
        step(e, p.x, p.y, sp, dt);
        if (e.atk <= 0 && dist < 400) {
          e.st = 1;
          const ang = Math.atan2(ny, nx);
          run.addTelegraph({ shape: 'line', x: e.x, y: e.y, r: 0, ang, len: 380, w: 34, dur: 0.75, color: 0xff4a4a, follow: e, onDone: () => {
            e.st = 2; e.stT = 0.55; e.dx = Math.cos(ang); e.dy = Math.sin(ang);
            audio.play('warn');
          } });
        }
      } else if (e.st === 2) {
        e.x += e.dx * 820 * dt; e.y += e.dy * 820 * dt;
        e.stT -= dt;
        if (Math.random() < 0.6) run.fx.spark(e.x, e.y, 0, 0, 0xffb070, 0.3, 0.9);
        if (e.stT <= 0) {
          e.dashes++;
          if (e.elite && e.dashes < 2) e.st = 4; else { e.st = 3; e.stT = 0.9; e.dashes = 0; }
        }
      } else if (e.st === 4) {
        // elite chargers immediately line up a second dash
        e.st = 1;
        const ang = Math.atan2(p.y - e.y, p.x - e.x);
        run.addTelegraph({ shape: 'line', x: e.x, y: e.y, r: 0, ang, len: 380, w: 34, dur: 0.5, color: 0xff4a4a, follow: e, onDone: () => {
          e.st = 2; e.stT = 0.5; e.dx = Math.cos(ang); e.dy = Math.sin(ang);
        } });
      } else if (e.st === 3) {
        e.stT -= dt;
        if (e.stT <= 0) { e.st = 0; e.atk = 2.2 + Math.random() * 1.5; }
      }
      if (e.st !== 2) e.face = nx > 0 ? 1 : -1; else e.face = e.dx > 0 ? 1 : -1;
      break;
    }
    case 'armored': {
      step(e, p.x, p.y, sp, dt);
      break;
    }
    case 'shaman': {
      e.atk -= dt;
      if (dist < 240) step(e, e.x - nx * 100, e.y - ny * 100, sp, dt);
      else if (dist > 340) step(e, p.x, p.y, sp, dt);
      else { e.x += -ny * sp * 0.4 * dt; e.y += nx * sp * 0.4 * dt; }
      e.face = nx > 0 ? 1 : -1;
      if (e.atk <= 0 && e.st === 0) {
        e.st = 1;
        const R = 150;
        run.addTelegraph({ shape: 'ring', x: e.x, y: e.y, r: R, dur: 0.7, color: 0xffd25a, follow: e, onDone: () => {
          e.st = 0; e.atk = 4.5;
          run.fx.ring(e.x, e.y, 0xffd25a, 20, R, 0.4);
          for (const n of run.query(e.x, e.y, R)) if (n !== e) n.buff = 5;
          e.buff = 5;
          audio.play('pick');
        } });
      }
      break;
    }
  }
}
