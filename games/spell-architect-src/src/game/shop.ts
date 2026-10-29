// Between-round shop: ONE shelf of cards mixing runes, a relic and permanent upgrades (capacity, spell slots, vitality, power...).
// Nothing has a purchase cap; instead every repeat costs much more than the last, so gold can't be turned into a maxed-out stat.
// Rerolling replaces the whole shelf (bought cards included), so it never leaves you with fewer things to buy.
import { RUNES, RUNE_BY_ID, RARITY, dropWeight, type Rarity, type RuneDef } from '../data/runes';
import { store } from '../core/save';
import { formsInPlay, relevance } from './rewards';
import { RELIC_BY_ID, RELICS, relicPrice, rollRelics } from './relics';
import type { Run } from './run';
import { rollRituals, type RitualDef } from './rituals';

export interface Offer {
  id: string;
  /** rune id, or relic id when `relic` is set */
  rune: string;
  relic?: boolean;
  /** set for permanent upgrades (see UPGRADES): these never sell out, they just get dearer */
  upgrade?: string;
  price: number;
  sold: boolean;
}
export interface Shop { stock: Offer[]; rerolls: number; /** ritual offers (see rituals.ts) */ rituals: RitualDef[] }

export const RUNE_OFFERS = 3;
export const RELIC_OFFERS = 1;
export const UPGRADE_OFFERS = 2;
export const SHOP_SIZE = RUNE_OFFERS + RELIC_OFFERS + UPGRADE_OFFERS; // one row of six cards

const BASE: Record<string, number> = { core: 4, form: 5, behavior: 3, trigger: 3, modifier: 3 };
const RMUL: Record<Rarity, number> = { common: 1, uncommon: 1.5, rare: 2.2, epic: 3.4, legendary: 5 };
/** Selection weight per rarity. Cores have no rarity of their own; they roll like a common rune. */
const OFFER_W: Record<Rarity, number> = { common: 10, uncommon: 6, rare: 3, epic: 1.2, legendary: 0.4 };

/** How many copies of this rune the player holds anywhere (pool + equipped). */
export function owned(run: Run, id: string): number {
  let n = run.inv[id] ?? 0;
  for (const sp of run.spells) if (sp.def.root) { const walk = (nd: { rune: string; children: unknown[] }) => { if (nd.rune === id) n++; for (const c of nd.children as typeof nd[]) walk(c); }; walk(sp.def.root as never); }
  return n;
}

/** Live price of an offer (rune or relic) under the current relics and holdings. */
export function offerPrice(run: Run, o: Offer): number {
  if (o.upgrade) return upgradeOf(run, o.upgrade)?.price ?? o.price;
  if (o.relic) return Math.max(2, Math.round(relicPrice(RELIC_BY_ID[o.rune]) * run.mods.priceMul));
  return runePrice(run, RUNE_BY_ID[o.rune]);
}
/** Re-price everything still on the shelf. Called whenever relics change (so Bargain Bell works at once) or holdings change. */
export function refreshPrices(run: Run) {
  for (const o of run.shop.stock) if (!o.sold && (o.upgrade || (o.relic ? RELIC_BY_ID[o.rune] : RUNE_BY_ID[o.rune]))) o.price = offerPrice(run, o);
}

export function runePrice(run: Run, r: RuneDef): number {
  const base = (BASE[r.kind] ?? 3) * (r.kind === 'core' ? 1 : RMUL[r.rarity]);
  const grow = 1 + 0.05 * (run.round - 1);
  const infl = 1 + 0.35 * owned(run, r.id); // the more you hoard of one rune, the more it costs
  return Math.max(2, Math.round(base * grow * infl * run.mods.priceMul));
}
export const sellPrice = (run: Run, r: RuneDef) => Math.max(1, Math.floor((BASE[r.kind] ?? 3) * (r.kind === 'core' ? 1 : RMUL[r.rarity]) * 0.5));

export const rerollCost = (run: Run) => Math.max(1, Math.round((1 + run.shop.rerolls) * run.mods.rerollMul) - run.mods.rerollMinus);

/** Hard per-rune ownership caps (how many you may hold) so a stack of one rune can't carry a run. */
export const OWN_CAP = (r: RuneDef) => (r.kind === 'core' ? 8 : r.kind === 'form' ? 4 : 5);

export function generateStock(run: Run): Offer[] {
  const pool = RUNES.filter((r) => store.isUnlocked(r.id) && !r.evolved && owned(run, r.id) < OWN_CAP(r));
  const forms = formsInPlay(run);
  const out: Offer[] = [];
  const taken = new Set<string>();
  const weight = (r: RuneDef) => {
    const rar: Rarity = r.kind === 'core' ? 'common' : r.rarity;
    const rel = r.kind === 'core' || r.kind === 'form' ? 1 : Math.max(0.35, relevance(run, r, forms));
    return OFFER_W[rar] * rel * (r.kind === 'trigger' ? 0.35 : 1) * dropWeight(r); // higher trigger levels are mostly forged, not found
  };
  for (let i = 0; i < RUNE_OFFERS; i++) {
    const c = pool.filter((r) => !taken.has(r.id));
    let tot = 0; for (const r of c) tot += weight(r);
    let x = Math.random() * tot;
    for (const r of c) { x -= weight(r); if (x <= 0) { taken.add(r.id); out.push({ id: `o${out.length}-${r.id}`, rune: r.id, price: runePrice(run, r), sold: false }); break; } }
  }
  const rl = rollRelics(run, RELIC_OFFERS, 'shop');
  for (const r of rl) out.push({ id: `r${out.length}-${r.id}`, rune: r.id, relic: true, price: Math.max(2, Math.round(relicPrice(r) * run.mods.priceMul)), sold: false });
  for (const id of pickUpgrades(run)) out.push({ id: `u${out.length}-${id}`, rune: '', upgrade: id, price: upgradeOf(run, id)!.price, sold: false });
  return out;
}

export function reroll(run: Run): boolean {
  const c = rerollCost(run);
  if (run.coins < c) return false;
  run.coins -= c;
  run.shop.rerolls++;
  run.shop.rituals = rollRituals(run);
  run.shop.stock = generateStock(run); // a whole new shelf: nothing you bought can take a slot away
  refreshPrices(run);
  return true;
}

export function newShop(run: Run): Shop { return { stock: generateStock(run), rerolls: 0, rituals: rollRituals(run) }; }

export function buyOffer(run: Run, offer: Offer, spellIndex = -1): string | null {
  if (offer.upgrade) return buyUpgrade(run, offer, spellIndex);
  if (offer.sold) return 'Already sold.';
  if (run.coins < offer.price) return `Not enough coins (need ${offer.price}).`;
  if (offer.relic && !RELIC_BY_ID[offer.rune]) return 'Unknown relic.';
  run.coins -= offer.price;
  offer.sold = true;
  if (offer.relic) run.addRelic(offer.rune);
  else run.addRune(offer.rune, 1);
  refreshPrices(run);
  return null;
}

export function sellRune(run: Run, id: string): number {
  if ((run.inv[id] ?? 0) <= 0) return 0;
  const v = sellPrice(run, RUNE_BY_ID[id]);
  run.inv[id]--;
  run.coins += v;
  refreshPrices(run);
  return v;
}

/* ---- permanent upgrades: no caps, steeply rising prices ---- */
export interface Upgrade { id: string; title: string; desc: string; icon: string; rarity: Rarity; price: number; needsSpell?: boolean; avail: boolean; weight: number }
export const UPGRADE_IDS = ['cap', 'slot', 'power', 'haste', 'maxhp', 'crit', 'heal'];

export function upgrades(run: Run): Upgrade[] {
  const b = run.buys, p = run.player;
  const n = (id: string) => b[id] ?? 0;
  const P = (x: number) => Math.max(2, Math.round(x * run.mods.priceMul));
  const slotCost = [18, 34, 60][Math.max(0, run.slots - 3)] ?? 60;
  return [
    { id: 'cap', title: 'Capacity +2', desc: "Raise one spell's capacity by 2.", icon: '🔷', rarity: 'common', price: P(5 * Math.pow(1.4, n('cap'))), needsSpell: true, avail: run.spells.length > 0, weight: 5 },
    { id: 'slot', title: `Spell Slot ${run.slots + 1}`, desc: 'Unlock another spell slot.', icon: '📜', rarity: 'rare', price: P(slotCost), avail: run.slots < 5, weight: run.slots < 5 ? 2.5 : 0 },
    { id: 'power', title: 'Spell Power +4%', desc: 'All spells deal 4% more damage.', icon: '🔺', rarity: 'uncommon', price: P(12 * Math.pow(1.65, n('power'))), avail: true, weight: 3 },
    { id: 'haste', title: 'Haste -4% cooldown', desc: 'Every spell recharges 4% faster.', icon: '⏩', rarity: 'uncommon', price: P(12 * Math.pow(1.65, n('haste'))), avail: p.cdMul > 0.45, weight: 2.5 },
    { id: 'maxhp', title: 'Vitality +10 HP', desc: '+10 maximum health and heal 5.', icon: '❤️', rarity: 'common', price: P(6 * Math.pow(1.35, n('maxhp'))), avail: p.maxHp < 400, weight: 4 },
    { id: 'crit', title: 'Keen Edge +3% crit', desc: 'Critical hit chance +3%.', icon: '🎯', rarity: 'uncommon', price: P(10 * Math.pow(1.6, n('crit'))), avail: p.crit < 0.6, weight: 2.5 },
    { id: 'heal', title: 'Healing Draught', desc: 'Restore 20% of your maximum health.', icon: '💚', rarity: 'uncommon', price: P((8 + run.round * 0.8) * Math.pow(1.25, n('heal'))), avail: p.hp < p.maxHp * 0.95, weight: p.hp < p.maxHp * 0.6 ? 6 : 2 },
  ];
}
export const upgradeOf = (run: Run, id: string) => upgrades(run).find((u) => u.id === id);

/** The upgrades on this shelf: a weighted random pair of those that can still help (health when hurt, slots while you have room...). */
export function pickUpgrades(run: Run): string[] {
  const live = upgrades(run).filter((u) => u.avail && u.weight > 0);
  const out: string[] = [];
  for (let k = 0; k < UPGRADE_OFFERS && live.length; k++) {
    let tot = 0; for (const u of live) tot += u.weight;
    let x = Math.random() * tot, i = 0;
    for (; i < live.length - 1; i++) { x -= live[i].weight; if (x <= 0) break; }
    out.push(live[i].id); live.splice(i, 1);
  }
  return out;
}

export function buyUpgrade(run: Run, offer: Offer, spellIndex = -1): string | null {
  const id = offer.upgrade!;
  const o = upgradeOf(run, id);
  if (!o || !o.avail) return 'Not available.';
  if (run.coins < o.price) return `Not enough coins (need ${o.price}).`;
  if (o.needsSpell && !run.spells[spellIndex]) return 'Pick a spell.';
  run.coins -= o.price;
  run.buys[id] = (run.buys[id] ?? 0) + 1;
  const p = run.player;
  switch (id) {
    case 'cap': run.spells[spellIndex].def.capacity += 2; break;
    case 'slot': run.addSlot(); break;
    case 'power': p.dmgMul += 0.04; break;
    case 'haste': p.cdMul *= 0.96; break;
    case 'maxhp': p.maxHp += 10; run.heal(5); break;
    case 'crit': p.crit += 0.03; break;
    case 'heal': run.heal(p.maxHp * 0.2); break;
  }
  refreshPrices(run);
  return null;
}

void RARITY; void RELICS;
