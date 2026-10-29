import type Phaser from 'phaser';
import type { Element, FormId, TriggerType } from '../data/runes';
import type { CForm, CompiledSpell, SpellDef } from '../core/spell';
import type { Mut, StatKey } from '../data/mutations';
import type { Aff } from './rounds';

export type EntKind = FormId | 'decal';
export type Img = Phaser.GameObjects.Image;

export interface ActiveSpell {
  uid: number;
  def: SpellDef;
  c: CompiledSpell;
  cd: number;
  live: number; // living root entities (for persistent forms)
  mut: Mut;
  mutations: string[];
  tiers: Record<string, number>;
  st: Record<StatKey, number>;
  damage: number;
  ultCd: number;
  casts: number;
  crits: number;
}

/** Provenance of a damage instance; also stored on statuses so DoT kills still trigger runes. */
export interface Src {
  sp: ActiveSpell;
  f: CForm;
  depth: number;
  el: Element;
  icd: { hit: number; crit: number };
}

export type EType = 'grunt' | 'swarmer' | 'archer' | 'charger' | 'armored' | 'shaman' | 'boss';

export interface BossState {
  kind: number;
  name: string;
  phase: number;
  cd: number;
  atk: string;
  atkT: number;
  dash: number;
  dx: number;
  dy: number;
  spiral: number;
  spiralAng: number;
  pull: number;
  last: string;
  enraged: boolean;
}

export interface Enemy {
  id: number;
  type: EType;
  x: number; y: number; vx: number; vy: number;
  hp: number; maxHp: number; r: number; speed: number; dmg: number; armor: number; xp: number;
  elite: boolean; sc: number;
  spr: Img; shadow: Img;
  flash: number; face: number; wob: number;
  wet: number;
  burn: number; burnDps: number; burnSrc: Src | null;
  chill: number; chillT: number;
  freeze: number; freezeImm: number;
  poison: number; poisonT: number; poisonDps: number; poisonSrc: Src | null;
  tickT: number; burnT: number; dotAcc: number; dotShow: number;
  slowT: number; slowMul: number; buff: number; capT: number; pulled: number; tint: number; conductCd: number;
  atk: number; st: number; stT: number; dx: number; dy: number;
  contact: number; spawnT: number; dashes: number;
  aff: Aff; res: Partial<Record<Element, number>>; badge: Img | null; resTxt: number; hitOnce: boolean;
  dead: boolean;
  boss: BossState | null;
}

export interface SEnt {
  id: number;
  sp: ActiveSpell;
  f: CForm;
  src: Src;
  kind: EntKind;
  el: Element;
  depth: number;
  x: number; y: number; vx: number; vy: number; ang: number;
  life: number; maxLife: number;
  r: number; baseR: number; dmg: number; speed: number;
  tick: number; tickT: number;
  pierce: number; bounce: number; chain: number; splitDone: boolean;
  hit: Map<number, number>;
  anchor: boolean; // true: follows the player; false: fixed point
  ax: number; ay: number;
  idx: number; n: number; orbAng: number; orbR: number; orbSpd: number;
  armT: number; blast: number;
  len: number; width: number;
  env: '' | 'puddle' | 'cloud';
  electric: number; ice: boolean; eSrc: Src | null;
  root: boolean; dead: boolean; silent: boolean;
  fireChk: number; target: number; strikeT: number;
  expand: boolean; pull: boolean; pullR: number; pullF: number;
  fxT: number; deco: Img[];
  spr: Img; spr2: Img | null;
}

export interface EBullet {
  id: number; x: number; y: number; vx: number; vy: number; r: number; dmg: number; life: number; spr: Img; dead: boolean;
}

export interface Pickup {
  id: number; x: number; y: number; type: 'xp' | 'coin' | 'heal' | 'cache'; v: number; spr: Img; fly: boolean; t: number; dead: boolean;
}

export interface Telegraph {
  id: number;
  shape: 'circle' | 'line' | 'ring' | 'windup';
  x: number; y: number; r: number; ang: number; len: number; w: number;
  t: number; total: number; color: number;
  follow: Enemy | null; // origin tracks this enemy
  onDone: () => void;
  dead: boolean;
}

export interface Zone { id: number; x: number; y: number; r: number; t: number; dmg: number; tick: number; spr: Img; dead: boolean }

export type EventType = TriggerType;
export interface GameEvent { type: EventType; src: Src; x: number; y: number; ang: number }

export interface Player {
  x: number; y: number; vx: number; vy: number;
  hp: number; maxHp: number; speed: number; r: number;
  inv: number; hurtFlash: number; regen: number;
  dmgMul: number; cdMul: number; crit: number; critMul: number;
  level: number; xp: number; xpNeed: number;
  faceX: number; walkT: number; pullX: number; pullY: number; pullT: number;
}
