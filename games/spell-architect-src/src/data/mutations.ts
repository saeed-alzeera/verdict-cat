import type { Element } from './runes';

/** Aggregated per-spell mutation modifiers read by the combat systems. */
export interface Mut {
  dmg: number; cd: number; size: number; area: number; dup: number;
  splash: number; chain: number; crit: number; pullR: number; freezeT: number;
  spread: number; polStacks: number; collapse: number; tide: number; conduct: number; react: number;
  pyre: boolean; shatter: boolean; bloom: boolean; overcharge: boolean;
}

export function defaultMut(): Mut {
  return {
    dmg: 1, cd: 1, size: 1, area: 1, dup: 0, splash: 1, chain: 0, crit: 0, pullR: 1, freezeT: 1,
    spread: 1, polStacks: 0, collapse: 1, tide: 1, conduct: 1, react: 1,
    pyre: false, shatter: false, bloom: false, overcharge: false,
  };
}

export type StatKey = 'kills' | 'burnKills' | 'chainJumps' | 'captured' | 'freezes' | 'spreads' | 'wetHits' | 'reactions';

export interface MutOption { id: string; name: string; icon: string; desc: string; apply: (m: Mut) => void }
export interface MutTrack {
  id: string; element?: Element; stat: StatKey; threshold: number; title: string; why: string;
  options: [MutOption, MutOption];
}

export const MUT_TRACKS: MutTrack[] = [
  {
    id: 'fire', element: 'fire', stat: 'burnKills', threshold: 25, title: 'Pyromaniac', why: 'defeated burning enemies',
    options: [
      { id: 'inferno', name: 'Inferno Blast', icon: '💥', desc: 'Fire explosions are 60% larger and hit 20% harder.', apply: (m) => { m.splash *= 1.6; m.dmg *= 1.2; } },
      { id: 'pyre', name: 'Pyre Heart', icon: '🔥', desc: 'Burning enemies killed by this spell erupt in a fiery blast that spreads burn.', apply: (m) => { m.pyre = true; } },
    ],
  },
  {
    id: 'lightning', element: 'lightning', stat: 'chainJumps', threshold: 60, title: 'Stormcaller', why: 'chained between enemies',
    options: [
      { id: 'fork', name: 'Forked Lightning', icon: '🌩️', desc: 'Chains and arcs gain +2 additional jumps.', apply: (m) => { m.chain += 2; } },
      { id: 'overcharge', name: 'Overcharge', icon: '⚡', desc: '+20% crit chance; critical hits release extra arcs.', apply: (m) => { m.crit += 0.2; m.overcharge = true; } },
    ],
  },
  {
    id: 'gravity', element: 'gravity', stat: 'captured', threshold: 400, title: 'Collapsing Star', why: 'dragged enemies into your wells',
    options: [
      { id: 'horizon', name: 'Event Horizon', icon: '🌌', desc: 'Pull radius and strength increased by 50%.', apply: (m) => { m.pullR *= 1.5; } },
      { id: 'singularity', name: 'Singularity', icon: '🕳️', desc: 'Gravity collapse deals triple damage.', apply: (m) => { m.collapse *= 3; } },
    ],
  },
  {
    id: 'ice', element: 'ice', stat: 'freezes', threshold: 15, title: 'Deep Winter', why: 'froze enemies solid',
    options: [
      { id: 'permafrost', name: 'Permafrost', icon: '🧊', desc: 'Freeze lasts 80% longer.', apply: (m) => { m.freezeT *= 1.8; } },
      { id: 'shatterglass', name: 'Shatterglass', icon: '💎', desc: 'Frozen enemies killed by this spell shatter into damaging shards.', apply: (m) => { m.shatter = true; } },
    ],
  },
  {
    id: 'poison', element: 'poison', stat: 'spreads', threshold: 20, title: 'Contagion', why: 'spread infection',
    options: [
      { id: 'plague', name: 'Plague Bearer', icon: '🦠', desc: 'Infection spreads twice as far and poison stacks 3 higher.', apply: (m) => { m.spread *= 2; m.polStacks += 3; } },
      { id: 'bloom', name: 'Toxic Bloom', icon: '🍄', desc: 'Poisoned enemies leave a toxic cloud when they die.', apply: (m) => { m.bloom = true; } },
    ],
  },
  {
    id: 'water', element: 'water', stat: 'wetHits', threshold: 100, title: 'Rising Tide', why: 'soaked enemies',
    options: [
      { id: 'deluge', name: 'Deluge', icon: '🌊', desc: 'Puddles are 70% larger and last twice as long.', apply: (m) => { m.tide *= 1.7; } },
      { id: 'conductive', name: 'Conductive Tide', icon: '🔌', desc: 'Electrified puddles and conduction deal double damage.', apply: (m) => { m.conduct *= 2; } },
    ],
  },
  {
    id: 'react', stat: 'reactions', threshold: 12, title: 'Alchemist', why: 'triggered elemental reactions',
    options: [
      { id: 'catalyst', name: 'Catalyst', icon: '⚗️', desc: 'Elemental reactions deal 60% more damage.', apply: (m) => { m.react *= 1.6; } },
      { id: 'resonance', name: 'Resonance', icon: '🔔', desc: '+25% area and +15% damage on this spell.', apply: (m) => { m.area *= 1.25; m.dmg *= 1.15; } },
    ],
  },
  {
    id: 'veteran', stat: 'kills', threshold: 250, title: 'Veteran', why: 'defeated enemies',
    options: [
      { id: 'overdrive', name: 'Overdrive', icon: '🔺', desc: '+25% damage.', apply: (m) => { m.dmg *= 1.25; } },
      { id: 'quickened', name: 'Quickened', icon: '⏩', desc: '-20% cooldown.', apply: (m) => { m.cd *= 0.8; } },
    ],
  },
  {
    id: 'master', stat: 'kills', threshold: 900, title: 'Master', why: 'defeated enemies',
    options: [
      { id: 'echo', name: 'Echo', icon: '🔁', desc: 'Casts one extra copy of the spell each time.', apply: (m) => { m.dup += 1; } },
      { id: 'colossus', name: 'Colossus', icon: '🗿', desc: '+30% size and +30% area.', apply: (m) => { m.size *= 1.3; m.area *= 1.3; } },
    ],
  },
];

export const MUT_OPTION_BY_ID: Record<string, MutOption> = {};
for (const t of MUT_TRACKS) for (const o of t.options) MUT_OPTION_BY_ID[`${t.id}:${o.id}`] = o;
