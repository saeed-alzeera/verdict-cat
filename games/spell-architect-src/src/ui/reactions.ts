// Shared rendering for elemental reaction cards (editor Reactions tab, journal).
import { ELEMENTS, type Element } from '../data/runes';
import type { ReactionDef } from '../data/reactions';

const chip = (e: Element, ok: boolean | null) =>
  `<span class="rel ${ok === null ? '' : ok ? 'have' : 'miss'}" style="--c:${ELEMENTS[e].css}">${ELEMENTS[e].icon} ${ELEMENTS[e].name}${ok === null ? '' : ok ? ' ✓' : ' ✗'}</span>`;

/** `present` = elements in the player's loadout (null = just show the recipe). */
export function reactionCardHtml(r: ReactionDef, present: Set<Element> | null, seen: number): string {
  const active = present ? r.needs.every((e) => present.has(e)) : false;
  return `<div class="rcard ${present ? (active ? 'active' : 'inactive') : ''}" style="--c:${r.color}">
    <div class="rch"><span class="rci">${r.icon}</span><b>${r.name}</b>${seen ? `<em>seen ${seen}×</em>` : ''}</div>
    <div class="rrow"><small>NEEDS</small>${r.needs.map((e) => chip(e, present ? present.has(e) : null)).join('<i>+</i>')}</div>
    <div class="rrow"><small>DEALS</small>${r.dmg.map((e) => chip(e, null)).join('<i>+</i>')}<small>damage</small></div>
    <p><b>${r.recipe}.</b> ${r.how}</p>
  </div>`;
}
