// Between-round shop. Constraint-led: a tiny randomized shelf (4 offers + 3 random permanent upgrades), per-run caps on
// upgrades, prices that climb with every copy you already own, and a rising reroll cost. You can't buy your way to a build.
import { RUNES, RUNE_BY_ID, RARITY, type Rarity, type RuneDef } from '../data/runes';
import { store } from '../core/save';
import { formsInPlay, relevance } from './rewards';
import { RELIC_BY_ID, RELICS, relicPrice, rollRelics } from './relics';
import type { Run } from './run';

export interface Offer {
  id: string;
  /** rune id, or relic id when `relic` is set */
  rune: string;
  relic?: boolean;
  price: number;
  sold: boolean;
}
export interface Shop { stock: Offer[]; rerolls: number; ups: string[] }

export const RUNE_OFFERS = 3;
export const RELIC_OFFERS = 1;
export const SHOP_SIZE = RUNE_OFFERS + RELIC_OFFERS; // at most 4 offers
export const UPGRADES_SHOWN = 3;

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
  if (o.relic) return Math.max(2, Math.round(relicPrice(RELIC_BY_ID[o.rune]) * run.mods.priceMul));
  return runePrice(run, RUNE_BY_ID[o.rune]);
}
/** Re-price everything still on the shelf. Called whenever relics change (so Bargain Bell works at once) or holdings change. */
export function refreshPrices(run: Run) {
  for (const o of run.shop.stock) if (!o.sold && (o.relic ? RELIC_BY_ID[o.rune] : RUNE_BY_ID[o.rune])) o.price = offerPrice(run, o);
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
    return OFFER_W[rar] * rel * (r.kind === 'trigger' ? 0.35 : 1); // trigger tiers are a family of 4: keep them from flooding the shelf
  };
  for (let i = 0; i < RUNE_OFFERS; i++) {
    const c = pool.filter((r) => !taken.has(r.id));
    let tot = 0; for (const r of c) tot += weight(r);
    let x = Math.random() * tot;
    for (const r of c) { x -= weight(r); if (x <= 0) { taken.add(r.id); out.push({ id: `o${out.length}-${r.id}`, rune: r.id, price: runePrice(run, r), sold: false }); break; } }
  }
  const rl = rollRelics(run, RELIC_OFFERS, 'shop');
  for (const r of rl) out.push({ id: `r${out.length}-${r.id}`, rune: r.id, relic: true, price: Math.max(2, Math.round(relicPrice(r) * run.mods.priceMul)), sold: false });
  return out;
}

export function reroll(run: Run): boolean {
  const c = rerollCost(run);
  if (run.coins < c) return false;
  run.coins -= c;
  run.shop.rerolls++;
  // keep bought items marked sold; only replace what is still on the shelf
  const kept = run.shop.stock.filter((o) => o.sold);
  const fresh = generateStock(run).filter((o) => !kept.some((k) => k.rune === o.rune));
  run.shop.stock = [...kept, ...fresh].slice(0, SHOP_SIZE);
  run.shop.ups = pickUpgrades(run);
  refreshPrices(run);
  return true;
}

export function newShop(run: Run): Shop { return { stock: generateStock(run), rerolls: 0, ups: pickUpgrades(run) }; }

export function buyOffer(run: Run, offer: Offer): string | null {
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

/* ---- always-available upgrades: capped per run, escalating prices; 3 random ones are shown each visit ---- */
export interface Always { id: string; title: string; desc: string; icon: string; rarity: Rarity; price: number; needsSpell?: boolean; avail: boolean; note?: string }
const CAPS: Record<string, number> = { cap: 6, power: 4, haste: 4, maxhp: 3, heal: 3 };
const UPGRADE_IDS = ['cap', 'slot', 'power', 'haste', 'maxhp', 'crit', 'heal'];

export function alwaysOffers(run: Run): Always[] {
  const b = run.buys;
  const left = (id: string) => (CAPS[id] ?? 99) - (b[id] ?? 0);
  const visit = (_id: string) => true; // no per-visit limit; per-run caps still apply
  const pm = run.mods.priceMul;
  const P = (n: number) => Math.max(2, Math.round(n * pm));
  const slotCost = run.slots === 3 ? 18 : 30;
  return [
    { id: 'cap', title: 'Capacity +2', desc: "Raise ONE spell's capacity by 2.", icon: '🔷', rarity: 'common', price: P(5 * Math.pow(1.3, b.cap ?? 0)), needsSpell: true, avail: left('cap') > 0 && visit('cap'), note: `${left('cap')} left` },
    { id: 'slot', title: `Spell Slot ${run.slots + 1}`, desc: 'Unlock another spell slot.', icon: '📜', rarity: 'rare', price: P(slotCost), avail: run.slots < 5 && visit('slot') },
    { id: 'power', title: 'Spell Power +5%', desc: 'All spells deal 5% more damage.', icon: '🔺', rarity: 'uncommon', price: P(10 * Math.pow(1.4, b.power ?? 0)), avail: left('power') > 0 && visit('power'), note: `${left('power')} left` },
    { id: 'haste', title: 'Haste -4% cooldown', desc: 'Every spell recharges 4% faster.', icon: '⏩', rarity: 'uncommon', price: P(10 * Math.pow(1.4, b.haste ?? 0)), avail: left('haste') > 0 && visit('haste'), note: `${left('haste')} left` },
    { id: 'maxhp', title: 'Vitality +10 HP', desc: '+10 maximum health and heal 5.', icon: '❤️', rarity: 'common', price: P(6 * Math.pow(1.35, b.maxhp ?? 0)), avail: left('maxhp') > 0 && visit('maxhp'), note: `${left('maxhp')} left` },
    { id: 'crit', title: 'Keen Edge +4% crit', desc: 'Critical hit chance +4%.', icon: '🎯', rarity: 'uncommon', price: P(9 * Math.pow(1.4, b.crit ?? 0)), avail: (b.crit ?? 0) < 5 && visit('crit'), note: `${5 - (b.crit ?? 0)} left` },
    { id: 'heal', title: 'Healing Draught', desc: 'Restore 20% of your maximum health.', icon: '💚', rarity: 'uncommon', price: P((8 + run.round * 0.8) * Math.pow(1.4, b.heal ?? 0)), avail: left('heal') > 0 && run.player.hp < run.player.maxHp * 0.95 && visit('heal'), note: `${left('heal')} left` },
  ];
}

/** Which permanent upgrades are on offer this visit: a random few of those still available (re-rolled with the stock). */
export function pickUpgrades(run: Run): string[] {
  const live = alwaysOffers(run).filter((a) => a.avail && UPGRADE_IDS.includes(a.id)).map((a) => a.id);
  for (let i = live.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [live[i], live[j]] = [live[j], live[i]]; }
  return live.slice(0, UPGRADES_SHOWN);
}

export function buyAlways(run: Run, id: string, spellIndex = -1): string | null {
  const o = alwaysOffers(run).find((x) => x.id === id);
  if (!o || !o.avail) return 'Not available.';
  if (run.coins < o.price) return `Not enough coins (need ${o.price}).`;
  if (o.needsSpell && !run.spells[spellIndex]) return 'Pick a spell.';
  run.coins -= o.price;
  run.buys[id] = (run.buys[id] ?? 0) + 1;
  const p = run.player;
  switch (id) {
    case 'cap': run.spells[spellIndex].def.capacity += 2; break;
    case 'slot': run.addSlot(); break;
    case 'power': p.dmgMul += 0.05; break;
    case 'haste': p.cdMul *= 0.96; break;
    case 'maxhp': p.maxHp += 10; run.heal(5); break;
    case 'crit': p.crit += 0.04; break;
    case 'heal': run.heal(p.maxHp * 0.2); break;
  }
  return null;
}

void RARITY; void RELICS;
