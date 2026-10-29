// Sandbox control panel: spawn any enemy with any attunement, toggle god/dummy mode, open the editor anytime.
import { ELEMENTS } from '../data/runes';
import { spawnEnemy, EDEFS } from '../game/enemies';
import { spawnBoss } from '../game/bosses';
import { RELICS } from '../game/relics';
import { audio } from '../core/audio';
import type { Run } from '../game/run';
import type { Aff } from '../game/rounds';
import type { EType } from '../game/types';
import { el, type UI } from './ui';

export function buildSandboxPanel(ui: UI, run: Run): HTMLElement {
  let type = 'grunt' as Exclude<EType, 'boss'>;
  let aff: Aff = 'neutral';
  let count = 5;
  let elite = false;
  const types = Object.keys(EDEFS) as Exclude<EType, 'boss'>[];
  const affs: Aff[] = ['neutral', 'fire', 'ice', 'lightning', 'poison', 'water', 'gravity'];
  const n = el(`<div class="sbox">
    <div class="sbh"><b>SANDBOX</b><button data-a="fold" title="Collapse">_</button></div>
    <div class="sbb">
      <small>ENEMY</small><div class="sgrp" data-g="type">${types.map((t) => `<button data-v="${t}" class="${t === type ? 'on' : ''}">${t}</button>`).join('')}</div>
      <small>ATTUNEMENT (resists its own element)</small>
      <div class="sgrp" data-g="aff">${affs.map((a) => `<button data-v="${a}" class="${a === aff ? 'on' : ''}">${a === 'neutral' ? 'neutral' : ELEMENTS[a].icon}</button>`).join('')}</div>
      <small>COUNT</small><div class="sgrp" data-g="count">${[1, 5, 15, 40].map((c) => `<button data-v="${c}" class="${c === count ? 'on' : ''}">${c}</button>`).join('')}</div>
      <div class="sgrp"><button data-a="elite" data-t="1">ELITE: off</button><button data-a="spawn" class="go">SPAWN</button></div>
      <small>BOSSES</small><div class="sgrp">${[0, 1, 2, 3].map((k) => `<button data-a="boss" data-v="${k}">B${k + 1}</button>`).join('')}</div>
      <small>TOOLS</small>
      <div class="sgrp"><button data-a="god" class="on">GOD: on</button><button data-a="dummy">DUMMIES: off</button></div>
      <div class="sgrp"><button data-a="clear">CLEAR</button><button data-a="ult">RESET ULTS</button><button data-a="editor">EDITOR (E)</button><button data-a="relics">ALL RELICS</button></div>
      <small>ENEMY STRENGTH <span class="dv">${Math.round(run.dtime)}</span></small>
      <input type="range" min="0" max="900" step="25" value="${Math.round(run.dtime)}" data-a="diff">
    </div>
  </div>`);
  const mark = (g: string, v: string) => n.querySelectorAll<HTMLElement>(`[data-g=${g}] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  n.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!b) return;
    audio.play('ui');
    const g = b.parentElement?.dataset.g;
    if (g === 'type') { type = b.dataset.v as typeof type; mark('type', type); return; }
    if (g === 'aff') { aff = b.dataset.v as Aff; mark('aff', aff); return; }
    if (g === 'count') { count = +b.dataset.v!; mark('count', String(count)); return; }
    switch (b.dataset.a) {
      case 'fold': n.classList.toggle('folded'); break;
      case 'elite': elite = !elite; b.textContent = `ELITE: ${elite ? 'on' : 'off'}`; b.classList.toggle('on', elite); break;
      case 'spawn':
        for (let i = 0; i < count; i++) {
          const a = Math.random() * 6.283, d = 200 + Math.random() * 120;
          const x = Math.max(40, Math.min(1560, run.player.x + Math.cos(a) * d)), y = Math.max(40, Math.min(1560, run.player.y + Math.sin(a) * d));
          spawnEnemy(run, type, x, y, elite, aff);
        }
        break;
      case 'boss': if (!run.boss) spawnBoss(run, +b.dataset.v!); break;
      case 'god': run.god = !run.god; b.textContent = `GOD: ${run.god ? 'on' : 'off'}`; b.classList.toggle('on', run.god); break;
      case 'dummy': run.dummy = !run.dummy; b.textContent = `DUMMIES: ${run.dummy ? 'on' : 'off'}`; b.classList.toggle('on', run.dummy); break;
      case 'clear': run.clearField(); break;
      case 'ult': for (const sp of run.spells) sp.ultCd = 0; break;
      case 'relics': for (const r of RELICS) run.addRelic(r.id, false); run.announce('RELICS', '#ffd25a', 'All relics granted: manage them in the editor\'s RELICS tab.'); break;
      case 'editor': ui.openEditorFromPlay(); break;
    }
    b.blur();
  });
  n.addEventListener('input', (e) => {
    const i = e.target as HTMLInputElement;
    if (i.dataset.a === 'diff') { run.dtime = +i.value; (n.querySelector('.dv') as HTMLElement).textContent = i.value; }
  });
  return n;
}
