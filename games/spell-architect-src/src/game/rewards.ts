// Level-up / cache reward generation with relevance weighting so runes are rarely dead picks.
import { RUNES, RUNE_BY_ID, RARITY, KIND_LABEL, runeColor, type FormId, type Rarity, type RuneDef } from '../data/runes';
import { store } from '../core/save';
import { walk } from '../core/spell';
import type { Run } from './run';
import { EVOLVE_COST } from '../data/runes';

export interface Reward {
  id: string;
  kind: 'rune' | 'stat';
  rune?: string;
  title: string;
  desc: string;
  icon: string;
  rarity: Rarity;
  tag: string;
  color: string;
  apply: (run: Run) => void;
}

interface StatDef {
  id: string; title: string; desc: (run: Run) => string; icon: string; rarity: Rarity; weight: (run: Run) => number;
  ok?: (run: Run) => boolean; apply: (run: Run) => void;
}

const hpFrac = (r: Run) => r.player.hp / r.player.maxHp;

const STATS: StatDef[] = [
  { id: 'heal', title: 'Mend Wounds', icon: '💚', rarity: 'common', desc: () => 'Restore 20% of your maximum health.', weight: (r) => 5 * (hpFrac(r) < 0.6 ? 2 : 0.4), apply: (r) => r.heal(r.player.maxHp * 0.2) },
  { id: 'healfull', title: 'Full Restoration', icon: '💖', rarity: 'uncommon', desc: () => 'Restore 50% of your maximum health.', weight: (r) => 2 * (hpFrac(r) < 0.4 ? 3 : 0.2), apply: (r) => r.heal(r.player.maxHp * 0.5) },
  { id: 'maxhp', title: 'Vitality', icon: '❤️', rarity: 'common', desc: () => '+10 maximum health and heal 5.', weight: () => 5, apply: (r) => { r.player.maxHp += 10; r.heal(5); } },
  { id: 'regen', title: 'Regeneration', icon: '🌿', rarity: 'common', desc: () => '+0.1 health regenerated per second.', weight: () => 2.5, apply: (r) => { r.player.regen += 0.1; } },
  { id: 'speed', title: 'Fleet Feet', icon: '👟', rarity: 'common', desc: () => '+6% movement speed.', weight: (r) => (r.player.speed < 480 ? 5 : 0), apply: (r) => { r.player.speed *= 1.06; } },
  { id: 'magnet', title: 'Arcane Magnet', icon: '🧲', rarity: 'common', desc: () => '+30% pickup radius.', weight: () => 4, apply: (r) => { r.player.pickup *= 1.3; } },
  { id: 'coins', title: 'Coin Purse', icon: '💰', rarity: 'common', desc: (r) => `Gain ${3 + Math.round(r.round / 2)} coins to spend in the shop.`, weight: () => 5, apply: (r) => r.addCoins(3 + Math.round(r.round / 2)) },
  { id: 'power', title: 'Spell Power', icon: '🔺', rarity: 'uncommon', desc: () => '+5% damage to all spells.', weight: () => 4, apply: (r) => { r.player.dmgMul += 0.05; } },
  { id: 'crit', title: 'Keen Eye', icon: '🎯', rarity: 'uncommon', desc: () => '+5% critical hit chance.', weight: () => 3.5, apply: (r) => { r.player.crit += 0.05; } },
  { id: 'critdmg', title: 'Brutal Strikes', icon: '🗡️', rarity: 'uncommon', desc: () => 'Critical hits deal +30% more damage.', weight: () => 3, apply: (r) => { r.player.critMul += 0.3; } },
  { id: 'haste', title: 'Quickened Mind', icon: '⏩', rarity: 'uncommon', desc: () => '-7% cooldown on every spell.', weight: () => 3.5, apply: (r) => { r.player.cdMul *= 0.93; } },
  { id: 'might', title: "Archmage's Might", icon: '🔮', rarity: 'epic', desc: () => '+8% damage, +6% crit chance and heal 8%.', weight: (r) => (r.player.level >= 8 ? 2 : 0), apply: (r) => { r.player.dmgMul += 0.08; r.player.crit += 0.06; r.heal(r.player.maxHp * 0.08); } },
  { id: 'ascend', title: 'Ascension', icon: '🌟', rarity: 'legendary', desc: () => '+12% damage, +20 max health, -8% cooldowns and heal 30%.', weight: (r) => (r.player.level >= 12 ? 0.8 : 0), apply: (r) => { r.player.dmgMul += 0.12; r.player.maxHp += 20; r.player.cdMul *= 0.92; r.heal(r.player.maxHp * 0.3); } },
];

export function formsInPlay(run: Run): Set<FormId> {
  const s = new Set<FormId>();
  for (const sp of run.spells) if (sp.def.root) walk(sp.def.root, (n) => { const r = RUNE_BY_ID[n.rune]; if (r.form) s.add(r.form); });
  for (const [id, n] of Object.entries(run.inv)) if (n > 0 && RUNE_BY_ID[id].form) s.add(RUNE_BY_ID[id].form!);
  return s;
}

function invCount(run: Run, kind: string): number {
  let c = 0;
  for (const [id, n] of Object.entries(run.inv)) if (RUNE_BY_ID[id].kind === kind) c += n;
  return c;
}

export function relevance(run: Run, r: RuneDef, forms: Set<FormId>): number {
  const emptySlots = run.spells.filter((s) => !s.def.root).length;
  const cores = invCount(run, 'core'), fms = invCount(run, 'form');
  const have = run.inv[r.id] ?? 0;
  let w = 1;
  switch (r.kind) {
    case 'core': {
      // a Core is only useful if a Form is waiting for an element
      let bare = 0;
      for (const sp of run.spells) if (sp.def.root) walk(sp.def.root, (n) => {
        if (RUNE_BY_ID[n.rune].kind === 'form' && !n.children.some((c) => RUNE_BY_ID[c.rune].kind === 'core')) bare++;
      });
      bare += fms;
      const copies = r.element ? run.coreCopies(r.element) : 0;
      if (copies >= 1 && copies < EVOLVE_COST) w *= 2.2; // progress toward an Evolution
      else if (bare > cores) w *= 1.8; else w *= 0.35;
      break;
    }
    case 'form':
      if (emptySlots > fms) w *= 2.2;
      if (fms >= 2) w *= 0.4;
      if (have > 0) w *= 0.6;
      break;
    default: {
      const compat = [...forms].some((f) => !r.forms || r.forms.includes(f));
      w *= compat ? 1.3 : 0.1;
      if (have >= 2) w *= 0.4;
      if (r.kind === 'trigger' && cores + fms > 0) w *= 1.4;
    }
  }
  return w;
}

function runeReward(run: Run, r: RuneDef): Reward {
  const copies = r.rarity === 'common' && (r.kind === 'modifier' || r.kind === 'behavior') ? 2 : 1;
  return {
    id: `rune:${r.id}`, kind: 'rune', rune: r.id,
    title: r.name, icon: r.icon, rarity: r.rarity, color: runeColor(r),
    desc: `${KIND_LABEL[r.kind]} rune · costs ${r.cost} capacity. ${r.desc}`,
    tag: r.kind === 'core' && r.element ? `${Math.min(EVOLVE_COST, run.coreCopies(r.element) + copies)}/${EVOLVE_COST} toward Evolution` : `+${copies} to your rune pool`,
    apply: (rn) => rn.addRune(r.id, copies),
  };
}

export function wpick<T>(items: { v: T; w: number }[]): number {
  let tot = 0;
  for (const i of items) tot += i.w;
  if (tot <= 0) return -1;
  let r = Math.random() * tot;
  for (let k = 0; k < items.length; k++) { r -= items[k].w; if (r <= 0) return k; }
  return items.length - 1;
}

/** Level-ups give stat boosts only. Boss caches give a choice of strong runes. */
export function generateRewards(run: Run, mode: 'levelup' | 'cache', count = 3): Reward[] {
  const out: Reward[] = [];
  if (mode === 'levelup') {
    const used = new Set<string>();
    for (let g = 0; g < 30 && out.length < count; g++) {
      const cand = STATS.filter((d) => !used.has(d.id)).map((d) => ({ v: d, w: d.weight(run) * RARITY[d.rarity].weight / 14 * (d.rarity === 'common' ? 1.4 : 1) }));
      const k = wpick(cand);
      if (k < 0 || cand[k].w <= 0) break;
      const d = cand[k].v;
      used.add(d.id);
      out.push({ id: `stat:${d.id}`, kind: 'stat', title: d.title, desc: d.desc(run), icon: d.icon, rarity: d.rarity, color: RARITY[d.rarity].color, tag: 'Stat boost', apply: d.apply });
    }
    return out;
  }
  const forms = formsInPlay(run);
  // with a small unlocked set there may be few non-common runes: top the pool up with commons rather than hand out nothing
  const unlocked = RUNES.filter((r) => store.isUnlocked(r.id) && !r.evolved);
  const rare = unlocked.filter((r) => r.rarity !== 'common');
  const pool = (rare.length >= count ? rare : unlocked)
    .map((r) => ({ v: r, w: RARITY[r.rarity].weight * relevance(run, r, forms) }));
  for (let g = 0; g < 30 && out.length < count; g++) {
    const cand = pool.filter((x) => !out.some((o) => o.rune === x.v.id));
    const k = wpick(cand);
    if (k < 0) break;
    out.push(runeReward(run, cand[k].v));
  }
  return out;
}
