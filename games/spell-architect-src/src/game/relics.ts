// Relics: passive items with conditional effects. Up to 6 are equipped; the rest sit in a stash and can be swapped
// between rounds. Effects are applied through a few hook points (damage, kill, crit, cast, reaction, round start/end).
import { RARITY, ELEMENTS, type Rarity } from '../data/runes';
import { ruleMods } from '../core/spell';
import { dealDamage, arc } from './combat';
import { castForm } from './casting';
import type { Run } from './run';
import { ritualEvent } from './rituals';
import type { Enemy, Src, ActiveSpell } from './types';

export const RELIC_SLOTS = 6;

export interface RelicDef {
  id: string;
  name: string;
  icon: string;
  rarity: Rarity;
  cursed?: boolean;
  desc: string;
  badge?: (run: Run) => string; // live counter shown on the relic
  onEquip?: (run: Run) => void;
  onUnequip?: (run: Run) => void;
}

const st = (run: Run, id: string) => (run.relicState[id] ??= {} as Record<string, number>) as Record<string, number>;

export const RELICS: RelicDef[] = [
  // ---- common
  { id: 'prism', name: 'Cracked Prism', icon: '🔶', rarity: 'common', desc: '+4% damage for each different element equipped across your spells (max +24%).', badge: (r) => `+${Math.min(6, r.mods.elements) * 4}%` },
  { id: 'whetstone', name: 'Whetstone', icon: '🪨', rarity: 'common', desc: 'The first hit on every enemy deals +30% damage.' },
  { id: 'penny', name: 'Lucky Penny', icon: '🪙', rarity: 'common', desc: 'Enemies that die while Wet, Burning, Poisoned or Frozen drop +1 coin.' },
  { id: 'thimble', name: "Healer's Thimble", icon: '🧵', rarity: 'common', desc: 'Heal 1 HP every 25 kills.', badge: (r) => `${st(r, 'thimble').n ?? 0}/25` },
  { id: 'ember', name: 'Ember Heart', icon: '❤️‍🔥', rarity: 'common', desc: 'Burning enemies take +15% damage from every source.' },
  // ---- uncommon
  { id: 'purist', name: 'Arcane Purist', icon: '✦', rarity: 'uncommon', desc: 'Spells whose main Form has no Core deal +50% damage and recharge 25% faster.' },
  { id: 'echo', name: 'Echo Chamber', icon: '🔔', rarity: 'uncommon', desc: '+8 percentage points to every On Hit / On Kill / On Crit chance.',
    onEquip: (r) => r.recomputeRelics(), onUnequip: (r) => r.recomputeRelics() },
  { id: 'sock', name: 'Static Sock', icon: '🧦', rarity: 'uncommon', desc: 'Every 8th spell cast is cast a second time for free.', badge: (r) => `${st(r, 'sock').n ?? 0}/8` },
  { id: 'resin', name: 'Resin Vial', icon: '🧪', rarity: 'uncommon', desc: '+2 poison stack cap, and poisoned enemies drop +1 coin when they die.',
    onEquip: (r) => r.recomputeRelics(), onUnequip: (r) => r.recomputeRelics() },
  { id: 'compass', name: 'Storm Compass', icon: '🧭', rarity: 'uncommon', desc: 'Critical hits release a free arc of lightning to 2 nearby enemies.' },
  { id: 'bell', name: 'Bargain Bell', icon: '🛎️', rarity: 'uncommon', desc: 'Shop prices -10% and rerolls cost 1 less.' },
  { id: 'lodestone', name: 'Lodestone', icon: '🧲', rarity: 'uncommon', desc: 'Coins are worth +20%.' },
  // ---- rare
  { id: 'nulllens', name: 'Null Lens', icon: '🔍', rarity: 'rare', desc: 'Elemental damage against enemies immune to that element is converted into 30% Arcane damage.' },
  { id: 'baton', name: "Conductor's Baton", icon: '🪄', rarity: 'rare', desc: 'Every different reaction you trigger this round adds +4% damage until the round ends (stacks).', badge: (r) => `+${(Object.keys(st(r, 'baton')).length) * 4}%` },
  { id: 'glove', name: "Duelist's Glove", icon: '🥊', rarity: 'rare', desc: 'A critical hit refunds 0.4s of that spell\'s cooldown (once per second per spell).' },
  { id: 'mirror', name: 'Mirror Shard', icon: '🪞', rarity: 'rare', desc: 'Whenever slot 1 casts, slot 2 also casts at 50% damage.' },
  { id: 'fang', name: 'Vampire Fang', icon: '🦷', rarity: 'rare', desc: 'Killing an enemy with a critical hit heals 1 HP (max 3 HP per round).' },
  // ---- epic
  { id: 'metronome', name: 'Metronome', icon: '🎼', rarity: 'epic', desc: 'Each cast shortens the NEXT slot\'s cooldown by 0.5 seconds, chaining multi-slot builds.' },
  { id: 'phoenix', name: 'Phoenix Feather', icon: '🪶', rarity: 'epic', desc: 'Once per run, lethal damage instead revives you at 40% health and blasts nearby enemies. The feather is consumed.', badge: (r) => (st(r, 'phoenix').used ? 'USED' : 'READY') },
  { id: 'ledger', name: "Alchemist's Ledger", icon: '📒', rarity: 'epic', desc: 'Reactions deal +60% damage, and the first reaction each round pays 1 coin.' },
  // ---- legendary
  { id: 'archive', name: 'Heart of the Archive', icon: '📚', rarity: 'legendary', desc: 'Your ultimates start every round ready, and refund half their cooldown if they kill 20+ enemies.' },
  { id: 'hammer', name: "Forgemaster's Hammer", icon: '🔨', rarity: 'legendary', desc: 'Forging costs 2 fewer Cores, and evolved Cores deal an extra +20% damage.' },
  // ---- cursed (big upside, real downside)
  { id: 'idol', name: 'Glass Cannon Idol', icon: '🗿', rarity: 'rare', cursed: true, desc: '+50% damage, but -40% maximum health.',
    onEquip: (r) => { const p = r.player; const lose = Math.round(p.maxHp * 0.4); st(r, 'idol').lost = lose; p.maxHp -= lose; p.hp = Math.min(p.hp, p.maxHp); },
    onUnequip: (r) => { const p = r.player; p.maxHp += st(r, 'idol').lost ?? 0; st(r, 'idol').lost = 0; } },
  { id: 'dice', name: "Gambler's Dice", icon: '🎲', rarity: 'epic', cursed: true, desc: 'Trigger chances ×1.5, but every Trigger rune costs +1 capacity.',
    onEquip: (r) => r.recomputeRelics(), onUnequip: (r) => r.recomputeRelics() },
  { id: 'purse', name: 'Hungry Purse', icon: '👛', rarity: 'uncommon', cursed: true, desc: 'Coins are worth ×1.5, but shop rerolls cost double.' },
];
export const RELIC_BY_ID: Record<string, RelicDef> = Object.fromEntries(RELICS.map((r) => [r.id, r]));

export const relicColor = (r: RelicDef) => (r.cursed ? '#ff5a6a' : RARITY[r.rarity].color);

/* ------------------------------ modifiers & hooks ------------------------------ */

export const has = (run: Run, id: string) => run.equipped.includes(id);

/** Recompute cached modifiers (called whenever relics or loadout change). */
export function recomputeMods(run: Run) {
  const m = run.mods;
  const els = new Set<string>();
  for (const sp of run.spells) if (sp.c.valid) for (const e of sp.c.elements) if (e !== 'arcane') els.add(e);
  m.elements = els.size;
  ruleMods.triggerChanceAdd = has(run, 'echo') ? 0.08 : 0;
  ruleMods.triggerChanceMul = has(run, 'dice') ? 1.5 : 1;
  ruleMods.triggerCost = has(run, 'dice') ? 1 : 0;
  m.poisonCap = has(run, 'resin') ? 2 : 0;
  m.coinMul = (has(run, 'purse') ? 1.5 : 1) * (has(run, 'lodestone') ? 1.2 : 1) * run.ritualBonus.coinMul;
  m.priceMul = (has(run, 'bell') ? 0.9 : 1) * run.ritualBonus.priceMul;
  m.rerollMul = has(run, 'purse') ? 2 : 1;
  m.rerollMinus = has(run, 'bell') ? 1 : 0;
  m.forgeMinus = (has(run, 'hammer') ? 2 : 0) + run.ritualBonus.forgeMinus;
}

/** Conditional damage multiplier from relics, applied to every damage instance. */
export function relicDamageMul(run: Run, e: Enemy, el: string, src: Src | null, o: { dot?: boolean; react?: boolean }): number {
  if (!run.equipped.length) return 1;
  let m = 1;
  if (has(run, 'prism')) m *= 1 + 0.04 * Math.min(6, run.mods.elements);
  if (has(run, 'idol')) m *= 1.5;
  if (has(run, 'ember') && e.burn > 0) m *= 1.15;
  if (has(run, 'whetstone') && !o.dot && !e.hitOnce) { e.hitOnce = true; m *= 1.3; }
  if (has(run, 'purist') && src && src.sp.c.root && src.sp.c.root.element === 'arcane') m *= 1.5;
  if (has(run, 'baton')) m *= 1 + 0.04 * Object.keys(st(run, 'baton')).length;
  if (has(run, 'hammer') && src && src.sp.c.root?.evolved) m *= 1.2;
  return m;
}

export const reactionMul = (run: Run) => (has(run, 'ledger') ? 1.6 : 1);

export function cooldownMul(run: Run, sp: ActiveSpell): number {
  return has(run, 'purist') && sp.c.root && sp.c.root.element === 'arcane' ? 0.75 : 1;
}

export function onReaction(run: Run, id: string) {
  if (has(run, 'baton')) st(run, 'baton')[id] = 1;
  if (has(run, 'ledger')) { const s = st(run, 'ledger'); if (!s.paid) { s.paid = 1; run.dropCoin(run.player.x, run.player.y - 10, 1); } }
}

export function onCrit(run: Run, e: Enemy, src: Src, dmg: number) {
  ritualEvent(run, { t: 'crit' });
  if (has(run, 'glove')) { const g = st(run, 'glove'); if (run.time >= (g[src.sp.uid] ?? 0)) { g[src.sp.uid] = run.time + 1; src.sp.cd = Math.max(0, src.sp.cd - 0.4); } }
  if (has(run, 'compass') && !run.inRelic) { run.inRelic = true; arc(run, e, dmg * 0.5, 'lightning', src, 2, 170, [e]); run.inRelic = false; }
}

export function onKill(run: Run, e: Enemy, crit: boolean) {
  if (!run.equipped.length) return;
  if (has(run, 'thimble')) { const s = st(run, 'thimble'); s.n = (s.n ?? 0) + 1; if (s.n >= 25) { s.n = 0; run.heal(1); } }
  if (has(run, 'penny') && (e.wet > 0 || e.burn > 0 || e.poison > 0 || e.freeze > 0)) run.dropCoin(e.x, e.y, 1);
  if (has(run, 'resin') && e.poison > 0) run.dropCoin(e.x, e.y, 1);
  if (has(run, 'fang') && crit) { const s = st(run, 'fang'); if ((s.n ?? 0) < 3) { s.n = (s.n ?? 0) + 1; run.heal(1); } }
}

export function onCast(run: Run, sp: ActiveSpell) {
  if (!run.equipped.length || run.inRelic) return;
  const i = run.spells.indexOf(sp);
  if (has(run, 'sock')) {
    const s = st(run, 'sock'); s.n = (s.n ?? 0) + 1;
    if (s.n >= 8 && sp.c.root) { s.n = 0; run.inRelic = true; castForm(run, sp, sp.c.root, run.player.x, run.player.y, Math.random() * 6.28, true); run.inRelic = false; }
  }
  if (has(run, 'mirror') && i === 0) {
    const o = run.spells[1];
    if (o && o.c.valid && o.c.root) { run.inRelic = true; castForm(run, o, o.c.root, run.player.x, run.player.y, Math.random() * 6.28, true, 0.5); run.inRelic = false; }
  }
  if (has(run, 'metronome') && run.spells.length > 1) { const n = run.spells[(i + 1) % run.spells.length]; n.cd = Math.max(0, n.cd - 0.5); }
}

export function onRoundStart(run: Run) {
  run.relicState.baton = {}; run.relicState.ledger = {}; run.relicState.fang = {};
  if (has(run, 'archive')) for (const sp of run.spells) sp.ultCd = 0;
}

/** Returns true if the relic prevented death. */
export function onLethal(run: Run): boolean {
  if (!has(run, 'phoenix') || st(run, 'phoenix').used) return false;
  st(run, 'phoenix').used = 1;
  const p = run.player;
  p.hp = p.maxHp * 0.4; p.inv = 2;
  run.fx.ring(p.x, p.y, 0xffa030, 10, 420, 0.7);
  run.fx.burst(p.x, p.y, 0xffd25a, 40, 400, 0.9, 2);
  run.fx.shake(10);
  run.announce('PHOENIX FEATHER', '#ffb347', 'You rise again. The feather is spent.');
  for (const e of run.query(p.x, p.y, 380)) {
    const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1;
    dealDamage(run, e, 40 + run.round * 12, 'fire', null, { react: true, noTrig: true });
    if (!e.dead && e.type !== 'boss') { e.vx += (dx / d) * 700; e.vy += (dy / d) * 700; }
  }
  return true;
}

/* ------------------------------ acquisition ------------------------------ */

export function relicPrice(r: RelicDef): number {
  const base: Record<Rarity, number> = { common: 6, uncommon: 11, rare: 18, epic: 28, legendary: 42 };
  return Math.round(base[r.rarity] * (r.cursed ? 0.75 : 1));
}

const BOSS_W: Record<number, Record<Rarity, number>> = {
  5: { common: 30, uncommon: 45, rare: 22, epic: 3, legendary: 0 },
  10: { common: 5, uncommon: 35, rare: 40, epic: 20, legendary: 0 },
  15: { common: 0, uncommon: 20, rare: 40, epic: 33, legendary: 7 },
  20: { common: 0, uncommon: 0, rare: 35, epic: 45, legendary: 20 },
};
const SHOP_W: Record<Rarity, number> = { common: 45, uncommon: 35, rare: 15, epic: 4, legendary: 1 };

export function rollRelics(run: Run, n: number, mode: 'boss' | 'shop'): RelicDef[] {
  const w = mode === 'boss' ? BOSS_W[Math.min(20, Math.max(5, Math.round(run.round / 5) * 5))] ?? BOSS_W[5] : SHOP_W;
  const out: RelicDef[] = [];
  for (let g = 0; g < 60 && out.length < n; g++) {
    const pool = RELICS.filter((r) => !run.owned.includes(r.id) && !out.includes(r) && (w[r.rarity] ?? 0) > 0);
    if (!pool.length) break;
    const wantCursed = Math.random() < 0.18;
    const cands = pool.filter((r) => !!r.cursed === wantCursed);
    const list = cands.length ? cands : pool;
    let tot = 0; for (const r of list) tot += w[r.rarity];
    let x = Math.random() * tot;
    let pick = list[0];
    for (const r of list) { x -= w[r.rarity]; if (x <= 0) { pick = r; break; } }
    out.push(pick);
  }
  return out;
}

void ELEMENTS;
