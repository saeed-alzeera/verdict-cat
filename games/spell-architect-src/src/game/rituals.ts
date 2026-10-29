// Rituals: optional multi-round contracts. Accept one in the shop (it costs coins and a ritual slot), meet every objective within
// its rounds and you gain a permanent upgrade for the rest of the run; miss one and it lapses (only the coins are lost).
// Objectives are plain counters fed by events the game already raises (kills, crits, reactions, damage taken, coins...).
// Co-op: every player has their own rituals (events reach the shell of the player they belong to); the host evaluates them,
// and count objectives are 10% higher per extra player.
import { ELEMENTS } from '../data/runes';
import type { Run } from './run';

export type RewardId = 'power' | 'maxhp' | 'regen' | 'crit' | 'cdr' | 'cap' | 'coins' | 'prices' | 'slot' | 'forge';
export type ObjId = 'kills' | 'elemkills' | 'elites' | 'crits' | 'reactions' | 'reactdiff' | 'hurtmax' | 'hpend' | 'novoid' | 'elements3' | 'slotsfull' | 'coins' | 'forge';

export interface Objective { id: ObjId; scope: 'round' | 'total' | 'once'; target: number; el?: string }
export interface RitualDef { id: string; name: string; icon: string; tier: 1 | 2 | 3; rounds: number; cost: number; objectives: Objective[]; reward: RewardId }
export interface ActiveRitual { def: RitualDef; startRound: number; roundsDone: number; prog: number[]; state: 'active' | 'fulfilled' | 'lapsed'; why: string }
export interface RitualBonus { coinMul: number; priceMul: number; forgeMinus: number; regen: number }
export const freshBonus = (): RitualBonus => ({ coinMul: 1, priceMul: 1, forgeMinus: 0, regen: 0 });

export const ritualSlots = (run: Run) => (run.round >= 8 ? 2 : 1);
const MAX_REGEN_BONUS = 0.8;

/* ------------------------------------------------------------------ rewards */

const AMOUNT: Record<RewardId, [number, number, number]> = {
  power: [0.06, 0.1, 0.15], maxhp: [15, 25, 40], regen: [0.15, 0.25, 0.35], crit: [0.04, 0.06, 0.08], cdr: [0.06, 0.09, 0.12],
  cap: [2, 3, 4], coins: [0.15, 0.25, 0.35], prices: [0.05, 0.08, 0.1], slot: [1, 1, 1], forge: [1, 1, 1],
};
const REWARD_INFO: Record<RewardId, { name: string; icon: string }> = {
  power: { name: 'Pact of Might', icon: '🔺' }, maxhp: { name: 'Vow of Vigor', icon: '❤️' }, regen: { name: 'Rite of Renewal', icon: '🌿' },
  crit: { name: "Oath of the Keen Eye", icon: '🎯' }, cdr: { name: 'Pact of Haste', icon: '⏩' }, cap: { name: 'Rite of Capacity', icon: '🔷' },
  coins: { name: 'Vow of Gold', icon: '💰' }, prices: { name: 'Pact of Bargains', icon: '🏷️' }, slot: { name: 'Oath of the Extra Hand', icon: '📜' },
  forge: { name: 'Rite of the Anvil', icon: '🔨' },
};
const POOL: Record<1 | 2 | 3, [RewardId, number][]> = {
  1: [['power', 3], ['maxhp', 4], ['regen', 3], ['crit', 2], ['cdr', 2], ['coins', 2]],
  2: [['power', 3], ['maxhp', 4], ['regen', 3], ['crit', 2], ['cdr', 3], ['cap', 3], ['coins', 2], ['prices', 2]],
  3: [['power', 3], ['maxhp', 3], ['regen', 2], ['cdr', 2], ['cap', 3], ['slot', 3], ['forge', 3], ['prices', 1]],
};

export function rewardText(r: RewardId, tier: 1 | 2 | 3): string {
  const a = AMOUNT[r][tier - 1];
  switch (r) {
    case 'power': return `+${Math.round(a * 100)}% damage for the rest of the run`;
    case 'maxhp': return `+${a} maximum health (and heal that much)`;
    case 'regen': return `+${a} health regenerated per second`;
    case 'crit': return `+${Math.round(a * 100)}% critical hit chance`;
    case 'cdr': return `-${Math.round(a * 100)}% cooldown on every spell`;
    case 'cap': return `+${a} capacity on every spell`;
    case 'coins': return `coins are worth +${Math.round(a * 100)}%`;
    case 'prices': return `shop prices -${Math.round(a * 100)}%`;
    case 'slot': return '+1 spell slot (or +15% damage if you have all five)';
    case 'forge': return 'forging costs 1 fewer Core';
  }
}

export function applyReward(run: Run, r: RewardId, tier: 1 | 2 | 3) {
  const a = AMOUNT[r][tier - 1], p = run.player, b = run.ritualBonus;
  switch (r) {
    case 'power': p.dmgMul += a; break;
    case 'maxhp': p.maxHp += a; run.heal(a); break;
    case 'regen': { const add = Math.min(a, Math.max(0, MAX_REGEN_BONUS - b.regen)); b.regen += add; p.regen += add; break; }
    case 'crit': p.crit += a; break;
    case 'cdr': p.cdMul *= 1 - a; break;
    case 'cap': run.addCapacity(a); break;
    case 'coins': b.coinMul *= 1 + a; break;
    case 'prices': b.priceMul = Math.max(0.75, b.priceMul * (1 - a)); break;
    case 'slot': if (run.slots < 5) run.addSlot(); else p.dmgMul += 0.15; break;
    case 'forge': b.forgeMinus = Math.min(2, b.forgeMinus + 1); break;
  }
  run.recomputeRelics();
}

/* ------------------------------------------------------------------ objectives */

/** Rough kills per round at this point of a run (the targets scale from it). */
const killBase = (round: number) => 26 + 20 * Math.min(round, 12);

export function objectiveText(o: Objective): string {
  switch (o.id) {
    case 'kills': return `Kill ${o.target} enemies`;
    case 'elemkills': return `Kill ${o.target} enemies with ${ELEMENTS[o.el as keyof typeof ELEMENTS]?.name ?? 'elemental'} spells`;
    case 'elites': return `Kill ${o.target} elite enem${o.target === 1 ? 'y' : 'ies'}`;
    case 'crits': return `Land ${o.target} critical hits`;
    case 'reactions': return `Trigger ${o.target} reactions`;
    case 'reactdiff': return `Trigger ${o.target} different reactions in one round`;
    case 'hurtmax': return `Take at most ${o.target} damage in every round`;
    case 'hpend': return `Finish every round above ${o.target}% health`;
    case 'novoid': return 'Never fall into the void';
    case 'elements3': return 'Finish every round with 3 or more elements equipped';
    case 'slotsfull': return 'Finish every round with every spell slot in use';
    case 'coins': return `Collect ${o.target} coins`;
    case 'forge': return 'Forge an evolved Core';
  }
}

function rollObjectives(run: Run, tier: 1 | 2 | 3, rounds: number): Objective[] {
  const round = run.round;
  const f = tier === 1 ? 0.8 : tier === 2 ? 1 : 1.25;
  const g = tier === 1 ? 1.2 : tier === 2 ? 0.9 : 0.7; // "take less" objectives get tighter
  const k = 1 + 0.1 * (run.coopSize() - 1); // more players: kills are shared out, so the count targets rise a little
  const rr = (n: number, step = 5) => Math.max(step, Math.round(n / step) * step);
  const els = [...new Set(run.spells.flatMap((s) => (s.c.valid ? s.c.elements : [])).filter((e) => e !== 'arcane'))];
  const slotsOk = run.spells.every((s) => !!s.def.root) && run.spells.length >= 2;
  type Mk = () => Objective | null;
  // group A shapes how you play or build, group B is output; every ritual mixes both so one behaviour cannot satisfy it
  const A: Mk[] = [
    () => ({ id: 'hurtmax', scope: 'round', target: rr(Math.max(15, (14 + 9 * Math.min(round, 10)) * g), 5) }),
    () => ({ id: 'hpend', scope: 'round', target: tier === 1 ? 40 : tier === 2 ? 50 : 60 }),
    () => ({ id: 'novoid', scope: 'total', target: 1 }),
    () => (run.mods.elements >= 2 ? { id: 'elements3', scope: 'round', target: 3 } : null),
    () => (slotsOk && run.slots >= 2 ? { id: 'slotsfull', scope: 'round', target: run.slots } : null),
  ];
  const B: Mk[] = [
    () => ({ id: 'kills', scope: 'total', target: rr(killBase(round) * rounds * f * k, 10) }),
    () => (els.length ? { id: 'elemkills', scope: 'total', el: els[(Math.random() * els.length) | 0], target: rr(killBase(round) * rounds * f * 0.5 * k, 10) } : null),
    () => ({ id: 'elites', scope: 'total', target: Math.max(1, Math.round((tier + rounds - 1) * 0.7 * k)) }),
    () => ({ id: 'crits', scope: 'total', target: rr(killBase(round) * rounds * f * 0.2 * k, 5) }),
    () => ({ id: 'reactions', scope: 'total', target: rr(killBase(round) * rounds * f * 0.12 * k, 5) }),
    () => ({ id: 'reactdiff', scope: 'once', target: tier === 1 ? 2 : tier === 2 ? 3 : 4 }),
    () => ({ id: 'coins', scope: 'total', target: Math.max(4, Math.round((3 + round * 0.7) * rounds * f * k)) }),
    () => (run.coreCopies && Object.keys(ELEMENTS).some((e) => run.coreCopies(e) >= 3) ? { id: 'forge', scope: 'once', target: 1 } : null),
  ];
  const pick = (list: Mk[], used: Set<ObjId>) => {
    for (let t = 0; t < 12; t++) { const o = list[(Math.random() * list.length) | 0](); if (o && !used.has(o.id)) { used.add(o.id); return o; } }
    return null;
  };
  const used = new Set<ObjId>();
  const out: Objective[] = [];
  const a = pick(A, used); if (a) out.push(a);
  const b = pick(B, used); if (b) out.push(b);
  if (tier >= 3 || (tier === 2 && Math.random() < 0.5)) { const c = pick(Math.random() < 0.5 ? A : B, used); if (c) out.push(c); }
  if (out.length < 2) { const c = pick(B, used); if (c) out.push(c); }
  return out;
}

/* ------------------------------------------------------------------ offers */

let seq = 1;
export function makeRitual(run: Run, tier: 1 | 2 | 3): RitualDef {
  const rounds = tier + 1;
  const pool = POOL[tier];
  let tot = 0; for (const [, w] of pool) tot += w;
  let x = Math.random() * tot, reward = pool[0][0];
  for (const [r, w] of pool) { x -= w; if (x <= 0) { reward = r; break; } }
  const cost = Math.max(2, Math.round((tier === 1 ? 6 + Math.random() * 4 : tier === 2 ? 12 + Math.random() * 8 : 20 + Math.random() * 15) * run.mods.priceMul));
  return { id: `rit${seq++}`, name: REWARD_INFO[reward].name, icon: REWARD_INFO[reward].icon, tier, rounds, cost, objectives: rollObjectives(run, tier, rounds), reward };
}

/** The rituals on offer for this visit. */
export function rollRituals(run: Run): RitualDef[] {
  const top: 1 | 2 | 3 = run.round >= 8 ? 3 : run.round >= 4 ? 2 : 1;
  const second: 1 | 2 | 3 = top === 1 ? 1 : ((top - 1) as 1 | 2);
  const out = [makeRitual(run, second)];
  const t2 = top;
  out.push(makeRitual(run, t2));
  return out;
}

export function acceptRitual(run: Run, def: RitualDef): string | null {
  const active = run.rituals.filter((r) => r.state === 'active');
  if (active.length >= ritualSlots(run)) return `You can run ${ritualSlots(run)} ritual${ritualSlots(run) > 1 ? 's' : ''} at a time.`;
  if (active.some((r) => r.def.tier === def.tier)) return 'You already have a ritual of that tier running.';
  if (run.coins < def.cost) return `Not enough coins (need ${def.cost}).`;
  run.coins -= def.cost;
  run.rituals.push({ def, startRound: run.round, roundsDone: 0, prog: def.objectives.map(() => 0), state: 'active', why: '' });
  run.shop.rituals = run.shop.rituals.filter((d) => d !== def);
  return null;
}

/* ------------------------------------------------------------------ events */

type Ev =
  | { t: 'kill'; elite: boolean; els: readonly string[] }
  | { t: 'crit' } | { t: 'reaction'; id: string } | { t: 'hurt'; d: number } | { t: 'void' } | { t: 'coin'; v: number } | { t: 'forge' };

/** Feed a game event to every running ritual. Cheap when there are none. */
export function ritualEvent(run: Run, ev: Ev) {
  const w = run;
  if (!w.rituals.length) return;
  if (ev.t === 'hurt') w.ritualRound.hurt += ev.d;
  if (ev.t === 'reaction') w.ritualRound.react.add(ev.id);
  for (const r of w.rituals) {
    if (r.state !== 'active') continue;
    r.def.objectives.forEach((o, i) => {
      switch (o.id) {
        case 'kills': if (ev.t === 'kill') r.prog[i]++; break;
        case 'elites': if (ev.t === 'kill' && ev.elite) r.prog[i]++; break;
        case 'elemkills': if (ev.t === 'kill' && o.el && ev.els.includes(o.el)) r.prog[i]++; break;
        case 'crits': if (ev.t === 'crit') r.prog[i]++; break;
        case 'reactions': if (ev.t === 'reaction') r.prog[i]++; break;
        case 'reactdiff': if (ev.t === 'reaction') r.prog[i] = Math.max(r.prog[i], w.ritualRound.react.size); break;
        case 'coins': if (ev.t === 'coin') r.prog[i] += ev.v; break;
        case 'forge': if (ev.t === 'forge') r.prog[i] = 1; break;
        case 'novoid': if (ev.t === 'void') fail(w, r, 'You fell into the void.'); break;
      }
    });
  }
}

/** Tell the player the ritual belongs to (a remote player gets it on their own screen only). */
function notify(run: Run, title: string, color: string, sub: string) {
  if (run.remote) run.world.onRemoteNotice(run, title, color, sub); else run.announce(title, color, sub);
}

function fail(run: Run, r: ActiveRitual, why: string) {
  if (r.state !== 'active') return;
  r.state = 'lapsed'; r.why = why;
  notify(run, 'RITUAL LAPSED', '#ff9a9a', `${r.def.name}: ${why}`);
}

export function ritualRoundStart(run: Run) {
  run.ritualRound = { hurt: 0, react: new Set() };
}

/** Called when a round ends: check the per-round objectives, count the round, and resolve rituals that are finished. */
export function ritualRoundEnd(run: Run) {
  const w = run;
  if (!w.rituals.length) return;
  const p = w.player;
  for (const r of w.rituals) {
    if (r.state !== 'active') continue;
    r.roundsDone++;
    for (const o of r.def.objectives) {
      if (r.state !== 'active') break;
      if (o.id === 'hurtmax' && w.ritualRound.hurt > o.target) fail(w, r, `You took ${Math.round(w.ritualRound.hurt)} damage in a round (limit ${o.target}).`);
      else if (o.id === 'hpend' && p.hp / p.maxHp * 100 < o.target) fail(w, r, `You finished a round below ${o.target}% health.`);
      else if (o.id === 'elements3' && w.mods.elements < 3) fail(w, r, 'You finished a round with fewer than 3 elements equipped.');
      else if (o.id === 'slotsfull' && !w.spells.every((s) => !!s.def.root)) fail(w, r, 'You finished a round with an empty spell slot.');
    }
    if (r.state === 'active' && r.roundsDone >= r.def.rounds) {
      const missed = r.def.objectives.filter((o, i) => (o.scope === 'total' || o.scope === 'once') && o.id !== 'novoid' && r.prog[i] < o.target);
      if (missed.length) fail(w, r, `Not enough: ${objectiveText(missed[0])}.`);
      else {
        r.state = 'fulfilled';
        applyReward(w, r.def.reward, r.def.tier);
        notify(w, 'RITUAL FULFILLED', '#ffd25a', `${r.def.name}: ${rewardText(r.def.reward, r.def.tier)}.`);
      }
    }
  }
}

/** Progress shown for one objective, as `have / need`. */
export function objectiveProgress(r: ActiveRitual, i: number, run: Run): string {
  const o = r.def.objectives[i];
  switch (o.id) {
    case 'hurtmax': return `${Math.round(run.ritualRound.hurt)}/${o.target} this round`;
    case 'hpend': return `${Math.round(run.player.hp / run.player.maxHp * 100)}% now`;
    case 'novoid': return r.state === 'lapsed' ? 'fell' : 'ok';
    case 'elements3': return `${run.mods.elements}/3 now`;
    case 'slotsfull': return `${run.spells.filter((s) => !!s.def.root).length}/${run.spells.length} now`;
    default: return `${Math.min(r.prog[i], o.target)}/${o.target}`;
  }
}
export function objectiveMet(r: ActiveRitual, i: number): boolean {
  const o = r.def.objectives[i];
  return (o.scope === 'total' || o.scope === 'once') && o.id !== 'novoid' && r.prog[i] >= o.target;
}

/* ------------------------------------------------------------------ co-op: trusting a build from another machine */

const OBJ_IDS: ObjId[] = ['kills', 'elemkills', 'elites', 'crits', 'reactions', 'reactdiff', 'hurtmax', 'hpend', 'novoid', 'elements3', 'slotsfull', 'coins', 'forge'];
const REWARDS = Object.keys(AMOUNT);
/** The smallest target a count objective may have (a host will not accept a joiner's ritual that is free). */
const FLOOR: Partial<Record<ObjId, number>> = { kills: 20, elemkills: 10, elites: 1, crits: 5, reactions: 5, reactdiff: 2, coins: 3, hpend: 30 };

/** Is this ritual list, sent by a joiner, well formed and not trivially easy? Returns the problem or null. */
export function validateRituals(list: unknown, bonus: unknown): string | null {
  if (!Array.isArray(list) || list.length > 6) return 'bad rituals';
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  for (const r of list as ActiveRitual[]) {
    const d = r?.def;
    if (!d || !Array.isArray(d.objectives) || d.objectives.length < 1 || d.objectives.length > 4 || !REWARDS.includes(d.reward)) return 'bad ritual';
    if (![1, 2, 3].includes(d.tier) || d.rounds !== d.tier + 1 || !Array.isArray(r.prog) || r.prog.length !== d.objectives.length) return 'bad ritual';
    if (!['active', 'fulfilled', 'lapsed'].includes(r.state) || !num(r.roundsDone, 0, 4) || !num(r.startRound, 0, 100)) return 'bad ritual';
    for (const o of d.objectives) {
      if (!OBJ_IDS.includes(o.id) || !num(o.target, 0, 5000)) return 'bad ritual objective';
      const lo = FLOOR[o.id];
      if (lo !== undefined && o.target < lo) return 'ritual too easy';
      if (o.id === 'hurtmax' && o.target > 250) return 'ritual too easy';
      if (o.id === 'elemkills' && typeof o.el !== 'string') return 'bad ritual objective';
    }
    for (const v of r.prog) if (!num(v, 0, 1e6)) return 'bad ritual';
  }
  const b = bonus as RitualBonus | undefined;
  if (b && (!num(b.coinMul, 1, 5) || !num(b.priceMul, 0.7, 1) || !num(b.forgeMinus, 0, 2) || !num(b.regen, 0, 0.8))) return 'bad ritual bonus';
  return null;
}
