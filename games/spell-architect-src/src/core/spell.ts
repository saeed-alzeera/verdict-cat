// Spell model. A spell SLOT holds a Form (the root). A Core rune is socketed into the Form to
// give it an element; Behaviors, Modifiers and Triggers attach to the Form too. Each Trigger
// launches further Forms (which may have their own Core). Includes validation, compilation,
// naming, a chained plain-language description, and damage estimation.
import {
  ELEMENTS, FORMS, RUNE_BY_ID, KIND_LABEL,
  type Element, type FormId, type TriggerType,
} from '../data/runes';
import { defaultMut, type Mut } from '../data/mutations';

export interface SpellNode { id: number; rune: string; children: SpellNode[] }
export interface SpellDef { uid: number; root: SpellNode | null; capacity: number }

let nodeSeq = 1;
let spellSeq = 1;
/** Global rule modifiers set by relics (recompile spells after changing). */
export const ruleMods = { triggerCost: 0, triggerChanceAdd: 0, triggerChanceMul: 1 };
export const costOf = (id: string): number => { const r = RUNE_BY_ID[id]; return r.cost + (r.kind === 'trigger' ? ruleMods.triggerCost : 0); };

/** No stack of boosts can push a trigger past this. */
export const MAX_TRIGGER_CHANCE = 0.9;
export const MAX_TRIGGER_NEST = 3;
export const MAX_TRIGGER_CHILDREN = 3;

export function newNode(rune: string): SpellNode { return { id: nodeSeq++, rune, children: [] }; }
export function newSpell(capacity: number): SpellDef { return { uid: spellSeq++, root: null, capacity }; }

export function walk(n: SpellNode, fn: (n: SpellNode, parent: SpellNode | null) => void, parent: SpellNode | null = null) {
  fn(n, parent);
  for (const c of n.children) walk(c, fn, n);
}

export function findNode(def: SpellDef, id: number): { node: SpellNode; parent: SpellNode | null } | null {
  let res: { node: SpellNode; parent: SpellNode | null } | null = null;
  if (def.root) walk(def.root, (n, p) => { if (n.id === id) res = { node: n, parent: p }; });
  return res;
}

export function pathTo(def: SpellDef, id: number): SpellNode[] {
  const out: SpellNode[] = [];
  const rec = (n: SpellNode): boolean => {
    out.push(n);
    if (n.id === id) return true;
    for (const c of n.children) if (rec(c)) return true;
    out.pop();
    return false;
  };
  if (def.root) rec(def.root);
  return out;
}

export function subtreeRunes(n: SpellNode): string[] {
  const out: string[] = [];
  walk(n, (x) => out.push(x.rune));
  return out;
}
export function subtreeCost(n: SpellNode): number {
  return subtreeRunes(n).reduce((a, r) => a + costOf(r), 0);
}
export function spellCost(def: SpellDef): number { return def.root ? subtreeCost(def.root) : 0; }

export interface Check { ok: boolean; reason: string }
const OK: Check = { ok: true, reason: 'Valid connection.' };
const no = (reason: string): Check => ({ ok: false, reason });

/**
 * Can `runeId` go under `parent` (null = an empty spell slot)?
 * `moving` is a node already in this spell being re-parented (its cost is already counted).
 */
export function checkAttach(def: SpellDef, parent: SpellNode | null, runeId: string, moving?: SpellNode): Check {
  const rune = RUNE_BY_ID[runeId];
  if (!rune) return no('Unknown rune.');
  const movingSet = new Set<number>();
  if (moving) walk(moving, (n) => movingSet.add(n.id));
  const kids = (p: SpellNode) => p.children.filter((c) => !movingSet.has(c.id));

  if (!parent) {
    if (rune.kind !== 'form') return no(`A spell slot holds a Form rune. ${rune.name} is a ${KIND_LABEL[rune.kind]}: put it into a Form's sockets instead.`);
    if (def.root && !moving) return no('This slot already has a Form. Remove it first.');
    return capacity();
  }
  if (moving && movingSet.has(parent.id)) return no("A rune can't be placed inside its own branch.");
  const prune = RUNE_BY_ID[parent.rune];

  if (prune.kind === 'form') {
    if (rune.kind === 'form') return no('A Form goes in a spell slot, or under a Trigger (so it launches when the trigger fires).');
    const f = prune.form!;
    if (rune.kind === 'core') {
      if (kids(parent).some((c) => RUNE_BY_ID[c.rune].kind === 'core')) return no(`${prune.name} already has a Core. Remove it first to swap elements.`);
      return capacity();
    }
    if (rune.forms && !rune.forms.includes(f)) {
      return no(`${rune.name} can't be used on ${FORMS[f].name}. It works with: ${rune.forms.map((x) => FORMS[x].name).join(', ')}.`);
    }
    const same = kids(parent).filter((c) => c.rune === rune.id).length;
    if (same >= (rune.maxStack ?? 1)) return no(`${rune.name} is already at its maximum (${rune.maxStack ?? 1}) on this form.`);
    if (rune.kind === 'trigger' && kids(parent).some((c) => RUNE_BY_ID[c.rune].trigger === rune.trigger)) return no(`This form already has an ${RUNE_BY_ID[kids(parent).find((c) => RUNE_BY_ID[c.rune].trigger === rune.trigger)!.rune].name.replace(/ (II|III|IV)$/, '')} trigger.`);
    if (rune.kind === 'trigger') {
      const depth = pathTo(def, parent.id).filter((n) => RUNE_BY_ID[n.rune].kind === 'trigger').length;
      if (depth >= MAX_TRIGGER_NEST) return no(`Triggers can only be nested ${MAX_TRIGGER_NEST} deep (prevents runaway spell loops).`);
    }
    return capacity();
  }
  if (prune.kind === 'trigger') {
    if (rune.kind !== 'form') return no(`A Trigger launches a new Form. ${rune.name} is a ${KIND_LABEL[rune.kind]}: put it on a Form instead.`);
    if (kids(parent).length >= MAX_TRIGGER_CHILDREN) return no(`A Trigger can launch at most ${MAX_TRIGGER_CHILDREN} effects.`);
    return capacity();
  }
  return no(`${prune.name} is a ${KIND_LABEL[prune.kind]} rune and can't hold other runes.`);

  function capacity(): Check {
    if (moving) return OK;
    const free = def.capacity - spellCost(def);
    const need = costOf(rune.id);
    if (need > free) return no(`Not enough Spell Capacity: ${rune.name} costs ${need}, only ${Math.max(0, free)} free.`);
    return OK;
  }
}

/* ------------------------------ Compilation ------------------------------ */

export interface CForm {
  nodeId: number;
  element: Element;
  form: FormId;
  b: Record<string, boolean>;
  m: { dup: number; acc: number; grow: number; dur: number; area: number; cd: number };
  triggers: { type: TriggerType; chance: number; children: CForm[] }[];
  depth: number;
  ownCore: boolean;
  evolved: boolean;
}

export interface Estimate { dmgCast: number; cd: number; dps: number; props: string[] }
export interface CompiledSpell {
  valid: boolean;
  root: CForm | null;
  name: string;
  story: string;
  cost: number;
  capacity: number;
  warnings: string[];
  elements: Element[];
  signature: string;
  runeCount: number;
  est: Estimate;
}

function compileForm(node: SpellNode, inherit: Element, depth: number, warnings: string[]): CForm {
  const rd = RUNE_BY_ID[node.rune];
  // Every Form has its own Core socket. No Core = plain Arcane (launched Forms do NOT inherit the parent's element).
  const core = node.children.find((c) => RUNE_BY_ID[c.rune].kind === 'core');
  const element: Element = core ? RUNE_BY_ID[core.rune].element! : 'arcane';
  void inherit;
  const f: CForm = {
    nodeId: node.id, element, form: rd.form!, b: {}, depth, ownCore: !!core, evolved: !!(core && RUNE_BY_ID[core.rune].evolved),
    m: { dup: 0, acc: 0, grow: 0, dur: 0, area: 0, cd: 0 }, triggers: [],
  };
  for (const c of node.children) {
    const cr = RUNE_BY_ID[c.rune];
    if (cr.kind === 'behavior') f.b[cr.key!] = true;
    else if (cr.kind === 'modifier') (f.m as Record<string, number>)[cr.key!]++;
    else if (cr.kind === 'trigger') {
      const base = cr.chance ?? 1;
      const chance = base >= 1 ? 1 : Math.min(MAX_TRIGGER_CHANCE, (base + ruleMods.triggerChanceAdd) * ruleMods.triggerChanceMul);
      const t: { type: TriggerType; chance: number; children: CForm[] } = { type: cr.trigger!, chance, children: [] };
      if (c.children.length === 0) warnings.push(`${cr.name} has no effect yet. Slot a Form into it.`);
      for (const k of c.children) t.children.push(compileForm(k, element, depth + 1, warnings));
      f.triggers.push(t);
    }
  }
  return f;
}

export function compileSpell(def: SpellDef): CompiledSpell {
  const warnings: string[] = [];
  const cost = spellCost(def);
  const base: CompiledSpell = {
    valid: false, root: null, name: 'Empty Slot', story: '', cost, capacity: def.capacity, warnings,
    elements: [], signature: '', runeCount: 0, est: { dmgCast: 0, cd: 0, dps: 0, props: [] },
  };
  if (!def.root) return base;
  const root = compileForm(def.root, 'arcane', 0, warnings);
  const els = new Set<Element>();
  const collect = (f: CForm) => { els.add(f.element); f.triggers.forEach((t) => t.children.forEach(collect)); };
  collect(root);
  let runeCount = 0;
  walk(def.root, () => runeCount++);
  const c: CompiledSpell = {
    ...base, valid: true, root, elements: [...els], runeCount,
    signature: signatureOf(def.root, 'Arcane'), name: nameSpell(root),
  };
  c.story = storyOf(root);
  c.est = estimate(root, defaultMut());
  return c;
}

export function signatureOf(n: SpellNode, inherit: string): string {
  const r = RUNE_BY_ID[n.rune];
  if (r.kind === 'trigger') return `${r.name} → ${n.children.map((k) => signatureOf(k, inherit)).join(' & ')}`;
  if (r.kind !== 'form') return r.name;
  const core = n.children.find((c) => RUNE_BY_ID[c.rune].kind === 'core');
  const el = core ? RUNE_BY_ID[core.rune].name : 'Arcane';
  void inherit;
  const rest = n.children.filter((c) => c !== core).map((c) => signatureOf(c, el));
  return [`${el} ${r.name}`, ...rest].join(' + ');
}

/* ------------------------------ Parameters ------------------------------ */

export const BASE_LIFE: Record<FormId, number> = { projectile: 1.5, beam: 0.8, orb: 6, aura: 7, mine: 14, nova: 0.6, meteor: 0.8 };

export function lifeOf(f: CForm): number {
  const base = f.form === 'projectile' && f.b.orbit ? 5 : BASE_LIFE[f.form];
  return base * (1 + 0.5 * f.m.dur);
}

export function spellCooldown(f: CForm, mut: Mut): number {
  return FORMS[f.form].cd * ELEMENTS[f.element].cd * Math.pow(0.8, f.m.cd) * mut.cd;
}

export function baseDamage(f: CForm, mut: Mut): number {
  return FORMS[f.form].dmg * ELEMENTS[f.element].dmg * (1 + 0.15 * f.m.grow) * mut.dmg * (f.depth > 0 ? 0.85 : 1) * (f.evolved ? 1.4 : 1);
}

export function copiesOf(f: CForm, mut: Mut): number { return 1 + f.m.dup + mut.dup; }

const TRIG_RATE: Record<TriggerType, number> = { hit: 1, kill: 0.4, expiry: 1, crit: 0.25 };

function singleTargetDamage(f: CForm, mut: Mut): number {
  const d = baseDamage(f, mut);
  const life = lifeOf(f);
  const tickScale = 1 + 0.4 * f.m.acc;
  let per = d;
  switch (f.form) {
    case 'beam': per = d * (life / (0.1 / tickScale)) * 0.8; break;
    case 'orb': per = d * (2 + f.m.dup + mut.dup) * (life / 0.45) * 0.35; break;
    case 'aura': per = d * (life / (0.5 / tickScale)); break;
    case 'projectile':
      if (f.b.split) per += d * 0.55 * 1.5;
      if (f.b.chain) per += d * 0.7 * 1.5;
      break;
    case 'mine': case 'meteor': case 'nova': if (f.b.chain) per += d * 0.7 * 1.5; break;
  }
  if (f.form !== 'orb') per *= copiesOf(f, mut);
  return per;
}

function totalDamage(f: CForm, mut: Mut): number {
  let t = singleTargetDamage(f, mut);
  for (const tr of f.triggers) for (const c of tr.children) t += totalDamage(c, mut) * TRIG_RATE[tr.type] * tr.chance;
  return t;
}

export function estimate(root: CForm, mut: Mut): Estimate {
  const cd = spellCooldown(root, mut);
  const persistent = root.form === 'orb' || root.form === 'aura' || (root.form === 'projectile' && root.b.orbit);
  const cycle = persistent ? lifeOf(root) + cd : cd;
  const dmgCast = totalDamage(root, mut);
  const p: string[] = [];
  if (root.b.pierce) p.push('Pierce 3');
  if (root.b.chain) p.push('Chain 3');
  if (root.b.bounce) p.push('Bounce 3');
  if (root.b.split) p.push('Split ×3');
  if (copiesOf(root, mut) > 1) p.push(`${copiesOf(root, mut)} copies`);
  return { dmgCast, cd, dps: dmgCast / cycle, props: p };
}

/* --------------------------- Naming & description --------------------------- */

const BEH_ADJ: [string, string][] = [
  ['split', 'Splitting'], ['chain', 'Arcing'], ['bounce', 'Ricochet'], ['pierce', 'Piercing'],
  ['homing', 'Seeking'], ['orbit', 'Orbiting'], ['pull', 'Dragging'], ['expand', 'Swelling'],
];
const TRIG_WORD: Record<TriggerType, string> = { hit: 'Impact', kill: 'Reaping', expiry: 'Fading', crit: 'Fortune' };

export function nameSpell(f: CForm): string {
  const adj: string[] = [];
  if (f.m.dup === 1) adj.push('Twin'); else if (f.m.dup >= 2) adj.push('Triple');
  for (const [k, a] of BEH_ADJ) if (f.b[k] && adj.length < 2) adj.push(a);
  if (adj.length < 2 && f.m.grow >= 2) adj.push('Greater');
  else if (adj.length < 2 && f.m.acc >= 2) adj.push('Swift');
  let name = [...adj, ELEMENTS[f.element].noun[f.form]].join(' ');
  if (f.triggers.length === 1) name += ` of ${TRIG_WORD[f.triggers[0].type]}`;
  else if (f.triggers.length > 1) name += ' of Cascades';
  return name;
}

const BEH_TEXT: Record<string, string> = {
  split: 'splits into 3 smaller copies',
  pierce: 'pierces up to 3 enemies',
  bounce: 'ricochets between enemies and walls',
  chain: 'arcs lightning to 3 nearby enemies',
  orbit: 'circles around you',
  homing: 'homes in on enemies',
  pull: 'drags enemies toward it',
  expand: 'grows over time',
};
const FORM_VERB: Record<FormId, string> = {
  projectile: 'launches', beam: 'fires', orb: 'conjures', aura: 'raises', mine: 'lays', nova: 'releases', meteor: 'calls down',
};
const WHEN: Record<TriggerType, string> = {
  hit: 'it hits an enemy', kill: 'it kills an enemy', expiry: 'it ends', crit: 'it lands a critical hit',
};
const WHEN_SHORT: Record<TriggerType, string> = {
  hit: 'on hitting an enemy', kill: 'on killing an enemy', expiry: 'when it ends', crit: 'on a critical hit',
};

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

function modsOf(f: CForm, isRoot: boolean): string[] {
  const mods: string[] = [];
  if (f.m.acc) mods.push(`+${f.m.acc * 40}% speed`);
  if (f.m.grow) mods.push(`+${f.m.grow * 30}% size and damage`);
  if (f.m.dur) mods.push(`+${f.m.dur * 50}% duration`);
  if (f.m.area) mods.push(`+${f.m.area * 35}% area`);
  if (f.m.cd && isRoot) mods.push(`-${Math.round((1 - Math.pow(0.8, f.m.cd)) * 100)}% cooldown`);
  return mods;
}

/** One form as a clause: "launches 2× Fireball that splits into 3 smaller copies, which on hitting an enemy raises a Frost Ring". */
function clause(f: CForm, isRoot: boolean): string {
  const noun = ELEMENTS[f.element].noun[f.form];
  const copies = f.m.dup > 0 ? `${1 + f.m.dup}× ` : 'a ';
  let s = `${FORM_VERB[f.form]} ${copies}${noun}`;
  const b = BEH_ADJ.filter(([k]) => f.b[k]).map(([k]) => BEH_TEXT[k]);
  if (b.length) s += ` that ${joinAnd(b)}`;
  const m = modsOf(f, isRoot);
  if (m.length) s += ` (${m.join(', ')})`;
  for (const t of f.triggers) {
    if (!t.children.length) continue;
    s += `, which ${WHEN_SHORT[t.type]}${t.chance < 1 ? ` (${Math.round(t.chance * 100)}% chance)` : ''} ${joinAnd(t.children.map((c) => clause(c, false)))}`;
  }
  return s;
}

/** Whole-spell plain-language story, as flowing chained sentences. */
export function storyOf(root: CForm): string {
  const cd = FORMS[root.form] ? '' : '';
  void cd;
  const noun = ELEMENTS[root.element].noun[root.form];
  const copies = root.m.dup > 0 ? `${1 + root.m.dup}× ` : 'a ';
  let first = `${FORM_VERB[root.form][0].toUpperCase()}${FORM_VERB[root.form].slice(1)} ${copies}${noun}`;
  const b = BEH_ADJ.filter(([k]) => root.b[k]).map(([k]) => BEH_TEXT[k]);
  if (b.length) first += ` that ${joinAnd(b)}`;
  const m = modsOf(root, true);
  if (m.length) first += ` (${m.join(', ')})`;
  const sentences = [first + '.'];
  for (const t of root.triggers) {
    if (!t.children.length) continue;
    sentences.push(`When ${WHEN[t.type]}, ${t.chance < 1 ? `${Math.round(t.chance * 100)}% of the time ` : ''}it ${joinAnd(t.children.map((c) => clause(c, false)))}.`);
  }
  return sentences.join(' ');
}
