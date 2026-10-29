// Between-round shop overlay: one shelf of cards (runes, a relic, permanent upgrades), selling, and relic management.
import { RUNE_BY_ID, RUNES, RARITY, KIND_LABEL, ELEMENTS, runeColor } from '../data/runes';
import { RELIC_BY_ID, relicColor } from '../game/relics';
import { buyOffer, upgradeOf, reroll, rerollCost, sellRune, sellPrice, owned } from '../game/shop';
import { audio } from '../core/audio';
import type { Run } from '../game/run';
import { el, type UI } from './ui';
import { relicManager } from './relics';
import { acceptRitual, objectiveMet, objectiveProgress, objectiveText, rewardText, ritualSlots, type ActiveRitual, type RitualDef } from '../game/rituals';

export function showShop(ui: UI, run: Run) {
  let tab: 'buy' | 'sell' | 'relics' | 'rituals' = 'buy';
  let msg = '';
  let bad = false;
  let picking: string | null = null;
  const n = el('<div class="overlay shopov"><div class="panel shopp"></div></div>');
  const panel = n.querySelector('.shopp') as HTMLElement;
  const say = (m: string, b = false) => { msg = m; bad = b; };
  let bindRel: ((r: HTMLElement) => void) | null = null;

  const render = () => {
    const forgeReady = run.forgeReady();
    const cards = run.shop.stock.map((o) => {
      const afford = run.coins >= o.price;
      if (o.upgrade) {
        const up = upgradeOf(run, o.upgrade);
        if (!up) return '';
        const ok = up.avail && afford;
        return `<div class="scard upoffer ${!up.avail ? 'sold' : ok ? 'aff' : 'poor'} ${picking === o.id ? 'pick' : ''}" data-offer="${o.id}" style="--rc:${RARITY[up.rarity].color};--c:${RARITY[up.rarity].color}">
          <div class="sci">${up.icon}</div><div class="scn">${up.title}</div><div class="scr">Upgrade</div>
          <p>${up.desc}${(run.buys[o.upgrade] ?? 0) ? ` Bought ${run.buys[o.upgrade]} time${run.buys[o.upgrade] === 1 ? '' : 's'}; each costs more.` : ''}</p><div class="sprice">${!up.avail ? 'MAXED' : `◈ ${up.price}`}</div></div>`;
      }
      if (o.relic) {
        const r = RELIC_BY_ID[o.rune];
        return `<div class="scard relicoffer ${o.sold ? 'sold' : afford ? 'aff' : 'poor'}" data-offer="${o.id}" style="--rc:${relicColor(r)};--c:${relicColor(r)}">
          <div class="sci">${r.icon}</div><div class="scn">${r.name}</div><div class="scr">${r.cursed ? 'Cursed' : RARITY[r.rarity].name} relic</div>
          <p>${r.desc}</p><div class="sprice">${o.sold ? 'SOLD' : `◈ ${o.price}`}</div></div>`;
      }
      const r = RUNE_BY_ID[o.rune];
      const own = owned(run, r.id);
      const prog = r.kind === 'core' && r.element ? `<div class="stag">${ELEMENTS[r.element].name} cores owned: ${run.coreCopies(r.element)}/${run.forgeCost()} to forge</div>` : own ? `<div class="stag">You own ${own}</div>` : '';
      return `<div class="scard ${o.sold ? 'sold' : afford ? 'aff' : 'poor'}" data-offer="${o.id}" style="--rc:${r.kind === 'core' ? '#9a9ab8' : RARITY[r.rarity].color};--c:${runeColor(r)}">
        <div class="sci">${r.icon}</div><div class="scn">${r.name}</div><div class="scr">${r.kind === 'core' ? '' : RARITY[r.rarity].name + ' '}${KIND_LABEL[r.kind]} · cap ${r.cost}</div>
        <p>${r.desc}</p>${prog}<div class="sprice">${o.sold ? 'SOLD' : `◈ ${o.price}`}</div></div>`;
    }).join('');
    const spells = picking ? `<div class="picker"><b>Add +2 capacity to which spell?</b>${run.spells.map((s, i) => `<button data-spell="${i}">${i + 1}. ${s.def.root ? s.c.name : 'Empty slot'} <small>${s.c.cost}/${s.def.capacity}</small></button>`).join('')}<button data-spell="x">cancel</button></div>` : '';
    const pool = RUNES.filter((r) => (run.inv[r.id] ?? 0) > 0).map((r) => `<div class="rchip inv" data-sell="${r.id}" style="--c:${runeColor(r)}" title="${r.name}: sell for ${sellPrice(run, r)}">
      <span class="ri">${r.icon}</span><span class="rn">${r.name}</span><span class="rc">+${sellPrice(run, r)}</span><span class="rx">×${run.inv[r.id]}</span></div>`).join('');
    const tierName = (t: number) => (t === 1 ? 'I' : t === 2 ? 'II' : 'III');
    const objHtml = (d: RitualDef) => d.objectives.map((o) => `<li>${objectiveText(o)}${o.scope === 'round' ? ' <em>(every round)</em>' : ''}</li>`).join('');
    const offerCards = run.shop.rituals.map((d) => `<div class="scard ritoffer ${run.coins >= d.cost ? 'aff' : 'poor'}" data-rit="${d.id}" style="--rc:#c9a6ff;--c:#c9a6ff">
        <div class="sci">${d.icon}</div><div class="scn">${d.name}</div><div class="scr">Tier ${tierName(d.tier)} · ${d.rounds} rounds</div>
        <ul class="ritobj">${objHtml(d)}</ul><p><b>Reward:</b> ${rewardText(d.reward, d.tier)}.</p><div class="sprice">ACCEPT ◈ ${d.cost}</div></div>`).join('');
    const activeCards = run.rituals.filter((r) => r.state === 'active').map((r: ActiveRitual) => `<div class="ritactive"><b>${r.def.icon} ${r.def.name}</b> <small>Tier ${tierName(r.def.tier)} · round ${r.roundsDone}/${r.def.rounds} done</small>
        <ul class="ritobj">${r.def.objectives.map((o, i) => `<li class="${objectiveMet(r, i) ? 'met' : ''}">${objectiveText(o)} <em>${objectiveProgress(r, i, run)}</em></li>`).join('')}</ul><small>Reward: ${rewardText(r.def.reward, r.def.tier)}.</small></div>`).join('');
    const doneList = run.rituals.filter((r) => r.state !== 'active').map((r) => `<span class="ritdone ${r.state}">${r.def.icon} ${r.def.name}: ${r.state === 'fulfilled' ? 'fulfilled' : 'lapsed'}</span>`).join('');
    const ritualsHtml = run.coop ? '<p class="muted">Rituals are not available in co-op yet.</p>' : `<p class="muted">A ritual is a contract: meet EVERY objective within its rounds to earn a permanent upgrade for this run. Fail and you only lose the coins. You can run ${ritualSlots(run)} at a time (a second slot opens at round 8), one per tier.</p>
      <h4>RUNNING</h4>${activeCards || '<p class="muted">None running. Accept one below; it starts with the next round.</p>'}${doneList ? `<div class="ritdones">${doneList}</div>` : ''}
      <h4>OFFERED THIS VISIT <small>(rerolled with the shop)</small></h4><div class="scards">${offerCards || '<p class="muted">Nothing on offer.</p>'}</div>`;
    const rm = tab === 'relics' ? relicManager(run, render) : null;
    bindRel = rm ? rm.bind : null;
    panel.innerHTML = `
      <div class="shh"><h2>SHOP</h2><div class="coins">◈ ${Math.floor(run.coins)}</div>
        <div class="stabs2"><button data-tab="buy" class="${tab === 'buy' ? 'on' : ''}">BUY</button><button data-tab="sell" class="${tab === 'sell' ? 'on' : ''}">SELL RUNES</button><button data-tab="relics" class="${tab === 'relics' ? 'on' : ''}">RELICS ${run.equipped.length}/6</button>${run.coop ? '' : `<button data-tab="rituals" class="${tab === 'rituals' ? 'on' : ''}">RITUALS${run.rituals.some((r) => r.state === 'active') ? ' ●' : ''}</button>`}</div></div>
      ${forgeReady.length ? `<div class="forgebanner">FORGE READY: you have ${run.forgeCost()}+ ${forgeReady.map((e) => ELEMENTS[e].name).join(', ')} cores. Open the Spell Editor's Forge tab to evolve!</div>` : ''}
      ${tab === 'buy' ? `
        <div class="shsec"><h4>FOR SALE <small class="buys">runes, relics and upgrades</small></h4><button class="big rr" data-reroll ${run.coins >= rerollCost(run) ? '' : 'disabled'}>REROLL ALL ◈ ${rerollCost(run)}</button></div>
        <div class="scards">${cards}</div>${spells}`
      : tab === 'sell' ? `<p class="muted">Sell runes you don't need. Click a rune to sell one.</p><div class="chips">${pool || '<p class="muted">Your rune pool is empty.</p>'}</div>`
      : tab === 'rituals' ? ritualsHtml
      : rm!.html}
      <div class="shmsg ${bad ? 'bad' : ''}">${msg || 'One shelf for everything. Upgrades never sell out, but every copy costs more than the last. Rerolling replaces the whole shelf.'}</div>
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
    const rt = t.closest('[data-rit]') as HTMLElement | null;
    if (rt) {
      const d = run.shop.rituals.find((x) => x.id === rt.dataset.rit);
      const err = d ? acceptRitual(run, d) : 'Gone.';
      if (err) { say(err, true); audio.play('warn'); } else { say(`${d!.name} accepted. It begins with the next round.`); audio.play('level'); }
      render(); return;
    }
    const of = t.closest('[data-offer]') as HTMLElement | null;
    if (of) {
      const o = run.shop.stock.find((x) => x.id === of.dataset.offer)!;
      if (o.upgrade === 'cap') {
        if (run.coins < o.price) { say(`Not enough coins (need ${o.price}).`, true); audio.play('warn'); } else picking = o.id;
        render(); return;
      }
      const err = buyOffer(run, o);
      if (err) { say(err, true); audio.play('warn'); }
      else { say(o.upgrade ? `${upgradeOf(run, o.upgrade)?.title ?? 'Upgrade'} bought.` : o.relic ? `Bought ${RELIC_BY_ID[o.rune].name}.` : `Bought ${RUNE_BY_ID[o.rune].name}. It is in your rune pool: place it in the Spell Editor.`); audio.play('pick'); }
      render(); return;
    }
    const sp = t.closest('[data-spell]') as HTMLElement | null;
    if (sp) {
      const o = run.shop.stock.find((x) => x.id === picking);
      if (sp.dataset.spell === 'x' || !o) { picking = null; render(); return; }
      const err = buyOffer(run, o, +sp.dataset.spell!);
      picking = null;
      if (err) { say(err, true); audio.play('warn'); } else { say('Capacity increased.'); audio.play('pick'); }
      render(); return;
    }
    const sl = t.closest('[data-sell]') as HTMLElement | null;
    if (sl) { const v = sellRune(run, sl.dataset.sell!); if (v) { say(`Sold for ${v} coins.`); audio.play('gem'); } render(); }
  });
  render();
  ui.push('shop', n);
}
