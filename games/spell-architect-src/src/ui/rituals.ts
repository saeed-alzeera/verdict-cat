// The Rituals block on the round-prep screen: what is running, and what is on offer (see game/rituals.ts).
import { audio } from '../core/audio';
import { acceptRitual, objectiveMet, objectiveProgress, objectiveText, rewardText, ritualSlots, type ActiveRitual, type RitualDef } from '../game/rituals';
import type { Run } from '../game/run';
import { el } from './ui';

const tierName = (t: number) => (t === 1 ? 'I' : t === 2 ? 'II' : 'III');

export function ritualSection(run: Run, onChange: () => void): HTMLElement {
  const n = el('<div class="ritsec"></div>');
  let msg = '';
  let bad = false;
  const render = () => {
    const objHtml = (d: RitualDef) => d.objectives.map((o) => `<li>${objectiveText(o)}${o.scope === 'round' ? ' <em>(every round)</em>' : ''}</li>`).join('');
    const offers = run.shop.rituals.map((d) => `<div class="scard ritoffer ${run.coins >= d.cost ? 'aff' : 'poor'}" data-rit="${d.id}" style="--rc:#c9a6ff;--c:#c9a6ff">
        <div class="sci">${d.icon}</div><div class="scn">${d.name}</div><div class="scr">Tier ${tierName(d.tier)} · ${d.rounds} rounds</div>
        <ul class="ritobj">${objHtml(d)}</ul><p><b>Reward:</b> ${rewardText(d.reward, d.tier)}.</p><div class="sprice">ACCEPT ◈ ${d.cost}</div></div>`).join('');
    const active = run.rituals.filter((r) => r.state === 'active').map((r: ActiveRitual) => `<div class="ritactive"><b>${r.def.icon} ${r.def.name}</b> <small>Tier ${tierName(r.def.tier)} · ${r.roundsDone}/${r.def.rounds} rounds done</small>
        <ul class="ritobj">${r.def.objectives.map((o, i) => `<li class="${objectiveMet(r, i) ? 'met' : ''}">${objectiveText(o)} <em>${objectiveProgress(r, i, run)}</em></li>`).join('')}</ul><small>Reward: ${rewardText(r.def.reward, r.def.tier)}.</small></div>`).join('');
    const done = run.rituals.filter((r) => r.state !== 'active').map((r) => `<span class="ritdone ${r.state}">${r.def.icon} ${r.def.name}: ${r.state}</span>`).join('');
    const co = run.coopSize() > 1;
    n.innerHTML = `<h4>RITUALS <small>meet every objective within its rounds for a permanent upgrade; fail and you only lose the coins. ${ritualSlots(run)} at a time${ritualSlots(run) < 2 ? ' (a second slot opens at round 8)' : ''}, one per tier${co ? '. In co-op each player has their own, and count targets are 10% higher per extra player' : ''}.</small></h4>
      ${active}${done ? `<div class="ritdones">${done}</div>` : ''}
      ${offers ? `<div class="scards">${offers}</div>` : '<p class="muted">No rituals on offer.</p>'}
      ${msg ? `<div class="shmsg ${bad ? 'bad' : ''}">${msg}</div>` : ''}`;
  };
  n.addEventListener('click', (e) => {
    const rt = (e.target as HTMLElement).closest('[data-rit]') as HTMLElement | null;
    if (!rt) return;
    const d = run.shop.rituals.find((x) => x.id === rt.dataset.rit);
    const err = d ? acceptRitual(run, d) : 'Gone.';
    bad = !!err;
    msg = err ?? `${d!.name} accepted. It begins with the next round.`;
    audio.play(err ? 'warn' : 'level');
    render(); onChange();
  });
  const again = () => { if (!n.isConnected) { window.removeEventListener('sa-shop-closed', again); return; } render(); onChange(); };
  window.addEventListener('sa-shop-closed', again); // the shop (reroll, purchases) may have changed the offers and the coins
  render();
  return n;
}
