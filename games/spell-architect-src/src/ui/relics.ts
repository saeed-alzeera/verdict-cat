// Relic UI: boss-reward pick overlay and the equip / stash manager (also embedded in the editor and the shop).
import { RELIC_BY_ID, RELIC_SLOTS, relicColor } from '../game/relics';
import { RARITY } from '../data/runes';
import { audio } from '../core/audio';
import type { Run } from '../game/run';
import { el, type UI } from './ui';

export const relicCard = (id: string, run: Run | null, extra = '') => {
  const r = RELIC_BY_ID[id];
  const badge = run && r.badge && run.equipped.includes(id) ? `<em class="rbadge">${r.badge(run)}</em>` : '';
  return `<div class="relic ${r.cursed ? 'cursed' : ''}" data-relic="${id}" style="--rc:${relicColor(r)}" title="${r.name}: ${r.desc}">
    <span class="rlic">${r.icon}</span><div class="rlt"><b>${r.name}</b><small>${r.cursed ? 'Cursed' : RARITY[r.rarity].name}</small></div>${badge}${extra}</div>`;
};

/** Equip/stash manager markup + wiring. `rerender` is called after any change. */
export function relicManager(run: Run, rerender: () => void): { html: string; bind: (root: HTMLElement) => void } {
  const slots = Array.from({ length: RELIC_SLOTS }, (_, i) => run.equipped[i]);
  const stash = run.owned.filter((id) => !run.equipped.includes(id));
  const html = `<div class="relmgr">
    <h4>EQUIPPED <small>${run.equipped.length}/${RELIC_SLOTS}</small></h4>
    <div class="relslots">${slots.map((id) => id ? `<div class="rslot full" data-un="${id}">${relicCard(id, run)}<p>${RELIC_BY_ID[id].desc}</p><button class="mini">Unequip</button></div>` : '<div class="rslot"><span>empty slot</span></div>').join('')}</div>
    <h4>STASH <small>${stash.length}</small></h4>
    <div class="relslots">${stash.length ? stash.map((id) => `<div class="rslot full" data-eq="${id}">${relicCard(id, run)}<p>${RELIC_BY_ID[id].desc}</p><button class="mini">${run.equipped.length < RELIC_SLOTS ? 'Equip' : 'Swap in'}</button></div>`).join('') : '<p class="muted">Relics you own but are not wearing wait here. Swap them freely between rounds.</p>'}</div>
  </div>`;
  const bind = (root: HTMLElement) => {
    root.querySelectorAll<HTMLElement>('[data-un]').forEach((b) => b.addEventListener('click', () => { run.unequipRelic(b.dataset.un!); audio.play('ui'); rerender(); }));
    root.querySelectorAll<HTMLElement>('[data-eq]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.eq!;
      if (run.equipped.length >= RELIC_SLOTS) pickSwap(run, id, rerender); else { run.equipRelic(id); audio.play('pick'); rerender(); }
    }));
  };
  return { html, bind };
}

/** Small prompt: which equipped relic to replace. */
function pickSwap(run: Run, incoming: string, rerender: () => void) {
  const n = el(`<div class="overlay swapov"><div class="panel swapp"><h3>Swap in ${RELIC_BY_ID[incoming].name}</h3><p class="sub">Choose a relic to put in the stash.</p>
    <div class="relslots">${run.equipped.map((id) => `<div class="rslot full" data-out="${id}">${relicCard(id, run)}</div>`).join('')}</div><button class="big" data-x>Cancel</button></div></div>`);
  document.getElementById('ui')?.appendChild(n) ?? document.body.appendChild(n);
  n.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const o = t.closest('[data-out]') as HTMLElement | null;
    if (o) { run.unequipRelic(o.dataset.out!); run.equipRelic(incoming); audio.play('pick'); n.remove(); rerender(); }
    else if (t.closest('[data-x]')) n.remove();
  });
}

export function showRelicPick(ui: UI, run: Run, options: string[]) {
  const n = el(`<div class="overlay lv relicpick"><div class="panel rewardp">
    <div class="rtitle"><small>BOSS REWARD</small><h2>Choose a Relic</h2><p class="sub">Relics are passive. You can wear ${RELIC_SLOTS}; extras go to your stash and can be swapped between rounds.</p></div>
    <div class="cards">${options.map((id, i) => { const r = RELIC_BY_ID[id]; return `<div class="card ${r.cursed ? 'cursedc' : ''}" data-i="${i}" style="--rc:${relicColor(r)};--c:${relicColor(r)}">
      <div class="ck">${i + 1}</div><div class="cicon">${r.icon}</div><div class="cname">${r.name}</div><div class="crar">${r.cursed ? 'Cursed' : RARITY[r.rarity].name}</div>
      <p>${r.desc}</p></div>`; }).join('')}</div>
    <div class="rbtns"><button class="big" data-skip>Skip</button></div></div></div>`);
  const choose = (i: number) => { run.addRelic(options[i]); audio.play('level'); ui.pop('relic'); };
  n.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const c = t.closest('.card') as HTMLElement | null;
    if (c) choose(+c.dataset.i!);
    else if (t.closest('[data-skip]')) { audio.play('ui'); ui.pop('relic'); }
  });
  ui.push('relic', n, (e) => {
    if (['1', '2', '3'].includes(e.key) && options[+e.key - 1]) { choose(+e.key - 1); return true; }
    return false;
  });
}
