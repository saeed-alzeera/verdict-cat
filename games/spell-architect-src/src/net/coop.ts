// Co-op sessions. The HOST runs the one authoritative simulation (every player is a "shell" Run with their own build, stats,
// relics and rewards); GUESTS keep a normal local Run for everything between rounds (editor, shop, briefing) and, during a round,
// only send inputs and draw the host's mirrored world.
import Phaser from 'phaser';
import { audio } from '../core/audio';
import { store } from '../core/save';
import { MUT_TRACKS } from '../data/mutations';
import { ELEMENTS, RUNE_BY_ID } from '../data/runes';
import { planFor } from '../game/rounds';
import { newShop } from '../game/shop';
import type { Build, CoopLink, Pending, Run, RunSummary } from '../game/run';
import type { Enemy } from '../game/types';
import { ui } from '../ui/ui';
import { showNotice } from '../ui/lobby';
import { decodeFrame, encodeFrame, MirrorLayer, textureTable, type Cull } from './mirror';
import type { GuestNet, HostNet } from './rtc';
import { drawTelegraph } from '../game/draw';

export interface MpOpts {
  role: 'host' | 'guest';
  name: string;
  code: string;
  host?: HostNet;
  guest?: GuestNet;
  /** Guest: what the host told us on connecting, plus any messages that arrived while the scene was starting. */
  welcome?: { pid: number; seed: number; round: number; host?: string };
  early?: Record<string, unknown>[];
}

export interface LobbyPlayer { pid: number; name: string; ready: boolean; host: boolean }

/** Messages worth hearing as sound cues on a guest's machine. */
const SFX_OK = new Set(['fire', 'ice', 'lightning', 'poison', 'water', 'gravity', 'hit', 'kill', 'hurt', 'boom', 'reaction', 'freeze', 'warn', 'boss', 'win', 'lose', 'level']);

/** A guest's build comes from another machine: check it is well formed and sane before the host compiles it. */
export function validateBuild(b: unknown): string | null {
  const x = b as Build | null;
  if (!x || typeof x !== 'object' || !Array.isArray(x.spells) || !x.player || !Array.isArray(x.owned) || !Array.isArray(x.equipped)) return 'malformed build';
  if (x.spells.length > 5 || x.owned.length > 40 || x.equipped.length > 6) return 'build too large';
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const p = x.player as unknown as Record<string, unknown>;
  if (!num(p.maxHp, 1, 3000) || !num(p.hp, 0, 3000) || !num(p.dmgMul, 0.1, 30) || !num(p.cdMul, 0.05, 5) || !num(p.crit, 0, 1) || !num(p.critMul, 1, 20)
    || !num(p.speed, 50, 900) || !num(p.regen, 0, 50) || !num(p.pickup, 0.1, 20) || !num(p.level, 1, 500) || !num(p.xp, 0, 1e7) || !num(p.xpNeed, 1, 1e7) || !num(p.r, 1, 60)) return 'bad player stats';
  for (const sp of x.spells) {
    if (!sp || !sp.def || typeof sp.def.capacity !== 'number' || sp.def.capacity < 1 || sp.def.capacity > 200) return 'bad spell';
    let n = 0;
    const walk = (nd: { rune?: unknown; children?: unknown }, depth: number): string | null => {
      if (!nd || typeof nd.rune !== 'string' || !RUNE_BY_ID[nd.rune] || !Array.isArray(nd.children)) return 'unknown rune';
      if (++n > 80 || depth > 14) return 'spell too large';
      for (const c of nd.children as { rune?: unknown; children?: unknown }[]) { const e = walk(c, depth + 1); if (e) return e; }
      return null;
    };
    if (sp.def.root) { const e = walk(sp.def.root as never, 0); if (e) return e; if (RUNE_BY_ID[sp.def.root.rune].kind !== 'form') return 'root is not a form'; }
    if (!Array.isArray(sp.mutations) || sp.mutations.length > 20) return 'bad mutations';
  }
  return null;
}

const SNAP_INTERVAL = 0.05; // 20 Hz
const INPUT_INTERVAL = 0.033;

interface GuestRec {
  id: string; pid: number; name: string; shell: Run; ready: boolean; build: Build | null; view: { w: number; h: number };
}

/* =============================================================== HOST =============================================================== */

export class HostSession implements CoopLink {
  role = 'host' as const;
  code: string;
  guests = new Map<string, GuestRec>();
  /** Lobby panel refresh. */
  onChange: (() => void) | null = null;
  private acc = 0;
  private seq = 0;
  private sfx: string[] = [];
  private table: Map<string, number>;
  private sprites = new Map<Run, { spr: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }>();
  private lobbyClosed = false;
  private overSent = false;

  constructor(public run: Run, private scene: Phaser.Scene, private net: HostNet, code: string, private name: string) {
    this.code = code;
    run.pname = name;
    run.coop = this;
    this.table = new Map(textureTable(scene).map((k, i) => [k, i]));
    run.onRemotePending = (pr, item) => this.sendPending(pr, item);
    const orig = run.onAnnounce;
    run.onAnnounce = (t, c, s) => { orig(t, c, s); if (!t.startsWith('NEW ')) this.net.broadcastCtl({ t: 'announce', text: t, color: c, sub: s }); };
    audio.tap = (n) => { if (SFX_OK.has(n) && this.sfx.length < 10 && !this.sfx.includes(n)) this.sfx.push(n); };
    net.h = {
      onPeers: () => this.onChange?.(),
      onOpen: (id) => this.onOpen(id),
      onClose: (id) => this.onClose(id),
      onCtl: (id, m) => this.onCtl(id, m),
      onSnap: (id, buf) => this.onInput(id, buf),
      onError: (m) => ui.announce('MULTIPLAYER', '#ff9a9a', m),
    };
    for (const id of net.ids()) this.onOpen(id); // guests that connected while the scene was starting
  }

  players(): LobbyPlayer[] {
    return [{ pid: 0, name: this.name, ready: true, host: true }, ...[...this.guests.values()].map((g) => ({ pid: g.pid, name: g.name, ready: g.ready, host: false }))];
  }
  allReady() { return [...this.guests.values()].every((g) => g.ready); }

  private lobbyMsg() { return { t: 'lobby', players: this.players() }; }

  private onOpen(id: string) {
    if (this.guests.has(id)) return;
    const name = this.net.names[id] || 'Guest';
    const pid = Number(id);
    const shell = this.run.addRemotePlayer(pid, name);
    this.guests.set(id, { id, pid, name, shell, ready: false, build: null, view: { w: 1400, h: 800 } });
    this.net.sendCtl(id, { t: 'welcome', pid, seed: this.run.seed, round: this.run.round, host: this.name });
    this.net.broadcastCtl(this.lobbyMsg());
    this.run.announce('PLAYER JOINED', '#9fd8ff', `${name} joined the game.`);
    this.onChange?.();
  }

  private onClose(id: string) {
    const g = this.guests.get(id);
    if (!g) return;
    this.guests.delete(id);
    const sp = this.sprites.get(g.shell);
    if (sp) { sp.spr.destroy(); sp.shadow.destroy(); sp.label.destroy(); this.sprites.delete(g.shell); }
    this.run.removePlayer(g.shell);
    this.run.announce('PLAYER LEFT', '#ff9a9a', `${g.name} disconnected.`);
    this.net.broadcastCtl(this.lobbyMsg());
    this.onChange?.();
  }

  private onCtl(id: string, m: Record<string, unknown>) {
    const g = this.guests.get(id);
    if (!g) return;
    switch (m.t) {
      case 'ready': {
        const bad = validateBuild(m.build);
        if (bad) { this.net.sendCtl(id, { t: 'announce', text: 'BUILD REJECTED', color: '#ff9a9a', sub: `The host could not use your build (${bad}).` }); this.net.sendCtl(id, { t: 'lobby', players: this.players().map((q) => (q.pid === g.pid ? { ...q, ready: false } : q)) }); break; }
        g.build = m.build as Build; g.ready = true; this.net.broadcastCtl(this.lobbyMsg()); this.onChange?.(); break;
      }
      case 'unready': g.ready = false; this.net.broadcastCtl(this.lobbyMsg()); this.onChange?.(); break;
      case 'ult': if (this.run.phase === 'fight' && !g.shell.down) g.shell.useUltimate(); break;
      case 'view': g.view = { w: Math.min(3000, Number(m.w) || 1400), h: Math.min(2000, Number(m.h) || 800) }; break;
      case 'bye': this.onClose(id); break;
    }
  }

  /** Input stream: [1, ix, iy] as signed bytes. */
  private onInput(id: string, buf: ArrayBuffer) {
    const g = this.guests.get(id);
    if (!g || buf.byteLength < 3) return;
    const v = new Int8Array(buf);
    if (v[0] !== 1) return;
    g.shell.input.x = Math.max(-1, Math.min(1, v[1] / 127));
    g.shell.input.y = Math.max(-1, Math.min(1, v[2] / 127));
  }

  /* ---- CoopLink ---- */

  beforeStart(): string | null {
    const wait = [...this.guests.values()].filter((g) => !g.ready || !g.build);
    if (wait.length) return `Waiting for ${wait.map((g) => g.name).join(', ')} to get ready.`;
    for (const g of this.guests.values()) {
      try { g.shell.applyBuild(g.build!); } catch (e) {
        g.ready = false; g.build = null;
        this.net.sendCtl(g.id, { t: 'announce', text: 'BUILD REJECTED', color: '#ff9a9a', sub: 'Your build could not be loaded. Re-check your spells and ready up again.' });
        this.onChange?.();
        return `${g.name}'s build could not be loaded.`;
      }
      g.shell.down = false;
    }
    this.run.rebuildOwners();
    if (!this.lobbyClosed) { this.lobbyClosed = true; void this.net.closeLobby(); }
    return null;
  }

  onStart() {
    for (const g of this.guests.values()) { g.ready = false; this.net.sendCtl(g.id, { t: 'start', round: this.run.round }); }
    this.net.broadcastCtl(this.lobbyMsg());
    this.onChange?.();
  }

  onPrep() {
    for (const g of this.guests.values()) {
      g.ready = false; g.build = null;
      this.net.sendCtl(g.id, { t: 'result', round: this.run.round, res: g.shell.roundResult() });
    }
    this.net.broadcastCtl(this.lobbyMsg());
    this.onChange?.();
  }

  onOver(won: boolean) {
    if (this.overSent) return;
    this.overSent = true;
    for (const g of this.guests.values()) {
      this.net.sendCtl(g.id, { t: 'over', won, round: this.run.round, bosses: this.run.bossesKilled, time: this.run.time, reactions: this.run.reactionCount, res: g.shell.roundResult() });
    }
  }

  ult() { return this.run.useUltimate(); }

  leave() {
    audio.tap = null;
    this.net.close();
  }

  private sendPending(pr: Run, item: Pending) {
    const g = [...this.guests.values()].find((x) => x.shell === pr);
    if (!g) return;
    let out: Record<string, unknown> | null = null;
    if (item.type === 'cache') out = { type: 'cache' };
    else if (item.type === 'relic') out = { type: 'relic', options: item.options };
    else if (item.type === 'mutation') out = { type: 'mutation', si: pr.spells.indexOf(item.sp), track: item.track.id };
    if (out) this.net.sendCtl(g.id, { t: 'pending', item: out });
  }

  /* ---- per-frame: remote sprites + snapshots ---- */

  frame(dt: number) {
    this.syncSprites();
    this.acc += dt;
    if (this.acc < SNAP_INTERVAL || !this.guests.size) return;
    this.acc = 0;
    const run = this.run;
    const a = run.arena;
    const tels = run.tels.filter((t) => !t.dead).map((t) => ({ shape: t.shape, x: Math.round(t.x), y: Math.round(t.y), r: Math.round(t.r), ang: Math.round(t.ang * 1000) / 1000, len: t.len, w: t.w, t: Math.round(t.t * 100) / 100, total: t.total, color: t.color }));
    const tt: [number, number][] = [];
    for (let i = 0; i < a.state.length; i++) if (a.state[i] === 1 || a.state[i] === 2) tt.push([i, Math.round(a.timer[i] * 100) / 100]);
    const boss = run.boss && !run.boss.dead && run.boss.boss ? { n: run.boss.boss.name, hp: Math.round(run.boss.hp), mh: Math.round(run.boss.maxHp) } : null;
    const teamKills = run.players.reduce((n, p) => n + p.kills, 0);
    const base = {
      seq: ++this.seq, ts: performance.now(), paused: run.frozen && run.phase === 'fight' && !run.over ? 1 : 0, t: run.time, round: run.round, phase: run.phase, el: run.roundElapsed, quick: run.quick, kills: teamKills,
      pl: run.players.map((p) => ({ pid: p.pid, name: p.pname, x: Math.round(p.player.x), y: Math.round(p.player.y), hp: Math.round(p.player.hp), mh: p.player.maxHp, down: p.down })),
      boss, ta: a.active ? 1 : 0, tiles: [...a.state].join(''), tt, tels, sfx: this.sfx, shake: Math.round(run.fx.shakeMag * 10) / 10,
    };
    this.sfx = [];
    for (const g of this.guests.values()) {
      const p = g.shell.player;
      const me = {
        pid: g.pid, x: p.x, y: p.y, hp: p.hp, mh: p.maxHp, xp: p.xp, xn: p.xpNeed, lv: p.level, coins: g.shell.coins, down: g.shell.down,
        cds: g.shell.spells.map((s) => [Math.round(s.cd * 100) / 100, s.live, Math.round(s.ultCd * 10) / 10]),
      };
      const cull: Cull = { x: p.x - g.view.w / 2 - 80, y: p.y - g.view.h / 2 - 80, w: g.view.w + 160, h: g.view.h + 160 };
      this.net.sendSnap(g.id, encodeFrame(this.scene, this.table, { ...base, me }, cull));
    }
  }

  /** Draw the remote players (the host's own wizard is drawn by the scene). */
  private hostLabel: Phaser.GameObjects.Text | null = null;

  private syncSprites() {
    const run = this.run;
    if (this.guests.size) {
      this.hostLabel ??= this.scene.add.text(0, 0, this.name, { fontFamily: '"Press Start 2P", monospace', fontSize: '8px', color: '#ffe08a', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(15);
      this.hostLabel.setPosition(run.player.x, run.player.y - 38).setText(run.down ? `${this.name} (down)` : this.name).setAlpha(run.down ? 0.6 : 1);
    }
    for (const g of this.guests.values()) {
      const sh = g.shell;
      let s = this.sprites.get(sh);
      if (!s) {
        s = {
          spr: this.scene.add.image(0, 0, 'wiz0').setScale(3).setDepth(8),
          shadow: this.scene.add.image(0, 0, 'shadow').setScale(3).setDepth(4).setAlpha(0.8),
          label: this.scene.add.text(0, 0, g.name, { fontFamily: '"Press Start 2P", monospace', fontSize: '8px', color: '#9fd8ff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(15),
        };
        this.sprites.set(sh, s);
      }
      const p = sh.player;
      const walking = Math.hypot(sh.input.x, sh.input.y) > 0.1;
      const frame = walking ? Math.floor(p.walkT * 8) % 2 : Math.floor(run.time * 2) % 2;
      s.spr.setTexture(`wiz${frame}`).setPosition(p.x, p.y - 8).setFlipX(p.faceX < 0).setDepth(8 + p.y / 4000).setScale(3, 3 * (1 + 0.03 * Math.sin(run.time * 6)));
      if (p.hurtFlash > 0) s.spr.setTintFill(0xff5a5a); else s.spr.setTint(0x9fd8ff);
      s.spr.setAlpha(sh.down ? 0.25 : p.inv > 0 ? (Math.floor(run.time * 20) % 2 ? 0.45 : 1) : 1);
      s.shadow.setPosition(p.x, p.y + 12).setAlpha(sh.down ? 0.2 : 0.8);
      s.label.setPosition(p.x, p.y - 38).setText(sh.down ? `${g.name} (down)` : g.name).setAlpha(sh.down ? 0.6 : 1);
    }
  }

  destroy() {
    audio.tap = null;
    for (const s of this.sprites.values()) { s.spr.destroy(); s.shadow.destroy(); s.label.destroy(); }
    this.sprites.clear();
    this.hostLabel?.destroy(); this.hostLabel = null;
  }
}

/* =============================================================== GUEST ============================================================== */

export class GuestSession implements CoopLink {
  role = 'guest' as const;
  code: string;
  lobby: LobbyPlayer[] = [];
  ready = false;
  hostName = 'Host';
  pid: number;
  onChange: (() => void) | null = null;
  inFight = false;
  private layer: MirrorLayer;
  private names: string[];
  private queue: ArrayBuffer[] = [];
  private pausedShown = false;
  private lastInput = '';
  private inputT = 0;
  private lastView = '';
  private tels: { v: Parameters<typeof drawTelegraph>[1]; at: number }[] = [];
  private coinBase = 0;
  private myKills = 0;
  private myDamage = 0;
  private camX = 0; private camY = 0;
  private bossFake: Enemy | null = null;
  private ended = false;
  /** Latest snapshot header, for the party panel and the camera. */
  meta: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(public run: Run, private scene: Phaser.Scene, private net: GuestNet, private opts: MpOpts) {
    this.code = opts.code;
    this.pid = opts.welcome?.pid ?? 0;
    this.hostName = opts.welcome?.host ?? 'Host';
    run.coop = this;
    run.pname = opts.name;
    if (opts.welcome) { run.seed = opts.welcome.seed; run.round = opts.welcome.round; run.plan = planFor(run.round, run.seed); }
    this.names = textureTable(scene);
    this.layer = new MirrorLayer(scene, this.names);
    net.h = {
      onCtl: (m) => this.onCtl(m),
      onSnap: (b) => { this.queue.push(b); if (this.queue.length > 12) this.queue.shift(); },
      onClose: (why) => this.onClosed(why),
    };
    for (const m of opts.early ?? []) this.onCtl(m);
  }

  private onClosed(why: string) {
    if (this.ended) return;
    this.ended = true;
    showNotice(ui, 'Disconnected', why, () => ui.quitToMenu());
  }

  private onCtl(m: Record<string, unknown>) {
    switch (m.t) {
      case 'welcome':
        this.pid = Number(m.pid); this.hostName = String(m.host ?? 'Host');
        this.run.seed = Number(m.seed); this.run.round = Number(m.round); this.run.plan = planFor(this.run.round, this.run.seed);
        break;
      case 'lobby': {
        this.lobby = m.players as LobbyPlayer[];
        const me = this.lobby.find((q) => q.pid === this.pid);
        if (me) this.ready = me.ready; // the host is the source of truth (it can reject a build)
        this.onChange?.();
        break;
      }
      case 'start': this.beginFight(Number(m.round)); break;
      case 'result': this.mergeResult(m as { round: number; res: RoundRes }); break;
      case 'pending': this.addPending(m.item as Record<string, unknown>); break;
      case 'announce': ui.announce(String(m.text), String(m.color), m.sub ? String(m.sub) : undefined); break;
      case 'over': this.finish(m as unknown as OverMsg); break;
    }
  }

  /* ---- prep: ready / unready ---- */

  setReady(on: boolean) {
    this.ready = on;
    if (on) this.net.sendCtl({ t: 'ready', build: this.run.exportBuild() });
    else this.net.sendCtl({ t: 'unready' });
    this.onChange?.();
  }

  /* ---- round flow ---- */

  private beginFight(round: number) {
    const run = this.run;
    this.ready = false;
    run.round = round; run.plan = planFor(round, run.seed);
    run.phase = 'fight'; run.frozen = false;
    this.coinBase = run.coins;
    this.inFight = true;
    this.queue = [];
    this.layer.clear();
    ui.closePrep();
    run.announce(isBoss(round) ? `ROUND ${round}: BOSS` : `ROUND ${round}`, isBoss(round) ? '#ff6b6b' : '#9fd8ff');
  }

  private mergeResult(m: { round: number; res: RoundRes }) {
    const run = this.run;
    const r = m.res;
    this.inFight = false;
    this.layer.clear();
    if (this.pausedShown) { this.pausedShown = false; ui.hideHostPause(); }
    run.fx.reset();
    // the host's copy of this character is authoritative for what the round changed (level-ups, mutation progress, relic counters)
    const keep = { x: run.player.x, y: run.player.y };
    Object.assign(run.player, r.build.player, keep);
    r.build.spells.forEach((bs, i) => {
      const sp = run.spells[i];
      if (!sp) return;
      sp.mutations = [...bs.mutations]; sp.tiers = { ...bs.tiers }; sp.st = { ...bs.st }; sp.damage = bs.damage; sp.ultCd = bs.ultCd;
      run.recomputeMut(sp);
    });
    run.relicState = r.build.relicState;
    run.coins = this.coinBase + r.coins;
    this.myKills += r.kills; this.myDamage += r.damage; run.kills = this.myKills; run.totalDamage = this.myDamage;
    run.boosts.push(...r.boosts);
    run.round = m.round; run.plan = planFor(m.round, run.seed);
    run.phase = 'prep'; run.frozen = true;
    run.shop = newShop(run); run.shopOpened = false;
    this.ready = false;
    run.arena.reset();
    this.tels = [];
    this.meta = null;
    this.onChange?.();
  }

  private addPending(it: Record<string, unknown>) {
    const run = this.run;
    let p: Pending | null = null;
    if (it.type === 'cache') p = { type: 'cache' };
    else if (it.type === 'relic') p = { type: 'relic', options: it.options as string[] };
    else if (it.type === 'mutation') {
      const sp = run.spells[Number(it.si)];
      const track = MUT_TRACKS.find((t) => t.id === it.track);
      if (sp && track) p = { type: 'mutation', sp, track };
    }
    if (p) run.pending.push(p);
  }

  private finish(m: OverMsg) {
    if (this.ended) return;
    this.ended = true;
    this.inFight = false;
    const run = this.run;
    const r = m.res;
    Object.assign(run.player, r.build.player);
    this.myKills += r.kills; this.myDamage += r.damage; run.kills = this.myKills; run.totalDamage = this.myDamage;
    const base = (m.round - 1) * 6 + Math.floor(run.kills / 25) + m.bosses * 25 + (m.won ? 150 : 0);
    const shards = Math.max(5, Math.round(base));
    store.addShards(shards);
    const s = store.d.stats; s.runs++; if (m.won) s.wins++; s.bestTime = Math.max(s.bestTime, Math.floor(m.time)); s.kills += run.kills; store.d.stats = s;
    const spells = r.build.spells.map((bs) => {
      const sp = run.spells[r.build.spells.indexOf(bs)];
      return sp?.c.valid ? { name: sp.c.name, damage: bs.damage, kills: bs.st.kills, elements: sp.c.elements } : null;
    }).filter(Boolean) as RunSummary['spells'];
    audio.play(m.won ? 'win' : 'lose');
    ui.showGameOver({
      id: `mp-${this.code}-${Date.now()}`, won: m.won, time: m.time, level: run.player.level, kills: run.kills, damage: run.totalDamage, shards, spells,
      discoveries: [], quick: false, bosses: m.bosses, reactions: m.reactions, round: m.round,
    });
  }

  /* ---- CoopLink ---- */

  ult(): boolean {
    if (!this.inFight) return false;
    if (!this.run.ultimates().length) return false;
    this.net.sendCtl({ t: 'ult' });
    return true;
  }

  leave() {
    this.ended = true;
    this.net.sendCtl({ t: 'bye' });
    this.net.close();
  }

  /* ---- per-frame ---- */

  /** Called by the scene each rendered frame while a round is on: send input, apply the newest snapshot, ease the images. */
  frame(dt: number, input: { x: number; y: number }, viewW: number, viewH: number) {
    const run = this.run;
    if (!this.inFight) return;
    this.inputT -= dt;
    const key = `${Math.round(input.x * 127)},${Math.round(input.y * 127)}`;
    if (key !== this.lastInput || this.inputT <= 0) {
      this.lastInput = key; this.inputT = INPUT_INTERVAL * 6;
      this.net.sendSnap(new Int8Array([1, Math.round(input.x * 127), Math.round(input.y * 127)]).buffer);
    }
    const vk = `${Math.round(viewW)}x${Math.round(viewH)}`;
    if (vk !== this.lastView) { this.lastView = vk; this.net.sendCtl({ t: 'view', w: Math.round(viewW), h: Math.round(viewH) }); }

    const now = performance.now();
    // decode everything that arrived; the layer drops out-of-order frames, and the HUD/floor data comes from the newest one
    let newest: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const buf of this.queue) {
      const f = decodeFrame(buf);
      if (this.layer.push(f.meta, f.recs, f.meta.texts, now)) newest = f.meta;
    }
    this.queue = [];
    if (newest) this.applyMeta(newest);
    this.layer.render(now); // draws slightly in the past, interpolated
    this.syncPause();
    // keep telegraphs ticking between snapshots, then draw them and the floor
    const g = run.telGfx;
    g.clear();
    for (const t of this.tels) {
      const left = t.v.t - (now - t.at) / 1000;
      if (left > 0) drawTelegraph(g, { ...t.v, t: left });
    }
    run.arena.draw(run.floorGfx, run.time);
  }

  /** The host paused: show the guests a pause screen (and take it away when play resumes). */
  private syncPause() {
    const paused = !!this.meta?.paused && this.inFight;
    if (paused === this.pausedShown) return;
    this.pausedShown = paused;
    if (paused) ui.showHostPause(this.hostName); else ui.hideHostPause();
  }

  private applyMeta(meta: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const run = this.run;
    this.meta = meta;
    const me = meta.me;
    const p = run.player;
    p.x = me.x; p.y = me.y; p.hp = me.hp; p.maxHp = me.mh; p.xp = me.xp; p.xpNeed = me.xn; p.level = me.lv;
    run.coins = this.coinBase + me.coins;
    run.quick = !!meta.quick; run.time = meta.t; run.round = meta.round; run.phase = meta.phase === 'prep' ? 'clearing' : meta.phase; run.roundElapsed = meta.el; run.kills = meta.kills;
    run.down = !!me.down;
    run.spells.forEach((sp, i) => { const c = me.cds[i]; if (c) { sp.cd = c[0]; sp.live = c[1]; sp.ultCd = c[2]; } });
    if (meta.boss) {
      if (!this.bossFake) this.bossFake = { boss: { name: '' }, hp: 1, maxHp: 1 } as unknown as Enemy;
      this.bossFake.boss!.name = meta.boss.n; this.bossFake.hp = meta.boss.hp; this.bossFake.maxHp = meta.boss.mh;
      run.boss = this.bossFake;
    } else run.boss = null;
    run.fx.shakeMag = meta.shake;
    // floor
    const a = run.arena;
    a.active = !!meta.ta;
    const tiles: string = meta.tiles;
    for (let i = 0; i < a.state.length && i < tiles.length; i++) a.state[i] = tiles.charCodeAt(i) - 48;
    a.timer.fill(0);
    for (const [i, t] of meta.tt as [number, number][]) a.timer[i] = t;
    const at = performance.now();
    this.tels = (meta.tels as Parameters<typeof drawTelegraph>[1][]).map((v) => ({ v, at }));
    for (const n of meta.sfx as string[]) audio.play(n as never);
  }

  /** Where the camera should look: you, or a teammate while you are down. */
  cameraTarget(): { x: number; y: number } {
    const v = this.layer.view;
    const m = this.meta;
    if (m && m.me.down) {
      for (const [pid, q] of v.pl) if (pid !== this.pid && !q.down) return q;
    }
    return v.me ?? this.run.player;
  }

  destroy() { this.layer.destroy(); }
}

const isBoss = (r: number) => r % 5 === 0;

interface RoundRes { build: Build; coins: number; kills: number; damage: number; boosts: string[] }
interface OverMsg { won: boolean; round: number; bosses: number; time: number; reactions: number; res: RoundRes }

void ELEMENTS;
