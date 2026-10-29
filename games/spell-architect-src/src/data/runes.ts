// Data-driven rune definitions. Add a rune here and (for new behaviours) one line in
// game/spells.ts and it becomes available in the editor, rewards and journal.

export type RuneKind = 'core' | 'form' | 'behavior' | 'trigger' | 'modifier';
export type Element = 'fire' | 'ice' | 'lightning' | 'poison' | 'water' | 'gravity' | 'arcane';
export type FormId = 'projectile' | 'beam' | 'orb' | 'aura' | 'mine' | 'nova' | 'meteor';
export type TriggerType = 'hit' | 'kill' | 'expiry' | 'crit';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export const FORM_IDS: FormId[] = ['projectile', 'beam', 'orb', 'aura', 'mine', 'nova', 'meteor'];
export const ELEMENT_IDS: Element[] = ['fire', 'ice', 'lightning', 'poison', 'water', 'gravity'];

export interface RuneDef {
  id: string;
  kind: RuneKind;
  name: string;
  icon: string;
  rarity: Rarity;
  cost: number; // spell capacity
  desc: string; // tooltip
  element?: Element; // core
  form?: FormId; // form
  trigger?: TriggerType; // trigger
  chance?: number; // trigger: chance (0..1) that it fires each time its condition happens
  key?: string; // behavior / modifier key used by the compiler
  evolved?: boolean; // forged core (4 copies of a core combined)
  tierOf?: string; // higher tier of a trigger: unlocked together with its base trigger
  merged?: boolean; // trigger made by merging two triggers (never sold, rewarded or unlocked)
  forms?: FormId[]; // compatible forms (omitted = all)
  maxStack?: number; // how many may sit on one form
  unlock: number; // arcane shards to unlock permanently (0 = from start)
}

export const RARITY: Record<Rarity, { name: string; color: string; weight: number }> = {
  common: { name: 'Common', color: '#b9c2d6', weight: 50 },
  uncommon: { name: 'Uncommon', color: '#5fdc7e', weight: 28 },
  rare: { name: 'Rare', color: '#4aa8ff', weight: 14 },
  epic: { name: 'Epic', color: '#c26bff', weight: 6 },
  legendary: { name: 'Legendary', color: '#ffb347', weight: 2 },
};

export const ELEMENTS: Record<Element, {
  name: string; color: number; css: string; icon: string; dmg: number; cd: number; adj: string;
  noun: Record<FormId, string>; blurb: string;
}> = {
  fire: {
    name: 'Fire', color: 0xff7a1a, css: '#ff7a1a', icon: '🔥', dmg: 1.3, cd: 1.0, adj: 'Blazing',
    blurb: 'Burns enemies for damage over time. Projectiles explode on impact.',
    noun: { projectile: 'Fireball', beam: 'Flame Lance', orb: 'Ember Orbs', aura: 'Flame Ring', mine: 'Fire Mine', nova: 'Fire Nova', meteor: 'Meteor' },
  },
  ice: {
    name: 'Ice', color: 0x66ddff, css: '#66ddff', icon: '❄️', dmg: 1.25, cd: 1.0, adj: 'Frigid',
    blurb: 'Chills and slows. Three chills freeze; wet enemies freeze at once.',
    noun: { projectile: 'Ice Shard', beam: 'Frost Ray', orb: 'Hail Orbs', aura: 'Frost Nova', mine: 'Frost Mine', nova: 'Frost Nova', meteor: 'Ice Comet' },
  },
  lightning: {
    name: 'Lightning', color: 0xfff35e, css: '#fff35e', icon: '⚡', dmg: 1.15, cd: 0.85, adj: 'Crackling',
    blurb: 'Fast, crit-prone, arcs to nearby enemies. Devastating on wet foes.',
    noun: { projectile: 'Spark Bolt', beam: 'Thunder Ray', orb: 'Plasma Orbs', aura: 'Static Field', mine: 'Tesla Mine', nova: 'Shock Nova', meteor: 'Thunderstrike' },
  },
  poison: {
    name: 'Poison', color: 0x7dff4a, css: '#7dff4a', icon: '☠️', dmg: 0.85, cd: 1.0, adj: 'Venomous',
    blurb: 'Stacking poison that ignores armor and spreads on death. Leaves flammable clouds.',
    noun: { projectile: 'Venom Dart', beam: 'Acid Jet', orb: 'Spore Orbs', aura: 'Toxic Cloud', mine: 'Spore Mine', nova: 'Plague Nova', meteor: 'Toxic Rain' },
  },
  water: {
    name: 'Water', color: 0x3d8bff, css: '#3d8bff', icon: '💧', dmg: 0.8, cd: 0.9, adj: 'Tidal',
    blurb: 'Soaks enemies and leaves puddles that slow and conduct electricity.',
    noun: { projectile: 'Water Bolt', beam: 'Tide Jet', orb: 'Bubble Orbs', aura: 'Tidal Ring', mine: 'Depth Charge', nova: 'Tidal Wave', meteor: 'Downpour' },
  },
  gravity: {
    name: 'Gravity', color: 0xb36bff, css: '#b36bff', icon: '🌀', dmg: 1.0, cd: 1.25, adj: 'Crushing',
    blurb: 'Pulls enemies together; wells collapse for extra damage when they end.',
    noun: { projectile: 'Void Orb', beam: 'Tether Beam', orb: 'Moon Orbs', aura: 'Gravity Field', mine: 'Singularity Mine', nova: 'Crush Nova', meteor: 'Star Drop' },
  },
  arcane: {
    name: 'Arcane', color: 0xc9a6ff, css: '#c9a6ff', icon: '✦', dmg: 1.0, cd: 1.0, adj: 'Arcane',
    blurb: 'Raw magic with no status effect. Socket a Core rune to give a Form an element.',
    noun: { projectile: 'Arcane Bolt', beam: 'Arcane Ray', orb: 'Arcane Orbs', aura: 'Arcane Ward', mine: 'Rune Mine', nova: 'Arcane Nova', meteor: 'Star Fall' },
  },
};

export const FORMS: Record<FormId, { name: string; icon: string; dmg: number; cd: number; blurb: string }> = {
  projectile: { name: 'Projectile', icon: '☄️', dmg: 14, cd: 0.9, blurb: 'Launches at the nearest enemy.' },
  beam: { name: 'Beam', icon: '🔆', dmg: 7, cd: 2.0, blurb: 'A sweeping beam that hits everything in a line.' },
  orb: { name: 'Orbiting Orb', icon: '🔮', dmg: 9, cd: 2.2, blurb: 'Orbs circle you, striking anything they touch.' },
  aura: { name: 'Aura', icon: '⭕', dmg: 8, cd: 1.2, blurb: 'A field around you that ticks damage.' },
  mine: { name: 'Mine', icon: '💣', dmg: 40, cd: 1.6, blurb: 'Dropped traps detonate when enemies approach.' },
  nova: { name: 'Nova', icon: '💫', dmg: 16, cd: 2.2, blurb: 'A shockwave ring bursts outward and hits everything it passes.' },
  meteor: { name: 'Meteor', icon: '☄', dmg: 45, cd: 2.6, blurb: 'Calls down a strike on the densest enemy cluster after a short warning.' },
};

const P: FormId[] = ['projectile'];

export const RUNES: RuneDef[] = [
  // ---------- CORES ----------
  { id: 'c_fire', kind: 'core', name: 'Fire', icon: '🔥', rarity: 'common', cost: 2, element: 'fire', unlock: 0,
    desc: 'Socket into a Form. Burning and explosive damage. Burning enemies take damage over time, spread fire to neighbours and ignite poison clouds.' },
  { id: 'c_ice', kind: 'core', name: 'Ice', icon: '❄️', rarity: 'common', cost: 2, element: 'ice', unlock: 15,
    desc: 'Chills enemies. Three chills freeze them solid; frozen enemies take bonus damage. Wet enemies freeze instantly.' },
  { id: 'c_lightning', kind: 'core', name: 'Lightning', icon: '⚡', rarity: 'uncommon', cost: 2, element: 'lightning', unlock: 25,
    desc: 'Fast casts, extra crit chance and random arcs. Electrifies puddles and deals +50% to wet enemies.' },
  { id: 'c_poison', kind: 'core', name: 'Poison', icon: '☠️', rarity: 'uncommon', cost: 2, element: 'poison', unlock: 25,
    desc: 'Stacking poison that ignores armor and spreads to neighbours on death. Leaves clouds that fire can detonate.' },
  { id: 'c_water', kind: 'core', name: 'Water', icon: '💧', rarity: 'common', cost: 1, element: 'water', unlock: 15,
    desc: 'Makes enemies Wet and leaves puddles. Wet enemies freeze faster and conduct lightning.' },
  { id: 'c_gravity', kind: 'core', name: 'Gravity', icon: '🌀', rarity: 'rare', cost: 3, element: 'gravity', unlock: 35,
    desc: 'Pulls enemies into tight groups. Gravity wells collapse for bonus damage when they expire.' },

  // ---------- EVOLVED CORES (forged from 4 copies of a core in the editor's Forge tab) ----------
  { id: 'e_fire', kind: 'core', name: 'Inferno', icon: '🌋', rarity: 'epic', cost: 3, element: 'fire', evolved: true, unlock: 0,
    desc: 'EVOLVED Fire. +40% damage, bigger explosions, and burning enemies erupt when they die. Unlocks the ULTIMATE: Meteor Storm.' },
  { id: 'e_ice', kind: 'core', name: 'Glacier', icon: '🧊', rarity: 'epic', cost: 3, element: 'ice', evolved: true, unlock: 0,
    desc: 'EVOLVED Ice. +40% damage, longer freezes, and frozen enemies shatter. Unlocks the ULTIMATE: Absolute Zero.' },
  { id: 'e_lightning', kind: 'core', name: 'Tempest', icon: '🌩️', rarity: 'epic', cost: 3, element: 'lightning', evolved: true, unlock: 0,
    desc: 'EVOLVED Lightning. +40% damage, +2 chain jumps, more crits that release extra arcs. Unlocks the ULTIMATE: Thunderstorm.' },
  { id: 'e_poison', kind: 'core', name: 'Pestilence', icon: '🦠', rarity: 'epic', cost: 3, element: 'poison', evolved: true, unlock: 0,
    desc: 'EVOLVED Poison. +40% damage, deeper stacks, wider infection, and toxic blooms. Unlocks the ULTIMATE: Plague Wave.' },
  { id: 'e_water', kind: 'core', name: 'Tsunami', icon: '🌊', rarity: 'epic', cost: 3, element: 'water', evolved: true, unlock: 0,
    desc: 'EVOLVED Water. +40% damage, huge long-lasting puddles, and stronger conduction. Unlocks the ULTIMATE: Tidal Surge.' },
  { id: 'e_gravity', kind: 'core', name: 'Singularity', icon: '🕳️', rarity: 'epic', cost: 3, element: 'gravity', evolved: true, unlock: 0,
    desc: 'EVOLVED Gravity. +40% damage, stronger pull, and double collapse damage. Unlocks the ULTIMATE: Event Horizon.' },

  // ---------- FORMS ----------
  { id: 'f_projectile', kind: 'form', name: 'Projectile', icon: '☄️', rarity: 'common', cost: 1, form: 'projectile', unlock: 0,
    desc: 'Fires at the nearest enemy. The workhorse form; pairs with every behavior.' },
  { id: 'f_beam', kind: 'form', name: 'Beam', icon: '🔆', rarity: 'rare', cost: 2, form: 'beam', unlock: 35,
    desc: 'A short-lived beam that tracks enemies and damages everything along its length.' },
  { id: 'f_orb', kind: 'form', name: 'Orbiting Orb', icon: '🔮', rarity: 'uncommon', cost: 2, form: 'orb', unlock: 25,
    desc: 'Two orbs circle you. Great defence and a reliable trigger source.' },
  { id: 'f_aura', kind: 'form', name: 'Aura', icon: '⭕', rarity: 'common', cost: 2, form: 'aura', unlock: 15,
    desc: 'A field around you that damages everything inside every half-second.' },
  { id: 'f_mine', kind: 'form', name: 'Mine', icon: '💣', rarity: 'uncommon', cost: 1, form: 'mine', unlock: 25,
    desc: 'Drops a trap that detonates when enemies come close. Strong against chargers.' },
  { id: 'f_nova', kind: 'form', name: 'Nova', icon: '💫', rarity: 'common', cost: 2, form: 'nova', unlock: 0,
    desc: 'A shockwave ring bursts out from you, hitting everything it passes and shoving it back. Water and poison leave puddles and clouds behind.' },
  { id: 'f_meteor', kind: 'form', name: 'Meteor', icon: '☄', rarity: 'uncommon', cost: 2, form: 'meteor', unlock: 30,
    desc: 'Marks the densest enemy cluster, then drops a big explosion on it after a short warning. Water and poison leave puddles and clouds.' },

  // ---------- BEHAVIORS ----------
  { id: 'b_split', kind: 'behavior', name: 'Split', icon: '🔱', rarity: 'uncommon', cost: 2, key: 'split', forms: ['projectile', 'mine', 'meteor'], maxStack: 1, unlock: 25,
    desc: 'On first impact or expiry, splits into three smaller copies (55% damage) that keep your triggers. Mines and meteors burst into projectiles.' },
  { id: 'b_pierce', kind: 'behavior', name: 'Pierce', icon: '➶', rarity: 'common', cost: 1, key: 'pierce', forms: P, maxStack: 1, unlock: 0,
    desc: 'Projectile passes through up to 3 enemies.' },
  { id: 'b_bounce', kind: 'behavior', name: 'Bounce', icon: '↩️', rarity: 'uncommon', cost: 2, key: 'bounce', forms: P, maxStack: 1, unlock: 30,
    desc: 'Ricochets to a new enemy up to 3 times and rebounds off arena walls.' },
  { id: 'b_chain', kind: 'behavior', name: 'Chain', icon: '🔗', rarity: 'rare', cost: 2, key: 'chain', forms: ['projectile', 'beam', 'orb', 'mine', 'nova', 'meteor'], maxStack: 1, unlock: 50,
    desc: 'On hit, arcs to up to 3 nearby enemies for 70% damage. Passes poison along; conducts through wet enemies.' },
  { id: 'b_orbit', kind: 'behavior', name: 'Orbit', icon: '🪐', rarity: 'rare', cost: 2, key: 'orbit', forms: ['projectile'], maxStack: 1, unlock: 50,
    desc: 'The projectile circles you instead of flying away, hitting anything it sweeps through.' },
  { id: 'b_homing', kind: 'behavior', name: 'Homing', icon: '🎯', rarity: 'common', cost: 1, key: 'homing', forms: ['projectile', 'mine', 'meteor'], maxStack: 1, unlock: 15,
    desc: 'Steers toward the nearest enemy. Mines crawl toward their prey.' },
  { id: 'b_pull', kind: 'behavior', name: 'Pull', icon: '🧲', rarity: 'uncommon', cost: 2, key: 'pull', maxStack: 1, unlock: 40,
    desc: 'Drags nearby enemies toward the form. Gather them into puddles, clouds and flames.' },
  { id: 'b_expand', kind: 'behavior', name: 'Expand', icon: '🫧', rarity: 'common', cost: 1, key: 'expand', forms: ['projectile', 'orb', 'aura', 'mine', 'nova', 'meteor'], maxStack: 1, unlock: 30,
    desc: 'The form grows steadily over its lifetime, up to 80% larger.' },

  // ---------- TRIGGERS ----------
  { id: 't_hit', kind: 'trigger', name: 'On Hit', icon: '💥', rarity: 'common', cost: 1, trigger: 'hit', chance: 0.2, forms: ['projectile', 'beam', 'orb', 'mine', 'nova', 'meteor'], maxStack: 1, unlock: 0,
    desc: 'When the form hits an enemy, every effect below activates at the impact point.' },
  { id: 't_kill', kind: 'trigger', name: 'On Kill', icon: '💀', rarity: 'uncommon', cost: 1, trigger: 'kill', chance: 0.2, maxStack: 1, unlock: 20,
    desc: 'When this spell kills an enemy (including by burn or poison), connected branches activate where it died.' },
  { id: 't_expiry', kind: 'trigger', name: 'On Expiry', icon: '⏳', rarity: 'uncommon', cost: 1, trigger: 'expiry', chance: 1, forms: ['projectile', 'beam', 'orb', 'mine', 'nova', 'meteor'], maxStack: 1, unlock: 30,
    desc: 'When the form ends (timeout, spent or detonated), the effects below activate at its final position.' },
  { id: 't_crit', kind: 'trigger', name: 'On Critical Hit', icon: '✴️', rarity: 'rare', cost: 1, trigger: 'crit', chance: 0.2, maxStack: 1, unlock: 40,
    desc: 'When this spell lands a critical hit, connected branches activate. Lightning crits often.' },

  // ---------- MODIFIERS ----------
  { id: 'm_dup', kind: 'modifier', name: 'Duplicate', icon: '✨', rarity: 'rare', cost: 2, key: 'dup', forms: ['projectile', 'beam', 'orb', 'mine', 'nova', 'meteor'], maxStack: 2, unlock: 60,
    desc: 'Casts an additional copy each time (projectiles fan out, orbs add more, mines scatter, novas and meteors repeat).' },
  { id: 'm_acc', kind: 'modifier', name: 'Accelerate', icon: '💨', rarity: 'common', cost: 1, key: 'acc', maxStack: 3, unlock: 30,
    desc: '+40% speed: faster projectiles, orbs, beam sweeps and quicker damage ticks.' },
  { id: 'm_grow', kind: 'modifier', name: 'Grow', icon: '⬆️', rarity: 'common', cost: 1, key: 'grow', maxStack: 3, unlock: 0,
    desc: '+30% size and +15% damage.' },
  { id: 'm_duration', kind: 'modifier', name: 'Increase Duration', icon: '⌛', rarity: 'common', cost: 1, key: 'dur', forms: ['projectile', 'beam', 'orb', 'aura', 'mine'], maxStack: 3, unlock: 10,
    desc: '+50% lifetime. More time to tick, orbit, chain and wait for triggers.' },
  { id: 'm_area', kind: 'modifier', name: 'Increase Area', icon: '🔆', rarity: 'common', cost: 1, key: 'area', maxStack: 3, unlock: 30,
    desc: '+35% radius of zones, auras, explosions, splashes and orbits.' },
  { id: 'm_cooldown', kind: 'modifier', name: 'Reduce Cooldown', icon: '⏱️', rarity: 'uncommon', cost: 2, key: 'cd', maxStack: 3, unlock: 25,
    desc: '-20% cooldown on this spell (multiplicative).' },
];

/** Runes available from the very first run (everything else is bought with Arcane Shards in the Grimoire). */
export const STARTER_RUNES = ['c_fire', 'f_projectile', 'f_nova', 'b_pierce', 't_hit', 'm_grow'];

// Trigger rarity tiers: Hit / Kill / Crit triggers fire only a fraction of the time.
// common 20%, uncommon 45%, rare 60%, epic 80%. (On Expiry is a timing event and always fires.)
for (const baseId of ['t_hit', 't_kill', 't_crit']) {
  const b = RUNES.find((r) => r.id === baseId)!;
  b.rarity = 'common'; b.unlock = 0;
  const tiers: [string, Rarity, number, string][] = [['_2', 'uncommon', 0.45, 'II'], ['_3', 'rare', 0.6, 'III'], ['_4', 'epic', 0.8, 'IV']];
  const baseDesc = b.desc;
  b.desc = `${baseDesc} Fires 20% of the time.`;
  for (const [suf, rar, ch, num] of tiers) {
    RUNES.push({ ...b, id: baseId + suf, name: `${b.name} ${num}`, rarity: rar, chance: ch, cost: rar === 'epic' ? 2 : 1, unlock: 0, tierOf: baseId, desc: `${baseDesc} Fires ${Math.round(ch * 100)}% of the time.` });
  }
}

export const RUNE_BY_ID: Record<string, RuneDef> = Object.fromEntries(RUNES.map((r) => [r.id, r]));

/** Two same-type triggers merge into one whose chance is the sum, up to this cap. */
export const MAX_MERGE_CHANCE = 0.8;
export const MERGEABLE: TriggerType[] = ['hit', 'kill', 'crit'];
const MERGE_BASE: Record<string, string> = { hit: 't_hit', kill: 't_kill', crit: 't_crit' };
const rarityForChance = (c: number): Rarity => (c <= 0.2 ? 'common' : c <= 0.45 ? 'uncommon' : c <= 0.6 ? 'rare' : 'epic');

/** The rune you get by merging triggers `a` and `b` (created on first use), or the reason it can't be done. */
export function mergeResult(a: string, b: string): RuneDef | string {
  const ra = RUNE_BY_ID[a], rb = RUNE_BY_ID[b];
  if (!ra || !rb || ra.kind !== 'trigger' || rb.kind !== 'trigger') return 'Only triggers can be merged.';
  if (ra.trigger !== rb.trigger) return 'Both triggers must be the same type (two On Hit, two On Kill, or two On Critical Hit).';
  if (!MERGEABLE.includes(ra.trigger!)) return 'On Expiry always fires, so there is nothing to merge.';
  const pct = Math.round(((ra.chance ?? 1) + (rb.chance ?? 1)) * 100);
  if (pct > MAX_MERGE_CHANCE * 100) return `The merged chance would be ${pct}%. A single trigger can't pass ${Math.round(MAX_MERGE_CHANCE * 100)}%.`;
  const base = RUNE_BY_ID[MERGE_BASE[ra.trigger!]];
  const id = `${base.id}@${pct}`;
  if (!RUNE_BY_ID[id]) {
    const d: RuneDef = { ...base, id, name: `${base.name} ${pct}%`, rarity: rarityForChance(pct / 100), chance: pct / 100, cost: pct >= 75 ? 2 : 1, unlock: 99999, merged: true,
      desc: `${base.desc.replace(/ Fires \d+% of the time\./, '')} Fires ${pct}% of the time (made by merging two triggers).` };
    RUNES.push(d); RUNE_BY_ID[id] = d;
  }
  return RUNE_BY_ID[id];
}
export const KIND_LABEL: Record<RuneKind, string> = {
  core: 'Core', form: 'Form', behavior: 'Behavior', trigger: 'Trigger', modifier: 'Modifier',
};
export const KIND_COLOR: Record<RuneKind, string> = {
  core: '#ff9d3a', form: '#59c7ff', behavior: '#7cf08a', trigger: '#ff6b9c', modifier: '#c9a6ff',
};

export function runeColor(r: RuneDef): string {
  if (r.kind === 'core' && r.element) return ELEMENTS[r.element].css;
  return KIND_COLOR[r.kind];
}

export const EVOLVE_COST = 6;
export const EVOLVED_OF: Record<string, string> = { fire: 'e_fire', ice: 'e_ice', lightning: 'e_lightning', poison: 'e_poison', water: 'e_water', gravity: 'e_gravity' };
export const BASE_CORE_OF: Record<string, string> = { fire: 'c_fire', ice: 'c_ice', lightning: 'c_lightning', poison: 'c_poison', water: 'c_water', gravity: 'c_gravity' };
export const ULTIMATES: Record<string, { name: string; icon: string; desc: string }> = {
  fire: { name: 'Meteor Storm', icon: '🌋', desc: 'Calls down a barrage of 14 meteors across the arena around you.' },
  ice: { name: 'Absolute Zero', icon: '🧊', desc: 'Flash-freezes every enemy (bosses are slowed) and shatters them for bonus damage.' },
  lightning: { name: 'Thunderstorm', icon: '🌩️', desc: 'Five seconds of relentless lightning strikes on random enemies, with chains.' },
  poison: { name: 'Plague Wave', icon: '🦠', desc: 'A toxic wave infects everything with maximum poison and leaves clouds everywhere.' },
  water: { name: 'Tidal Surge', icon: '🌊', desc: 'A giant wave soaks and shoves every enemy, leaving puddles ready to be electrified.' },
  gravity: { name: 'Event Horizon', icon: '🕳️', desc: 'A huge black hole drags every enemy in, then collapses for massive damage.' },
};
