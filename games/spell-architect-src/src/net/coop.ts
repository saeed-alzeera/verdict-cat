// Co-op sessions. The HOST runs the one authoritative simulation (every player is a "shell" Run with their own build, stats,
// relics and rewards) and replicates it (replicate.ts). A JOINER keeps a normal local Run for everything between rounds
// (editor, shop, briefing); during a round it predicts its own wizard locally, sends its input commands to the host, and draws
// the replicated world (replica.ts). See proto.ts for the wire format and channels.
import Phaser from 'phaser';
import { audio } from '../core/audio';
import { store } from '../core/save';
import { MUT_TRACKS } from '../data/mutations';
import { RUNE_BY_ID } from '../data/runes';
import { planFor } from '../game/rounds';
import { newShop } from '../game/shop';
import type { Build, Cmd, CoopLink, Pending, Run, RunSummary } from '../game/run';
import { poseWizard } from '../game/render';
import { ui } from '../ui/ui';
import { showNotice } from '../ui/lobby';
import type { GuestNet, HostNet } from './rtc';
import { K } from './proto';
import { Predictor } from './predict';
import { Replica, type NetStats } from './replica';
import { Replicator, type GuestView } from './replicate';
import { Reader, Writer } from './wire';

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

/** A guest's build comes from another machine: check it is well formed and sane before the host compiles it. */
export function validateBuild(b: unknown): string | null {
  const x = b as Build | null;
  if (!x || typeof x !== 'object' || !Array.isArray(x.spells) || !x.player || !Array.isArray(x.owned) || !Array.isArray(x.equipped)) return 'malformed build';
  if (x.spells.length > 5 || x.owned.length > 40 || x.equipped.length > 6) return 'build too large';
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const p = x.player as unknown as Record<string, unknown>;
  if (!num(p.maxHp, 1, 3000) || !num(p.hp, 0, 3000) || !num(p.dmgMul, 0.1, 30) || !num(p.cdMul, 0.05, 5) || !num(p.crit, 0, 1) || !num(p.critMul, 1, 20)
    || !num(p.speed, 50, 900) || !num(p.regen, 0, 50) || !num(p.level, 1, 500) || !num(p.xp, 0, 1e7) || !num(p.xpNeed, 1, 1e7) || !num(p.r, 1, 60)) return 'bad player stats';
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


/** How long a dropped player's character is kept (standing down) before the host gives up on them. */
const GRACE_MS = 45000;
const CMD_RESEND = 32;

interface GuestRec {
  id: string; pid: number; name: string; shell: Run; ready: boolean; build: Build | null;
  echo: number; echoAt: number; offline: boolean; offAt: number; wasDown: boolean;
}

/* =============================================================== HOST =============================================================== */

export class HostSession implements CoopLink {
  role = 'host' as const;
  code: string;
  guests = new Map<string, GuestRec>();
  /** Lobby panel refresh. */
  onChange: (() => void) | null = null;
  rep: Replicator;
  private sprites = new Map<Run, { spr: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }>();
  private lobbyClosed = false;
  private started = false;
  private overSent = false;
  private hostLabel: Phaser.GameObjects.Text | null = null;

  constructor(public run: Run, private scene: Phaser.Scene, private net: HostNet, code: string, private name: string) {
    this.code = code;
    run.pname = name;
    run.coop = this;
    run.onRemotePending = (pr, item) => this.sendPending(pr, item);
    const orig = run.onAnnounce;
    run.onAnnounce = (t, c, s) => { orig(t, c, s); if (!t.startsWith('NEW ')) this.net.broadcastCtl({ t: 'announce', text: t, color: c, sub: s }); };
    this.rep = new Replicator(run, {
      st: (id, b) => this.net.sendSt(id, b),
      fx: (id, b) => this.net.sendFx(id, b),
      ready: (id) => this.net.ready(id),
    });
    net.h = {
      onPeers: () => this.onChange?.(),
      onOpen: (id, rejoin) => this.onOpen(id, rejoin),
      onClose: (id, graceful) => this.onClose(id, graceful),
      onCtl: (id, m) => this.onCtl(id, m),
      onInp: (id, buf) => this.onInput(id, buf),
      onError: (m) => ui.announce('MULTIPLAYER', '#ff9a9a', m),
    };
    for (const id of net.ids()) this.onOpen(id, false); // guests that connected while the scene was starting
  }

  players(): LobbyPlayer[] {
    return [{ pid: 0, name: this.name, ready: true, host: true }, ...[...this.guests.values()].map((g) => ({ pid: g.pid, name: g.name + (g.offline ? ' (reconnecting)' : ''), ready: g.ready, host: false }))];
  }
  allReady() { return [...this.guests.values()].every((g) => g.ready || g.offline); }
  party() { return this.run.players.map((q) => ({ name: q.pname, hp: q.player.hp, mh: q.player.maxHp, down: q.down, me: q === this.run })); }

  private lobbyMsg() { return { t: 'lobby', players: this.players() }; }

  private onOpen(id: string, rejoin: boolean) {
    const known = this.guests.get(id);
    if (known) { this.reconnected(known); return; }
    if (this.started) { this.net.sendCtl(id, { t: 'reject', reason: 'The game has already started.' }); this.net.forget(id); return; }
    const name = this.net.names[id] || 'Guest';
    const pid = Number(id);
    const shell = this.run.addRemotePlayer(pid, name);
    this.guests.set(id, { id, pid, name, shell, ready: false, build: null, echo: 0, echoAt: 0, offline: false, offAt: 0, wasDown: false });
    this.net.sendCtl(id, { t: 'welcome', pid, seed: this.run.seed, round: this.run.round, host: this.name, rejoin });
    this.net.broadcastCtl(this.lobbyMsg());
    this.run.announce('PLAYER JOINED', '#9fd8ff', `${name} joined the game.`);
    this.onChange?.();
  }

  /** A player whose connection dropped is back: put their wizard back on its feet. */
  private reconnected(g: GuestRec) {
    g.offline = false;
    const sh = g.shell;
    sh.down = g.wasDown;
    sh.cmdQ.length = 0; sh.cmdCredit = 0.25;
    if (!sh.down) sh.player.inv = Math.max(sh.player.inv, 2);
    this.net.sendCtl(g.id, { t: 'welcome', pid: g.pid, seed: this.run.seed, round: this.run.round, host: this.name, rejoin: true });
    if (this.run.phase === 'fight' || this.run.phase === 'clearing') this.net.sendCtl(g.id, { t: 'start', round: this.run.round, rejoin: true });
    this.net.broadcastCtl(this.lobbyMsg());
    this.run.announce('PLAYER RECONNECTED', '#9fd8ff', `${g.name} is back.`);
    this.onChange?.();
  }

  private onClose(id: string, graceful: boolean) {
    const g = this.guests.get(id);
    if (!g) return;
    if (graceful || !this.started) { this.remove(g, 'disconnected.'); return; }
    // the connection dropped mid-game: keep their wizard (standing down) for a while so they can reconnect
    g.offline = true; g.offAt = performance.now(); g.wasDown = g.shell.down; g.shell.down = true; g.ready = true;
    g.shell.dropCmds();
    this.run.announce('CONNECTION LOST', '#ffb27a', `${g.name} dropped. Waiting up to ${GRACE_MS / 1000} s for them to reconnect.`);
    this.net.broadcastCtl(this.lobbyMsg());
    this.onChange?.();
  }

  private remove(g: GuestRec, why: string) {
    this.guests.delete(g.id);
    const sp = this.sprites.get(g.shell);
    if (sp) { this.run.freeImg(sp.spr); this.run.freeImg(sp.shadow); sp.label.destroy(); this.sprites.delete(g.shell); }
    this.run.removePlayer(g.shell);
    this.net.forget(g.id);
    this.run.announce('PLAYER LEFT', '#ff9a9a', `${g.name} ${why}`);
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
      case 'bye': this.remove(g, 'left the game.'); break;
    }
  }

  /** Input stream from a joiner: [Cmd, client time, count, first seq, (ix, iy, dt) x count]. */
  private onInput(id: string, buf: ArrayBuffer) {
    const g = this.guests.get(id);
    if (!g || g.offline) return;
    try {
      const r = new Reader(buf);
      if (r.u8() !== K.Cmd) return;
      const ts = r.u32(), n = r.u8();
      let seq = r.u16();
      const cmds: Cmd[] = [];
      for (let i = 0; i < n && i < 64; i++) {
        const ix = r.i8(), iy = r.i8(), dt = r.u8();
        cmds.push({ seq, ix: Math.max(-127, ix), iy: Math.max(-127, iy), dt: Math.max(1, Math.min(200, dt)) / 4000 });
        seq = (seq + 1) & 0xffff;
      }
      g.echo = ts; g.echoAt = performance.now();
      g.shell.pushCmds(cmds);
    } catch { /* malformed packet */ }
  }

  /* ---- CoopLink ---- */

  beforeStart(): string | null {
    const wait = [...this.guests.values()].filter((g) => !g.offline && (!g.ready || !g.build));
    if (wait.length) return `Waiting for ${wait.map((g) => g.name).join(', ')} to get ready.`;
    for (const g of this.guests.values()) {
      if (g.offline) continue;
      try { g.shell.applyBuild(g.build!); } catch (e) {
        g.ready = false; g.build = null;
        this.net.sendCtl(g.id, { t: 'announce', text: 'BUILD REJECTED', color: '#ff9a9a', sub: 'Your build could not be loaded. Re-check your spells and ready up again.' });
        this.onChange?.();
        return `${g.name}'s build could not be loaded.`;
      }
      g.shell.down = false;
      g.shell.dropCmds(); g.shell.cmdCredit = 0.25;
    }
    this.run.rebuildOwners();
    if (!this.lobbyClosed) { this.lobbyClosed = true; this.started = true; void this.net.lockLobby(); }
    return null;
  }

  onStart() {
    for (const g of this.guests.values()) { if (g.offline) continue; g.ready = false; this.net.sendCtl(g.id, { t: 'start', round: this.run.round }); }
    this.net.broadcastCtl(this.lobbyMsg());
    this.onChange?.();
  }

  onPrep() {
    for (const g of this.guests.values()) {
      g.ready = false; g.build = null;
      if (!g.offline) this.net.sendCtl(g.id, { t: 'result', round: this.run.round, res: g.shell.roundResult() });
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
    this.rep.destroy();
    this.net.broadcastCtl({ t: 'bye' });
    setTimeout(() => this.net.close(), 120); // let the goodbye out first
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

  /* ---- per-frame ---- */

  /** Called once per rendered host frame, after the simulation step. */
  frame(dt: number) {
    this.syncSprites();
    const now = performance.now();
    for (const g of [...this.guests.values()]) if (g.offline && now - g.offAt > GRACE_MS) this.remove(g, 'did not reconnect.');
    const views: GuestView[] = [];
    for (const g of this.guests.values()) if (!g.offline) views.push({ id: g.id, shell: g.shell, echo: g.echo, echoAt: g.echoAt });
    if (this.run.phase === 'fight' || this.run.phase === 'clearing') this.rep.frame(dt, now, views);
  }

  /** Network numbers for the debug overlay and tests. */
  netInfo() {
    const out: Record<string, unknown> = { snap: { ...this.rep.stats } };
    for (const g of this.guests.values()) out[g.name] = { offline: g.offline, ...this.net.stats(g.id), cmdQueue: g.shell.cmdQ.length, credit: Math.round(g.shell.cmdCredit * 1000) / 1000 };
    return out;
  }

  /** Draw the remote players (the host's own wizard is drawn by the scene). */
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
          spr: run.img('wiz0', 8).setScale(3),
          shadow: run.img('shadow', 4).setScale(3).setAlpha(0.8),
          label: this.scene.add.text(0, 0, g.name, { fontFamily: '"Press Start 2P", monospace', fontSize: '8px', color: '#9fd8ff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(15),
        };
        this.sprites.set(sh, s);
      }
      const p = sh.player;
      poseWizard(s.spr, s.shadow, { x: p.x, y: p.y, faceX: p.faceX, walking: Math.hypot(sh.input.x, sh.input.y) > 0.1, walkT: p.walkT, hurt: p.hurtFlash > 0, inv: p.inv > 0, down: sh.down }, run.time, 0x9fd8ff);
      s.label.setPosition(p.x, p.y - 38).setText(g.offline ? `${g.name} (offline)` : sh.down ? `${g.name} (down)` : g.name).setAlpha(sh.down ? 0.6 : 1);
    }
  }

  destroy() {
    this.rep.destroy();
    for (const s of this.sprites.values()) { this.run.freeImg(s.spr); this.run.freeImg(s.shadow); s.label.destroy(); }
    this.sprites.clear();
    this.hostLabel?.destroy(); this.hostLabel = null;
  }
}

/* =============================================================== GUEST ============================================================== */

const CMD_INTERVAL = 15; // ms between input packets (<= ~66/s)

export class GuestSession implements CoopLink {
  role = 'guest' as const;
  code: string;
  lobby: LobbyPlayer[] = [];
  ready = false;
  hostName = 'Host';
  pid: number;
  onChange: (() => void) | null = null;
  inFight = false;
  readonly pred = new Predictor();
  readonly replica: Replica;
  private names = new Map<number, string>();
  private pausedShown = false;
  private coinBase = 0;
  private myKills = 0;
  private myDamage = 0;
  private bossFake: import('../game/types').Enemy | null = null;
  private ended = false;
  private started = false;
  private leaving = false;
  private reconnecting = false;
  private lastErr = '';
  private lastSend = 0;
  private lastMeAt = 0;
  private banner: HTMLElement | null = null;
  private fpsAcc = 0;
  /** Frame-time and correction samples, for the net overlay and tests. */
  perf = { frames: 0, over50: 0, maxFrame: 0, sum: 0 };

  constructor(public run: Run, private scene: Phaser.Scene, private net: GuestNet, private opts: MpOpts) {
    this.code = opts.code;
    this.pid = opts.welcome?.pid ?? 0;
    this.hostName = opts.welcome?.host ?? 'Host';
    run.coop = this;
    run.pname = opts.name;
    if (opts.welcome) { run.seed = opts.welcome.seed; run.round = opts.welcome.round; run.plan = planFor(run.round, run.seed); }
    this.replica = new Replica(run, scene, this.names, () => this.pid);
    this.replica.onMe = (m) => this.onMe(m);
    net.h = {
      onCtl: (m) => this.onCtl(m),
      onSt: (b) => this.replica.onSt(b, performance.now()),
      onFx: (b) => this.replica.onFx(b),
      onClose: (why, graceful) => this.onClosed(why, graceful),
    };
    for (const m of opts.early ?? []) this.onCtl(m);
  }

  party() {
    const m = this.replica.me;
    return (m?.party ?? []).map((q) => ({ name: this.names.get(q.pid) ?? (q.pid === 0 ? this.hostName : `P${q.pid}`), hp: q.hp, mh: q.mh, down: q.down, me: q.pid === this.pid }));
  }

  netInfo(): { net: NetStats; pred: Predictor['stats']; perf: GuestSession['perf']; chan: GuestNet['stats']; counts: ReturnType<Replica['counts']> } {
    return { net: { ...this.replica.stats }, pred: { ...this.pred.stats }, perf: { ...this.perf }, chan: this.net.stats, counts: this.replica.counts() };
  }

  private setBanner(text: string | null) {
    if (!text) { this.banner?.remove(); this.banner = null; return; }
    if (!this.banner) {
      this.banner = document.createElement('div');
      this.banner.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:60;padding:10px 16px;background:rgba(20,12,36,.92);border:2px solid #ffb27a;color:#ffd9a0;font:10px "Press Start 2P",monospace;pointer-events:none;text-align:center;line-height:1.8';
      document.body.appendChild(this.banner);
    }
    this.banner.textContent = text;
  }

  private onClosed(why: string, graceful: boolean) {
    if (this.ended || this.leaving) return;
    if (graceful || !this.started) { this.terminal(why); return; }
    void this.reconnect();
  }

  private terminal(why: string) {
    if (this.ended) return;
    this.ended = true;
    this.setBanner(null);
    showNotice(ui, 'Disconnected', why, () => ui.quitToMenu());
  }

  /** The connection dropped mid-game: keep trying to get back in (the host holds our wizard for a while). */
  private async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    for (let i = 0; i < 6 && !this.ended && !this.leaving; i++) {
      this.setBanner(`Connection lost. Reconnecting... (${i + 1}/6)`);
      await new Promise((r) => setTimeout(r, i === 0 ? 800 : 2500));
      try {
        await this.net.connect(this.code, this.opts.name, { peerId: this.net.peerId, peerKey: this.net.peerKey });
        this.reconnecting = false;
        this.setBanner(null);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        this.lastErr = msg;
        if (/closed|No such room|Bad key|version/i.test(msg)) break;
      }
    }
    this.reconnecting = false;
    this.terminal(this.lastErr && /closed|No such room/i.test(this.lastErr) ? 'The host ended the game.' : 'Could not reconnect to the host.');
  }

  private onCtl(m: Record<string, unknown>) {
    switch (m.t) {
      case 'welcome':
        this.pid = Number(m.pid); this.hostName = String(m.host ?? 'Host');
        if (!m.rejoin) { this.run.seed = Number(m.seed); this.run.round = Number(m.round); this.run.plan = planFor(this.run.round, this.run.seed); }
        break;
      case 'reject': this.terminal(String(m.reason ?? 'The host refused the connection.')); break;
      case 'bye': this.terminal('The host ended the game.'); break;
      case 'lobby': {
        this.lobby = m.players as LobbyPlayer[];
        for (const q of this.lobby) this.names.set(q.pid, q.name.replace(/ \(reconnecting\)$/, ''));
        this.names.set(0, this.hostName);
        const me = this.lobby.find((q) => q.pid === this.pid);
        if (me) this.ready = me.ready; // the host is the source of truth (it can reject a build)
        this.onChange?.();
        break;
      }
      case 'start': this.beginFight(Number(m.round), !!m.rejoin); break;
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

  private beginFight(round: number, rejoin = false) {
    const run = this.run;
    this.ready = false;
    this.started = true;
    run.round = round; run.plan = planFor(round, run.seed);
    run.phase = 'fight'; run.frozen = false;
    if (!rejoin || !this.inFight) this.coinBase = run.coins;
    this.inFight = true;
    this.replica.clear(); this.pred.reset();
    ui.closePrep();
    if (!rejoin) run.announce(isBoss(round) ? `ROUND ${round}: BOSS` : `ROUND ${round}`, isBoss(round) ? '#ff6b6b' : '#9fd8ff');
  }

  private mergeResult(m: { round: number; res: RoundRes }) {
    const run = this.run;
    const r = m.res;
    this.inFight = false;
    this.replica.clear(); this.pred.reset();
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
    this.leaving = true;
    this.ended = true;
    this.setBanner(null);
    this.net.sendCtl({ t: 'bye' });
    setTimeout(() => this.net.close(), 60);
  }

  /* ---- per-frame ---- */

  /** Called by the scene each rendered frame while a round is on. Order matters: predict and send FIRST (nothing waits for the
   *  network), then draw the replicated world. */
  frame(dt: number, input: { x: number; y: number }) {
    const run = this.run;
    if (!this.inFight) return;
    const now = performance.now();
    this.perf.frames++; this.perf.sum += dt * 1000; if (dt > 0.05) this.perf.over50++; if (dt * 1000 > this.perf.maxFrame) this.perf.maxFrame = dt * 1000;
    // 1. own wizard: apply input now, tell the host
    const me = this.replica.me;
    if (this.net.connected && !(me?.down)) {
      const c = this.pred.step(dt, input.x, input.y, run.arena);
      if (c && now - this.lastSend >= CMD_INTERVAL) { this.lastSend = now; this.sendCmds(now); }
    } else if (me?.down) this.pred.moving = false;
    // 2. the world
    this.replica.render(dt, now, this.pid, run.telGfx);
    run.fx.update(dt);
    run.arena.draw(run.floorGfx, this.replica.time / 1000);
    this.syncPause();
    // no news from the host for a while: say so instead of silently freezing
    if (!this.reconnecting) this.setBanner(this.lastMeAt && now - this.lastMeAt > 1500 && this.net.connected ? 'Waiting for the host...' : null);
  }

  private sendCmds(now: number) {
    const h = this.pred.hist;
    if (!h.length) return;
    const from = Math.max(0, h.length - CMD_RESEND);
    const w = new Writer(8 + (h.length - from) * 3);
    w.u8(K.Cmd); w.u32(now); w.u8(h.length - from); w.u16(h[from].seq);
    for (let i = from; i < h.length; i++) { w.i8(h[i].ix); w.i8(h[i].iy); w.u8(Math.round(h[i].dt * 4000)); }
    this.net.sendInp(w.bytes());
  }

  /** The newest authoritative word from the host: reconcile the prediction and update the HUD. */
  private onMe(m: import('./proto').MeMsg) {
    const run = this.run;
    this.lastMeAt = performance.now();
    if (!this.inFight) return;
    this.pred.reconcile(m, run.arena);
    const p = run.player;
    p.hp = m.hp; p.maxHp = m.mh; p.xp = m.xp; p.xpNeed = m.xn; p.level = m.lv; p.speed = m.speed;
    run.coins = this.coinBase + m.coins;
    run.quick = m.quick; run.time = m.t; run.round = m.round; run.phase = m.phase === 'prep' ? 'clearing' : (m.phase as Run['phase']); run.roundElapsed = m.el; run.kills = m.kills;
    run.down = m.down;
    run.arena.active = m.tilesActive;
    run.spells.forEach((sp, i) => { const c = m.spells[i]; if (c) { sp.cd = c.cd; sp.live = c.live; sp.ultCd = c.ult; } });
    if (m.boss) {
      this.bossFake ??= { boss: { name: '' }, hp: 1, maxHp: 1 } as unknown as import('../game/types').Enemy;
      this.bossFake.boss!.name = BOSS_NAMES[m.boss.kind] ?? 'Boss'; this.bossFake.hp = m.boss.hp; this.bossFake.maxHp = m.boss.mh;
      run.boss = this.bossFake;
    } else run.boss = null;
    p.hurtFlash = m.hurt ? 0.1 : 0; p.inv = m.inv ? 0.1 : 0;
  }

  /** Draw the joiner's own wizard from the prediction (called by the scene each frame, with the scene's sprites). */
  drawSelf(spr: Phaser.GameObjects.Image, shadow: Phaser.GameObjects.Image) {
    const run = this.run;
    const show = this.inFight && this.pred.ready;
    spr.setVisible(show); shadow.setVisible(show);
    if (!show) return;
    const s = this.pred.s;
    const m = this.replica.me;
    poseWizard(spr, shadow, { x: this.pred.x, y: this.pred.y, faceX: s.faceX, walking: this.pred.moving, walkT: s.walkT, hurt: !!m?.hurt, inv: !!m?.inv, down: !!m?.down }, performance.now() / 1000);
    run.player.x = this.pred.x; run.player.y = this.pred.y;
  }

  /** The host paused: show the joiners a pause screen (and take it away when play resumes). */
  private syncPause() {
    const paused = !!this.replica.me?.paused && this.inFight;
    if (paused === this.pausedShown) return;
    this.pausedShown = paused;
    if (paused) ui.showHostPause(this.hostName); else ui.hideHostPause();
  }

  /** Where the camera should look: you (predicted, so it never lags your keys), or a teammate while you are down. */
  cameraTarget(): { x: number; y: number } {
    const m = this.replica.me;
    if (m?.down) for (const pid of this.replica.otherPids(this.pid)) { const q = this.replica.playerPos(pid); if (q && !q.down) return q; }
    return this.pred.ready ? { x: this.pred.x, y: this.pred.y } : this.run.player;
  }

  destroy() { this.setBanner(null); this.replica.destroy(); }
}

const isBoss = (r: number) => r % 5 === 0;
import { BOSS_NAMES } from '../game/bosses';

interface RoundRes { build: Build; coins: number; kills: number; damage: number; boosts: string[] }
interface OverMsg { won: boolean; round: number; bosses: number; time: number; reactions: number; res: RoundRes }

