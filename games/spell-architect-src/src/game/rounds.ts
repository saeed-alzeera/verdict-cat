// Round structure: timed survival rounds, a boss every 5th round, enemy attunements and resistances.
import { ELEMENTS, type Element } from '../data/runes';

export const FINAL_ROUND = 20;
export const BOSS_EVERY = 5;
export const ROUND_DIFF = 50; // "difficulty seconds" each round adds to the director clock

export type Aff = Element | 'neutral';
export const ELEMENT_LIST: Element[] = ['fire', 'ice', 'lightning', 'poison', 'water', 'gravity'];

/** Elements an attuned enemy is vulnerable to. */
export const WEAK_TO: Record<string, Element[]> = {
  fire: ['ice', 'water'], ice: ['fire'], lightning: ['gravity'], poison: ['fire'], water: ['lightning'], gravity: ['poison'],
};

export const isBossRound = (r: number) => r % BOSS_EVERY === 0;
export const bossKind = (r: number) => Math.min(3, r / BOSS_EVERY - 1);
export const roundLen = (quick: boolean) => (quick ? 12 : 45);

export interface Plan {
  round: number;
  boss: number | null;
  shares: { aff: Aff; pct: number }[];
  resFactor: number; // damage multiplier an attuned enemy takes from its own element
  weakMul: number;
  bossRes: Record<string, number> | null;
  tip: string;
}

export const BOSS_RES: Record<number, Record<string, number>> = {
  0: { fire: 0.4, water: 1.3 },
  1: { poison: 0, water: 0.5, fire: 1.3 },
  2: { lightning: 0, ice: 0.5, gravity: 1.3 },
  3: { gravity: 0, ice: 0.3, poison: 0.5, fire: 1.25 },
};

function rng(seed: number) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function typesFor(round: number, k: number, seed: number): Element[] {
  const r = rng(round * 7919 + 17 + seed * 104729);
  const pool = [...ELEMENT_LIST];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, k);
}

/** `seed` is per run, so the order and mix of attunements differs every run. */
export function planFor(round: number, seed = 0): Plan {
  let neutral: number, k: number;
  if (round <= 1) { neutral = 100; k = 0; }
  else if (round === 2) { neutral = 80; k = 1; }
  else if (round === 3) { neutral = 65; k = 2; }
  else if (round === 4) { neutral = 55; k = 3; }
  else if (round === 5) { neutral = 50; k = 2; }
  else if (round <= 9) { neutral = 35; k = 4; }
  else if (round === 10) { neutral = 35; k = 3; }
  else if (round <= 14) { neutral = 25; k = 5; }
  else if (round === 15) { neutral = 25; k = 4; }
  else { neutral = 15; k = 6; }
  const types = typesFor(round, k, seed);
  // uneven mix: a dominant attunement, jittered neutral share
  const jr = rng(round * 31 + seed * 977 + 5);
  if (k) neutral = Math.max(10, Math.min(70, neutral + Math.round((jr() - 0.5) * 20)));
  const wts = types.map((_, i) => (i === 0 ? 1.6 : 0.6 + jr() * 0.8));
  const wsum = wts.reduce((a, b) => a + b, 0) || 1;
  const pcts = wts.map((w) => Math.max(5, Math.round(((100 - neutral) * w) / wsum)));
  const shares: Plan['shares'] = [{ aff: 'neutral', pct: k ? 100 - pcts.reduce((a, b) => a + b, 0) : 100 }];
  types.forEach((t, i) => shares.push({ aff: t, pct: pcts[i] }));
  const resFactor = round <= 5 ? 0.4 : round <= 10 ? 0.3 : round <= 15 ? 0.22 : 0.15;
  const boss = isBossRound(round) ? bossKind(round) : null;
  const tips: string[] = [];
  if (round === 1) tips.push('Neutral enemies take full damage from everything. Experiment!');
  else if (k > 0) tips.push('Attuned enemies resist their own element. Slot a Core they are weak to, or use plain Arcane, which is never resisted.');
  if (boss !== null) tips.push('Boss rounds end when the boss falls. Check its resistances: Arcane always works.');
  return { round, boss, shares, resFactor, weakMul: 1.3, bossRes: boss !== null ? BOSS_RES[boss] : null, tip: tips.join(' ') };
}

/** Resistance table for an enemy of a given attunement under a plan. */
export function resFor(aff: Aff, plan: Plan): Partial<Record<Element, number>> {
  if (aff === 'neutral') return {};
  const r: Partial<Record<Element, number>> = { [aff]: plan.resFactor };
  for (const w of WEAK_TO[aff]) r[w] = plan.weakMul;
  return r;
}

export function describeRes(res: Partial<Record<string, number>>): { immune: Element[]; resist: Element[]; weak: Element[] } {
  const immune: Element[] = [], resist: Element[] = [], weak: Element[] = [];
  for (const [e, m] of Object.entries(res)) {
    if (m === undefined) continue;
    if (m <= 0) immune.push(e as Element); else if (m < 1) resist.push(e as Element); else if (m > 1) weak.push(e as Element);
  }
  return { immune, resist, weak };
}

export const affColor = (a: Aff): number => (a === 'neutral' ? 0xffffff : ELEMENTS[a].color);
