// Elemental reactions emerge from simple rules in game/combat.ts; this is display + rules data.
// `needs` = elements that must be present in your loadout (in any slot), `dmg` = damage types dealt.
// Reactions split their damage between both types, so enemies resisting one element still take the other.
import type { Element } from './runes';

export interface ReactionDef {
  id: string; name: string; icon: string; color: string; desc: string; recipe: string;
  needs: Element[]; dmg: Element[]; how: string;
}

export const REACTIONS: ReactionDef[] = [
  { id: 'electrify', name: 'Electrified Puddle', icon: '⚡', color: '#fff35e', recipe: 'Lightning hits a Water puddle',
    needs: ['lightning', 'water'], dmg: ['lightning', 'water'], how: 'The puddle (and nearby puddles) shocks everything inside every 0.4s for about 4s.',
    desc: 'Lightning striking a puddle electrifies it and nearby puddles for several seconds, shocking everything inside.' },
  { id: 'conduct', name: 'Conduction', icon: '🔌', color: '#fff35e', recipe: 'Lightning hits a Wet enemy',
    needs: ['lightning', 'water'], dmg: ['lightning', 'water'], how: '+50% lightning damage on the hit, and arcs to 2 other wet enemies.',
    desc: 'Wet enemies take +50% lightning damage and conduct arcs to other wet enemies nearby.' },
  { id: 'gasblast', name: 'Gas Explosion', icon: '💥', color: '#ff7a1a', recipe: 'Fire touches a Poison cloud',
    needs: ['fire', 'poison'], dmg: ['fire', 'poison'], how: 'The cloud detonates; enemies in the blast take fire + poison damage and are set alight. Chains to nearby clouds.',
    desc: 'Fire ignites poison clouds into a violent blast that also ignites neighbouring clouds.' },
  { id: 'flashfreeze', name: 'Flash Freeze', icon: '🧊', color: '#66ddff', recipe: 'Ice hits a Wet enemy',
    needs: ['ice', 'water'], dmg: ['ice', 'water'], how: 'The enemy freezes instantly and takes a burst of ice + water damage. Frozen enemies take +25% damage.',
    desc: 'Wet enemies hit by ice freeze instantly. Frozen enemies take +25% damage.' },
  { id: 'steam', name: 'Steam Burst', icon: '♨️', color: '#d8e6ff', recipe: 'Fire hits a Wet enemy',
    needs: ['fire', 'water'], dmg: ['fire', 'water'], how: 'The water flash-boils: fire + water damage around the enemy, and the fire is doused.',
    desc: 'Fire flash-boils the water on a wet enemy into a scalding steam burst and douses the flames.' },
  { id: 'icesheet', name: 'Ice Sheet', icon: '❄️', color: '#9fe8ff', recipe: 'Ice touches a Water puddle',
    needs: ['ice', 'water'], dmg: ['ice', 'water'], how: 'The puddle freezes into a sheet that slows enemies by 50% for 6s and cannot be electrified.',
    desc: 'Ice freezes a puddle into a long-lasting sheet that heavily slows enemies and cannot be electrified.' },
  { id: 'evaporate', name: 'Evaporation', icon: '🌫️', color: '#bcd0ff', recipe: 'Fire touches a Water puddle',
    needs: ['fire', 'water'], dmg: ['fire', 'water'], how: 'The puddle boils away (halving its life) and scalds enemies standing in it with fire + water damage.',
    desc: 'Fire boils puddles away in a burst of steam, scalding enemies standing in them.' },
  { id: 'toxicarc', name: 'Toxic Arc', icon: '🧪', color: '#7dff4a', recipe: 'Lightning arc from a Poisoned enemy',
    needs: ['lightning', 'poison'], dmg: ['lightning', 'poison'], how: 'Arcs carry the poison stacks to every target they touch.',
    desc: 'Chains and arcs carry poison from infected enemies to every target they touch.' },
  { id: 'wildfire', name: 'Wildfire', icon: '🔥', color: '#ff7a1a', recipe: 'Burning enemy near others',
    needs: ['fire'], dmg: ['fire'], how: 'Burning enemies ignite neighbours and burst into flames when they die.',
    desc: 'Burning enemies ignite adjacent enemies, and burst in flames when they die.' },
  { id: 'plague', name: 'Plague', icon: '🦠', color: '#7dff4a', recipe: 'Poisoned enemy dies',
    needs: ['poison'], dmg: ['poison'], how: 'Infected enemies spread their poison to up to 5 nearby enemies when they die.',
    desc: 'Infected enemies spread their poison to nearby enemies when they die.' },
  { id: 'collapse', name: 'Gravity Collapse', icon: '🕳️', color: '#b36bff', recipe: 'Gravity well ends',
    needs: ['gravity'], dmg: ['gravity'], how: 'A gravity field implodes when it ends: bonus damage for every enemy it gathered.',
    desc: 'A gravity well implodes when it ends, dealing bonus damage for every enemy it gathered.' },
  { id: 'shatter', name: 'Shatter', icon: '💎', color: '#66ddff', recipe: 'Frozen enemy killed (Shatterglass / Glacier)',
    needs: ['ice'], dmg: ['ice'], how: 'Frozen enemies killed with the Shatterglass mutation or a Glacier core burst into ice shards.',
    desc: 'Frozen enemies killed with the Shatterglass mutation burst into piercing ice shards.' },
];
export const REACTION_BY_ID: Record<string, ReactionDef> = Object.fromEntries(REACTIONS.map((r) => [r.id, r]));
