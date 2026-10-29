// Between-round shop overlay: limited stock (rune + relic offers), capped upgrades, selling, and relic management.
import { RUNE_BY_ID, RUNES, RARITY, KIND_LABEL, ELEMENTS, runeColor } from '../data/runes';
import { RELIC_BY_ID, relicColor } from '../game/relics';
import { buyOffer, buyAlways, alwaysOffers, reroll, rerollCost, sellRune, sellPrice, owned, BUYS_PER_VISIT } from '../game/shop';
import { audio } from '../core/audio';
import type { Run } from '../game/run';
import { el, type UI } from './ui';
import { relicManager } from './relics';

export function showShop(ui: UI, run: Run) {
  let tab: 'buy' | 'sell' | 'relics' = 'buy';
  let msg = '';
  let bad = false;
  let picking: string | null = null;
  const n = el('<div class="overlay shopov"><div class="panel shopp"></div></div>');
  const panel = n.querySelector('.shopp') as HTMLElement;
  const say = (m: string, b = false) => { msg = m; bad = b; };
  let bindRel: ((r: HTMLElement) => void) | null = null;

  const render = () => {
    const forgeReady = run.forgeReady();
    const left = run.shop.buysLeft;
    const cards = run.shop.stock.map((o) => {
      const afford = run.coins >= o.price && left > 0;
      if (o.relic) {
        const r = RELIC_BY_ID[o.rune];
        return `<div class="scard relicoffer ${o.sold ? 'sold' : afford ? 'aff' : 'poor'}" data-offer="${o.id}" style="--rc:${relicColor(r)};--c:${relicColor(r)}">
          <div class="sci">${r.icon}</div><div class="scn">${r.name}</div><div class="scr">${r.cursed ? 'CURSED' : RARITY[r.rarity].name} Relic · ${r.tag}</div>
          <p><b>${r.cond}.</b> ${r.desc}</p><div class="sprice">${o.sold ? 'SOLD' : `◈ ${o.price}`}</div></div>`;
      }
      const r = RUNE_BY_ID[o.rune];
      const own = owned(run, r.id);
      const prog = r.kind === 'core' && r.element ? `<div class="stag">${ELEMENTS[r.element].name} cores owned: ${run.coreCopies(r.element)}/${run.forgeCost()} to forge</div>` : own ? `<div class="stag">You own ${own}</div>` : '';
      return `<div class="scard ${o.sold ? 'sold' : afford ? 'aff' : 'poor'}" data-offer="${o.id}" style="--rc:${r.kind === 'core' ? '#9a9ab8' : RARITY[r.rarity].color};--c:${runeColor(r)}">
        <div class="sci">${r.icon}</div><div class="scn">${r.name}</div><div class="scr">${r.kind === 'core' ? '' : RARITY[r.rarity].name + ' '}${KIND_LABEL[r.kind]} · cap ${r.cost}</div>
        <p>${r.desc}</p>${prog}<div class="sprice">${o.sold ? 'SOLD' : `◈ ${o.price}`}</div></div>`;
    }).join('');
    const ups = alwaysOffers(run).filter((a) => a.avail).map((a) => `<button class="up ${run.coins >= a.price ? 'aff' : 'poor'} ${picking === a.id ? 'pick' : ''}" data-up="${a.id}" style="--rc:${RARITY[a.rarity].color}">
      <span>${a.icon}</span><b>${a.title}</b><small>${a.desc}${a.note ? ` (${a.note})` : ''}</small><em>◈ ${a.price}</em></button>`).join('');
    const spells = picking === 'cap' ? `<div class="picker"><b>Add +2 capacity to which spell?</b>${run.spells.map((s, i) => `<button data-spell="${i}">${i + 1}. ${s.def.root ? s.c.name : 'Empty slot'} <small>${s.c.cost}/${s.def.capacity}</small></button>`).join('')}<button data-spell="x">cancel</button></div>` : '';
    const pool = RUNES.filter((r) => (run.inv[r.id] ?? 0) > 0).map((r) => `<div class="rchip inv" data-sell="${r.id}" style="--c:${runeColor(r)}" title="${r.name}: sell for ${sellPrice(run, r)}">
      <span class="ri">${r.icon}</span><span class="rn">${r.name}</span><span class="rc">+${sellPrice(run, r)}</span><span class="rx">×${run.inv[r.id]}</span></div>`).join('');
    const rm = tab === 'relics' ? relicManager(run, render) : null;
    bindRel = rm ? rm.bind : null;
    panel.innerHTML = `
      <div class="shh"><h2>SHOP</h2><div class="coins">◈ ${Math.floor(run.coins)}</div>
        <div class="stabs2"><button data-tab="buy" class="${tab === 'buy' ? 'on' : ''}">BUY</button><button data-tab="sell" class="${tab === 'sell' ? 'on' : ''}">SELL RUNES</button><button data-tab="relics" class="${tab === 'relics' ? 'on' : ''}">RELICS ${run.equipped.length}/6</button></div></div>
      ${forgeReady.length ? `<div class="forgebanner">FORGE READY: you have ${run.forgeCost()}+ ${forgeReady.map((e) => ELEMENTS[e].name).join(', ')} cores. Open the Spell Editor's Forge tab to evolve!</div>` : ''}
      ${tab === 'buy' ? `
        <div class="shsec"><h4>STOCK <small class="buys">${left}/${BUYS_PER_VISIT} purchases left this visit</small></h4><button class="big rr" data-reroll ${run.coins >= rerollCost(run) ? '' : 'disabled'}>REROLL ◈ ${rerollCost(run)}</button></div>
        <div class="scards">${cards}</div>
        <h4>UPGRADES <small>(each once per visit, capped per run, prices rise)</small></h4><div class="ups">${ups}</div>${spells}`
      : tab === 'sell' ? `<p class="muted">Sell runes you don't need. Click a rune to sell one.</p><div class="chips">${pool || '<p class="muted">Your rune pool is empty.</p>'}</div>`
      : rm!.html}
      <div class="shmsg ${bad ? 'bad' : ''}">${msg || 'Coins drop from enemies. You can only make a few purchases each visit: pick what your build actually needs.'}</div>
      <div class="rbtns"><button class="big primary" data-done>Done</button></div>`;
    bindRel?.(panel);
  };

  n.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tb = t.closest('[data-tab]') as HTMLElement | null;
    if (tb) { tab = tb.dataset.tab as typeof tab; picking = null; audio.play('ui'); render(); return; }
    if (t.closest('[data-done]')) { audio.play('ui'); ui.pop('shop'); return; }
    if (t.closest('[data-reroll]')) {
      if (reroll(run)) { audio.play('pick'); say('Stock rerolled.'); } else say('Not enough coins to reroll.', true);
      render(); return;
    }
    const of = t.closest('[data-offer]') as HTMLElement | null;
    if (of) {
      const o = run.shop.stock.find((x) => x.id === of.dataset.offer)!;
      const err = buyOffer(run, o);
      if (err) { say(err, true); audio.play('warn'); }
      else { say(o.relic ? `Bought ${RELIC_BY_ID[o.rune].name}.` : `Bought ${RUNE_BY_ID[o.rune].name}. It is in your rune pool: place it in the Spell Editor.`); audio.play('pick'); }
      render(); return;
    }
    const sp = t.closest('[data-spell]') as HTMLElement | null;
    if (sp) {
      if (sp.dataset.spell === 'x') { picking = null; render(); return; }
      const err = buyAlways(run, 'cap', +sp.dataset.spell!);
      picking = null;
      if (err) { say(err, true); audio.play('warn'); } else { say('Capacity increased.'); audio.play('pick'); }
      render(); return;
    }
    const up = t.closest('[data-up]') as HTMLElement | null;
    if (up) {
      const id = up.dataset.up!;
      const o = alwaysOffers(run).find((x) => x.id === id)!;
      if (run.coins < o.price) { say(`Not enough coins (need ${o.price}).`, true); audio.play('warn'); render(); return; }
      if (o.needsSpell) { picking = id; render(); return; }
      const err = buyAlways(run, id);
      if (err) { say(err, true); audio.play('warn'); } else { say(`${o.title} purchased.`); audio.play('pick'); }
      render(); return;
    }
    const sl = t.closest('[data-sell]') as HTMLElement | null;
    if (sl) { const v = sellRune(run, sl.dataset.sell!); if (v) { say(`Sold for ${v} coins.`); audio.play('gem'); } render(); }
  });
  render();
  ui.push('shop', n);
}
