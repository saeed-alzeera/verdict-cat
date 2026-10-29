// The Run: owns all simulation state for one playthrough and advances it each frame.
import Phaser from 'phaser';
import { RUNES, RUNE_BY_ID, mergeResult, tierUpResult, EVOLVE_COST, BASE_CORE_OF, EVOLVED_OF, ELEMENTS, type Rarity } from '../data/runes';
import { MUT_TRACKS, MUT_OPTION_BY_ID, defaultMut, type MutTrack } from '../data/mutations';
import { compileSpell, newNode, newSpell, walk, type SpellDef } from '../core/spell';
import { store } from '../core/save';
import { audio } from '../core/audio';
import { Fx } from './fx';
import type { ActiveSpell, EBullet, Enemy, GameEvent, Img, Pickup, Player, SEnt, Src, Telegraph, Zone, EventType } from './types';
import { updateDirector, updateEnemies, openRound } from './enemies';
import { planFor, roundLen, isBossRound, FINAL_ROUND, ROUND_DIFF, type Plan } from './rounds';
import { castUltimate, ULT_COOLDOWN } from './ultimates';
import { newShop, refreshPrices, type Shop } from './shop';
import { RELIC_BY_ID, RELIC_SLOTS, recomputeMods, onRoundStart, onLethal, onKill, rollRelics } from './relics';
import { saveRunRecord, type RunRecord, type RoundRec } from '../core/analytics';
import { ruleMods } from '../core/spell';
import { generateRewards } from './rewards';
import { drawTelegraph } from './draw';
import { freshBonus, ritualEvent, ritualRoundEnd, ritualRoundStart, type ActiveRitual, type RitualBonus } from './rituals';
import { updateCasting, updateEnts, processEvents } from './casting';

import { Arena, ARENA, tileCx, tileCy } from './arena';
import { stepMove } from './move';
import { applyTint, poseEnemy, poseWizard, tintKey } from './render';
export { ARENA };

/** Ids for the small world objects (enemy bullets, pickups, zones) so a co-op joiner can follow each one between snapshots. */
let oid = 1;
const nextOid = () => (oid = (oid + 1) & 0xffff || 1);
const CELL = 64;
/** Health income (the run-long health budget was the main killer in the saved runs): a slow baseline regen and a modest heal at each round start. */
export const BASE_REGEN = 0.15; // HP per second, about 7 HP over a 45 s round
export const ROUND_START_HEAL = 0.06; // of max HP
/** Apprentice's focus: spells hit harder in the first rounds (+60% in round 1, fading to nothing by round 5) so the weak starter is not dead time. */
export const EARLY_POWER = 0.6;
export const earlyPower = (round: number) => 1 + EARLY_POWER * Math.max(0, 1 - (round - 1) / 4);

export type Pending =
  | { type: 'levelup' }
  | { type: 'cache' }
  | { type: 'relic'; options: string[] }
  | { type: 'mutation'; sp: ActiveSpell; track: MutTrack };

/** One frame of a joiner's input: stick direction as signed bytes and how long it was held (seconds, quantised to 1/4000 s). */
export interface Cmd { seq: number; ix: number; iy: number; dt: number }

/** Co-op plumbing handed to a Run (see net/coop.ts). */
export interface CoopLink {
  role: 'host' | 'guest';
  code: string;
  /** Host: false (with a message) while guests are not ready. Called before a round starts. */
  beforeStart?(): string | null;
  /** Host: a round has just started (tell the guests). */
  onStart?(): void;
  /** Host: the run moved back to the prep phase (send results to guests). */
  onPrep?(): void;
  /** Host: the run ended. */
  onOver?(won: boolean): void;
  /** Guest: Space pressed. Returns whether an ultimate was available. */
  ult(): boolean;
  /** Leave the game (guest) or end it for everyone (host). */
  leave(): void;
}
export interface RunOpts { quick: boolean; core: string; form: string; sandbox?: boolean; mp?: import('../net/coop').MpOpts } // core '' = no element (Arcane)
export interface RunSummary {
  won: boolean; time: number; level: number; kills: number; damage: number; shards: number;
  spells: { name: string; damage: number; kills: number; elements: string[] }[];
  discoveries: string[]; quick: boolean; bosses: number; reactions: number; round: number; id: string;
}

/** Per-player build handed between a guest and the host (plain JSON). */
export interface Build {
  spells: { def: SpellDef; mutations: string[]; tiers: Record<string, number>; st: ActiveSpell['st']; damage: number; ultCd: number }[];
  player: Omit<Player, 'x' | 'y' | 'vx' | 'vy' | 'inv' | 'hurtFlash' | 'walkT' | 'pullX' | 'pullY' | 'pullT' | 'faceX'>;
  owned: string[]; equipped: string[]; relicState: Record<string, Record<string, number>>;
}

export class Run {
  /** The world (host) Run. Remote players are "shells": objects inheriting from the world that own their personal state. */
  world: Run = this;
  players: Run[] = [this];
  pid = 0;
  pname = 'You';
  remote = false; // a shell for a remote guest (its build lives on the guest's machine)
  down = false;
  ownerMap = new WeakMap<object, Run>();
  /** Set by the co-op session on the host: delivers a reward to a remote player. */
  onRemotePending: (pr: Run, item: Pending) => void = () => {};
  private _boss: Enemy | null = null;
  private _sb = 36;
  get boss(): Enemy | null { return this.world._boss; }
  set boss(v: Enemy | null) { this.world._boss = v; }
  get spawnBudget(): number { return this.world._sb; }
  set spawnBudget(v: number) { this.world._sb = v; }
  fx: Fx;
  player: Player;
  enemies: Enemy[] = [];
  ents: SEnt[] = [];
  hazards: SEnt[] = [];
  bullets: EBullet[] = [];
  pickups: Pickup[] = [];
  tels: Telegraph[] = [];
  zones: Zone[] = [];
  events: GameEvent[] = [];
  laters: { t: number; fn: () => void }[] = [];
  gridN = Math.ceil(ARENA / CELL);
  grid: Enemy[][] = [];
  byId = new Map<number, Enemy>();

  spells: ActiveSpell[] = [];
  slots = 3;
  inv: Record<string, number> = {};
  capBase = 12;
  coins = 9;
  buys: Record<string, number> = {};
  shop: Shop = { stock: [], rerolls: 0, rituals: [] };
  /** Rituals (see rituals.ts): the contracts you have accepted, their per-round tallies and the permanent bonuses they paid. */
  rituals: ActiveRitual[] = [];
  ritualRound: { hurt: number; react: Set<string> } = { hurt: 0, react: new Set() };
  ritualBonus: RitualBonus = freshBonus();
  shopOpened = true;
  seed = (Math.random() * 2147483647) | 0;
  startedAt = Date.now();
  owned: string[] = [];
  equipped: string[] = [];
  relicState: Record<string, Record<string, number>> = {};
  inRelic = false;
  critKill = false;
  mods = { elements: 0, poisonCap: 0, coinMul: 1, priceMul: 1, rerollMul: 1, rerollMinus: 0, forgeMinus: 0 };
  roundLog: RoundRec[] = [];
  hurtBy: Record<string, number> = {};
  lastHurt = '';
  snap = { kills: 0, damage: 0, taken: 0, spell: [] as number[], t: 0, coins: 0 };
  ultTrack: { sp: ActiveSpell; t: number; kills: number } | null = null;
  saved = false;

  time = 0;
  dtime = 0;
  kills = 0;
  totalDamage = 0;
  reactionCount = 0;
  reactTxt: Record<string, number> = {};
  quick: boolean;
  spawnAcc = 0;
  round = 1;
  roundElapsed = 0;
  phase: 'prep' | 'fight' | 'clearing' | 'sandbox' = 'prep';
  clearT = 0;
  plan: Plan = planFor(1);
  pieces = new Set<string>();
  sandbox = false;
  god = false;
  dummy = false;
  bossesKilled = 0;
  won = false;
  over = false;
  frozen = false;
  victoryT = 0;
  pending: Pending[] = [];
  rerolls = 2;
  discoveries: string[] = [];
  mutT = 0;
  imgPool: Img[] = [];
  telGfx: Phaser.GameObjects.Graphics;
  floorGfx: Phaser.GameObjects.Graphics;
  arena = new Arena();
  input = { x: 0, y: 0 };
  /** Remote shells (host): joiner input commands waiting to be applied, the time budget left to apply them, the newest queued
   *  and the newest applied sequence numbers. */
  cmdQ: Cmd[] = [];
  cmdCredit = 0.25;
  cmdSeq = 0;
  cmdAck = 0;
  gemCount = 0;
  boosts: string[] = []; // stat boosts gained from level-ups this run
  openerDone = false;
  viewW = 1280;
  viewH = 720;

  coop: CoopLink | null = null;
  onAnnounce: (text: string, color: string, sub?: string) => void = () => {};
  onEnd: (s: RunSummary) => void = () => {};

  constructor(public scene: Phaser.Scene, public opts: RunOpts) {
    this.quick = opts.quick;
    this.sandbox = !!opts.sandbox;
    this.fx = new Fx(scene);
    this.floorGfx = scene.add.graphics().setDepth(0.5);
    this.telGfx = scene.add.graphics().setDepth(2);
    for (let i = 0; i < this.gridN * this.gridN; i++) this.grid.push([]);
    this.player = {
      x: ARENA / 2, y: ARENA / 2, vx: 0, vy: 0, hp: 100, maxHp: 100, speed: 330, r: 10, inv: 0, hurtFlash: 0, regen: BASE_REGEN,
      dmgMul: 1, cdMul: 1, crit: 0.05, critMul: 1.8, level: 1, xp: 0, xpNeed: this.xpFor(1),
      faceX: 1, walkT: 0, pullX: 0, pullY: 0, pullT: 0,
    };
    // slots
    for (let i = 0; i < this.slots; i++) this.spells.push(this.makeSpell());
    // starter spell: a Form in slot 1 with a Core socketed in it, plus a few spare runes
    const sp0 = this.spells[0];
    sp0.def.root = newNode(opts.form);
    if (opts.core) sp0.def.root.children.push(newNode(opts.core));
    this.recompile(sp0, true);
    // starting spares are always Common (no rare trigger tiers or strong forms on turn one)
    const unl = RUNES.filter((r) => store.isUnlocked(r.id) && !r.evolved && r.rarity === 'common');
    const pick = (f: (r: typeof RUNES[number]) => boolean, exclude: string[] = []) => {
      const c = unl.filter((r) => f(r) && !exclude.includes(r.id));
      return c.length ? c[(Math.random() * c.length) | 0] : null;
    };
    const f2 = pick((r) => r.kind === 'form', [opts.form]);
    const b = pick((r) => r.kind === 'behavior' || r.kind === 'trigger');
    const m = pick((r) => r.kind === 'modifier');
    for (const r of [f2, b, m]) if (r) this.addRune(r.id, 1);
    this.shop = newShop(this);
    if (this.sandbox) {
      this.phase = 'sandbox'; this.god = true; this.round = 8; this.plan = planFor(8, this.seed); this.dtime = 150;
      this.addSlot(); this.addSlot();
      this.addCapacity(40);
      for (const r of RUNES) this.inv[r.id] = r.evolved ? 3 : r.kind === 'form' ? 4 : 6;
    } else {
      this.phase = 'prep';
      this.frozen = true; // the round briefing / editor opens first (see ui.pump)
    }
    this.arena.reset();
    this.recalcEnemyIndex();
  }

  /* ------------------------------ players (co-op) ------------------------------ */

  /** The Run (player) that owns a spell: its caster's stats, relics and rewards apply. Solo: always this world. */
  owner(sp: object | undefined): Run {
    const w = this.world;
    if (w.players.length < 2 || !sp) return w;
    return w.ownerMap.get(sp) ?? w;
  }
  rebuildOwners() {
    const w = this.world;
    w.ownerMap = new WeakMap();
    for (const pr of w.players) for (const sp of pr.spells) w.ownerMap.set(sp, pr);
  }
  alive(): Run[] { return this.world.players.filter((p) => !p.down); }
  /** The nearest living player to a point (null when everyone is down). */
  nearestPlayer(x: number, y: number): Run | null {
    let best: Run | null = null, bd = Infinity;
    for (const pr of this.world.players) {
      if (pr.down) continue;
      const d = (pr.player.x - x) ** 2 + (pr.player.y - y) ** 2;
      if (d < bd) { bd = d; best = pr; }
    }
    return best;
  }
  randomPlayer(): Run {
    const a = this.alive();
    return a.length ? a[(Math.random() * a.length) | 0] : this.world;
  }

  /** Create a shell for a remote player: shares the world, owns its personal state (spells, stats, relics, rewards). */
  addRemotePlayer(pid: number, name: string): Run {
    const w = this.world;
    const s = Object.create(w) as Run;
    const p = this.freshPlayer();
    Object.assign(s, {
      pid, pname: name, remote: true, down: false,
      player: p, spells: [] as ActiveSpell[], slots: 0, inv: {}, coins: 0, buys: {}, owned: [] as string[], equipped: [] as string[],
      relicState: {}, inRelic: false, critKill: false, kills: 0, totalDamage: 0, reactionCount: 0, hurtBy: {}, lastHurt: '', pending: [] as Pending[],
      boosts: [] as string[], input: { x: 0, y: 0 }, ultTrack: null, capExtra: 0, cmdQ: [] as Cmd[], cmdCredit: 0.25, cmdSeq: 0, cmdAck: 0,
      mods: { elements: 0, poisonCap: 0, coinMul: 1, priceMul: 1, rerollMul: 1, rerollMinus: 0, forgeMinus: 0 },
    });
    w.players.push(s);
    return s;
  }
  removePlayer(pr: Run) {
    const w = this.world;
    const i = w.players.indexOf(pr);
    if (i > 0) w.players.splice(i, 1);
    pr.down = true;
    w.rebuildOwners();
    if (w.players.every((q) => q.down) && !w.over && w.phase === 'fight') w.finish(false);
  }

  freshPlayer(): Player {
    return {
      x: ARENA / 2, y: ARENA / 2, vx: 0, vy: 0, hp: 100, maxHp: 100, speed: 330, r: 10, inv: 0, hurtFlash: 0, regen: BASE_REGEN,
      dmgMul: 1, cdMul: 1, crit: 0.05, critMul: 1.8, level: 1, xp: 0, xpNeed: this.xpFor(1),
      faceX: 1, walkT: 0, pullX: 0, pullY: 0, pullT: 0,
    };
  }

  /** Everything a guest's machine needs to know to describe its character to the host. */
  exportBuild(): Build {
    const { x, y, vx, vy, inv, hurtFlash, walkT, pullX, pullY, pullT, faceX, ...stats } = this.player;
    void x; void y; void vx; void vy; void inv; void hurtFlash; void walkT; void pullX; void pullY; void pullT; void faceX;
    return {
      spells: this.spells.map((sp) => ({ def: JSON.parse(JSON.stringify(sp.def)), mutations: [...sp.mutations], tiers: { ...sp.tiers }, st: { ...sp.st }, damage: sp.damage, ultCd: sp.ultCd })),
      player: { ...stats }, owned: [...this.owned], equipped: [...this.equipped], relicState: JSON.parse(JSON.stringify(this.relicState)),
    };
  }

  /** Host side: instantiate a guest's build on its shell (compiled with that guest's relic rules). */
  applyBuild(b: Build) {
    const w = this.world;
    Object.assign(this.player, b.player);
    this.owned = [...b.owned]; this.equipped = [...b.equipped];
    this.relicState = JSON.parse(JSON.stringify(b.relicState));
    recomputeMods(this); // sets this.mods and the global trigger rules for this player's relics
    this.spells = b.spells.map((bs) => {
      const def: SpellDef = JSON.parse(JSON.stringify(bs.def));
      const sp: ActiveSpell = {
        uid: def.uid, def, c: compileSpell(def), cd: 0.3, live: 0, mut: defaultMut(), mutations: [...bs.mutations], tiers: { ...bs.tiers },
        st: { ...bs.st }, damage: bs.damage, ultCd: bs.ultCd, casts: 0, crits: 0,
      };
      this.recomputeMut(sp);
      return sp;
    });
    this.slots = this.spells.length;
    recomputeMods(w); // put the world's own trigger rules back
    w.rebuildOwners();
  }

  /** Stats to hand back to a guest after a round (their build plus what the round changed). */
  roundResult() {
    return { build: this.exportBuild(), coins: this.coins, kills: this.kills, damage: Math.round(this.totalDamage), boosts: [...this.boosts] };
  }

  /* ------------------------------ helpers ------------------------------ */

  xpFor(l: number) { return 8 + 8 * l + 0.5 * l * l; }

  makeSpell(): ActiveSpell {
    const def: SpellDef = newSpell(this.capBase + this.capBonus());
    return {
      uid: def.uid, def, c: compileSpell(def), cd: 0.3, live: 0, mut: defaultMut(), mutations: [], tiers: {},
      st: { kills: 0, burnKills: 0, chainJumps: 0, captured: 0, freezes: 0, spreads: 0, wetHits: 0, reactions: 0 },
      damage: 0, ultCd: 0, casts: 0, crits: 0,
    };
  }
  private capExtra = 0;
  capBonus() { return this.capExtra; }

  addCapacity(n: number) {
    this.capExtra += n;
    for (const sp of this.spells) sp.def.capacity += n;
  }
  addSlot() { this.slots++; this.spells.push(this.makeSpell()); }
  addCoins(n: number) { this.coins += n; }
  addRune(id: string, n: number) { this.inv[id] = (this.inv[id] ?? 0) + n; store.seeRune(id); }
  heal(n: number) {
    const p = this.player;
    p.hp = Math.min(p.maxHp, p.hp + n);
    this.fx.text(p.x, p.y - 30, `+${Math.round(n)}`, '#7dff9a', 16, 0.8);
  }
  announce(text: string, color: string, sub?: string) { this.onAnnounce(text, color, sub); }

  recompile(sp: ActiveSpell, silent = false) {
    sp.c = compileSpell(sp.def);
    this.recomputeMut(sp);
    // Cracked Prism counts elements across the whole loadout, so keep it current whenever any spell changes
    const els = new Set<string>();
    for (const o of this.spells) if (o.c?.valid) for (const e of o.c.elements) if (e !== 'arcane') els.add(e);
    this.mods.elements = els.size;
    if (!this.remote && sp.c.valid && sp.c.runeCount >= 3) {
      const first = store.discoverCombo(sp.c.signature, sp.c.name);
      if (first && !silent) {
        this.discoveries.push(`combo:${sp.c.signature}`);
        this.announce('NEW COMBINATION', '#7cf0ff', `${sp.c.name} added to the Discovery Journal`);
      }
    }
  }

  recomputeMut(sp: ActiveSpell) {
    const m = defaultMut();
    for (const id of sp.mutations) MUT_OPTION_BY_ID[id]?.apply(m);
    const root = sp.c?.root;
    if (root?.evolved) {
      switch (root.element) {
        case 'fire': m.pyre = true; m.splash *= 1.3; break;
        case 'ice': m.freezeT *= 1.5; m.shatter = true; break;
        case 'lightning': m.chain += 2; m.crit += 0.1; m.overcharge = true; break;
        case 'poison': m.polStacks += 3; m.spread *= 1.5; m.bloom = true; break;
        case 'water': m.tide *= 1.5; m.conduct *= 1.5; break;
        case 'gravity': m.pullR *= 1.3; m.collapse *= 2; break;
      }
    }
    m.polStacks += this.mods.poisonCap;
    sp.mut = m;
  }

  /* ------------------------------ relics ------------------------------ */

  recomputeRelics() {
    recomputeMods(this);
    for (const sp of this.spells) this.recompile(sp, true);
    if (!this.remote) refreshPrices(this); // Bargain Bell & co. take effect on the shelf immediately
  }
  addRelic(id: string, announce = true) {
    if (this.owned.includes(id)) return;
    this.owned.push(id);
    const d = RELIC_BY_ID[id];
    if (this.equipped.length < RELIC_SLOTS) this.equipRelic(id);
    if (announce) this.announce(`RELIC: ${d.name.toUpperCase()}`, d.cursed ? '#ff5a6a' : '#ffd25a', this.equipped.includes(id) ? d.desc : 'Stored in your stash. Swap it in between rounds.');
  }
  equipRelic(id: string): boolean {
    if (!this.owned.includes(id) || this.equipped.includes(id) || this.equipped.length >= RELIC_SLOTS) return false;
    this.equipped.push(id);
    RELIC_BY_ID[id].onEquip?.(this);
    this.recomputeRelics();
    return true;
  }
  unequipRelic(id: string) {
    const i = this.equipped.indexOf(id);
    if (i < 0) return;
    RELIC_BY_ID[id].onUnequip?.(this);
    this.equipped.splice(i, 1);
    this.recomputeRelics();
  }
  /** Merge two same-type triggers from the pool into one with the summed chance. Returns an error message or null. */
  mergeTriggers(a: string, b: string): string | null {
    const res = mergeResult(a, b);
    if (typeof res === 'string') return res;
    const need: Record<string, number> = {};
    need[a] = (need[a] ?? 0) + 1; need[b] = (need[b] ?? 0) + 1;
    for (const [id, n] of Object.entries(need)) if ((this.inv[id] ?? 0) < n) return 'You need both triggers in your rune pool (take them out of the spell first).';
    this.inv[a]--; this.inv[b]--;
    this.addRune(res.id, 1);
    return null;
  }
  /** Forge two identical triggers from the pool into the next level. Returns an error message or null. */
  forgeTriggerUp(a: string, b: string): string | null {
    const res = tierUpResult(a, b);
    if (typeof res === 'string') return res;
    if ((this.inv[a] ?? 0) < 2) return 'You need two of them in your rune pool (take them out of the spell first).';
    this.inv[a] -= 2;
    this.addRune(res.id, 1);
    return null;
  }
  forgeCost(): number { return Math.max(2, EVOLVE_COST - this.mods.forgeMinus); }
  private setCurse() { void ruleMods; }
  applyMutation(sp: ActiveSpell, track: MutTrack, optId: string) {
    sp.mutations.push(`${track.id}:${optId}`);
    this.recomputeMut(sp);
  }

  img(tex: string, depth: number, add = false): Img {
    let im = this.imgPool.pop();
    if (!im) im = this.scene.add.image(0, 0, tex);
    im.setTexture(tex).setDepth(depth).setVisible(true).setAlpha(1).setScale(1).setRotation(0).clearTint()
      .setFlip(false, false).setOrigin(0.5, 0.5).setBlendMode(add ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL);
    return im;
  }
  freeImg(im: Img | null) { if (im) { im.setVisible(false); this.imgPool.push(im); } }

  queueEvent(type: EventType, src: Src, x: number, y: number, ang: number) {
    if (!src.f.triggers.some((t) => t.type === type)) return;
    if (type === 'hit' || type === 'crit') {
      if (this.time < src.icd[type]) return;
      src.icd[type] = this.time + 0.12;
    }
    if (this.events.length > 300) return;
    this.events.push({ type, src, x, y, ang });
  }

  /** Queue a reward for this player: locally, or sent to their machine when they are a remote guest. */
  pushPending(item: Pending) {
    if (this.remote) this.world.onRemotePending(this, item);
    else this.pending.push(item);
  }

  later(t: number, fn: () => void) { this.laters.push({ t, fn }); }

  /* ------------------------------ spatial ------------------------------ */

  private recalcEnemyIndex() {
    for (const c of this.grid) c.length = 0;
    this.byId.clear();
    const N = this.gridN;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const cx = Math.max(0, Math.min(N - 1, (e.x / CELL) | 0)), cy = Math.max(0, Math.min(N - 1, (e.y / CELL) | 0));
      this.grid[cy * N + cx].push(e);
      this.byId.set(e.id, e);
    }
  }

  query(x: number, y: number, r: number): Enemy[] {
    const out: Enemy[] = [];
    const N = this.gridN, pad = r + 42;
    const x0 = Math.max(0, ((x - pad) / CELL) | 0), x1 = Math.min(N - 1, ((x + pad) / CELL) | 0);
    const y0 = Math.max(0, ((y - pad) / CELL) | 0), y1 = Math.min(N - 1, ((y + pad) / CELL) | 0);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = this.grid[gy * N + gx];
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          if (e.dead) continue;
          const dx = e.x - x, dy = e.y - y, rr = r + e.r;
          if (dx * dx + dy * dy <= rr * rr) out.push(e);
        }
      }
    }
    return out;
  }

  nearest(x: number, y: number, maxR: number, skip?: Enemy): Enemy | null {
    let best: Enemy | null = null, bd = Infinity;
    for (const e of this.enemies) {
      if (e.dead || e === skip || e.spawnT > 0.2) continue;
      const dx = e.x - x, dy = e.y - y, real = dx * dx + dy * dy;
      if (real > maxR * maxR) continue;
      const d = e.type === 'boss' ? real * 0.2 : real; // spells favour bosses
      if (d < bd || best === null) { bd = d; best = e; }
    }
    return best;
  }

  enemyById(id: number): Enemy | undefined { return this.byId.get(id); }

  denseSpots(x: number, y: number, R: number, n: number): [number, number][] {
    const cands: Enemy[] = [];
    for (const e of this.enemies) if (!e.dead && (e.x - x) ** 2 + (e.y - y) ** 2 < R * R) cands.push(e);
    if (!cands.length) return [[x + (Math.random() - 0.5) * 200, y + (Math.random() - 0.5) * 200]];
    const scored: { e: Enemy; s: number }[] = [];
    const samples = Math.min(cands.length, 18);
    for (let i = 0; i < samples; i++) {
      const e = cands[(Math.random() * cands.length) | 0];
      scored.push({ e, s: this.query(e.x, e.y, 90).length });
    }
    scored.sort((a, b) => b.s - a.s);
    const out: [number, number][] = [];
    for (const s of scored) {
      if (out.every((o) => (o[0] - s.e.x) ** 2 + (o[1] - s.e.y) ** 2 > 110 * 110)) out.push([s.e.x, s.e.y]);
      if (out.length >= n) break;
    }
    while (out.length < n) out.push([x + (Math.random() - 0.5) * 300, y + (Math.random() - 0.5) * 300]);
    return out;
  }

  /* ------------------------------ pickups ------------------------------ */

  /** XP is awarded directly on kill (no gems). */
  dropGem(_x: number, _y: number, v: number) { this.addXp(v); }

  /** Coins drop as pickups (walk over them); everything is swept up at round end. */
  dropCoin(x: number, y: number, v: number) {
    if (this.pickups.length > 150) { this.coins += v * this.mods.coinMul; ritualEvent(this, { t: 'coin', v }); return; }
    const pk: Pickup = { id: nextOid(), x: x + (Math.random() - 0.5) * 14, y: y + (Math.random() - 0.5) * 14, type: 'coin', v, spr: this.img('coin', 3).setScale(1.7 + 0.3 * Math.min(2, v)), fly: false, t: Math.random() * 6, dead: false };
    this.pickups.push(pk);
  }
  dropPickup(type: 'heal' | 'cache', x: number, y: number) {
    const tex = type === 'heal' ? 'heart' : 'chest';
    const pk: Pickup = { id: nextOid(), x, y, type, v: type === 'heal' ? 6 : 0, spr: this.img(tex, 3).setScale(type === 'cache' ? 3 : 2.4), fly: false, t: 0, dead: false };
    this.pickups.push(pk);
  }

  /** XP is shared: every player in the run levels together. */
  addXp(v: number) { for (const pr of this.world.players) pr.gainXp(v); }

  gainXp(v: number) {
    const p = this.player;
    p.xp += v * (this.quick ? 3 : 1);
    while (p.xp >= p.xpNeed) {
      p.xp -= p.xpNeed;
      p.level++;
      p.xpNeed = this.xpFor(p.level);
      p.dmgMul += 0.015;
      this.applyLevelBoost();
      audio.play('level');
      this.fx.ring(p.x, p.y, 0xffe08a, 10, 160, 0.6);
      this.fx.burst(p.x, p.y, 0xffe08a, 20, 220, 0.8, 1.4);
    }
  }

  /** Level-ups give a random stat boost right away, mid-round, with no menu. */
  applyLevelBoost() {
    const p = this.player;
    const opts = generateRewards(this, 'levelup', 3);
    if (!opts.length) return;
    const pick = opts[(Math.random() * opts.length) | 0];
    pick.apply(this);
    this.fx.text(p.x, p.y - 52, `LEVEL ${p.level}`, '#ffe08a', 14, 1.4);
    this.fx.text(p.x, p.y - 70, `${pick.icon} ${pick.title}`, '#ffffff', 11, 1.6);
    this.boosts.push(`${pick.icon} ${pick.title}`);
  }

  /* -------------------------- enemy projectiles etc -------------------------- */

  fireBullet(x: number, y: number, ang: number, speed: number, dmg: number, color = 0xff2a4a) {
    if (this.bullets.length > 320) return;
    const spr = this.img('ebullet', 11, true).setTint(color).setScale(1.6);
    this.bullets.push({ id: nextOid(), x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, r: 7, dmg, life: 6, spr, dead: false });
  }

  addTelegraph(o: Partial<Telegraph> & { shape: Telegraph['shape']; dur: number; color: number; onDone: () => void; follow: Enemy | null }) {
    this.tels.push({
      id: nextOid(), shape: o.shape, x: o.x ?? 0, y: o.y ?? 0, r: o.r ?? 0, ang: o.ang ?? 0, len: o.len ?? 0, w: o.w ?? 0,
      t: o.dur, total: o.dur, color: o.color, follow: o.follow, onDone: o.onDone, dead: false,
    });
  }

  addZone(x: number, y: number, r: number, life: number, dmg: number) {
    const spr = this.img('zone', 1).setTint(0x66dd33).setAlpha(0.55).setScale(r / 61);
    spr.setPosition(x, y);
    this.zones.push({ id: nextOid(), x, y, r, t: life, dmg, tick: 0, spr, dead: false });
  }

  hurtPlayer(dmg: number, sx: number, sy: number, cause = 'enemy') {
    const p = this.player;
    if (this.over || this.down || p.inv > 0 || this.god || this.phase === 'clearing') return;
    const d = Math.max(1, Math.round(dmg * (this.quick ? 0.6 : 1)));
    p.hp -= d;
    ritualEvent(this, { t: 'hurt', d });
    this.hurtBy[cause] = (this.hurtBy[cause] ?? 0) + d;
    this.lastHurt = cause;
    p.inv = 0.55;
    p.hurtFlash = 0.25;
    this.fx.shake(6);
    this.fx.text(p.x, p.y - 28, `-${d}`, '#ff5a5a', 18, 0.7);
    this.fx.burst(p.x, p.y, 0xff4a4a, 8, 160, 0.4, 1);
    audio.play('hurt');
    const dx = p.x - sx, dy = p.y - sy, l = Math.hypot(dx, dy) || 1;
    p.vx += (dx / l) * 220; p.vy += (dy / l) * 220;
    if (p.hp <= 0) {
      if (onLethal(this)) return;
      if (this.sandbox) { p.hp = p.maxHp; return; }
      p.hp = 0; this.downPlayer();
    }
  }

  /** A player ran out of health. The run ends when nobody is left standing; downed players return next round. */
  downPlayer() {
    const w = this.world;
    this.down = true;
    this.fx.burst(this.player.x, this.player.y, 0xff4a4a, 16, 220, 0.6, 1.2);
    w.lastHurt = this.lastHurt;
    if (w.players.length > 1) w.announce(`${this.pname.toUpperCase()} IS DOWN`, '#ff6b6b', this === w ? 'Your teammates can carry on. You return next round.' : 'They return next round.');
    if (w.players.every((q) => q.down)) w.finish(false);
  }

  onBossDeath(e: Enemy) {
    if (this !== this.world) { this.world.onBossDeath(e); return; }
    this.boss = null;
    this.bossesKilled++;
    const kind = e.boss!.kind;
    for (const b of this.bullets) b.dead = true;
    for (const t of this.tels) t.dead = true;
    this.fx.shake(12);
    this.fx.ring(e.x, e.y, 0xffe08a, 20, 400, 0.8);
    this.fx.flash(250, 255, 240, 200);
    audio.play('boom');
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * 6.28;
      this.dropGem(e.x + Math.cos(a) * 40, e.y + Math.sin(a) * 40, 6);
    }
    if (kind < 3) {
      const co = this.players.length > 1; // co-op: everyone gets their own cache and relic pick, no shared chest
      if (!co) this.dropPickup('cache', e.x, e.y);
      this.dropPickup('heal', e.x + 30, e.y);
      if (!this.sandbox) {
        for (const pr of this.players) {
          if (co) pr.pushPending({ type: 'cache' });
          const opts = rollRelics(pr, 3, 'boss');
          if (opts.length) pr.pushPending({ type: 'relic', options: opts.map((r) => r.id) });
        }
      }
      this.announce(`${e.boss!.name.toUpperCase()} DEFEATED`, '#ffd25a', 'A Rune Cache has dropped. Collecting your spoils...');
      for (const pr of this.players) pr.addCoins(8 + 2 * kind);
      if (!this.sandbox) this.later(1.8, () => this.endRound());
    } else if (this.sandbox) {
      this.announce('BOSS DEFEATED', '#ffd25a');
    } else {
      this.announce('THE VOID ARCHITECT FALLS', '#ffd25a', 'Victory is yours!');
      this.victoryT = 2.4;
      for (const en of this.enemies) if (en !== e && !en.dead) { en.hp = 0; en.dead = true; this.fx.burst(en.x, en.y, 0xffd25a, 4, 120, 0.5, 1); this.freeImg(en.spr); this.freeImg(en.shadow); this.freeImg(en.badge); }
    }
  }

  /** Compact description of each equipped spell (for analytics). */
  snapshotSpells() {
    return this.spells.filter((sp) => sp.c.valid && sp.c.root).map((sp) => {
      const forms: string[] = [];
      const walkF = (f: import('../core/spell').CForm) => { forms.push(`${ELEMENTS[f.element].name} ${f.form}`); f.triggers.forEach((t) => t.children.forEach(walkF)); };
      walkF(sp.c.root!);
      return { name: sp.c.name, element: sp.c.root!.element, damage: Math.round(sp.damage), cost: sp.c.cost, cap: sp.def.capacity, forms, evolved: !!sp.c.root!.evolved };
    });
  }

  private buildRecord(result: RunRecord['result'], shards: number): RunRecord {
    const taken = Object.values(this.hurtBy).reduce((a, b) => a + b, 0);
    return {
      id: `${this.startedAt}-${this.seed}`, v: 1, startedAt: this.startedAt, endedAt: Date.now(), result, quick: this.quick, sandbox: this.sandbox,
      seed: this.seed, startForm: this.opts.form, reachedRound: this.round, time: Math.round(this.time), level: this.player.level, kills: this.kills,
      damage: Math.round(this.totalDamage), taken, hurtBy: { ...this.hurtBy }, deathCause: result === 'lost' ? this.lastHurt : '', shards,
      bosses: this.bossesKilled, reactions: this.reactionCount, spells: this.snapshotSpells(), relics: [...this.equipped], roundLog: this.roundLog, discoveries: [...this.discoveries],
    };
  }

  /** Save the run as abandoned when the player quits or restarts mid-run. */
  abandon() {
    if (this.over || this.saved || this.sandbox || this.roundLog.length === 0) return;
    this.saved = true;
    saveRunRecord(this.buildRecord('abandoned', 0));
  }

  finish(won: boolean) {
    if (this !== this.world) { this.world.finish(won); return; }
    if (this.over) return;
    this.over = true;
    this.won = won;
    this.frozen = true;
    audio.play(won ? 'win' : 'lose');
    const base = (this.round - 1) * 6 + Math.floor(this.kills / 25) + this.bossesKilled * 25 + (won ? 150 : 0);
    const shards = Math.max(5, Math.round(base * (this.quick ? 0.4 : 1)));
    store.addShards(shards);
    const s = store.d.stats;
    s.runs++; if (won) s.wins++;
    s.bestTime = Math.max(s.bestTime, Math.floor(this.time));
    s.kills += this.kills;
    store.d.stats = s;
    const rec = this.buildRecord(won ? 'won' : 'lost', shards);
    this.saved = true;
    saveRunRecord(rec);
    this.onEnd({
      id: rec.id, won, time: this.time, level: this.player.level, kills: this.kills, damage: this.totalDamage, shards,
      spells: this.spells.filter((sp) => sp.c.valid).map((sp) => ({ name: sp.c.name, damage: sp.damage, kills: sp.st.kills, elements: sp.c.elements })),
      discoveries: this.discoveries, quick: this.quick, bosses: this.bossesKilled, reactions: this.reactionCount, round: this.round,
    });
    this.coop?.onOver?.(won);
  }

  /* ------------------------------ main loop ------------------------------ */

  tick(dtRaw: number) {
    if (this.over && this.victoryT <= 0) { this.fx.update(dtRaw); return; }
    if (this.frozen) { this.fx.update(0); return; }
    const dt = Math.min(0.05, dtRaw);
    this.time += dt;
    if (this.phase === 'fight') {
      this.roundElapsed += dt;
      const len = roundLen(this.quick);
      this.dtime = (this.round - 1) * ROUND_DIFF + (isBossRound(this.round) ? this.roundElapsed : (ROUND_DIFF * this.roundElapsed) / len);
      if (!isBossRound(this.round) && this.roundElapsed >= len) this.endRound();
    } else if (this.phase === 'clearing') {
      this.clearT -= dt;
      if (this.clearT <= 0) this.enterPrep();
    }
    for (const pr of this.players) pr.tickUlt(dt);
    this.spawnBudget = 36;

    this.updateArena(dt);

    for (const pr of this.players) { if (!pr.down) pr.movePlayer(dt); else if (pr.remote) pr.dropCmds(); }

    this.recalcEnemyIndex();
    if (!this.over && this.phase === 'fight') updateDirector(this, dt);
    updateEnemies(this, dt);
    if (!this.over && this.phase !== 'clearing') for (const pr of this.players) if (!pr.down) updateCasting(pr, dt);
    if (this.sandbox) this.pending.length = 0;
    updateEnts(this, dt);
    processEvents(this);
    this.updateBullets(dt);
    this.updateTelegraphs(dt);
    this.updateZones(dt);
    this.updatePickups(dt);
    for (let i = this.laters.length - 1; i >= 0; i--) {
      const l = this.laters[i];
      l.t -= dt;
      if (l.t <= 0) { this.laters.splice(i, 1); l.fn(); }
    }
    this.mutT -= dt;
    if (this.mutT <= 0) { this.mutT = 0.4; for (const pr of this.players) pr.checkMutations(); }
    this.compact();
    this.fx.update(dt);
    if (this.victoryT > 0) { this.victoryT -= dt; if (this.victoryT <= 0) { this.over = false; this.finish(true); } }
    audio.intensity = Math.min(1, this.enemies.length / 120 + (this.boss ? 0.5 : 0));
  }

  /* ------------------------------ rounds ------------------------------ */

  /** Per-player ultimate cooldown and the Archive refund bookkeeping. */
  tickUlt(dt: number) {
    for (const sp of this.spells) if (sp.ultCd > 0) sp.ultCd -= dt;
    const w = this.world;
    if (this.ultTrack && w.time - this.ultTrack.t >= 4) {
      if (this.equipped.includes('archive') && this.kills - this.ultTrack.kills >= 20) { this.ultTrack.sp.ultCd *= 0.5; this.fx.text(this.player.x, this.player.y - 40, 'ARCHIVE REFUND', '#ffd25a', 12, 1); }
      this.ultTrack = null;
    }
  }

  /** Move this player by its input, resolve the floor, tick timers and regen. A co-op joiner's character is moved by the
   *  input commands the joiner sent instead (see driveRemote): the host never guesses at what a remote player is pressing. */
  movePlayer(dt: number) {
    if (this.remote) this.driveRemote(dt);
    else stepMove(this.player, this.arena, this.input.x, this.input.y, dt);
    this.tickBody(dt);
  }

  /** Host: a downed remote player's input is ignored; keep the acknowledgement current. */
  dropCmds() { this.cmdQ.length = 0; this.cmdAck = this.cmdSeq; }

  /** Timers and regeneration that run on host time for every player. */
  private tickBody(dt: number) {
    const p = this.player;
    if (p.inv > 0) p.inv -= dt;
    if (p.hurtFlash > 0) p.hurtFlash -= dt;
    p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
  }

  /** Host: queue input commands from a joiner (already de-duplicated and in order). */
  pushCmds(cmds: Cmd[]) {
    const q = this.cmdQ;
    for (const c of cmds) {
      if (((c.seq - this.cmdSeq) & 0xffff) > 0x8000 || c.seq === this.cmdSeq) continue; // old or duplicate (16-bit wraparound)
      this.cmdSeq = c.seq;
      q.push(c);
    }
    if (q.length > 120) q.splice(0, q.length - 120);
  }

  /** Host: apply the joiner's queued commands, each for exactly the duration the joiner applied it on its own screen, so the
   *  joiner's prediction and this authoritative result agree. Time is metered (about 1.15x real time, with a short burst
   *  allowance for network jitter) so a modified client cannot make its character faster than allowed. */
  private driveRemote(dt: number) {
    this.cmdCredit = Math.min(0.25, this.cmdCredit + dt * 1.15);
    const q = this.cmdQ;
    let n = 0;
    while (n < q.length && this.cmdCredit > 0) {
      const c = q[n++];
      const ix = c.ix / 127, iy = c.iy / 127;
      stepMove(this.player, this.arena, ix, iy, c.dt);
      this.cmdCredit -= c.dt;
      this.cmdAck = c.seq;
      this.input.x = ix; this.input.y = iy;
    }
    if (n) q.splice(0, n);
    else if (!q.length) { this.input.x = 0; this.input.y = 0; }
  }

  /** Crumbling floor: advance the schedule, announce waves, and drop whatever stands on a tile that falls. */
  private updateArena(dt: number) {
    const a = this.arena;
    if (this.phase !== 'fight' || !a.active) return;
    const r = a.update(dt);
    if (r.warned.length) audio.play('warn'); // the cracked red tiles speak for themselves
    if (r.fell.length) {
      audio.play('boom');
      this.fx.shake(4);
      for (const t of r.fell) this.fx.burst(tileCx(t), tileCy(t), 0x8a7aa8, 8, 140, 0.5, 1.1);
    }
    for (const pr of this.players) if (!pr.down && !a.solid(pr.player.x, pr.player.y)) pr.fallPlayer();
    for (const e of this.enemies) {
      if (e.dead || a.solid(e.x, e.y)) continue;
      if (e.type === 'boss') { const [x, y] = a.nearestSolid(e.x, e.y); e.x = x; e.y = y; continue; }
      this.fx.burst(e.x, e.y, 0x6a4cc0, 5, 90, 0.4, 0.8);
      e.dead = true; this.freeImg(e.spr); this.freeImg(e.shadow); this.freeImg(e.badge);
    }
    for (const k of this.pickups) if (!k.dead && !a.solid(k.x, k.y)) { const [x, y] = a.nearestSolid(k.x, k.y); k.x = x; k.y = y; }
  }

  fallPlayer() {
    const p = this.player;
    ritualEvent(this, { t: 'void' });
    p.inv = 0;
    this.hurtPlayer(Math.max(6, p.maxHp * 0.12), p.x, p.y, 'fell into the void');
    const [x, y] = this.arena.nearestSolid(p.x, p.y);
    p.x = x; p.y = y; p.vx = p.vy = 0; p.pullT = 0;
    if (!this.over) p.inv = 1;
  }

  /** Wipe the arena of everything transient (between rounds / sandbox reset). */
  clearField() {
    for (const e of this.enemies) { if (!e.dead) { e.dead = true; this.freeImg(e.spr); this.freeImg(e.shadow); this.freeImg(e.badge); } }
    for (const e of this.ents) e.dead = true;
    for (const sp of this.spells) sp.live = 0;
    for (const b of this.bullets) b.dead = true;
    for (const t of this.tels) t.dead = true;
    for (const z of this.zones) z.dead = true;
    this.events.length = 0; this.laters.length = 0;
    this.boss = null;
  }

  startRound() {
    this.clearField();
    this.compact();
    this.phase = 'fight';
    this.roundElapsed = 0;
    this.pieces.clear();
    this.spawnAcc = 0;
    this.plan = planFor(this.round, this.seed);
    // everyone starts clustered at the centre; players who went down last round are back on their feet
    this.players.forEach((pr, i) => {
      const p = pr.player, a = (i / Math.max(1, this.players.length)) * 6.2832;
      const off = this.players.length > 1 ? 36 : 0;
      p.x = ARENA / 2 + Math.cos(a) * off; p.y = ARENA / 2 + Math.sin(a) * off; p.vx = p.vy = 0; p.pullT = 0;
      if (pr.down) { pr.down = false; p.hp = Math.max(p.hp, p.maxHp * 0.35); }
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * ROUND_START_HEAL);
      p.inv = 1;
      pr.coins = pr.remote ? 0 : pr.coins; // a remote shell reports the coins earned this round
      pr.kills = pr.remote ? 0 : pr.kills; pr.totalDamage = pr.remote ? 0 : pr.totalDamage;
      pr.boosts = pr.remote ? [] : pr.boosts;
    });
    this.rebuildOwners();
    ritualRoundStart(this);
    this.arena.start(this.round, this.seed, isBossRound(this.round) ? roundLen(false) : roundLen(this.quick), !this.sandbox);
    this.snap = { kills: this.kills, damage: this.totalDamage, taken: Object.values(this.hurtBy).reduce((a, b) => a + b, 0), spell: this.spells.map((x) => x.damage), t: this.time, coins: this.coins };
    for (const pr of this.players) { onRoundStart(pr); for (const sp of pr.spells) sp.cd = 0.3; }
    this.frozen = false;
    this.dtime = (this.round - 1) * ROUND_DIFF;
    openRound(this);
    const boss = isBossRound(this.round);
    this.announce(boss ? `ROUND ${this.round}: BOSS` : `ROUND ${this.round}`, boss ? '#ff6b6b' : '#9fd8ff', boss ? 'Defeat the boss to finish the round.' : `Survive ${roundLen(this.quick)} seconds.`);
    audio.play(boss ? 'boss' : 'warn');
    this.coop?.onStart?.();
  }

  private pushRoundRecord() {
    const sn = this.snap;
    const taken = Object.values(this.hurtBy).reduce((a, b) => a + b, 0);
    const spells = this.snapshotSpells().map((x, i) => ({ ...x, damage: Math.round(x.damage - (sn.spell[i] ?? 0)) }));
    this.roundLog.push({
      round: this.round, boss: isBossRound(this.round), secs: Math.round(this.time - sn.t), kills: this.kills - sn.kills, damage: Math.round(this.totalDamage - sn.damage),
      taken: taken - sn.taken, hpEnd: Math.round(this.player.hp), maxHp: this.player.maxHp, coins: Math.round(this.coins * 10) / 10, level: this.player.level, spells, relics: [...this.equipped],
    });
  }

  /** The round is won: sweep the field, collect everything, then open the prep screen. */
  endRound() {
    if (this.phase !== 'fight') return;
    this.phase = 'clearing';
    this.clearT = 1.5;
    this.pushRoundRecord();
    ritualRoundEnd(this);
    for (const pr of this.players) pr.addCoins(3 + this.round);
    for (const e of this.enemies) {
      if (e.dead) continue;
      this.fx.burst(e.x, e.y, 0xffe08a, 4, 120, 0.5, 1);
      this.dropGem(e.x, e.y, e.xp * 0.6);
      e.dead = true; this.freeImg(e.spr); this.freeImg(e.shadow); this.freeImg(e.badge);
    }
    for (const b of this.bullets) b.dead = true;
    for (const t of this.tels) t.dead = true;
    for (const k of this.pickups) k.fly = true;
    this.boss = null;
    this.announce(`ROUND ${this.round} CLEARED`, '#ffd25a');
    audio.play('level');
  }

  private enterPrep() {
    for (const k of this.pickups) k.fly = true;
    this.clearField();
    this.compact();
    if (this.round >= FINAL_ROUND) { this.finish(true); return; }
    this.round++;
    this.plan = planFor(this.round, this.seed);
    this.phase = 'prep';
    this.frozen = true;
    this.arena.reset();
    this.shop = newShop(this);
    this.shopOpened = false;
    this.coop?.onPrep?.();
  }

  /* ------------------------------ evolution & ultimates ------------------------------ */

  /** How many copies of an element's base core you own (pool + equipped). */
  coreCopies(el: string): number {
    const id = BASE_CORE_OF[el];
    let n = this.inv[id] ?? 0;
    for (const sp of this.spells) if (sp.def.root) walk(sp.def.root, (nd) => { if (nd.rune === id) n++; });
    return n;
  }

  forge(el: string): boolean {
    if (this.coreCopies(el) < this.forgeCost()) return false;
    const id = BASE_CORE_OF[el];
    let need = this.forgeCost();
    const fromPool = Math.min(need, this.inv[id] ?? 0);
    this.inv[id] = (this.inv[id] ?? 0) - fromPool;
    need -= fromPool;
    // then pull the rest out of equipped spells (any Form, including ones launched by triggers)
    for (const sp of this.spells) {
      if (need <= 0) break;
      if (!sp.def.root) continue;
      let took = 0;
      walk(sp.def.root, (nd) => {
        if (need - took <= 0) return;
        const hit = nd.children.filter((c) => c.rune === id);
        const n = Math.min(hit.length, need - took);
        if (n > 0) { const drop = new Set(hit.slice(0, n)); nd.children = nd.children.filter((c) => !drop.has(c)); took += n; }
      });
      if (took) { need -= took; this.recompile(sp); }
    }
    this.addRune(EVOLVED_OF[el], 1);
    ritualEvent(this, { t: 'forge' });
    return true;
  }

  /** Elements for which you own enough Cores to forge right now. */
  forgeReady(): ('fire' | 'ice' | 'lightning' | 'poison' | 'water' | 'gravity')[] {
    return (['fire', 'ice', 'lightning', 'poison', 'water', 'gravity'] as const).filter((e) => this.coreCopies(e) >= this.forgeCost());
  }

  /** Ultimates available from equipped evolved cores. */
  ultimates() {
    return this.spells.map((sp, i) => ({ sp, i })).filter((x) => x.sp.c.valid && x.sp.c.root?.evolved);
  }

  useUltimate(): boolean {
    if (this.frozen || this.over || (this.phase !== 'fight' && this.phase !== 'sandbox')) return false;
    for (const u of this.ultimates()) {
      if (u.sp.ultCd <= 0) {
        u.sp.ultCd = this.sandbox ? 6 : ULT_COOLDOWN;
        this.ultTrack = { sp: u.sp, t: this.time, kills: this.kills };
        castUltimate(this, u.sp);
        return true;
      }
    }
    return false;
  }

  checkMutations() {
    if (this.pending.some((q) => q.type === 'mutation')) return;
    for (const sp of this.spells) {
      if (!sp.c.valid) continue;
      for (const tr of MUT_TRACKS) {
        if (tr.element && !sp.c.elements.includes(tr.element)) continue;
        if (sp.tiers[tr.id]) continue;
        if (sp.st[tr.stat] >= tr.threshold) {
          sp.tiers[tr.id] = 1;
          this.pushPending({ type: 'mutation', sp, track: tr });
          return;
        }
      }
    }
  }

  private updateBullets(dt: number) {
    const alive = this.players.filter((q) => !q.down);
    for (const b of this.bullets) {
      if (b.dead) continue;
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      b.spr.setPosition(b.x, b.y);
      if (b.life <= 0 || b.x < -20 || b.y < -20 || b.x > ARENA + 20 || b.y > ARENA + 20) { b.dead = true; continue; }
      for (const pr of alive) {
        const p = pr.player;
        const rr = b.r + p.r * 0.8;
        if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 < rr * rr) {
          pr.hurtPlayer(b.dmg, b.x - b.vx, b.y - b.vy, 'projectile');
          b.dead = true;
          this.fx.burst(b.x, b.y, 0xff4a6a, 4, 90, 0.3, 0.7);
          break;
        }
      }
    }
  }

  private updateTelegraphs(dt: number) {
    const g = this.telGfx;
    g.clear();
    for (const t of this.tels) {
      if (t.dead) continue;
      if (t.follow) {
        if (t.follow.dead) { t.dead = true; continue; }
        t.x = t.follow.x; t.y = t.follow.y;
      }
      t.t -= dt;
      if (t.t <= 0) { t.dead = true; t.onDone(); continue; }
      drawTelegraph(g, t);
    }
  }

  private updateZones(dt: number) {
    for (const z of this.zones) {
      if (z.dead) continue;
      z.t -= dt;
      z.spr.setAlpha(Math.min(0.55, z.t * 0.5));
      if (z.t <= 0) { z.dead = true; continue; }
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.5;
        for (const pr of this.players) {
          const p = pr.player;
          if (!pr.down && (p.x - z.x) ** 2 + (p.y - z.y) ** 2 < (z.r + p.r) ** 2) pr.hurtPlayer(z.dmg, z.x, z.y, 'hazard zone');
        }
        if (Math.random() < 0.5) this.fx.spark(z.x + (Math.random() - 0.5) * z.r, z.y + (Math.random() - 0.5) * z.r, 0, -30, 0x7dff4a, 0.6, 1);
      }
    }
  }

  private updatePickups(dt: number) {
    for (const k of this.pickups) {
      if (k.dead) continue;
      k.t += dt;
      const pr = this.nearestPlayer(k.x, k.y) ?? this.world;
      const p = pr.player;
      const dx = p.x - k.x, dy = p.y - k.y;
      const d2 = dx * dx + dy * dy;
      const can = !pr.down;
      if (k.fly) {
        const d = Math.sqrt(d2) || 1;
        const sp = Math.min(700, 260 + k.t * 500);
        k.x += (dx / d) * sp * dt; k.y += (dy / d) * sp * dt;
      }
      k.spr.setPosition(k.x, k.y + Math.sin(k.t * 4 + k.x) * 1.5);
      if (can && d2 < 30 * 30) { // pick-ups are collected by touch; there is no pickup range
        k.dead = true;
        if (k.type === 'coin') { const v = k.v * pr.mods.coinMul; pr.coins += v; ritualEvent(pr, { t: 'coin', v }); this.fx.text(p.x, p.y - 26, `+${Math.round(v * 10) / 10}`, '#ffd25a', 11, 0.5); if (!pr.remote) audio.play('gem'); }
        else if (k.type === 'heal') { pr.heal(k.v); if (!pr.remote) audio.play('pick'); }
        else if (k.type === 'cache') {
          pr.pushPending({ type: 'cache' });
          audio.play('pick');
        }
      }
    }
  }

  private compact() {
    const prune = <T>(arr: T[], dead: (t: T) => boolean, drop?: (t: T) => void) => {
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (dead(t)) { drop?.(t); } else arr[w++] = t;
      }
      arr.length = w;
    };
    prune(this.enemies, (e) => e.dead);
    prune(this.ents, (e) => e.dead, (e) => { this.freeImg(e.spr); this.freeImg(e.spr2); for (const d of e.deco) this.freeImg(d); });
    prune(this.hazards, (e) => e.dead);
    prune(this.bullets, (b) => b.dead, (b) => this.freeImg(b.spr));
    prune(this.pickups, (k) => k.dead, (k) => this.freeImg(k.spr));
    prune(this.tels, (t) => t.dead);
    prune(this.zones, (z) => z.dead, (z) => this.freeImg(z.spr));
    if (this.boss && this.boss.dead) this.boss = null;
  }

  /** Sync enemy / player sprites after a tick (done each rendered frame). */
  syncSprites(playerSpr: Img, playerShadow: Img) {
    const p = this.player;
    this.arena.draw(this.floorGfx, this.time);
    for (const e of this.enemies) {
      if (e.dead) continue;
      poseEnemy(e, e.spr, e.shadow, e.badge, this.time);
      const key = tintKey(e);
      if (key !== e.tint) { e.tint = key; applyTint(e.spr, key, e.aff); }
    }
    poseWizard(playerSpr, playerShadow, { x: p.x, y: p.y, faceX: p.faceX, walking: Math.hypot(this.input.x, this.input.y) > 0.1, walkT: p.walkT, hurt: p.hurtFlash > 0, inv: p.inv > 0, down: false }, this.time);
  }

  destroy() {
    this.telGfx.destroy();
    this.floorGfx.destroy();
  }
}

export { RUNE_BY_ID };
