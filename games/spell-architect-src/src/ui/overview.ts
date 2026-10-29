// Spell overview: every slot's spell at a glance (name, story, stats, mutations). Opened from the editor and from the pause menu.
import { ELEMENTS, FORMS, type Element } from '../data/runes';
import { REACTIONS } from '../data/reactions';
import { MUT_OPTION_BY_ID } from '../data/mutations';
import { estimate } from '../core/spell';
import { RELIC_BY_ID } from '../game/relics';
import type { Run } from '../game/run';
import type { UI } from './ui';

export function overviewHtml(run: Run): string {
  const pm = run.player;
  const loadEls = new Set<Element>();
  for (const s of run.spells) if (s.c.valid) for (const e of s.c.elements) if (e !== 'arcane') loadEls.add(e);
  let totalDps = 0;
  const cards = run.spells.map((sp, i) => {
    const c = sp.c;
    if (!c.valid || !c.root) {
      return `<div class="ovcard empty"><div class="ovh"><b>${i + 1}. Empty slot</b><em>${sp.def.capacity} capacity</em></div><p class="muted">Nothing equipped. Open the Spell Editor between rounds to build something.</p></div>`;
    }
    const est = estimate(c.root, sp.mut);
    const dps = est.dps * pm.dmgMul / pm.cdMul;
    totalDps += dps;
    const R = c.root;
    const css = ELEMENTS[R.element].css;
    const elems = c.elements.map((e) => `<span class="elchip" style="--c:${ELEMENTS[e].css}">${ELEMENTS[e].icon} ${ELEMENTS[e].name}</span>`).join('');
    const muts = sp.mutations.map((m) => MUT_OPTION_BY_ID[m]).filter(Boolean).map((m) => `<span class="mutchip">${m.icon} ${m.name}</span>`).join('');
    const pct = Math.min(100, (c.cost / sp.def.capacity) * 100);
    return `<div class="ovcard" style="--c:${css}">
      <div class="ovh"><span class="ovi">${ELEMENTS[R.element].icon}${FORMS[R.form].icon}</span><b>${i + 1}. ${c.name}</b>${R.evolved ? '<span class="elchip" style="--c:#ffd25a">EVOLVED</span>' : ''}</div>
      <div class="elrow">${elems}</div>
      <p class="story">${c.story}</p>
      <div class="ovstats"><div><b>${(est.dmgCast * pm.dmgMul).toFixed(0)}</b><span>Dmg / cast</span></div><div><b>${(est.cd * pm.cdMul).toFixed(2)}s</b><span>Cooldown</span></div><div><b>${dps.toFixed(0)}</b><span>Est. DPS</span></div><div><b>${c.runeCount}</b><span>Runes</span></div></div>
      <div class="capbar ${pct >= 100 ? 'full' : ''}"><div style="width:${pct}%"></div><span>CAPACITY ${c.cost}/${sp.def.capacity}</span></div>
      ${muts ? `<div>${muts}</div>` : ''}
      ${c.warnings.length ? `<div class="warns">${c.warnings.map((w) => `<div>⚠ ${w}</div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  const reacts = REACTIONS.filter((r) => r.needs.every((e) => loadEls.has(e)));
  const relics = run.equipped.map((id) => `<span class="mutchip">${RELIC_BY_ID[id].icon} ${RELIC_BY_ID[id].name}</span>`).join('');
  return `<div class="ovw">
    <div class="ovsum">
      <div><b>${Math.round(totalDps)}</b><span>Total est. DPS</span></div>
      <div><b>${loadEls.size}</b><span>Elements</span></div>
      <div><b>${reacts.length}</b><span>Reactions ready</span></div>
      <div><b>${run.spells.filter((s) => s.c.valid).length}/${run.spells.length}</b><span>Slots used</span></div>
    </div>
    <div class="elrow">${[...loadEls].map((e) => `<span class="elchip" style="--c:${ELEMENTS[e].css}">${ELEMENTS[e].icon} ${ELEMENTS[e].name}</span>`).join('') || '<span class="muted">Arcane only</span>'}
      ${reacts.map((r) => `<span class="elchip" style="--c:${r.color}">${r.icon} ${r.name}</span>`).join('')}</div>
    <div class="ovgrid">${cards}</div>
    ${relics ? `<h4>Relics</h4><div>${relics}</div>` : ''}
  </div>`;
}

export function showSpellOverview(ui: UI, run: Run) {
  const m = ui.modal('Spell Overview', overviewHtml(run), 'wide');
  ui.openModal(m, 'overview');
}
