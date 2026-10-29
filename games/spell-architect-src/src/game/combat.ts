// Damage pipeline, status effects, elemental reactions and kill handling.
import { ELEMENTS, type Element } from '../data/runes';
import { REACTION_BY_ID } from '../data/reactions';
import { store } from '../core/save';
import { audio } from '../core/audio';
import type { Enemy, Src, SEnt } from './types';
import type { Run } from './run';
import { spawnEnv } from './casting';
import { rollRelics } from './relics';
import { relicDamageMul, reactionMul, onReaction, onCrit, onKill, has } from './relics';

export interface DmgOpts {
  dot?: boolean; noCrit?: boolean; noTrig?: boolean; react?: boolean;
  kx?: number; ky?: number; kf?: number; ang?: number; lens?: boolean;
}

const colorCss = (c: number) => '#' + c.toString(16).padStart(6, '0');
void colorCss;

/** Damage multiplier an enemy applies to an element. Arcane is never resisted. */
export function resMul(e: Enemy, el: Element): number {
  if (el === 'arcane') return 1;
  const m = e.res[el];
  return m === undefined ? 1 : m;
}

/** Reaction damage is split between both element types, so a resisted type still leaves the other. */
export function reactDamage(run: Run, e: Enemy, amount: number, els: Element[], src: Src | null) {
  if (src) run = run.owner(src.sp); // the caster's stats, relics and rewards apply
  for (const el of els) {
    if (e.dead) return;
    dealDamage(run, e, (amount / els.length) * reactionMul(run), el, src, { react: true, noTrig: true });
  }
}

export function reaction(run: Run, id: string, x: number, y: number, src: Src | null) {
  if (src) run = run.owner(src.sp); // the caster's stats, relics and rewards apply
  const def = REACTION_BY_ID[id];
  if (!def) return;
  const passive = id === 'wildfire' || id === 'plague';
  if (src && (!passive || Math.random() < 0.2)) src.sp.st.reactions++;
  run.reactionCount++;
  const first = run.remote ? false : store.discoverReaction(id);
  onReaction(run, id);
  const last = run.reactTxt[id] ?? -9;
  if (first) {
    run.discoveries.push(`reaction:${id}`);
    run.announce(`NEW REACTION: ${def.name}`, def.color, def.desc);
    run.fx.ring(x, y, 0xffffff, 10, 90, 0.5);
    run.fx.shake(4);
  }
  if (run.time - last > 0.9) {
    run.reactTxt[id] = run.time;
    run.fx.text(x, y - 26, `${def.icon} ${def.name}`, def.color, 15, 0.9, -40);
    audio.play('reaction');
  }
}

/* ----------------------------- Statuses ----------------------------- */

export function applyBurn(run: Run, e: Enemy, dps: number, src: Src | null) {
  if (e.wet > 0 || resMul(e, 'fire') < 0.5) return;
  if (e.burn <= 0 && src) run.fx.burst(e.x, e.y, 0xff7a1a, 4, 90, 0.4, 0.6, -60);
  e.burn = 3.2;
  if (dps > e.burnDps || e.burn <= 0) e.burnDps = Math.max(e.burnDps, dps);
  e.burnSrc = src ?? e.burnSrc;
}

/** Poison stacks are capped lower and each extra stack adds less (see POISON_STACK_VALUE). */
export const POISON_BASE_STACKS = 4;
export const poisonStackValue = (stacks: number) => 1 + 0.55 * (stacks - 1);
export function applyPoison(run: Run, e: Enemy, dps: number, src: Src | null, maxStacks = POISON_BASE_STACKS) {
  if (resMul(e, 'poison') < 0.5) return;
  e.poison = Math.min(maxStacks, e.poison + 1);
  e.poisonT = 3.5;
  e.poisonDps = Math.max(e.poisonDps, dps);
  e.poisonSrc = src ?? e.poisonSrc;
}

export function applyWet(run: Run, e: Enemy, src: Src | null) {
  if (resMul(e, 'water') < 0.5) return;
  if (e.wet <= 0 && src) src.sp.st.wetHits++;
  else if (src && Math.random() < 0.35) src.sp.st.wetHits++;
  e.wet = 5.5;
  if (e.burn > 0) { e.burn = 0; run.fx.burst(e.x, e.y, 0xdde8ff, 4, 60, 0.5, 0.8, -40); }
}

export function killEnt(run: Run, en: SEnt) {
  if (en.dead) return;
  en.dead = true; en.silent = true;
  if (en.root) en.sp.live = Math.max(0, en.sp.live - 1);
}

export function freezeEnemy(run: Run, e: Enemy, src: Src | null, viaWet: boolean, dmg = 0) {
  const boss = e.type === 'boss';
  if (boss || e.freezeImm > 0) return;
  const mult = src ? src.sp.mut.freezeT : 1;
  e.freeze = (e.elite ? 1.0 : 1.7) * mult;
  e.freezeImm = e.freeze + 2.2;
  e.chill = 0;
  e.wet = 0;
  if (src) src.sp.st.freezes++;
  run.fx.burst(e.x, e.y, 0xaaf0ff, 9, 150, 0.5, 0.9);
  run.fx.ring(e.x, e.y, 0x66ddff, 8, 40, 0.3);
  audio.play('freeze');
  if (viaWet) reaction(run, 'flashfreeze', e.x, e.y, src);
  if (dmg > 0 && src) reactDamage(run, e, dmg * 1.3, viaWet ? ['ice', 'water'] : ['ice'], src);
}

export function applyChill(run: Run, e: Enemy, src: Src | null, dmg = 0) {
  if (resMul(e, 'ice') < 0.5) return;
  if (e.wet > 0 && e.type !== 'boss' && e.freezeImm <= 0) { freezeEnemy(run, e, src, true, dmg); return; }
  e.chill = Math.min(e.type === 'boss' ? 2 : 3, e.chill + 1);
  e.chillT = 3;
  if (e.chill >= 3) freezeEnemy(run, e, src, false, dmg);
}

export function updateStatus(run: Run, e: Enemy, dt: number) {
  if (e.wet > 0) e.wet -= dt;
  if (e.freeze > 0) e.freeze -= dt;
  else if (e.freezeImm > 0) e.freezeImm -= dt;
  if (e.chill > 0) { e.chillT -= dt; if (e.chillT <= 0) e.chill = 0; }
  if (e.buff > 0) e.buff -= dt;
  if (e.slowT > 0) e.slowT -= dt;
  if (e.pulled > 0) e.pulled -= dt;
  if (e.conductCd > 0) e.conductCd -= dt;
  if (e.burn <= 0 && e.poison <= 0) return;
  if (e.burn > 0) e.burn -= dt;
  if (e.poison > 0) { e.poisonT -= dt; if (e.poisonT <= 0) e.poison = 0; }
  e.tickT += dt;
  if (e.tickT < 0.25) return;
  e.tickT -= 0.25;
  let tot = 0;
  if (e.burn > 0) {
    const d = e.burnDps * 0.25;
    tot += d;
    dealDamage(run, e, d, 'fire', e.burnSrc, { dot: true, noTrig: true });
    if (e.dead) return;
    e.burnT += 0.25;
    if (e.burnT >= 0.5) {
      e.burnT = 0;
      run.fx.spark(e.x + (Math.random() - 0.5) * 12, e.y - 4, 0, -50, 0xff8a2a, 0.45, 0.7, -30);
      // wildfire: burning enemies ignite close neighbours
      if (Math.random() < 0.4) {
        const near = run.query(e.x, e.y, 40);
        for (const n of near) {
          if (n !== e && n.burn <= 0 && n.wet <= 0 && !n.dead) {
            applyBurn(run, n, e.burnDps * 0.7, e.burnSrc);
            reaction(run, 'wildfire', n.x, n.y, e.burnSrc);
            break;
          }
        }
      }
      // burning enemies ignite poison clouds they stand in
      for (const h of run.hazards) {
        if (h.env === 'cloud' && !h.dead && (h.x - e.x) ** 2 + (h.y - e.y) ** 2 < (h.r + e.r) ** 2) {
          igniteCloud(run, h, e.burnSrc, 0);
          break;
        }
      }
    }
  }
  if (e.poison > 0 && !e.dead) {
    const d = e.poisonDps * poisonStackValue(e.poison) * 0.25;
    tot += d;
    dealDamage(run, e, d, 'poison', e.poisonSrc, { dot: true, noTrig: true });
    if (!e.dead && Math.random() < 0.25) run.fx.spark(e.x, e.y, (Math.random() - 0.5) * 30, -30, 0x7dff4a, 0.5, 0.6, -10);
  }
  e.dotAcc += tot;
  e.dotShow += 0.25;
  if (e.dotShow >= 0.75 && !e.dead) {
    if (e.dotAcc >= 1) run.fx.text(e.x, e.y - 18, String(Math.round(e.dotAcc)), e.burn > 0 ? '#ff9a4a' : '#8dff6a', 12, 0.55, -35);
    e.dotAcc = 0; e.dotShow = 0;
  }
}

/* --------------------------- Damage pipeline --------------------------- */

export function dealDamage(run: Run, e: Enemy, amount: number, el: Element, src: Src | null, o: DmgOpts = {}): number {
  if (e.dead) return 0;
  if (src) run = run.owner(src.sp); // the caster's stats, relics and rewards apply
  let a = amount;
  let conduct = false;
  const rm = resMul(e, el);
  if (rm <= 0) {
    if (!o.dot && run.time >= e.resTxt) { e.resTxt = run.time + 0.7; run.fx.text(e.x, e.y - e.r - 10, 'IMMUNE', '#aab0d0', 12, 0.7); }
    if (!o.lens && !o.dot && src && has(run, 'nulllens')) return dealDamage(run, e, amount * 0.3, 'arcane', src, { ...o, lens: true, react: true });
    return 0;
  }
  a *= rm;
  a *= relicDamageMul(run, e, el, src, o);
  if (rm !== 1 && !o.dot && run.time >= e.resTxt) {
    e.resTxt = run.time + 0.9;
    run.fx.text(e.x, e.y - e.r - 10, rm < 1 ? 'RESIST' : 'WEAK!', rm < 1 ? '#8890b8' : '#ffb347', 11, 0.6);
  }
  if (!o.dot && !o.react) {
    if (el === 'lightning' && e.wet > 0) {
      a *= 1 + 0.5 * (src ? src.sp.mut.conduct : 1);
      conduct = true;
    }
    if (e.freeze > 0) a *= 1.25;
  }
  if (!o.dot && !o.react && e.armor > 0) a = Math.max(a * 0.25, a - e.armor);
  if (e.buff > 0) a *= 0.85;
  let crit = false;
  if (!o.noCrit && !o.dot && !o.react && src) {
    const chance = run.player.crit + (el === 'lightning' ? 0.12 : 0) + src.sp.mut.crit;
    if (Math.random() < chance) { crit = true; a *= run.player.critMul; }
  }
  run.critKill = crit;
  const dealt = Math.min(a, Math.max(0, e.hp));
  e.hp -= a;
  run.totalDamage += dealt;
  if (src) src.sp.damage += dealt;
  if (!o.dot) e.flash = 0.06;
  if (!o.dot) {
    run.fx.text(e.x + (Math.random() - 0.5) * 14, e.y - e.r - 6, String(Math.max(1, Math.round(a))), crit ? '#ffe14d' : o.react ? ELEMENTS[el].css : rm < 1 ? '#9aa0c0' : rm > 1 ? '#ffc070' : '#ffffff', crit ? 22 : 14, 0.6);
    run.fx.burst(e.x, e.y, ELEMENTS[el].color, crit ? 5 : 2, 110, 0.3, 0.55);
    audio.play(crit ? 'boom' : 'hit');
  }
  if (o.kf && o.kf > 0 && e.type !== 'boss') {
    const k = e.elite ? 0.5 : e.type === 'armored' ? 0.4 : 1;
    e.vx += (o.kx ?? 0) * o.kf * k; e.vy += (o.ky ?? 0) * o.kf * k;
  }
  if (src && !o.noTrig) {
    run.queueEvent('hit', src, e.x, e.y, o.ang ?? Math.random() * 6.28);
    if (crit) { src.sp.crits++; run.queueEvent('crit', src, e.x, e.y, o.ang ?? Math.random() * 6.28); }
  }
  if (crit && src) onCrit(run, e, src, a);
  if (conduct && e.conductCd <= 0) {
    e.conductCd = 0.3;
    reaction(run, 'conduct', e.x, e.y, src);
    conductArc(run, e, a * 0.5 * (src ? src.sp.mut.react : 1), src);
  }
  if (e.hp <= 0) killEnemy(run, e, src, el);
  return dealt;
}

function conductArc(run: Run, from: Enemy, dmg: number, src: Src | null) {
  const near = run.query(from.x, from.y, 120).filter((n) => n !== from && n.wet > 0 && !n.dead).slice(0, 2);
  for (const n of near) {
    run.fx.bolt(from.x, from.y, n.x, n.y, 0xfff35e, 6, 0.14);
    n.conductCd = 0.3;
    reactDamage(run, n, dmg, ['lightning', 'water'], src);
  }
}

/** Chain lightning style arcs between enemies. Returns jumps made. */
export function arc(run: Run, from: Enemy | { x: number; y: number }, dmg: number, el: Element, src: Src, jumps: number, range: number, skip: Enemy[]) {
  const visited = new Set<Enemy>(skip);
  let cx = from.x, cy = from.y;
  let poison = 0, poisonSrc: Src | null = null;
  const fe = from as Enemy;
  if (fe.poison !== undefined && fe.poison > 0) { poison = fe.poison; poisonSrc = fe.poisonSrc; }
  let made = 0;
  for (let j = 0; j < jumps; j++) {
    let best: Enemy | null = null, bd = range * range;
    for (const n of run.query(cx, cy, range)) {
      if (visited.has(n) || n.dead) continue;
      const d = (n.x - cx) ** 2 + (n.y - cy) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) break;
    visited.add(best);
    run.fx.bolt(cx, cy, best.x, best.y, ELEMENTS[el].color, 7, 0.16);
    audio.play('lightning');
    src.sp.st.chainJumps++;
    made++;
    cx = best.x; cy = best.y;
    dealDamage(run, best, dmg, el, src, { noTrig: true, noCrit: false });
    if (!best.dead) {
      applyElement(run, best, dmg, el, src, true);
      if (poison > 0) {
        applyPoison(run, best, Math.max(1.5, dmg * 0.2), poisonSrc ?? src);
        if (!best.dead) reactDamage(run, best, dmg * 0.5, ['poison'], src);
        reaction(run, 'toxicarc', best.x, best.y, src);
      }
    }
    dmg *= 0.92;
  }
  return made;
}

/** The per-element on-hit status effect. */
export function applyElement(run: Run, e: Enemy, dmg: number, el: Element, src: Src, noArc = false, ox?: number, oy?: number) {
  if (e.dead) return;
  switch (el) {
    case 'fire':
      if (e.wet > 0) {
        e.wet = 0;
        run.fx.burst(e.x, e.y, 0xdde8ff, 10, 120, 0.7, 1.2, -50);
        run.fx.ring(e.x, e.y, 0xdde8ff, 8, 56, 0.4, 0.7);
        reaction(run, 'steam', e.x, e.y, src);
        const r = 56;
        for (const n of run.query(e.x, e.y, r)) {
          if (n !== e) reactDamage(run, n, dmg * 0.4 * src.sp.mut.react, ['fire', 'water'], src);
        }
        reactDamage(run, e, dmg * 0.4 * src.sp.mut.react, ['fire', 'water'], src);
      } else applyBurn(run, e, Math.max(2, dmg * 0.4), src);
      break;
    case 'ice': applyChill(run, e, src, dmg); break;
    case 'lightning':
      if (!noArc && Math.random() < 0.28) arc(run, e, dmg * 0.5, 'lightning', src, 1, 140, [e]);
      break;
    case 'poison': applyPoison(run, e, Math.max(1.2, dmg * 0.27), src, POISON_BASE_STACKS + src.sp.mut.polStacks); break;
    case 'water': applyWet(run, e, src); break;
    case 'gravity': {
      const px = ox ?? e.x, py = oy ?? e.y;
      gravityImpulse(run, px, py, 100 * src.sp.mut.pullR, 240, src);
      break;
    }
  }
}

export function gravityImpulse(run: Run, x: number, y: number, r: number, force: number, src: Src | null) {
  for (const n of run.query(x, y, r)) {
    const dx = x - n.x, dy = y - n.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = pullResist(n) * (1 - d / (r + 20)) * force;
    n.vx += (dx / d) * k * 0.9; n.vy += (dy / d) * k * 0.9;
    n.pulled = 0.3;
    if (src && n.capT <= 0) { n.capT = 0.6; src.sp.st.captured++; }
  }
  run.fx.ring(x, y, 0xb36bff, r, 8, 0.3, 0.6);
}

export function pullResist(e: Enemy): number {
  return e.type === 'boss' ? 0.25 : e.elite ? 0.6 : e.type === 'armored' ? 0.6 : 1;
}

/* ------------------------- Area helpers & hazards ------------------------- */

export function explode(run: Run, x: number, y: number, r: number, dmg: number, el: Element, src: Src | null, o: { status?: boolean; noTrig?: boolean; react?: boolean; fx?: boolean; kb?: number } = {}) {
  if (o.fx !== false) {
    run.fx.ring(x, y, ELEMENTS[el].color, r * 0.3, r, 0.35);
    run.fx.burst(x, y, ELEMENTS[el].color, Math.min(14, 5 + r / 10), r * 3, 0.45, 1.2);
  }
  const list = run.query(x, y, r);
  for (const e of list) {
    if (e.dead) continue;
    const dx = e.x - x, dy = e.y - y, d = Math.hypot(dx, dy) || 1;
    dealDamage(run, e, dmg, el, src, { noTrig: o.noTrig ?? true, react: o.react, noCrit: true, kx: dx / d, ky: dy / d, kf: o.kb ?? 0 });
    if (o.status && src && !e.dead) applyElement(run, e, dmg, el, src, true, x, y);
  }
  return list.length;
}

export function envReact(run: Run, el: Element, x: number, y: number, r: number, src: Src) {
  if (el !== 'lightning' && el !== 'fire' && el !== 'ice') return;
  const hz = run.hazards;
  for (let i = 0; i < hz.length; i++) {
    const h = hz[i];
    if (h.dead) continue;
    const d2 = (h.x - x) ** 2 + (h.y - y) ** 2;
    if (d2 > (h.r + r) ** 2) continue;
    if (el === 'lightning' && h.env === 'puddle' && !h.ice) electrify(run, h, src);
    else if (el === 'fire' && h.env === 'cloud') igniteCloud(run, h, src, 0);
    else if (el === 'fire' && h.env === 'puddle' && !h.ice) evaporate(run, h, src);
    else if (el === 'ice' && h.env === 'puddle' && !h.ice) freezePuddle(run, h, src);
  }
}

function electrify(run: Run, p: SEnt, src: Src, depth = 0) {
  const fresh = p.electric <= 0;
  p.electric = 4 * src.sp.mut.conduct;
  p.eSrc = src;
  if (fresh) {
    reaction(run, 'electrify', p.x, p.y, src);
    run.fx.ring(p.x, p.y, 0xfff35e, p.r * 0.4, p.r, 0.4);
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * 6.28, d = Math.random() * p.r;
      run.fx.bolt(p.x, p.y, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 0xfff35e, 5, 0.2);
    }
  }
  if (depth > 3) return;
  for (const o of run.hazards) {
    if (o !== p && !o.dead && o.env === 'puddle' && !o.ice && o.electric <= 0 && (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < (o.r + p.r + 26) ** 2) electrify(run, o, src, depth + 1);
  }
}

function freezePuddle(run: Run, p: SEnt, src: Src) {
  p.ice = true; p.electric = 0;
  p.life = Math.max(p.life, 6);
  p.maxLife = Math.max(p.maxLife, p.life);
  p.spr.setTint(0xb8f0ff);
  reaction(run, 'icesheet', p.x, p.y, src);
  run.fx.burst(p.x, p.y, 0xaaf0ff, 8, 100, 0.5, 1);
}

function evaporate(run: Run, p: SEnt, src: Src) {
  if (src) run = run.owner(src.sp); // the caster's stats, relics and rewards apply
  if (p.life < 1.2) { killEnt(run, p); return; }
  p.life *= 0.5; p.maxLife = Math.max(p.maxLife, p.life);
  reaction(run, 'evaporate', p.x, p.y, src);
  run.fx.burst(p.x, p.y, 0xdde8ff, 14, 90, 0.8, 1.5, -50);
  for (const n of run.query(p.x, p.y, p.r)) reactDamage(run, n, 8 * src.sp.mut.react * run.player.dmgMul, ['fire', 'water'], src);
}

export function igniteCloud(run: Run, c: SEnt, src: Src | null, depth: number) {
  if (c.dead) return;
  if (src) run = run.owner(src.sp); // the caster's stats, relics and rewards apply
  killEnt(run, c);
  const sp = src?.sp;
  const rm = sp ? sp.mut.react : 1;
  const R = c.r * 1.4;
  const dmg = (26 + c.dmg * 5) * rm * run.player.dmgMul;
  reaction(run, 'gasblast', c.x, c.y, src);
  run.fx.ring(c.x, c.y, 0xff7a1a, R * 0.3, R, 0.4);
  run.fx.ring(c.x, c.y, 0xffe08a, R * 0.1, R * 0.7, 0.3);
  run.fx.burst(c.x, c.y, 0xff9a2a, 14, R * 3, 0.55, 1.6);
  run.fx.shake(6);
  audio.play('boom');
  for (const n of run.query(c.x, c.y, R)) {
    reactDamage(run, n, dmg, ['fire', 'poison'], src);
    if (!n.dead) applyBurn(run, n, dmg * 0.25, src);
  }
  if (depth < 5) {
    for (const o of run.hazards) {
      if (!o.dead && o.env === 'cloud' && (o.x - c.x) ** 2 + (o.y - c.y) ** 2 < (o.r + R) ** 2) igniteCloud(run, o, src, depth + 1);
    }
  }
}

/* ------------------------------ Kill handling ------------------------------ */

export function killEnemy(run: Run, e: Enemy, src: Src | null, el: Element) {
  if (e.dead) return;
  e.dead = true;
  if (src) run = run.owner(src.sp); // the caster's stats, relics and rewards apply
  run.kills++;
  for (const sp of run.spells) if (sp.ultCd > 0) sp.ultCd = Math.max(0, sp.ultCd - 0.2);
  const wasBurn = e.burn > 0, wasPoison = e.poison > 0, wasFrozen = e.freeze > 0;
  const psrc = e.poisonSrc;
  if (src) {
    src.sp.st.kills++;
    if (wasBurn || el === 'fire') src.sp.st.burnKills += wasBurn ? 1 : 0;
    run.queueEvent('kill', src, e.x, e.y, Math.random() * 6.28);
  }
  run.fx.burst(e.x, e.y, e.elite || e.type === 'boss' ? 0xffd25a : ELEMENTS[el].color, e.type === 'boss' ? 40 : e.elite ? 18 : 6, e.type === 'boss' ? 300 : 150, 0.5, e.type === 'boss' ? 2 : 1);
  audio.play('kill');
  if (e.elite && e.type !== 'boss') { run.fx.shake(4); run.fx.ring(e.x, e.y, 0xffd25a, 10, 80, 0.4); }

  run.addXp(e.xp);
  if (e.type !== 'boss') {
    // coins drop as pickups (new scale: roughly 1 coin per ten kills); elites always pay
    const chance: Record<string, number> = { grunt: 0.1, swarmer: 0.05, archer: 0.16, charger: 0.16, shaman: 0.2, armored: 0.3 };
    if (e.elite) run.dropCoin(e.x, e.y, 3);
    else if (Math.random() < (chance[e.type] ?? 0.1)) run.dropCoin(e.x, e.y, 1);
    if (e.elite) { if (Math.random() < 0.2) run.dropPickup('heal', e.x + 10, e.y); if (run.round >= 4 && Math.random() < 0.12) { const rl = rollRelics(run, 1, 'shop')[0]; if (rl) { if (run.remote) run.pushPending({ type: 'relic', options: [rl.id] }); else run.addRelic(rl.id); } } }
    else if (Math.random() < 0.0005) run.dropPickup('heal', e.x, e.y);
    if (Math.random() < 0.012) run.dropPickup('magnet', e.x, e.y);
  }
  onKill(run, e, run.critKill);

  // Wildfire: burning enemies burst into flame
  if (wasBurn) {
    reaction(run, 'wildfire', e.x, e.y, e.burnSrc);
    const bs = e.burnSrc;
    const mutPyre = bs?.sp.mut.pyre;
    const r = mutPyre ? 95 : 52;
    const d = (mutPyre ? 1.5 : 0.35) * e.burnDps * (mutPyre ? 3 : 1);
    run.fx.burst(e.x, e.y, 0xff8a2a, 8, 130, 0.5, 1.1);
    if (mutPyre) { run.fx.ring(e.x, e.y, 0xff7a1a, 20, r, 0.4); run.fx.shake(3); }
    for (const n of run.query(e.x, e.y, r)) {
      if (n === e || n.dead) continue;
      if (mutPyre) dealDamage(run, n, d + 10 * run.player.dmgMul, 'fire', bs, { react: true, noTrig: true });
      if (!n.dead) applyBurn(run, n, e.burnDps * 0.7, bs);
    }
  }
  // Plague: poison spreads when infected enemies die
  if (wasPoison && psrc) {
    const sp = psrc.sp;
    const r = 85 * sp.mut.spread;
    let spread = 0;
    for (const n of run.query(e.x, e.y, r)) {
      if (n === e || n.dead) continue;
      applyPoison(run, n, e.poisonDps * 0.7, psrc, POISON_BASE_STACKS + sp.mut.polStacks);
      spread++;
      if (spread >= 3) break;
    }
    if (spread > 0) {
      sp.st.spreads += spread;
      run.fx.ring(e.x, e.y, 0x7dff4a, 10, r, 0.4, 0.8);
      reaction(run, 'plague', e.x, e.y, psrc);
    }
    if (sp.mut.bloom) spawnEnv(run, psrc, 'poison', e.x, e.y, 70, 4, 4);
  }
  // Shatterglass
  if (wasFrozen && src?.sp.mut.shatter) {
    reaction(run, 'shatter', e.x, e.y, src);
    run.fx.burst(e.x, e.y, 0xaaf0ff, 14, 220, 0.5, 1.1);
    explode(run, e.x, e.y, 80, 12 * run.player.dmgMul + e.maxHp * 0.06, 'ice', src, { react: true, fx: false });
  }
  if (e.type === 'boss') run.onBossDeath(e);
  run.freeImg(e.spr); run.freeImg(e.shadow); run.freeImg(e.badge);
}
