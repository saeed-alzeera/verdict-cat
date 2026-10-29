// Spell editor. Each slot is a nested stack of cards: a FORM with a CORE socket (its element),
// AUGMENT chips (behaviors / modifiers) and TRIGGER blocks that each launch further Forms.
// A plain-language story of the whole spell is written beside it. Pauses the game while open.
import {
  RUNES, RUNE_BY_ID, ELEMENTS, FORMS, RARITY, KIND_COLOR, KIND_LABEL, runeColor, EVOLVE_COST, EVOLVED_OF, BASE_CORE_OF, ULTIMATES, type RuneKind, type Element,
} from '../data/runes';
import { REACTIONS } from '../data/reactions';
import { store } from '../core/save';
import { reactionCardHtml } from './reactions';
import { MUT_TRACKS, MUT_OPTION_BY_ID } from '../data/mutations';
import {
  checkAttach, findNode, newNode, spellCost, subtreeRunes, estimate, type SpellNode,
} from '../core/spell';
import { audio } from '../core/audio';
import type { Run } from '../game/run';
import type { ActiveSpell } from '../game/types';
import { el, type UI } from './ui';
import { relicManager } from './relics';

export function openEditor(ui: UI, run: Run) { new Editor(ui, run).open(); }

const TRIG_ICON: Record<string, string> = { hit: '💥', kill: '💀', expiry: '⏳', crit: '✴️' };

class Editor {
  root!: HTMLElement;
  slot = 0;
  sel: string | null = null;
  filter: RuneKind | 'all' = 'all';
  drag: { rune?: string; node?: number } | null = null;
  menu: HTMLElement | null = null;
  hint = '';
  hintBad = false;
  tab: 'spell' | 'react' | 'forge' | 'relics' | 'stats' = 'spell';

  constructor(private ui: UI, private run: Run) {
    const first = run.spells.findIndex((s) => s.def.root);
    this.slot = first >= 0 ? first : 0;
  }

  get sp(): ActiveSpell { return this.run.spells[this.slot]; }

  open() {
    this.root = el('<div class="overlay editor-ov"><div class="editor"></div></div>');
    this.ui.push('editor', this.root, (e) => {
      if (e.key === 'Escape' || e.key === 'e' || e.key === 'E' || e.key === 'Tab') { this.close(); return true; }
      return false;
    });
    this.bind();
    this.render();
    audio.play('ui');
  }
  close() { this.closeMenu(); this.ui.pop('editor'); audio.play('ui'); }

  say(msg: string, bad = false) {
    this.hint = msg; this.hintBad = bad;
    const h = this.root.querySelector('.hintbar');
    if (h) { h.textContent = msg; h.classList.toggle('bad', bad); }
  }

  recompile() { this.run.recompile(this.sp); }

  /* ------------------------------ operations ------------------------------ */

  attach(parentId: number | null, runeId: string): boolean {
    const sp = this.sp;
    if ((this.run.inv[runeId] ?? 0) <= 0) { this.say('You have none of that rune left.', true); return false; }
    const parent = parentId === null ? null : findNode(sp.def, parentId)?.node ?? null;
    if (parentId !== null && !parent) return false;
    const c = checkAttach(sp.def, parent, runeId);
    if (!c.ok) { this.say(c.reason, true); audio.play('warn'); return false; }
    const n = newNode(runeId);
    if (!parent) sp.def.root = n; else parent.children.push(n);
    this.run.inv[runeId]--;
    this.recompile();
    audio.play('pick');
    this.say(`${RUNE_BY_ID[runeId].name} placed.`);
    if ((this.run.inv[runeId] ?? 0) <= 0 && this.sel === runeId) this.sel = null;
    return true;
  }

  move(nodeId: number, newParentId: number): boolean {
    const sp = this.sp;
    const f = findNode(sp.def, nodeId), t = findNode(sp.def, newParentId);
    if (!f || !t || !f.parent) return false;
    const c = checkAttach(sp.def, t.node, f.node.rune, f.node);
    if (!c.ok) { this.say(c.reason, true); audio.play('warn'); return false; }
    f.parent.children = f.parent.children.filter((x) => x !== f.node);
    t.node.children.push(f.node);
    this.recompile();
    audio.play('pick');
    this.say(`Moved ${RUNE_BY_ID[f.node.rune].name}.`);
    return true;
  }

  remove(nodeId: number) {
    const sp = this.sp;
    const f = findNode(sp.def, nodeId);
    if (!f) return;
    for (const r of subtreeRunes(f.node)) this.run.inv[r] = (this.run.inv[r] ?? 0) + 1;
    if (!f.parent) sp.def.root = null;
    else f.parent.children = f.parent.children.filter((x) => x !== f.node);
    this.recompile();
    audio.play('ui');
    this.say('Removed. The runes went back to your pool.');
  }

  /* ------------------------------ events ------------------------------ */

  bind() {
    const r = this.root;
    r.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (this.menu && !t.closest('.addmenu')) this.closeMenu();
      const mi = t.closest('[data-pick]') as HTMLElement | null;
      if (mi) {
        if (!mi.classList.contains('dis')) { const pid = +mi.dataset.parent!; const rid = mi.dataset.pick!; this.closeMenu(); this.attach(pid < 0 ? null : pid, rid); this.render(); }
        return;
      }
      const rm = t.closest('[data-rm]') as HTMLElement | null;
      if (rm) { this.remove(+rm.dataset.rm!); this.render(); return; }
      const add = t.closest('[data-add]') as HTMLElement | null;
      if (add) {
        const pid = +add.dataset.add!;
        if (this.sel && add.dataset.kinds === undefined) { this.attach(pid, this.sel); this.render(); }
        else this.openMenu(pid, add, add.dataset.kinds?.split(','));
        return;
      }
      const tb = t.closest('[data-tab]') as HTMLElement | null;
      if (tb) { this.tab = tb.dataset.tab as typeof this.tab; audio.play('ui'); this.render(); return; }
      const fg = t.closest('[data-forge]') as HTMLElement | null;
      if (fg) {
        const el0 = fg.dataset.forge!;
        if (this.run.forge(el0)) { audio.play('level'); this.say(`Forged ${RUNE_BY_ID[EVOLVED_OF[el0]].name}! Socket it into a Form to use it.`); }
        else this.say(`You need ${EVOLVE_COST} ${ELEMENTS[el0 as Element].name} cores to forge.`, true);
        this.render(); return;
      }
      const slot = t.closest('[data-slot]') as HTMLElement | null;
      if (slot) { this.slot = +slot.dataset.slot!; this.sel = null; this.hint = ''; this.render(); return; }
      const f = t.closest('[data-filter]') as HTMLElement | null;
      if (f) { this.filter = f.dataset.filter as RuneKind | 'all'; this.render(); return; }
      const chip = t.closest('.rchip[data-rune]') as HTMLElement | null;
      if (chip) { const id = chip.dataset.rune!; this.sel = this.sel === id ? null : id; audio.play('ui'); this.hint = ''; this.render(); return; }
      if (t.closest('[data-a=close]')) { this.close(); return; }
      if (t.closest('[data-clear]')) { this.sel = null; this.hint = ''; this.render(); return; }
      const empty = t.closest('.emptyroot');
      if (empty) { if (this.sel) { this.attach(null, this.sel); this.render(); } else this.openMenu(-1, empty as HTMLElement, ['form']); return; }
      const tg = t.closest('[data-target]') as HTMLElement | null;
      if (tg && this.sel) { this.attach(+tg.dataset.target!, this.sel); this.render(); }
    });
    r.addEventListener('contextmenu', (e) => {
      const nd = (e.target as HTMLElement).closest('[data-node]') as HTMLElement | null;
      if (nd) { e.preventDefault(); this.remove(+nd.dataset.node!); this.render(); }
    });
    r.addEventListener('mouseover', (e) => {
      const t = e.target as HTMLElement;
      const rd = t.closest('[data-rune],[data-node]') as HTMLElement | null;
      if (rd) {
        let id = rd.dataset.rune;
        if (!id && rd.dataset.node) id = findNode(this.sp.def, +rd.dataset.node)?.node.rune;
        if (id) this.showDetail(id);
      }
      const tg = t.closest('[data-target]') as HTMLElement | null;
      if (tg && this.sel) {
        const n = findNode(this.sp.def, +tg.dataset.target!);
        if (n) { const c = checkAttach(this.sp.def, n.node, this.sel); this.say(c.ok ? `Click to place ${RUNE_BY_ID[this.sel].name} on ${RUNE_BY_ID[n.node.rune].name}.` : c.reason, !c.ok); }
      }
    });
    // drag & drop
    r.addEventListener('dragstart', (e) => {
      const t = (e.target as HTMLElement).closest('[data-rune],[data-node]') as HTMLElement | null;
      if (!t) return;
      this.drag = t.dataset.rune ? { rune: t.dataset.rune } : { node: +t.dataset.node! };
      e.dataTransfer?.setData('text/plain', 'sa');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      this.closeMenu();
      setTimeout(() => this.markTargets(), 0);
    });
    r.addEventListener('dragend', () => { this.drag = null; this.clearMarks(); });
    r.addEventListener('dragover', (e) => {
      if (!this.drag) return;
      const t = e.target as HTMLElement;
      const tg = t.closest('[data-target]') as HTMLElement | null;
      const inv = t.closest('.inventory');
      const emp = t.closest('.emptyroot');
      if (tg) {
        const c = this.checkDrop(+tg.dataset.target!);
        this.say(c.reason, !c.ok);
        if (c.ok) e.preventDefault();
      } else if (emp && this.drag.rune) {
        const c = checkAttach(this.sp.def, null, this.drag.rune);
        this.say(c.ok ? 'Drop to equip this Form in the slot.' : c.reason, !c.ok);
        if (c.ok) e.preventDefault();
      } else if (inv && this.drag.node !== undefined) { e.preventDefault(); this.say('Drop to return this rune to your pool.'); }
    });
    r.addEventListener('drop', (e) => {
      const d = this.drag;
      if (!d) return;
      e.preventDefault();
      const t = e.target as HTMLElement;
      const tg = t.closest('[data-target]') as HTMLElement | null;
      const inv = t.closest('.inventory');
      const emp = t.closest('.emptyroot');
      this.drag = null;
      if (tg) {
        const id = +tg.dataset.target!;
        if (d.rune) this.attach(id, d.rune); else if (d.node !== undefined) this.move(d.node, id);
      } else if (emp && d.rune) this.attach(null, d.rune);
      else if (inv && d.node !== undefined) this.remove(d.node);
      this.render();
    });
  }

  checkDrop(targetId: number) {
    const sp = this.sp;
    const t = findNode(sp.def, targetId);
    if (!t || !this.drag) return { ok: false, reason: '' };
    if (this.drag.rune) return checkAttach(sp.def, t.node, this.drag.rune);
    const f = findNode(sp.def, this.drag.node!);
    if (!f) return { ok: false, reason: '' };
    if (!f.parent) return { ok: false, reason: 'The slot\'s main Form can\'t be moved. Drag it to the rune pool to unequip the whole spell.' };
    return checkAttach(sp.def, t.node, f.node.rune, f.node);
  }

  markTargets() {
    this.root.querySelectorAll<HTMLElement>('[data-target]').forEach((n) => {
      const c = this.checkDrop(+n.dataset.target!);
      n.classList.toggle('ok', c.ok); n.classList.toggle('bad', !c.ok);
    });
    const em = this.root.querySelector('.emptyroot');
    if (em && this.drag?.rune) { const c = checkAttach(this.sp.def, null, this.drag.rune); em.classList.toggle('ok', c.ok); em.classList.toggle('bad', !c.ok); }
  }
  clearMarks() { this.root.querySelectorAll('.ok,.bad').forEach((n) => { n.classList.remove('ok'); n.classList.remove('bad'); }); }

  showDetail(id: string) {
    const r = RUNE_BY_ID[id];
    const d = this.root.querySelector('.rdetail');
    if (!d) return;
    const works = r.forms ? `<div class="works">Works on: ${r.forms.map((f) => FORMS[f].name).join(', ')}</div>` : '';
    const where = r.kind === 'form' ? 'Goes in a spell slot, or under a Trigger.' : r.kind === 'core' ? 'Socket it into a Form to set its element.' : r.kind === 'trigger' ? 'Add to a Form, then slot a Form under it.' : 'Add to a Form.';
    d.innerHTML = `<div class="rdh" style="--c:${runeColor(r)}"><span>${r.icon}</span><div><b>${r.name}</b><small>${KIND_LABEL[r.kind]} · <i style="color:${RARITY[r.rarity].color}">${RARITY[r.rarity].name}</i> · cost ${r.cost}</small></div></div>
      <p>${r.desc}</p>${works}<div class="works">${where}</div>`;
  }

  /* ------------------------------ add menu ------------------------------ */

  openMenu(parentId: number, anchor: HTMLElement, kinds?: string[]) {
    this.closeMenu();
    const sp = this.sp;
    const parent = parentId < 0 ? null : findNode(sp.def, parentId)?.node ?? null;
    const items = RUNES.filter((r) => (this.run.inv[r.id] ?? 0) > 0 && (!kinds || kinds.includes(r.kind))).map((r) => ({ r, c: checkAttach(sp.def, parent, r.id) }));
    items.sort((a, b) => Number(b.c.ok) - Number(a.c.ok));
    const label = !parent ? 'Equip a Form' : RUNE_BY_ID[parent.rune].kind === 'trigger' ? 'Launch which Form?' : kinds?.includes('core') && kinds.length === 1 ? 'Socket a Core (element)' : `Add to ${RUNE_BY_ID[parent.rune].name}`;
    const m = el(`<div class="addmenu"><div class="amh">${label}</div>${items.length ? items.map(({ r, c }) => `
      <div class="ami ${c.ok ? '' : 'dis'}" data-pick="${r.id}" data-parent="${parentId}" style="--c:${runeColor(r)}" title="${c.reason.replace(/"/g, '&quot;')}">
        <span>${r.icon}</span><b>${r.name}</b><em>${KIND_LABEL[r.kind]} · ${r.cost}</em>${c.ok ? '' : `<small>${c.reason}</small>`}</div>`).join('') : '<p class="muted">Nothing suitable in your rune pool. Level up to find more.</p>'}</div>`);
    const rect = anchor.getBoundingClientRect();
    m.style.left = `${Math.min(window.innerWidth - 320, Math.max(8, rect.left))}px`;
    m.style.top = `${Math.min(window.innerHeight - 340, Math.max(8, rect.bottom + 6))}px`;
    this.root.appendChild(m);
    this.menu = m;
  }
  closeMenu() { this.menu?.remove(); this.menu = null; }

  /* ------------------------------ rendering ------------------------------ */

  /** Render one form card and, recursively, the forms launched by its triggers. */
  formCard(node: SpellNode, inherit: Element, isRoot: boolean): string {
    const rd = RUNE_BY_ID[node.rune];
    const coreNode = node.children.find((c) => RUNE_BY_ID[c.rune].kind === 'core');
    void inherit;
    const element: Element = coreNode ? RUNE_BY_ID[coreNode.rune].element! : 'arcane';
    const E = ELEMENTS[element];
    const sel = this.sel ? RUNE_BY_ID[this.sel] : null;
    const cls = sel ? (checkAttach(this.sp.def, node, sel.id).ok ? 'ok' : '') : '';
    const augs = node.children.filter((c) => ['behavior', 'modifier'].includes(RUNE_BY_ID[c.rune].kind));
    const trigs = node.children.filter((c) => RUNE_BY_ID[c.rune].kind === 'trigger');
    const core = coreNode
      ? `<div class="sock core filled" data-node="${coreNode.id}" draggable="true" style="--c:${runeColor(RUNE_BY_ID[coreNode.rune])}"><span>${RUNE_BY_ID[coreNode.rune].icon}</span><b>${RUNE_BY_ID[coreNode.rune].name}</b><button class="nrm" data-rm="${coreNode.id}" title="Remove Core">X</button></div>`
      : `<button class="sock core empty" data-add="${node.id}" data-kinds="core" title="Socket a Core rune to give this Form an element"><span>+</span><b>Core</b><small>${isRoot ? 'none = Arcane' : 'none = Arcane (not inherited)'}</small></button>`;
    const chips = augs.map((c) => {
      const r = RUNE_BY_ID[c.rune];
      return `<span class="chip k-${r.kind}" data-node="${c.id}" draggable="true" style="--c:${runeColor(r)}" title="${r.name}">${r.icon} ${r.name}<button class="nrm" data-rm="${c.id}">X</button></span>`;
    }).join('');
    const trigHtml = trigs.map((t) => {
      const tr = RUNE_BY_ID[t.rune];
      const kids = t.children.map((k) => this.formCard(k, 'arcane', false)).join('');
      const selOk = sel && checkAttach(this.sp.def, t, sel.id).ok ? 'ok' : '';
      return `<div class="trig ${selOk}" data-node="${t.id}" data-target="${t.id}" draggable="true">
        <div class="thead"><span class="ti">${TRIG_ICON[tr.trigger!]}</span><b>${tr.name.toUpperCase()}</b><em>${tr.chance !== undefined && tr.chance < 1 ? `${Math.round(tr.chance * 100)}% · ` : ''}launches ></em><button class="nrm" data-rm="${t.id}" title="Remove trigger and its effects">X</button></div>
        <div class="tkids">${kids || '<div class="hole">Nothing launches yet.</div>'}</div>
        <button class="addchip" data-add="${t.id}" data-kinds="form">+ Launch a Form</button></div>`;
    }).join('');
    return `<div class="fcard ${cls} ${isRoot ? 'root' : ''}" data-target="${node.id}" ${isRoot ? '' : `data-node="${node.id}" draggable="true"`} style="--c:${E.css}">
      <div class="fhead"><span class="fi">${rd.icon}</span><div class="ft"><b>${E.name.toUpperCase()} ${rd.name.toUpperCase()}</b><small>${isRoot ? 'MAIN FORM' : 'EFFECT FORM'} · cost ${rd.cost}</small></div>
        <button class="nrm" data-rm="${node.id}" title="${isRoot ? 'Unequip this whole spell' : 'Remove'}">X</button></div>
      <div class="frow">${core}<div class="augs">${chips}<button class="addchip" data-add="${node.id}" data-kinds="behavior,modifier,trigger">+ Augment / Trigger</button></div></div>
      ${trigHtml ? `<div class="trigs">${trigHtml}</div>` : ''}
    </div>`;
  }

  render() {
    const run = this.run, sp = this.sp;
    const ed = this.root.querySelector('.editor') as HTMLElement;
    const gw = ed.querySelector('.graph') as HTMLElement | null;
    const sl = gw ? gw.scrollLeft : 0, st = gw ? gw.scrollTop : 0;
    const c = sp.c;

    const tabs = run.spells.map((s, i) => {
      const cost = spellCost(s.def);
      const root = s.c.valid ? s.c.root : null;
      const ico = root ? `${ELEMENTS[root.element].icon}${FORMS[root.form].icon}` : '+';
      return `<button class="stab ${i === this.slot ? 'on' : ''}" data-slot="${i}" style="--c:${root ? ELEMENTS[root.element].css : '#6a5ab0'}">
        <span class="sti">${ico}</span><span class="stn"><b>${i + 1}. ${s.def.root ? s.c.name : 'Empty'}</b><small>${cost}/${s.def.capacity} cap</small></span></button>`;
    }).join('') + (run.slots < 5 ? `<button class="stab locked" disabled title="Buy another slot in the shop"><span class="sti">🔒</span><span class="stn"><b>Slot ${run.slots + 1}</b><small>buy in shop</small></span></button>` : '');

    let graph: string;
    if (!sp.def.root) {
      graph = `<div class="emptyroot ${this.sel && RUNE_BY_ID[this.sel].kind === 'form' ? 'ok' : ''}"><div class="eri">✦</div><b>EMPTY SLOT</b><p>Pick a <span style="color:${KIND_COLOR.form}">Form</span> from your rune pool and click here (or drag it in). Then socket a <span style="color:${KIND_COLOR.core}">Core</span> into it to choose its element.</p></div>`;
    } else {
      graph = this.formCard(sp.def.root, 'arcane', true);
    }

    const est = c.valid && c.root ? estimate(c.root, sp.mut) : null;
    const pm = run.player;
    const dmg = est ? est.dmgCast * pm.dmgMul : 0, cd = est ? est.cd * pm.cdMul : 0;
    const cost = spellCost(sp.def);
    const pct = Math.min(100, (cost / sp.def.capacity) * 100);
    const elems = c.valid ? c.elements.map((e) => `<span class="elchip" style="--c:${ELEMENTS[e].css}">${ELEMENTS[e].icon} ${ELEMENTS[e].name}</span>`).join('') : '';
    const muts = sp.mutations.map((m) => MUT_OPTION_BY_ID[m]).filter(Boolean).map((m) => `<span class="mutchip">${m.icon} ${m.name}</span>`).join('');
    const prog = MUT_TRACKS.filter((t) => c.valid && (!t.element || c.elements.includes(t.element)) && !sp.tiers[t.id]).slice(0, 3)
      .map((t) => `<div class="prog"><span>${t.title}</span><div><i style="width:${Math.min(100, sp.st[t.stat] / t.threshold * 100)}%"></i></div><em>${Math.floor(sp.st[t.stat])}/${t.threshold}</em></div>`).join('');
    const rootC = c.valid ? c.root : null;
    const loadEls = new Set<Element>();
    for (const s2 of run.spells) if (s2.c.valid) for (const e of s2.c.elements) if (e !== 'arcane') loadEls.add(e);
    const inSpell = new Set<Element>(c.valid ? c.elements.filter((e) => e !== 'arcane') : []);
    const pots = REACTIONS.filter((r) => r.needs.every((e) => loadEls.has(e)) && r.needs.some((e) => inSpell.has(e)));
    const potHtml = pots.length ? `<h4>Reaction potential</h4>${pots.map((r) => {
      const self = r.needs.every((e) => inSpell.has(e));
      return `<div class="pot" style="--c:${r.color}"><b>${r.icon} ${r.name}</b> ${self ? '<em>(this spell alone)</em>' : '<em>(with another slot)</em>'}<br>${r.recipe}. ${r.how}</div>`;
    }).join('')}` : (inSpell.size ? '<h4>Reaction potential</h4><p class="muted">No reactions yet. Pair this element with another one (in this spell or another slot) to unlock some. See the Reactions tab.</p>' : '');
    const ult = rootC?.evolved ? ULTIMATES[rootC.element] : null;
    const spellInfo = `
      <div class="spname">${sp.def.root ? c.name : 'Empty slot'}</div>
      <div class="elrow">${elems}${rootC?.evolved ? '<span class="elchip" style="--c:#ffd25a">EVOLVED</span>' : ''}</div>
      ${c.valid ? `<h4>What it does</h4><p class="story">${c.story}</p>` : '<p class="muted">Equip a Form to begin.</p>'}
      ${ult ? `<div class="ultbox"><b>${ult.icon} ULTIMATE (SPACE): ${ult.name}</b><p>${ult.desc}</p></div>` : ''}
      <div class="capbar ${pct >= 100 ? 'full' : ''}"><div style="width:${pct}%"></div><span>CAPACITY ${cost}/${sp.def.capacity}</span></div>
      ${est ? `<div class="tiles">
        <div><b>${dmg.toFixed(0)}</b><span>Damage / cast</span></div>
        <div><b>${cd.toFixed(2)}s</b><span>Cooldown</span></div>
        <div><b>${(est.dps * pm.dmgMul / pm.cdMul).toFixed(0)}</b><span>Est. DPS</span></div>
        <div><b>${c.runeCount}</b><span>Runes</span></div></div>` : ''}
      ${rootC && rootC.element !== 'arcane' ? `<p class="muted">${ELEMENTS[rootC.element].name} hits harder than Arcane (x${(ELEMENTS[rootC.element].dmg * (rootC.evolved ? 1.4 : 1)).toFixed(2)}). ${ELEMENTS[rootC.element].blurb} Enemies attuned to ${ELEMENTS[rootC.element].name} resist it. Arcane never is.</p>` : rootC ? '<p class="muted">Arcane: no element, no effect, but never resisted by any enemy.</p>' : ''}
      ${potHtml}
      ${c.warnings.length ? `<div class="warns">${c.warnings.map((w) => `<div>⚠ ${w}</div>`).join('')}</div>` : ''}
      ${muts ? `<h4>Mutations</h4><div>${muts}</div>` : ''}
      ${prog ? `<h4>Mutation progress</h4>${prog}` : ''}
      <h4>Rune details</h4><div class="rdetail"><p class="muted">Hover any rune.</p></div>`;

    // loadout-wide elements for the Reactions tab
    const present = new Set<Element>();
    for (const s2 of run.spells) if (s2.c.valid) for (const e of s2.c.elements) if (e !== 'arcane') present.add(e);
    const seenR = store.d.journal.reactions;
    const reactList = [...REACTIONS].sort((a, b) => Number(b.needs.every((e) => present.has(e))) - Number(a.needs.every((e) => present.has(e))));
    const reactInfo = `
      <div class="spname">REACTIONS</div>
      <p class="muted">Elements from <b>different slots</b> react with each other's puddles, clouds and statuses. A reaction deals <b>both</b> of its damage types (split evenly), so an enemy resisting one still takes the other. Your loadout elements: ${present.size ? [...present].map((e) => `<span class="elchip" style="--c:${ELEMENTS[e].css}">${ELEMENTS[e].icon} ${ELEMENTS[e].name}</span>`).join(' ') : 'none yet (Arcane has no reactions)'}</p>
      <div class="rlist">${reactList.map((r) => reactionCardHtml(r, present, seenR[r.id] ?? 0)).join('')}</div>`;

    // Forge tab: 4 cores -> evolved core
    const owned = (id: string) => (run.inv[id] ?? 0) + run.spells.filter((s2) => s2.def.root?.children.some((ch) => ch.rune === id)).length;
    const forgeInfo = `
      <div class="spname">FORGE</div>
      ${run.forgeReady().length ? `<div class="forgebanner">You can forge: ${run.forgeReady().map((e3) => ELEMENTS[e3].name).join(', ')}!</div>` : ''}
      <p class="muted">Combine <b>${EVOLVE_COST} copies</b> of the same Core (from your pool or equipped) into an <b>evolved Core</b>: +40% damage, a new passive, and an <b>Ultimate</b> on Space while it is equipped.</p>
      ${(Object.keys(BASE_CORE_OF) as Element[]).map((e2) => {
        const n = run.coreCopies(e2), have = owned(EVOLVED_OF[e2]);
        const evo = RUNE_BY_ID[EVOLVED_OF[e2]], U = ULTIMATES[e2];
        return `<div class="forge ${n >= EVOLVE_COST ? 'ready' : ''}" style="--c:${ELEMENTS[e2].css}">
          <div class="fgh"><span>${ELEMENTS[e2].icon}</span><b>${ELEMENTS[e2].name} cores</b><em>${Math.min(n, EVOLVE_COST)}/${EVOLVE_COST}</em></div>
          <div class="fgbar"><i style="width:${Math.min(100, (n / EVOLVE_COST) * 100)}%"></i></div>
          <p><b>${evo.icon} ${evo.name}</b> ${have ? `(owned: ${have})` : ''}: ${evo.desc.replace(/^EVOLVED \w+\. /, '')}</p>
          <p class="ul"><b>${U.icon} ${U.name}:</b> ${U.desc}</p>
          <button class="addchip" data-forge="${e2}" ${n >= EVOLVE_COST ? '' : 'disabled'}>FORGE ${evo.name.toUpperCase()}</button></div>`;
      }).join('')}`;
    const tabsHtml = `<div class="itabs">${(['spell', 'react', 'forge', 'relics', 'stats'] as const).map((t) => `<button data-tab="${t}" class="${this.tab === t ? 'on' : ''} ${t === 'forge' && run.forgeReady().length ? 'glow' : ''}">${t === 'spell' ? 'SPELL' : t === 'react' ? 'REACTIONS' : t === 'relics' ? `RELICS ${run.equipped.length}/6` : t === 'stats' ? 'STATS' : run.forgeReady().length ? 'FORGE !' : 'FORGE'}</button>`).join('')}</div>`;
    const rm = this.tab === 'relics' ? relicManager(run, () => this.render()) : null;
    const pl = run.player;
    const statsInfo = `<div class="spname">STATS</div><div class="statgrid">
      <span>Spell power</span><b>x${pl.dmgMul.toFixed(2)}</b><span>Cooldown</span><b>x${pl.cdMul.toFixed(2)}</b>
      <span>Crit chance</span><b>${Math.round(pl.crit * 100)}%</b><span>Crit damage</span><b>x${pl.critMul.toFixed(2)}</b>
      <span>Max health</span><b>${Math.round(pl.maxHp)}</b><span>Regen</span><b>${pl.regen.toFixed(2)}/s</b>
      <span>Move speed</span><b>${Math.round(pl.speed)}</b><span>Pickup range</span><b>x${(pl.pickup * run.mods.pickupMul).toFixed(2)}</b>
      <span>Level</span><b>${pl.level}</b><span>Coins</span><b>${Math.floor(run.coins)}</b></div>
      <p class="muted">Crit chance and Crit damage come from the shop's Keen Edge upgrade, level-up boosts, Lightning cores and relics. Triggers like On Critical Hit fire on crits.</p>`;
    const info = tabsHtml + (this.tab === 'spell' ? spellInfo : this.tab === 'react' ? reactInfo : this.tab === 'relics' ? `<div class="spname">RELICS</div>${rm!.html}` : this.tab === 'stats' ? statsInfo : forgeInfo);

    const kinds: (RuneKind | 'all')[] = ['all', 'form', 'core', 'behavior', 'trigger', 'modifier'];
    const invRunes = RUNES.filter((r) => (run.inv[r.id] ?? 0) > 0 && (this.filter === 'all' || r.kind === this.filter));
    const total = Object.values(run.inv).reduce((a, b) => a + b, 0);
    const chips = invRunes.map((r) => `<div class="rchip inv ${this.sel === r.id ? 'sel' : ''}" draggable="true" data-rune="${r.id}" style="--c:${runeColor(r)}" title="${r.name}: ${r.desc}">
      <span class="ri">${r.icon}</span><span class="rn">${r.name}</span><span class="rc">${r.cost}</span><span class="rx">×${run.inv[r.id]}</span></div>`).join('');

    ed.innerHTML = `
      <header><h2>SPELL EDITOR</h2><div class="stabs">${tabs}</div><button class="x" data-a="close" title="Close (Esc / E)">X</button></header>
      <main>
        <section class="graphwrap">
          <div class="legend"><span style="--c:${KIND_COLOR.form}">FORM = the spell</span><span style="--c:${KIND_COLOR.core}">CORE = its element</span><span style="--c:${KIND_COLOR.behavior}">AUGMENTS = tweaks</span><span style="--c:${KIND_COLOR.trigger}">TRIGGER = launches more Forms</span></div>
          <div class="graph">${graph}</div>
          <div class="hintbar ${this.hintBad ? 'bad' : ''}">${this.hint || (this.sel ? `Selected ${RUNE_BY_ID[this.sel].name}. Click a glowing card to place it.` : 'Click a rune in your pool, then click a glowing card, or use the + buttons. Right-click removes.')}</div></section>
        <aside class="info">${info}</aside>
      </main>
      <footer class="inventory">
        <div class="invh"><b>RUNE POOL</b> <small>${total} rune${total === 1 ? '' : 's'}</small>
          <div class="filters">${kinds.map((k) => `<button data-filter="${k}" class="${this.filter === k ? 'on' : ''}" style="${k !== 'all' ? `--c:${KIND_COLOR[k]}` : ''}">${k === 'all' ? 'ALL' : KIND_LABEL[k].toUpperCase()}</button>`).join('')}
          ${this.sel ? '<button data-clear class="clr">DESELECT</button>' : ''}</div></div>
        <div class="chips">${chips || '<p class="muted">Nothing here. Level up and open Rune Caches to find more.</p>'}</div>
      </footer>`;
    const g2 = ed.querySelector('.graph') as HTMLElement;
    g2.scrollLeft = sl; g2.scrollTop = st;
    rm?.bind(ed.querySelector('.info') as HTMLElement);
  }
}
