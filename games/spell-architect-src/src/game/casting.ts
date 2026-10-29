// Spell execution: casting, entity simulation per form, and the event (trigger) processor.
import Phaser from 'phaser';
import { ELEMENTS, FORMS, type Element } from '../data/runes';
import { copiesOf, baseDamage, lifeOf, spellCooldown, type CForm } from '../core/spell';
import { audio } from '../core/audio';
import type { ActiveSpell, Enemy, GameEvent, SEnt, Src } from './types';
import type { Run } from './run';
import { ARENA } from './run';
import { onCast, cooldownMul } from './relics';
import {
  dealDamage, applyElement, applyWet, applyPoison, POISON_BASE_STACKS, arc, explode, envReact, gravityImpulse, pullResist, reaction, reactDamage,
} from './combat';

export const MAX_DEPTH = 4;
export const MAX_ENTS = 480;
export const SPAWN_BUDGET = 36;

let entSeq = 1;
const noSplitCache = new WeakMap<CForm, CForm>();
const splitChild = (f: CForm): CForm => {
  let c = noSplitCache.get(f);
  if (!c) { c = { ...f, b: { ...f.b, split: false } }; noSplitCache.set(f, c); }
  return c;
};

export function makeSrc(sp: ActiveSpell, f: CForm, depth: number): Src {
  return { sp, f, depth, el: f.element, icd: { hit: 0, crit: 0 } };
}

interface Style { tint: number; add: boolean; alpha: number }
function zoneStyle(el: Element): Style {
  switch (el) {
    case 'fire': return { tint: 0xff6a1a, add: true, alpha: 0.5 };
    case 'ice': return { tint: 0x8fe8ff, add: false, alpha: 0.55 };
    case 'lightning': return { tint: 0xfff35e, add: true, alpha: 0.4 };
    case 'poison': return { tint: 0x6fe03a, add: false, alpha: 0.55 };
    case 'water': return { tint: 0x3d8bff, add: false, alpha: 0.75 };
    case 'gravity': return { tint: 0x8a3bf0, add: false, alpha: 0.7 };
    default: return { tint: 0xc9a6ff, add: true, alpha: 0.3 };
  }
}

interface SpawnOpts {
  root?: boolean; anchor?: boolean; idx?: number; n?: number; dmgMul?: number; sizeMul?: number; life?: number;
  f?: CForm; src?: Src; radius?: number;
}

function blank(run: Run, sp: ActiveSpell, f: CForm, src: Src, kind: SEnt['kind'], x: number, y: number, ang: number): SEnt {
  return {
    id: entSeq++, sp, f, src, kind, el: f.element, depth: src.depth,
    x, y, vx: 0, vy: 0, ang, life: 1, maxLife: 1, r: 8, baseR: 8, dmg: 0, speed: 0,
    tick: 0.5, tickT: 0.1, pierce: 0, bounce: 0, chain: 0, splitDone: false, hit: new Map(),
    anchor: false, ax: x, ay: y, idx: 0, n: 1, orbAng: 0, orbR: 0, orbSpd: 0, armT: 0, blast: 0,
    len: 0, width: 0, env: '', electric: 0, ice: false, eSrc: null, root: false, dead: false, silent: false,
    fireChk: 0, target: 0, strikeT: 0, expand: false, pull: false, pullR: 0, pullF: 0, fxT: 0, deco: [],
    spr: null as never, spr2: null,
  };
}

export function spawnEnt(run: Run, sp: ActiveSpell, f: CForm, x: number, y: number, ang: number, o: SpawnOpts = {}): SEnt | null {
  if (run.ents.length >= MAX_ENTS) return null;
  const mut = sp.mut;
  const src = o.src ?? makeSrc(sp, f, f.depth);
  const en = blank(run, sp, f, src, f.form, x, y, ang);
  const pm = run.player;
  const size = (1 + 0.3 * f.m.grow) * mut.size * (o.sizeMul ?? 1);
  const rad = (1 + 0.35 * f.m.area) * (1 + 0.15 * f.m.grow) * mut.area * (o.sizeMul ?? 1);
  const spd = 1 + 0.4 * f.m.acc;
  en.dmg = baseDamage(f, mut) * pm.dmgMul * (o.dmgMul ?? 1);
  en.life = en.maxLife = o.life ?? lifeOf(f);
  en.root = !!o.root;
  en.anchor = o.anchor ?? false;
  en.idx = o.idx ?? 0; en.n = o.n ?? 1;
  en.expand = !!f.b.expand;
  en.chain = f.b.chain ? 3 + (f.element === 'lightning' ? 1 : 0) + mut.chain : 0;
  const el = ELEMENTS[f.element];
  const zs = zoneStyle(f.element);
  const gravity = f.element === 'gravity';
  const pullOn = gravity || !!f.b.pull;
  en.pull = pullOn;
  en.pullF = (gravity && f.b.pull ? 230 : gravity ? 140 : 120) * mut.pullR;

  switch (f.form) {
    case 'projectile': {
      en.r = en.baseR = 9 * size;
      en.speed = 400 * spd;
      en.vx = Math.cos(ang) * en.speed; en.vy = Math.sin(ang) * en.speed;
      en.pierce = f.b.pierce ? 3 : 0;
      en.bounce = f.b.bounce ? 3 : 0;
      en.blast = f.element === 'fire' ? 48 * rad * mut.splash : f.element === 'gravity' ? 56 * rad : 0;
      en.pullR = 95 * mut.pullR;
      if (f.b.orbit) {
        en.orbR = 85 * rad; en.orbSpd = 3.2 * spd; en.orbAng = ang + ((o.idx ?? 0) / (o.n ?? 1)) * Math.PI * 2;
        en.life = en.maxLife = o.life ?? lifeOf(f);
      }
      en.spr = run.img(`proj_${f.element}`, 10).setScale(en.r / 6.5);
      en.spr2 = run.img('dot', 9, true).setTint(el.color).setAlpha(0.8).setScale(en.r / 4.5);
      en.deco.push(run.img('tail', 9, true).setTint(el.color).setOrigin(1, 0.5).setAlpha(0.7));
      break;
    }
    case 'beam': {
      en.width = 26 * size;
      en.len = Math.max(260, 380 * rad);
      en.tick = 0.1 / spd; en.tickT = 0;
      en.spr = run.img('beam', 10, true).setTint(el.color).setOrigin(0, 0.5);
      en.spr2 = run.img('dot', 10, true).setTint(el.color).setScale(1.8);
      en.deco.push(run.img('beam', 10, true).setTint(0xffffff).setOrigin(0, 0.5));
      en.deco.push(run.img('dot', 10, true).setTint(0xffffff).setScale(0.9));
      break;
    }
    case 'orb': {
      en.r = en.baseR = 13 * size;
      en.orbR = 95 * rad; en.orbSpd = 2.6 * spd;
      en.orbAng = ang + ((o.idx ?? 0) / (o.n ?? 1)) * Math.PI * 2;
      en.pullR = 120 * mut.pullR;
      en.spr = run.img('orb_core', 10).setTint(el.color).setScale(en.r / 8);
      en.spr2 = run.img('dot', 9, true).setTint(el.color).setScale(en.r / 5).setAlpha(0.8);
      en.deco.push(run.img('tail', 9, true).setTint(el.color).setOrigin(1, 0.5).setAlpha(0.6));
      if ((o.idx ?? 0) === 0) en.deco.push(run.img('ring', 1, true).setTint(el.color).setAlpha(0.1));
      break;
    }
    case 'aura': {
      en.r = en.baseR = 100 * rad;
      en.tick = 0.5 / spd; en.tickT = 0.2;
      en.pullR = en.r * 1.3;
      en.spr = run.img('zone', 2, zs.add).setTint(zs.tint).setAlpha(zs.alpha);
      en.spr2 = run.img('runering', 3, true).setTint(el.color).setAlpha(0.85);
      en.deco.push(run.img('runering', 3, true).setTint(el.color).setAlpha(0.45));
      if (gravity) en.deco.push(run.img('swirl', 3, true).setTint(0xb36bff).setAlpha(0.7));
      if (f.element === 'poison') en.env = 'cloud';
      else if (f.element === 'water') en.env = 'puddle';
      break;
    }
    case 'mine': {
      en.r = en.baseR = 9 * size;
      en.armT = 0.5;
      en.blast = 85 * rad * (f.element === 'fire' ? mut.splash : 1);
      en.pullR = en.blast;
      en.speed = 70;
      en.spr = run.img('orb_core', 4).setTint(el.color).setScale(0.8);
      en.spr2 = run.img('ring', 3, true).setTint(el.color).setAlpha(0.35).setScale(en.blast / 160);
      break;
    }
    case 'nova': {
      en.r = en.baseR = 175 * rad * (f.b.expand ? 1.35 : 1);
      en.life = en.maxLife = 0.6 / spd;
      en.pullR = en.r;
      en.spr = run.img('ring', 10, true).setTint(el.color).setScale(0.1);
      en.spr2 = run.img('zone', 2, true).setTint(el.color).setAlpha(0.4).setScale(0.1);
      en.deco.push(run.img('ring', 10, true).setTint(0xffffff).setScale(0.1).setAlpha(0.7));
      if (f.element === 'water') spawnEnv(run, src, 'water', x, y, en.r * 0.55, 5, 0);
      else if (f.element === 'poison') spawnEnv(run, src, 'poison', x, y, en.r * 0.55, 4, 3);
      break;
    }
    case 'meteor': {
      en.r = en.baseR = 12 * size;
      en.armT = 0.8 / spd;
      en.life = en.maxLife = en.armT + 0.5;
      en.blast = 100 * rad * (f.element === 'fire' ? mut.splash : 1) * (f.b.expand ? 1.35 : 1);
      en.pullR = en.blast;
      en.speed = 220;
      en.spr = run.img(`proj_${f.element}`, 12).setScale(3);
      en.spr2 = run.img('runering', 3, true).setTint(el.color).setAlpha(0.8);
      en.deco.push(run.img('zone', 2, true).setTint(el.color).setAlpha(0.18));
      en.deco.push(run.img('tail', 11, true).setTint(el.color).setOrigin(1, 0.5).setRotation(Math.PI / 2 + 0.3));
      en.deco.push(run.img('dot', 11, true).setTint(el.color).setScale(2.4).setAlpha(0.9));
      break;
    }
  }
  run.ents.push(en);
  if (en.env) run.hazards.push(en);
  if (en.root) sp.live++;
  syncEnt(run, en);
  return en;
}

/** Non-triggering environment decals: puddles/clouds left behind by water and poison impacts. */
export function spawnEnv(run: Run, src: Src, el: Element, x: number, y: number, r: number, life: number, dmg: number) {
  if (el !== 'water' && el !== 'poison') return;
  if (run.ents.length >= MAX_ENTS) return;
  let n = 0;
  for (const h of run.hazards) if (h.silent && !h.dead) n++;
  if (n > 40) { for (const h of run.hazards) if (h.silent && !h.dead) { h.life = Math.min(h.life, 0.2); break; } return; }
  const tide = el === 'water' ? src.sp.mut.tide : 1;
  const en = blank(run, src.sp, src.f, src, 'decal', x, y, 0);
  en.el = el; en.silent = true; en.r = en.baseR = r * tide; en.life = en.maxLife = life * (tide > 1 ? 2 : 1);
  en.dmg = dmg * run.player.dmgMul; en.tick = 0.5; en.tickT = 0.2; en.depth = src.depth;
  en.env = el === 'water' ? 'puddle' : 'cloud';
  en.spr = el === 'water' ? run.img('puddle', 1, false).setTint(0x3d8bff).setAlpha(0.75) : run.img('zone', 2, false).setTint(0x6fe03a).setAlpha(0.5);
  en.spr2 = null;
  run.ents.push(en); run.hazards.push(en);
  syncEnt(run, en);
}

function center(run: Run, en: SEnt): [number, number] {
  return en.anchor ? [run.player.x, run.player.y] : [en.ax, en.ay];
}

function syncEnt(run: Run, en: SEnt) {
  const fadeIn = Math.min(1, (en.maxLife - en.life) / 0.15 + 0.2);
  const fadeOut = Math.min(1, en.life / 0.35);
  const a = Math.min(fadeIn, fadeOut);
  const T = run.time;
  const col = ELEMENTS[en.el].color;
  const d = en.deco;
  switch (en.kind) {
    case 'projectile': {
      const fl = en.el === 'fire' ? 1 + 0.18 * Math.sin(T * 40 + en.id) : en.el === 'lightning' ? 0.9 + Math.random() * 0.3 : 1;
      en.spr.setPosition(en.x, en.y).setScale((en.r / 6.5) * fl);
      if (en.el === 'ice' || en.el === 'lightning' || en.el === 'arcane') en.spr.setRotation(en.ang + (en.el === 'lightning' ? (Math.random() - 0.5) * 0.6 : 0));
      else if (en.el === 'water') en.spr.setRotation(en.ang + Math.PI / 2);
      else if (en.el === 'gravity' || en.el === 'poison') en.spr.setRotation(T * 6);
      en.spr2?.setPosition(en.x, en.y).setScale((en.r / 4.5) * (1 + 0.15 * Math.sin(T * 25 + en.id)));
      if (d[0]) {
        const sp = en.f.b.orbit ? en.orbSpd * en.orbR : en.speed;
        d[0].setPosition(en.x, en.y).setRotation(en.f.b.orbit ? en.ang - Math.PI : Math.atan2(en.vy, en.vx)).setScale(Math.min(3, sp / 190) * (en.r / 9), en.r / 7).setAlpha(0.75 * a);
      }
      break;
    }
    case 'orb': {
      en.spr.setPosition(en.x, en.y).setScale((en.r / 8) * (1 + 0.1 * Math.sin(T * 12 + en.idx)));
      en.spr2?.setPosition(en.x, en.y);
      if (d[0]) d[0].setPosition(en.x, en.y).setRotation(en.orbAng + Math.PI / 2 + Math.PI).setScale(en.orbR / 90, en.r / 8).setAlpha(0.6 * a);
      if (d[1]) d[1].setPosition(...center(run, en)).setScale(en.orbR / 60).setAlpha(0.1 * a);
      break;
    }
    case 'aura': case 'decal': {
      const R = currentR(en);
      const water = en.el === 'water' && en.kind === 'decal';
      const base = water ? 30 : 61;
      const pulse = 1 + 0.025 * Math.sin(T * 6 + en.id);
      en.spr.setPosition(en.x, en.y).setScale((R / base) * pulse);
      const zs = zoneStyle(en.el);
      const baseA = en.env === 'puddle' && en.ice ? 0.7 : zs.alpha;
      en.spr.setAlpha(baseA * a * (en.electric > 0 ? 0.7 + 0.3 * Math.sin(T * 40) : 1));
      if (en.electric > 0) en.spr.setTint(0xfff35e);
      else if (en.ice) en.spr.setTint(0xb8f0ff);
      if (en.kind === 'aura') {
        const rs = R / 64;
        en.spr2?.setPosition(en.x, en.y).setScale(rs).setRotation(T * (en.el === 'gravity' ? 1.6 : 0.5)).setAlpha(0.8 * a);
        if (d[0]) d[0].setPosition(en.x, en.y).setScale(rs * 0.78).setRotation(-T * 0.9).setAlpha(0.4 * a);
        if (d[1]) d[1].setPosition(en.x, en.y).setScale(rs * 1.05).setRotation(-T * 3).setAlpha(0.7 * a);
        auraFx(run, en, R);
      }
      break;
    }
    case 'mine': {
      const armed = en.armT <= 0;
      en.spr.setPosition(en.x, en.y).setScale(0.7 + (armed ? 0.15 * Math.sin(T * 10) : 0)).setRotation(T * 2);
      en.spr2?.setPosition(en.x, en.y).setAlpha(armed ? 0.3 : 0.12);
      break;
    }
    case 'beam': {
      const [ox, oy] = center(run, en);
      const f = Math.min(1, en.life / 0.12) * Math.min(1, (en.maxLife - en.life) / 0.05 + 0.3);
      const w = (en.width / 16) * (0.85 + 0.15 * Math.sin(T * 50));
      en.spr.setPosition(ox, oy).setRotation(en.ang).setScale(en.len / 64, w).setAlpha(f);
      en.spr2?.setPosition(ox, oy).setAlpha(f);
      d[0]?.setPosition(ox, oy).setRotation(en.ang).setScale(en.len / 64, w * 0.3).setAlpha(f * 0.9);
      d[1]?.setPosition(ox + Math.cos(en.ang) * en.len, oy + Math.sin(en.ang) * en.len).setAlpha(f * 0.6);
      break;
    }
    case 'nova': {
      const t = 1 - en.life / en.maxLife;
      const e = 1 - (1 - t) * (1 - t);
      const R = en.r * e;
      en.spr.setPosition(en.x, en.y).setScale(Math.max(0.05, R / 60)).setAlpha(1 - t * t);
      en.spr2?.setPosition(en.x, en.y).setScale(Math.max(0.05, R / 61)).setAlpha(0.45 * (1 - t));
      d[0]?.setPosition(en.x, en.y).setScale(Math.max(0.05, R / 64 * 0.92)).setAlpha(0.8 * (1 - t));
      break;
    }
    case 'meteor': {
      const k = Math.max(0, en.armT) / (en.maxLife - 0.5);
      const R = en.blast;
      en.spr2?.setPosition(en.x, en.y).setScale((R / 64) * (1 + k * 0.8)).setRotation(T * 2).setAlpha(0.35 + 0.5 * (1 - k));
      d[0]?.setPosition(en.x, en.y).setScale(R / 61).setAlpha(0.1 + 0.18 * (1 - k));
      const fy = en.y - 520 * k * k - 6;
      const fx = en.x - 120 * k;
      en.spr.setPosition(fx, fy).setScale(2 + 1.4 * (1 - k)).setAlpha(Math.min(1, a * 1.5));
      d[1]?.setPosition(fx, fy).setAlpha(0.8 * Math.min(1, k * 3));
      d[2]?.setPosition(fx, fy).setScale(3.4 - 1 * k);
      break;
    }
  }
}

/** Element-flavoured ambient particles around an aura. */
function auraFx(run: Run, en: SEnt, R: number) {
  if (run.time < en.fxT) return;
  en.fxT = run.time + 0.07;
  const a = Math.random() * 6.283;
  const rr = R * (0.55 + Math.random() * 0.45);
  const px = en.x + Math.cos(a) * rr, py = en.y + Math.sin(a) * rr;
  switch (en.el) {
    case 'fire':
      run.fx.spark(px, py, (Math.random() - 0.5) * 30, -60 - Math.random() * 50, Math.random() < 0.5 ? 0xffd25a : 0xff6a1a, 0.7, 1.3, -30);
      if (Math.random() < 0.6) run.fx.spark(en.x + Math.cos(a) * R, en.y + Math.sin(a) * R, 0, -40, 0xff4a0a, 0.5, 1.8, -20);
      break;
    case 'ice':
      run.fx.spark(px, py, (Math.random() - 0.5) * 16, 10 + Math.random() * 14, 0xe8fbff, 1.0, 0.9, 6, 'spark');
      break;
    case 'lightning':
      if (Math.random() < 0.7) {
        const b = a + 0.5 + Math.random() * 1.5;
        run.fx.bolt(en.x + Math.cos(a) * R * 0.97, en.y + Math.sin(a) * R * 0.97, en.x + Math.cos(b) * R * 0.97, en.y + Math.sin(b) * R * 0.97, 0xfff35e, 4, 0.09);
      }
      break;
    case 'poison':
      run.fx.spark(px, py, (Math.random() - 0.5) * 14, -22 - Math.random() * 20, 0x9dff6a, 1.0, 1.6, -4);
      break;
    case 'water':
      if (Math.random() < 0.18) run.fx.ring(en.x, en.y, 0x7fb8ff, R * 0.25, R * 0.98, 0.9, 0.55);
      run.fx.spark(px, py, 0, -26, 0xbfe0ff, 0.6, 0.9, 10);
      break;
    case 'gravity':
      run.fx.spark(en.x + Math.cos(a) * R, en.y + Math.sin(a) * R, -Math.cos(a) * R * 1.3 - Math.sin(a) * 40, -Math.sin(a) * R * 1.3 + Math.cos(a) * 40, 0xd9a8ff, 0.7, 1.2);
      break;
    default:
      run.fx.spark(px, py, -Math.sin(a) * 30, Math.cos(a) * 30, 0xe8d8ff, 0.8, 1, 0, 'spark');
  }
}

function currentR(en: SEnt): number {
  return en.expand ? en.r * (1 + 0.8 * (1 - en.life / en.maxLife)) : en.r;
}

/* --------------------------------- Casting --------------------------------- */

function isPersistent(f: CForm) { return f.form === 'orb' || f.form === 'aura' || (f.form === 'projectile' && f.b.orbit); }

export function updateCasting(run: Run, dt: number) {
  for (const sp of run.spells) {
    const f = sp.c.root;
    if (!sp.c.valid || !f) continue;
    if (!(isPersistent(f) && sp.live > 0)) sp.cd -= dt;
    if (sp.cd <= 0) {
      if (castRoot(run, sp, f)) {
        sp.cd = spellCooldown(f, sp.mut) * run.player.cdMul * cooldownMul(run, sp);
        sp.casts++;
        audio.play(f.element);
        onCast(run, sp);
      } else sp.cd = 0.05;
    }
  }
}

function castRoot(run: Run, sp: ActiveSpell, f: CForm): boolean {
  const p = run.player;
  if (f.form === 'mine' && sp.live >= 10) return false;
  if (f.form === 'projectile' && !f.b.orbit) {
    if (!run.nearest(p.x, p.y, 700)) return false;
  } else if (f.form === 'beam') {
    if (!run.nearest(p.x, p.y, 420)) return false;
  } else if (f.form === 'mine') {
    if (!run.nearest(p.x, p.y, 420)) return false;
  } else if (f.form === 'nova') {
    if (!run.nearest(p.x, p.y, 300)) return false;
  } else if (f.form === 'meteor') {
    if (!run.nearest(p.x, p.y, 480)) return false;
  }
  run.fx.ring(p.x, p.y, ELEMENTS[f.element].color, 8, 38, 0.25, 0.7);
  castForm(run, sp, f, p.x, p.y, Math.random() * 6.28, true);
  return true;
}

export function castForm(run: Run, sp: ActiveSpell, f: CForm, x: number, y: number, hint: number, root: boolean, dmgMul = 1) {
  const n = f.form === 'aura' ? 1 : copiesOf(f, sp.mut);
  const src = makeSrc(sp, f, f.depth);
  const o = (extra: SpawnOpts): SpawnOpts => ({ root, dmgMul, src: { ...src, icd: { hit: 0, crit: 0 } }, ...extra });
  const nearTo = run.nearest(x, y, 700);
  const aim = nearTo ? Math.atan2(nearTo.y - y, nearTo.x - x) : hint;
  switch (f.form) {
    case 'projectile':
      if (f.b.orbit) {
        for (let i = 0; i < n; i++) spawnEnt(run, sp, f, x, y, hint, o({ anchor: root, idx: i, n }));
      } else {
        for (let i = 0; i < n; i++) spawnEnt(run, sp, f, x, y, aim + (i - (n - 1) / 2) * 0.17, o({}));
      }
      break;
    case 'beam':
      for (let i = 0; i < n; i++) {
        const b = spawnEnt(run, sp, f, x, y, aim + (i - (n - 1) / 2) * 0.5, o({ anchor: root, idx: i, n }));
        if (b) { b.ax = x; b.ay = y; }
      }
      break;
    case 'orb': {
      const count = 2 + (n - 1);
      for (let i = 0; i < count; i++) {
        const e = spawnEnt(run, sp, f, x, y, hint, o({ anchor: root, idx: i, n: count }));
        if (e) { e.ax = x; e.ay = y; }
      }
      break;
    }
    case 'aura': {
      const e = spawnEnt(run, sp, f, x, y, 0, o({ anchor: root }));
      if (e) { e.ax = x; e.ay = y; }
      break;
    }
    case 'mine':
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, d = i === 0 && n === 1 ? 0 : 20 + Math.random() * 30;
        spawnEnt(run, sp, f, x + Math.cos(a) * d, y + Math.sin(a) * d, 0, o({ root }));
      }
      break;
    case 'nova':
      for (let i = 0; i < n; i++) {
        run.later(i * 0.3, () => {
          if (run.over) return;
          const cx = root ? run.player.x : x, cy = root ? run.player.y : y;
          spawnEnt(run, sp, f, cx, cy, 0, o({}));
          audio.play(f.element);
        });
      }
      break;
    case 'meteor': {
      const spots = root ? run.denseSpots(x, y, 480, n) : Array.from({ length: n }, (_, i) => [x + (n > 1 ? Math.cos(i * 2.4) * 70 : 0), y + (n > 1 ? Math.sin(i * 2.4) * 70 : 0)] as [number, number]);
      spots.forEach((sx, i) => {
        run.later(i * 0.25, () => { if (!run.over) spawnEnt(run, sp, f, sx[0], sx[1], 0, o({})); });
      });
      break;
    }
  }
}

/* --------------------------------- Events --------------------------------- */

export function processEvents(run: Run) {
  const evs = run.events;
  if (!evs.length) return;
  run.spawnBudget = SPAWN_BUDGET;
  const lim = Math.min(evs.length, 160);
  for (let i = 0; i < lim; i++) {
    const ev: GameEvent = evs[i];
    const f = ev.src.f;
    for (const t of f.triggers) {
      if (t.type !== ev.type) continue;
      if (t.chance < 1 && Math.random() >= t.chance) continue;
      for (const child of t.children) {
        if (ev.src.depth + 1 > MAX_DEPTH || run.spawnBudget <= 0 || run.ents.length >= MAX_ENTS) continue;
        run.spawnBudget--;
        castForm(run, ev.src.sp, child, ev.x, ev.y, ev.ang, false);
        run.fx.ring(ev.x, ev.y, ELEMENTS[child.element].color, 4, 22, 0.2, 0.7);
      }
    }
  }
  evs.length = 0;
}

/* ----------------------------- Entity simulation ----------------------------- */

export function updateEnts(run: Run, dt: number) {
  const ents = run.ents;
  for (let i = 0; i < ents.length; i++) {
    const en = ents[i];
    if (en.dead) continue;
    en.life -= dt;
    switch (en.kind) {
      case 'projectile': updateProjectile(run, en, dt); break;
      case 'beam': updateBeam(run, en, dt); break;
      case 'orb': updateOrb(run, en, dt); break;
      case 'aura': case 'decal': updateZone(run, en, dt); break;
      case 'mine': updateMine(run, en, dt); break;
      case 'nova': updateNova(run, en, dt); break;
      case 'meteor': updateMeteor(run, en, dt); break;
    }
    if (en.env && !en.dead) hazardTick(run, en, dt);
    if (en.life <= 0 && !en.dead) endEnt(run, en);
    if (!en.dead) syncEnt(run, en);
  }
}

function endEnt(run: Run, en: SEnt, skipSplit = false) {
  if (en.dead) return;
  en.dead = true;
  if (en.root) en.sp.live = Math.max(0, en.sp.live - 1);
  if (!en.silent) {
    if (en.kind === 'projectile' && en.f.b.split && !en.splitDone && !skipSplit) doSplit(run, en, en.ang);
    if (en.kind === 'aura') collapse(run, en);
    run.queueEvent('expiry', en.src, en.x, en.y, en.ang);
  }
  if (en.kind === 'projectile') run.fx.burst(en.x, en.y, ELEMENTS[en.el].color, 3, 70, 0.25, 0.5);
}

function collapse(run: Run, en: SEnt) {
  if (en.el !== 'gravity') return;
  const R = currentR(en) * 1.1;
  const list = run.query(en.x, en.y, R);
  if (list.length < 2) return;
  const dmg = en.dmg * (2 + 0.35 * list.length) * en.sp.mut.collapse * en.sp.mut.react;
  reaction(run, 'collapse', en.x, en.y, en.src);
  run.fx.ring(en.x, en.y, 0xb36bff, R, 6, 0.4);
  run.fx.burst(en.x, en.y, 0xe0b0ff, 16, 200, 0.5, 1.3);
  run.fx.shake(5);
  audio.play('boom');
  for (const e of list) dealDamage(run, e, dmg, 'gravity', en.src, { react: true, noTrig: true });
}

function doSplit(run: Run, en: SEnt, baseAng: number) {
  if (en.splitDone) return;
  en.splitDone = true;
  const child = splitChild(en.f);
  const angs = en.kind === 'mine' || en.kind === 'meteor' ? [0, 2.094, 4.189].map((a) => a + Math.random()) : [-0.5, 0, 0.5].map((a) => a + baseAng);
  for (const a of angs) {
    if (run.spawnBudget <= 0 && run.events.length > 0) break;
    const c = spawnEnt(run, en.sp, child, en.x, en.y, a, { dmgMul: 0.55 * (en.dmg / (en.dmg || 1)), sizeMul: 0.75, life: 0.9, src: { ...en.src, f: child, icd: { hit: 0, crit: 0 } } });
    if (c) { c.dmg = en.dmg * 0.55; c.depth = en.depth + 1; }
  }
  run.fx.ring(en.x, en.y, ELEMENTS[en.el].color, 6, 26, 0.2);
}

function pullEnemies(run: Run, cx: number, cy: number, R: number, F: number, dt: number, src: Src) {
  for (const e of run.query(cx, cy, R)) {
    const dx = cx - e.x, dy = cy - e.y;
    const d = Math.hypot(dx, dy);
    if (d < 10) continue;
    const k = F * (0.45 + 0.55 * (1 - d / R)) * pullResist(e) * dt;
    e.x += (dx / d) * k; e.y += (dy / d) * k;
    e.pulled = 0.25;
    if (e.capT <= 0) { e.capT = 0.5; src.sp.st.captured++; }
  }
}

function updateProjectile(run: Run, en: SEnt, dt: number) {
  const f = en.f;
  if (f.b.orbit) {
    en.orbAng += en.orbSpd * dt;
    const [cx, cy] = center(run, en);
    const R = en.orbR * (en.expand ? 1 + 0.8 * (1 - en.life / en.maxLife) : 1);
    en.x = cx + Math.cos(en.orbAng) * R; en.y = cy + Math.sin(en.orbAng) * R;
    en.ang = en.orbAng + Math.PI / 2;
  } else {
    if (f.b.homing) {
      en.target -= dt;
      let t: Enemy | null | undefined = run.enemyById(en.target);
      if (!t || t.dead) {
        t = run.nearest(en.x, en.y, 450);
        en.target = t ? t.id : 0;
      }
      if (t) {
        const want = Math.atan2(t.y - en.y, t.x - en.x);
        let diff = Phaser.Math.Angle.Wrap(want - en.ang);
        const turn = 4.2 * dt;
        diff = Math.max(-turn, Math.min(turn, diff));
        en.ang += diff;
        en.vx = Math.cos(en.ang) * en.speed; en.vy = Math.sin(en.ang) * en.speed;
      }
    }
    en.x += en.vx * dt; en.y += en.vy * dt;
    const M = 20;
    if (en.x < M || en.x > ARENA - M || en.y < M || en.y > ARENA - M) {
      if (f.b.bounce) {
        if (en.x < M || en.x > ARENA - M) en.vx = -en.vx;
        if (en.y < M || en.y > ARENA - M) en.vy = -en.vy;
        en.x = Math.max(M, Math.min(ARENA - M, en.x)); en.y = Math.max(M, Math.min(ARENA - M, en.y));
        en.ang = Math.atan2(en.vy, en.vx);
      } else { en.life = 0; }
    }
  }
  if (en.expand) en.r = en.baseR * (1 + 0.8 * (1 - en.life / en.maxLife));
  if (en.pull) pullEnemies(run, en.x, en.y, en.pullR, en.pullF, dt, en.src);
  passThrough(run, en, dt);
  if (Math.random() < 0.6) {
    run.fx.spark(en.x, en.y, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30 + (en.el === 'fire' ? -25 : 0), ELEMENTS[en.el].color, 0.3, 0.5 + en.r / 25);
  }
  // collision
  const list = run.query(en.x, en.y, en.r);
  const orbit = !!f.b.orbit;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.dead) continue;
    const nt = en.hit.get(e.id);
    if (nt !== undefined && nt > run.time) continue;
    en.hit.set(e.id, orbit ? run.time + 0.5 : Infinity);
    hitWithProjectile(run, en, e);
    if (en.dead || en.life <= 0) break;
  }
}

/** Fire flying through poison clouds, lightning through puddles: reactions without needing a direct hit. */
function passThrough(run: Run, en: SEnt, dt: number) {
  if (!run.hazards.length || (en.el !== 'fire' && en.el !== 'lightning')) return;
  en.fireChk -= dt;
  if (en.fireChk > 0) return;
  en.fireChk = 0.1;
  envReact(run, en.el, en.x, en.y, en.r, en.src);
}

function hitWithProjectile(run: Run, en: SEnt, e: Enemy) {
  const sp = en.sp;
  const sp0 = Math.hypot(en.vx, en.vy) || 1;
  dealDamage(run, e, en.dmg, en.el, en.src, { kx: en.vx / sp0, ky: en.vy / sp0, kf: en.el === 'water' || en.el === 'gravity' ? 60 : 110, ang: en.ang });
  if (!e.dead) applyElement(run, e, en.dmg, en.el, en.src, false, en.x, en.y);
  if (en.blast > 0 && en.el === 'fire') explode(run, en.x, en.y, en.blast, en.dmg * 0.45, 'fire', en.src, { status: true, kb: 90 });
  else if (en.blast > 0 && en.el === 'gravity') explode(run, en.x, en.y, en.blast, en.dmg * 0.4, 'gravity', en.src, { kb: 0 });
  envReact(run, en.el, en.x, en.y, en.r + 8, en.src);
  if (en.el === 'water' && Math.random() < 0.4) spawnEnv(run, en.src, 'water', en.x, en.y, 30, 5, 0);
  if (en.el === 'poison' && Math.random() < 0.4) spawnEnv(run, en.src, 'poison', en.x, en.y, 34, 3.2, 2.5);
  if (en.chain > 0) arc(run, e, en.dmg * 0.7, en.el === 'fire' ? 'lightning' : en.el, en.src, en.chain, 170, [e]);
  run.fx.ring(en.x, en.y, ELEMENTS[en.el].color, 4, 20, 0.18, 0.8);
  if (en.f.b.orbit) return;
  if (en.f.b.split && !en.splitDone) doSplit(run, en, en.ang);
  if (en.pierce > 0) { en.pierce--; return; }
  if (en.bounce > 0) {
    let best: Enemy | null = null, bd = 380 * 380;
    for (const n of run.query(en.x, en.y, 380)) {
      if (n === e || n.dead || en.hit.has(n.id)) continue;
      const d = (n.x - en.x) ** 2 + (n.y - en.y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    if (best) {
      en.bounce--; en.dmg *= 0.85;
      en.ang = Math.atan2(best.y - en.y, best.x - en.x);
      en.vx = Math.cos(en.ang) * en.speed; en.vy = Math.sin(en.ang) * en.speed;
      return;
    }
  }
  endEnt(run, en, true);
}

function updateBeam(run: Run, en: SEnt, dt: number) {
  const [ox, oy] = center(run, en);
  en.x = ox; en.y = oy;
  // track nearest enemy
  const t = run.nearest(ox, oy, en.len + 60);
  if (t) {
    const off = (en.idx - (en.n - 1) / 2) * 0.5;
    const want = Math.atan2(t.y - oy, t.x - ox) + off;
    const diff = Phaser.Math.Angle.Wrap(want - en.ang);
    const turn = 3.4 * (1 + 0.4 * en.f.m.acc) * dt;
    en.ang += Math.max(-turn, Math.min(turn, diff));
  }
  en.tickT -= dt;
  if (en.tickT > 0) return;
  en.tickT += en.tick;
  const dx = Math.cos(en.ang), dy = Math.sin(en.ang);
  const mx = ox + dx * en.len / 2, my = oy + dy * en.len / 2;
  let first: Enemy | null = null, last: Enemy | null = null, lastT = -1;
  for (const e of run.query(mx, my, en.len / 2 + 20)) {
    if (e.dead) continue;
    const rx = e.x - ox, ry = e.y - oy;
    const proj = rx * dx + ry * dy;
    if (proj < 0 || proj > en.len) continue;
    const perp = Math.abs(rx * -dy + ry * dx);
    if (perp > en.width / 2 + e.r * 0.8) continue;
    if (!first) first = e;
    if (proj > lastT) { lastT = proj; last = e; }
    dealDamage(run, e, en.dmg, en.el, en.src, { kx: dx, ky: dy, kf: en.el === 'gravity' ? 0 : 25, ang: en.ang });
    if (e.dead) continue;
    const nt = en.hit.get(e.id) ?? 0;
    if (nt <= run.time) {
      en.hit.set(e.id, run.time + 0.5);
      applyElement(run, e, en.dmg * 3, en.el, en.src, true);
    }
    if (en.pull || en.f.b.pull) {
      const d = Math.hypot(rx, ry) || 1;
      const k = en.pullF * 0.6 * pullResist(e) * en.tick;
      e.x -= (rx / d) * k; e.y -= (ry / d) * k; e.pulled = 0.2;
      if (e.capT <= 0) { e.capT = 0.5; en.sp.st.captured++; }
    }
  }
  if (en.chain > 0 && last && en.strikeT <= run.time) {
    en.strikeT = run.time + 0.4;
    arc(run, last, en.dmg * 1.4, en.el === 'fire' ? 'lightning' : en.el, en.src, en.chain, 170, [last]);
  }
  if (run.hazards.length) {
    envReact(run, en.el, ox + dx * en.len * 0.5, oy + dy * en.len * 0.5, 40, en.src);
    envReact(run, en.el, ox + dx * en.len * 0.95, oy + dy * en.len * 0.95, 40, en.src);
  }
  if (Math.random() < 0.5) run.fx.spark(ox + dx * en.len * Math.random(), oy + dy * en.len * Math.random(), (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, ELEMENTS[en.el].color, 0.3, 0.7);
}

function updateOrb(run: Run, en: SEnt, dt: number) {
  en.orbAng += en.orbSpd * dt;
  const [cx, cy] = center(run, en);
  const R = en.orbR * (en.expand ? 1 + 0.8 * (1 - en.life / en.maxLife) : 1);
  en.x = cx + Math.cos(en.orbAng) * R; en.y = cy + Math.sin(en.orbAng) * R;
  if (en.expand) en.r = en.baseR * (1 + 0.5 * (1 - en.life / en.maxLife));
  if (en.pull) pullEnemies(run, en.x, en.y, en.pullR, en.pullF, dt, en.src);
  passThrough(run, en, dt);
  if (Math.random() < 0.5) run.fx.spark(en.x, en.y, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, ELEMENTS[en.el].color, 0.3, 0.6);
  for (const e of run.query(en.x, en.y, en.r + 2)) {
    if (e.dead) continue;
    const nt = en.hit.get(e.id);
    if (nt !== undefined && nt > run.time) continue;
    en.hit.set(e.id, run.time + 0.45);
    const dx = e.x - en.x, dy = e.y - en.y, d = Math.hypot(dx, dy) || 1;
    dealDamage(run, e, en.dmg, en.el, en.src, { kx: dx / d, ky: dy / d, kf: 140, ang: Math.atan2(dy, dx) });
    if (!e.dead) applyElement(run, e, en.dmg, en.el, en.src, false, en.x, en.y);
    if (en.el === 'fire') explode(run, en.x, en.y, 38 * en.sp.mut.splash, en.dmg * 0.3, 'fire', en.src, { fx: false });
    envReact(run, en.el, en.x, en.y, en.r + 8, en.src);
    if (en.chain > 0) arc(run, e, en.dmg * 0.7, en.el === 'fire' ? 'lightning' : en.el, en.src, en.chain, 160, [e]);
  }
}

function updateZone(run: Run, en: SEnt, dt: number) {
  if (en.kind === 'aura') {
    const [cx, cy] = center(run, en);
    en.x = cx; en.y = cy;
  }
  const R = currentR(en);
  if (en.pull && !en.silent) pullEnemies(run, en.x, en.y, Math.max(R * (en.kind === 'aura' ? 1.3 : 1.5), 60), en.pullF, dt, en.src);
  en.tickT -= dt;
  if (en.tickT > 0) return;
  en.tickT += en.tick;
  const list = run.query(en.x, en.y, R);
  if (en.silent) {
    for (const e of list) {
      if (en.el === 'poison') { applyPoison(run, e, Math.max(1.2, en.dmg * 0.3), en.src, POISON_BASE_STACKS + en.sp.mut.polStacks); dealDamage(run, e, en.dmg * 0.7, 'poison', en.src, { dot: true, noTrig: true }); }
      else applyWet(run, e, en.src);
    }
    return;
  }
  if (en.el === 'lightning') {
    // storm: strikes on random targets inside the zone
    const picks = Math.min(list.length, 3);
    for (let i = 0; i < picks; i++) {
      const e = list[(Math.random() * list.length) | 0];
      if (e.dead) continue;
      run.fx.bolt(e.x + (Math.random() - 0.5) * 30, e.y - 120, e.x, e.y, 0xfff35e, 9, 0.18);
      audio.play('lightning');
      dealDamage(run, e, en.dmg * 2.8, 'lightning', en.src, { ang: en.ang });
      if (!e.dead) applyElement(run, e, en.dmg * 2.4, 'lightning', en.src, true);
      envReact(run, 'lightning', e.x, e.y, 24, en.src);
    }
    if (en.chain > 0 && list.length) arc(run, list[0], en.dmg * 1.5, 'lightning', en.src, en.chain, 150, [list[0]]);
    return;
  }
  let reacted = false;
  for (const e of list) {
    if (e.dead) continue;
    const dx = e.x - en.x, dy = e.y - en.y, d = Math.hypot(dx, dy) || 1;
    dealDamage(run, e, en.dmg, en.el, en.src, { kx: dx / d, ky: dy / d, kf: en.el === 'water' ? 25 : 0, ang: Math.atan2(dy, dx) });
    if (e.dead) continue;
    const nt = en.hit.get(e.id) ?? 0;
    const statusEvery = en.el === 'ice' ? 0.9 : 0.5;
    if (nt <= run.time) {
      en.hit.set(e.id, run.time + statusEvery);
      applyElement(run, e, en.dmg * (en.el === 'fire' ? 1.5 : 1), en.el, en.src, true, en.x, en.y);
    }
    if (!reacted && (en.el === 'fire' || en.el === 'ice') && run.hazards.length) { reacted = true; envReact(run, en.el, en.x, en.y, R, en.src); }
  }
  if (en.el === 'fire' && Math.random() < 0.6) {
    const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * R;
    run.fx.spark(en.x + Math.cos(a) * d, en.y + Math.sin(a) * d, 0, -40, 0xff8a2a, 0.5, 1);
  }
  if ((en.el as Element) === 'lightning' || en.el === 'poison' || en.el === 'ice') {
    const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * R;
    run.fx.spark(en.x + Math.cos(a) * d, en.y + Math.sin(a) * d, 0, -20, ELEMENTS[en.el].color, 0.5, 1);
  }
  if (list.length && run.hazards.length && !reacted) envReact(run, en.el, en.x, en.y, R, en.src);
  void gravityImpulse;
}

function updateMine(run: Run, en: SEnt, dt: number) {
  if (en.armT > 0) en.armT -= dt;
  if (en.f.b.homing && en.armT <= 0) {
    const t = run.nearest(en.x, en.y, 350);
    if (t) {
      const a = Math.atan2(t.y - en.y, t.x - en.x);
      en.x += Math.cos(a) * en.speed * dt; en.y += Math.sin(a) * en.speed * dt;
    }
  }
  if (en.armT > 0) return;
  const trig = 40 * (1 + 0.35 * en.f.m.area);
  let go = false;
  for (const e of run.query(en.x, en.y, trig)) { if (!e.dead) { go = true; break; } }
  if (go) detonate(run, en);
  else if (en.life <= 0) detonate(run, en);
}

function updateNova(run: Run, en: SEnt, dt: number) {
  const t = 1 - en.life / en.maxLife;
  const R = en.r * (1 - (1 - t) * (1 - t));
  const inward = en.pull;
  const col = ELEMENTS[en.el].color;
  if (Math.random() < 0.9) {
    const a = Math.random() * 6.283;
    run.fx.spark(en.x + Math.cos(a) * R, en.y + Math.sin(a) * R, Math.cos(a) * 60, Math.sin(a) * 60, col, 0.4, 1.4);
  }
  if (en.el === 'lightning' && Math.random() < 0.5) {
    const a = Math.random() * 6.283;
    run.fx.bolt(en.x + Math.cos(a) * R * 0.8, en.y + Math.sin(a) * R * 0.8, en.x + Math.cos(a + 0.4) * R, en.y + Math.sin(a + 0.4) * R, 0xfff35e, 5, 0.1);
  }
  for (const e of run.query(en.x, en.y, R)) {
    if (e.dead || en.hit.has(e.id)) continue;
    en.hit.set(e.id, Infinity);
    const dx = e.x - en.x, dy = e.y - en.y, dd = Math.hypot(dx, dy) || 1;
    const s = inward ? -1 : 1;
    dealDamage(run, e, en.dmg, en.el, en.src, { kx: (dx / dd) * s, ky: (dy / dd) * s, kf: en.el === 'gravity' ? 0 : 230, ang: Math.atan2(dy, dx) });
    if (e.dead) continue;
    applyElement(run, e, en.dmg, en.el, en.src, false, en.x, en.y);
    if (en.chain > 0) arc(run, e, en.dmg * 0.7, en.el === 'fire' ? 'lightning' : en.el, en.src, en.chain, 170, [e]);
  }
  if (!en.fireChk) { en.fireChk = 1; envReact(run, en.el, en.x, en.y, en.r * 0.7, en.src); run.fx.shake(2); }
  if (en.pull) pullEnemies(run, en.x, en.y, en.r * 1.1, en.pullF, dt, en.src);
}

function updateMeteor(run: Run, en: SEnt, dt: number) {
  en.armT -= dt;
  if (en.f.b.homing && en.armT > 0.15) {
    const t = run.nearest(en.x, en.y, 220);
    if (t) {
      const a = Math.atan2(t.y - en.y, t.x - en.x);
      en.x += Math.cos(a) * en.speed * dt; en.y += Math.sin(a) * en.speed * dt;
    }
  }
  if (en.armT > 0) {
    if (Math.random() < 0.7) run.fx.spark(en.x + (Math.random() - 0.5) * en.blast, en.y + (Math.random() - 0.5) * en.blast, 0, 0, ELEMENTS[en.el].color, 0.3, 0.9);
    return;
  }
  run.fx.ring(en.x, en.y, 0xffffff, 10, en.blast * 0.8, 0.25, 0.8);
  detonate(run, en);
}

function detonate(run: Run, en: SEnt) {
  if (en.dead) return;
  const R = en.blast * (en.expand ? 1.5 : 1);
  if (en.pull || en.el === 'gravity') gravityImpulse(run, en.x, en.y, R * 1.2, 320 * en.sp.mut.pullR, en.src);
  const cnt = explode(run, en.x, en.y, R, en.dmg, en.el, en.src, { status: true, noTrig: false, kb: en.el === 'gravity' ? 0 : 160 });
  run.fx.shake(2 + Math.min(4, R / 40));
  audio.play('boom');
  envReact(run, en.el, en.x, en.y, R, en.src);
  if (en.el === 'water') spawnEnv(run, en.src, 'water', en.x, en.y, R * 0.7, 6, 0);
  if (en.el === 'poison') spawnEnv(run, en.src, 'poison', en.x, en.y, R * 0.8, 4, 3);
  if (en.chain > 0) {
    const t = run.nearest(en.x, en.y, R + 30);
    if (t) arc(run, t, en.dmg * 0.7, en.el === 'fire' ? 'lightning' : en.el, en.src, en.chain, 180, [t]);
  }
  if (en.f.b.split && !en.splitDone) doSplit(run, en, 0);
  if (en.el === 'gravity' && cnt >= 2) collapse(run, en);
  en.life = 0;
  endEnt(run, en, true);
}

/** Puddles & clouds: slowing, electrified damage. */
function hazardTick(run: Run, en: SEnt, dt: number) {
  const R = currentR(en);
  if (en.env === 'puddle') {
    if (en.electric > 0) {
      en.electric -= dt;
      en.strikeT -= dt;
      if (en.strikeT <= 0) {
        en.strikeT = 0.4;
        const src = en.eSrc ?? en.src;
        const base = (9 + run.player.level * 0.7) * run.player.dmgMul * src.sp.mut.conduct * src.sp.mut.react;
        for (const e of run.query(en.x, en.y, R)) {
          reactDamage(run, e, base, ['lightning', 'water'], src);
          if (!e.dead) { e.wet = Math.max(e.wet, 2); }
        }
        const a = Math.random() * 6.28, d = Math.random() * R;
        run.fx.bolt(en.x + Math.cos(a) * d * 0.4, en.y + Math.sin(a) * d * 0.4, en.x + Math.cos(a) * d, en.y + Math.sin(a) * d, 0xfff35e, 5, 0.15);
        if (en.electric <= 0) en.electric = 0;
      }
    }
    // slowing
    en.fireChk -= dt;
    if (en.fireChk <= 0) {
      en.fireChk = 0.2;
      const slow = en.ice ? 0.5 : 0.8;
      for (const e of run.query(en.x, en.y, R)) { e.slowT = 0.3; e.slowMul = Math.min(e.slowMul, slow); }
    }
  }
}
