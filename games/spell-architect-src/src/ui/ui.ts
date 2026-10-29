// DOM-based user interface: menus, HUD, level-up, mutation, pause, game over, journal, grimoire.
import { showSpellOverview } from './overview';
import type Phaser from 'phaser';
import {
  RUNES, RUNE_BY_ID, RARITY, ELEMENTS, FORMS, KIND_LABEL, KIND_COLOR, runeColor,
  type RuneDef, type RuneKind,
} from '../data/runes';
import { REACTIONS, REACTION_BY_ID } from '../data/reactions';
import { reactionCardHtml } from './reactions';
import { buildSandboxPanel } from './sandbox';
import { showShop } from './shop';
import { loadRuns, syncRuns, syncAvailable, type RunRecord } from '../core/analytics';
import { showRelicPick } from './relics';
import { RELIC_BY_ID, relicColor } from '../game/relics';
import { EVOLVE_COST } from '../data/runes';
import { describeRes, FINAL_ROUND, roundLen, WEAK_TO, isBossRound, type Aff } from '../game/rounds';
import { ULT_COOLDOWN } from '../game/ultimates';
import { ULTIMATES } from '../data/runes';
import { MUT_TRACKS } from '../data/mutations';
import { store, save, saveNow } from '../core/save';
import { audio } from '../core/audio';
import { spellCooldown } from '../core/spell';
import type { Run, RunOpts, RunSummary } from '../game/run';
import { generateRewards, type Reward } from '../game/rewards';
import { openEditor } from './editor';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, el: ParentNode = document) => el.querySelector(sel) as T;
export function el(html: string): HTMLElement {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild as HTMLElement;
}
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function runeChipHtml(r: RuneDef, extra = ''): string {
  const col = runeColor(r);
  return `<div class="rchip ${extra}" style="--c:${col}"><span class="ri">${r.icon}</span><span class="rn">${r.name}</span><span class="rc">${r.cost}</span></div>`;
}

interface Layer { kind: string; el: HTMLElement; onKey?: (e: KeyboardEvent) => boolean }

class Hud {
  root: HTMLElement;
  hp!: HTMLElement; hpTxt!: HTMLElement; xp!: HTMLElement; lvl!: HTMLElement; timer!: HTMLElement; kills!: HTMLElement;
  bossBox!: HTMLElement; bossFill!: HTMLElement; bossName!: HTMLElement; slotsEl!: HTMLElement; ann!: HTMLElement; toasts!: HTMLElement; badge!: HTMLElement; coinEl!: HTMLElement; lastCoin = -1; ultsEl!: HTMLElement; ultKey = '';
  ultEls: HTMLElement[] = [];
  slotKey = '';
  frame = 0; relEl!: HTMLElement; hpBar!: HTMLElement; relKey = '';
  cdEls: HTMLElement[] = [];
  last = { hp: -1, xp: -1, t: -1, k: -1, b: -1, k2: -1, kl: -1 };
  constructor(private uiRef: UI) {
    this.root = el(`<div id="hud" class="hidden">
      <div class="hud-tl">
        <div class="bar hp"><div class="fill"></div><span></span></div>
        <div class="bar xp"><div class="fill"></div><b class="lvl">LV 1</b></div>
        <div class="coinbar">◈ <b class="cn">0</b></div>
        <div class="hud-relics"></div>
        <div class="rewardbadge hidden"></div>
      </div>
      <div class="hud-ults"></div>
      <div class="hud-tc"><div class="timer">0:00</div><div class="kills">0 slain</div>
        <div class="bossbox hidden"><div class="bossname"></div><div class="bar boss"><div class="fill"></div></div></div></div>
      <div class="hud-tr">
        <button data-a="editor" class="hidden" title="Spell Editor (E)">📖 <small>E</small></button>
        <button data-a="mute" title="Mute">🔊</button>
        <button data-a="pause" title="Pause (Esc)">⏸</button>
      </div>
      <div class="hud-slots"></div>
      <div class="announce"></div>
      <div class="toasts"></div>
    </div>`);
    uiRef.root.appendChild(this.root);
    this.relEl = $('.hud-relics', this.root); this.hpBar = $('.bar.hp', this.root);
    this.hp = $('.hp .fill', this.root); this.hpTxt = $('.hp span', this.root);
    this.xp = $('.xp .fill', this.root); this.lvl = $('.lvl', this.root);
    this.timer = $('.timer', this.root); this.kills = $('.kills', this.root);
    this.bossBox = $('.bossbox', this.root); this.bossFill = $('.boss .fill', this.root); this.bossName = $('.bossname', this.root);
    this.slotsEl = $('.hud-slots', this.root); this.ann = $('.announce', this.root); this.toasts = $('.toasts', this.root); this.badge = $('.rewardbadge', this.root); this.coinEl = $('.cn', this.root); this.ultsEl = $('.hud-ults', this.root);
    this.root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'pause') uiRef.togglePause();
      else if (a === 'editor') uiRef.openEditorFromPlay();
      else if (a === 'mute') {
        store.settings.muted = !store.settings.muted; audio.applyVolumes(); save(); b.textContent = store.settings.muted ? '🔇' : '🔊';
      }
      (b as HTMLElement).blur();
    });
  }
  show(run: Run) {
    this.root.classList.remove('hidden');
    this.slotKey = ''; this.relKey = '';
    this.last = { hp: -1, xp: -1, t: -1, k: -1, b: -1, k2: -1, kl: -1 };
    this.ultKey = '';
    this.ann.innerHTML = ''; this.toasts.innerHTML = '';
    $('[data-a=mute]', this.root).textContent = store.settings.muted ? '🔇' : '🔊';
    this.update(run);
  }
  hide() { this.root.classList.add('hidden'); }
  flashUlt(run: Run) {
    if (!run.ultimates().length) { run.announce('NO ULTIMATE', '#ff9a9a', 'Forge ${EVOLVE_COST} copies of a Core into an evolved Core in the editor, then equip it.'); return; }
    this.ultEls.forEach((e) => { e.classList.remove('nope'); void e.offsetWidth; e.classList.add('nope'); });
  }
  update(run: Run) {
    const p = run.player;
    const hp = Math.round(p.hp);
    const barW = Math.round(Math.min(360, 70 + p.maxHp * 0.9));
    if (this.hpBar.dataset.w !== String(barW)) { this.hpBar.dataset.w = String(barW); this.hpBar.style.width = `${barW}px`; }
    const rk = run.equipped.join(',');
    if (rk !== this.relKey) {
      this.relKey = rk;
      this.relEl.innerHTML = run.equipped.map((id) => { const r = RELIC_BY_ID[id]; return `<div class="hrel ${r.cursed ? 'cursed' : ''}" data-r="${id}" style="--rc:${relicColor(r)}" title="${r.name} — ${r.cond}: ${r.desc}"><span>${r.icon}</span><em></em></div>`; }).join('');
    }
    if (run.equipped.length && (this.frame++ & 7) === 0) this.relEl.querySelectorAll<HTMLElement>('.hrel').forEach((h) => { const d = RELIC_BY_ID[h.dataset.r!]; h.querySelector('em')!.textContent = d.badge ? d.badge(run) : ''; });
    if (hp !== this.last.hp) {
      this.last.hp = hp;
      this.hp.style.width = `${Math.max(0, (p.hp / p.maxHp) * 100)}%`;
      this.hpTxt.textContent = `${hp} / ${p.maxHp}`;
      this.root.classList.toggle('lowhp', p.hp / p.maxHp < 0.3);
    }
    const xp = Math.round((p.xp / p.xpNeed) * 500);
    if (xp !== this.last.xp) { this.last.xp = xp; this.xp.style.width = `${(p.xp / p.xpNeed) * 100}%`; }
    if (p.level !== this.last.k) { this.last.k = p.level; this.lvl.textContent = `LV ${p.level}`; }
    const remain = run.phase === 'fight' && !isBossRound(run.round) ? Math.max(0, roundLen(run.quick) - run.roundElapsed) : -1;
    const t = run.sandbox ? -2 : isBossRound(run.round) ? -3 : Math.ceil(remain);
    if (t !== this.last.t || this.last.k2 !== run.round) {
      this.last.t = t; this.last.k2 = run.round;
      this.timer.innerHTML = run.sandbox ? 'SANDBOX' : `<small>ROUND ${run.round}/${FINAL_ROUND}</small><br>${isBossRound(run.round) ? 'BOSS' : fmtTime(Math.max(0, remain))}`;
    }
    if (run.kills !== this.last.kl) { this.last.kl = run.kills; this.kills.textContent = `${run.kills} slain`; }
    const cn = Math.floor(run.coins);
    if (cn !== this.lastCoin) { this.lastCoin = cn; this.coinEl.textContent = String(cn); }
    const pend = run.pending.filter((q) => q.type !== 'mutation').length;
    this.badge.classList.toggle('hidden', pend === 0 || run.sandbox);
    if (pend) this.badge.textContent = `★ ${pend} REWARD${pend > 1 ? 'S' : ''} WAITING FOR ROUND END`;
    $('[data-a=editor]', this.root).classList.toggle('hidden', !run.sandbox);
    // ultimates
    const uls = run.ultimates();
    const ukey = uls.map((u) => `${u.i}:${u.sp.c.root!.element}`).join(',');
    if (ukey !== this.ultKey) {
      this.ultKey = ukey;
      this.ultsEl.innerHTML = uls.map((u, n) => {
        const U = ULTIMATES[u.sp.c.root!.element];
        return `<div class="ult" style="--c:${ELEMENTS[u.sp.c.root!.element].css}" title="${U.name}: ${U.desc}"><span>${U.icon}</span><small>${n === 0 ? 'SPACE' : `#${n + 1}`}</small><em>${U.name}</em><div class="cd"></div></div>`;
      }).join('');
      this.ultEls = Array.from(this.ultsEl.querySelectorAll<HTMLElement>('.ult'));
    }
    uls.forEach((u, n) => {
      const e = this.ultEls[n]; if (!e) return;
      const f = Math.max(0, Math.min(1, u.sp.ultCd / ULT_COOLDOWN));
      ($('.cd', e) as HTMLElement).style.height = `${f * 100}%`;
      e.classList.toggle('ready', u.sp.ultCd <= 0);
    });
    const boss = run.boss;
    if (boss && boss.boss) {
      this.bossBox.classList.remove('hidden');
      this.bossName.textContent = boss.boss.name;
      const b = Math.round(Math.max(0, boss.hp / boss.maxHp) * 500);
      if (b !== this.last.b) { this.last.b = b; this.bossFill.style.width = `${b / 5}%`; }
    } else this.bossBox.classList.add('hidden');
    // spell slots
    const key = run.spells.map((s) => `${s.c.signature}|${s.c.name}|${s.mutations.length}`).join(';');
    if (key !== this.slotKey) {
      this.slotKey = key;
      this.slotsEl.innerHTML = run.spells.map((s, i) => {
        if (!s.c.valid || !s.c.root) return `<div class="slot empty"><b>${i + 1}</b><span class="si">+</span><em>Empty</em></div>`;
        const r = s.c.root;
        const rootRune = ELEMENTS[r.element];
        return `<div class="slot" style="--c:${rootRune.css}"><b>${i + 1}</b><span class="si">${rootRune.icon}${FORMS[r.form].icon}</span><em>${s.c.name}</em>${s.mutations.length ? `<i class="mutdot">✦${s.mutations.length}</i>` : ''}<div class="cd"></div></div>`;
      }).join('');
      this.cdEls = Array.from(this.slotsEl.querySelectorAll<HTMLElement>('.cd'));
    }
    let ci = 0;
    for (const s of run.spells) {
      if (!s.c.valid || !s.c.root) continue;
      const cd = spellCooldown(s.c.root, s.mut) * p.cdMul;
      const f = s.live > 0 && (s.c.root.form === 'orb' || s.c.root.form === 'aura') ? 0 : Math.max(0, Math.min(1, s.cd / cd));
      const e = this.cdEls[ci++];
      if (e) e.style.height = `${f * 100}%`;
    }
  }
  announce(text: string, color: string, sub?: string) {
    if (text.startsWith('NEW ') || text.startsWith('MUTATED')) {
      while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
      const t = el(`<div class="toast" style="--c:${color}"><b>${text}</b>${sub ? `<span>${sub}</span>` : ''}</div>`);
      this.toasts.appendChild(t);
      setTimeout(() => t.remove(), 6000);
      return;
    }
    while (this.ann.children.length > 2) this.ann.firstElementChild!.remove();
    const n = el(`<div class="ann" style="--c:${color}"><b>${text}</b>${sub ? `<span>${sub}</span>` : ''}</div>`);
    this.ann.appendChild(n);
    setTimeout(() => n.remove(), 4200);
  }
}

class UI {
  root = document.getElementById('ui')!;
  game!: Phaser.Game;
  run: Run | null = null;
  opts: RunOpts | null = null;
  hud!: Hud;
  stack: Layer[] = [];
  menuEl: HTMLElement | null = null;
  rerollsLeft = 0;

  get blocking() { return this.stack.length > 0; }

  init(game: Phaser.Game) {
    this.game = game;
    this.hud = new Hud(this);
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('blur', () => { if (this.run && !this.run.over && !this.blocking) this.togglePause(); });
    const unlock = () => { audio.init(); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.showMenu();
  }

  /* ------------------------------ layers ------------------------------ */

  push(kind: string, node: HTMLElement, onKey?: (e: KeyboardEvent) => boolean) {
    const top = this.stack[this.stack.length - 1];
    if (top) top.el.classList.add('hidden');
    this.stack.push({ kind, el: node, onKey });
    this.root.appendChild(node);
    if (this.run) this.run.frozen = true;
  }
  pop(kind?: string) {
    const i = kind ? this.stack.map((l) => l.kind).lastIndexOf(kind) : this.stack.length - 1;
    if (i < 0) return;
    const [l] = this.stack.splice(i, 1);
    l.el.remove();
    const top = this.stack[this.stack.length - 1];
    if (top) top.el.classList.remove('hidden');
    else if (this.run && !this.run.over) { if (this.run.phase !== 'prep') this.run.frozen = false; this.pump(this.run); }
  }
  clearLayers() { for (const l of this.stack) l.el.remove(); this.stack = []; }

  onKey(e: KeyboardEvent) {
    const top = this.stack[this.stack.length - 1];
    if (top?.onKey && top.onKey(e)) { e.preventDefault(); return; }
    const k = e.key;
    if (!this.run) return;
    if (this.run.over) {
      if ((k === 'r' || k === 'R' || k === 'Enter') && top?.kind === 'gameover') this.retry();
      return;
    }
    if (k === ' ' || k === 'Spacebar') { e.preventDefault(); if (!top && !e.repeat && !this.run.useUltimate()) this.hud.flashUlt(this.run); return; }
    if (k === 'Escape' || k === 'p' || k === 'P') {
      if (top?.kind === 'pause') this.pop('pause');
      else if (!top && this.run.phase !== 'prep') this.togglePause();
    } else if ((k === 'e' || k === 'E' || k === 'Tab') && !top) {
      e.preventDefault();
      if (this.run.sandbox) this.openEditorFromPlay();
      else if (this.run.phase === 'fight') this.run.announce('EDITOR LOCKED', '#ff9a9a', 'Spells can only be edited between rounds.');
    } else if (k === 'Tab') e.preventDefault();
  }

  /* ------------------------------ run lifecycle ------------------------------ */

  beginRun(run: Run, opts: RunOpts) {
    this.run = run; this.opts = opts;
    this.clearLayers();
    this.menuEl?.remove(); this.menuEl = null;
    this.rerollsLeft = run.rerolls;
    this.hud.show(run);
    audio.init();
    this.sbox?.remove(); this.sbox = null;
    if (run.sandbox) {
      const sb = buildSandboxPanel(this, run);
      this.sbox = sb;
      this.root.appendChild(sb);
      run.announce('SANDBOX', '#9fd8ff', 'All runes unlocked. Press E to edit, spawn enemies on the right.');
    }
  }
  sbox: HTMLElement | null = null;
  endRun() { this.run = null; this.clearLayers(); this.hud.hide(); this.sbox?.remove(); this.sbox = null; }
  announce(text: string, color: string, sub?: string) { this.hud.announce(text, color, sub); }

  pump(run: Run) {
    if (run.over || this.blocking || run.sandbox || run.phase !== 'prep') return;
    if (run.pending.length) {
      const next = run.pending.shift()!;
      run.frozen = true;
      if (next.type === 'levelup') this.showReward(run, 'levelup');
      else if (next.type === 'cache') this.showReward(run, 'cache');
      else if (next.type === 'relic') showRelicPick(this, run, next.options);
      else this.showMutation(run, next.sp, next.track);
    } else if (!run.shopOpened) { run.shopOpened = true; showShop(this, run); }
    else this.showPrep(run);
  }

  /** Between-round screen: what's coming (attunements, boss resistances), then edit and start. */
  showPrep(run: Run) {
    const plan = run.plan;
    const r = run.round;
    const boss = plan.boss;
    const aff = (a: Aff) => (a === 'neutral' ? { name: 'Neutral', icon: '⚪', css: '#d8d8e8' } : { name: ELEMENTS[a].name, icon: ELEMENTS[a].icon, css: ELEMENTS[a].css });
    const elChips = (list: string[]) => list.map((e) => `<span class="rel" style="--c:${ELEMENTS[e as keyof typeof ELEMENTS].css}">${ELEMENTS[e as keyof typeof ELEMENTS].icon} ${ELEMENTS[e as keyof typeof ELEMENTS].name}</span>`).join('');
    const shares = plan.shares.filter((x) => x.pct > 0).map((x) => {
      const a = aff(x.aff);
      const d = x.aff === 'neutral' ? null : { res: [x.aff as string], weak: (WEAK_TO[x.aff] ?? []) as string[] };
      return `<div class="share" style="--c:${a.css}"><div class="sbarbg"><i style="width:${x.pct}%"></i></div>
        <b>${a.icon} ${a.name}${x.aff === 'neutral' ? '' : '-attuned'}</b><span>${x.pct}%</span>
        <small>${d ? `Resists ${elChips(d.res)} (takes ${Math.round(plan.resFactor * 100)}%) · Weak to ${elChips(d.weak)} (+${Math.round((plan.weakMul - 1) * 100)}%)` : 'Takes full damage from everything.'}</small></div>`;
    }).join('');
    let bossHtml = '';
    if (boss !== null && plan.bossRes) {
      const d = describeRes(plan.bossRes);
      const names = ['Stone Warden', 'Plague Matron', 'Storm Colossus', 'The Void Architect'];
      bossHtml = `<div class="bossprev"><canvas width="96" height="96" data-boss="${boss}"></canvas><div>
        <h3>BOSS: ${names[boss].toUpperCase()}</h3>
        ${d.immune.length ? `<p class="bi">IMMUNE: ${elChips(d.immune)} (elemental damage does nothing)</p>` : ''}
        ${d.resist.length ? `<p>Resists: ${elChips(d.resist)}</p>` : ''}
        ${d.weak.length ? `<p>Weak to: ${elChips(d.weak)}</p>` : ''}
        <p class="muted">Arcane (no Core) is never resisted. Bring a mix.</p></div></div>`;
    }
    const slots = run.spells.map((s, i) => `<div class="pslot"><b>${i + 1}</b>${s.c.valid && s.c.root ? `${ELEMENTS[s.c.root.element].icon} ${s.c.name}` : '<em>empty</em>'}${s.c.root?.evolved ? ' ★' : ''}</div>`).join('');
    const n = el(`<div class="overlay prepov"><div class="panel prepp">
      <div class="rtitle"><small>${r === 1 ? 'GET READY' : `ROUND ${r - 1} COMPLETE`}</small><h2>ROUND ${r}${boss !== null ? ' · BOSS' : ''} <span class="of">/ ${FINAL_ROUND}</span></h2>
      <p class="sub">${boss !== null ? 'Defeat the boss to finish the round.' : `Survive ${roundLen(run.quick)} seconds.`} ${boss === null ? `Next boss: round ${Math.ceil(r / 5) * 5}.` : ''}</p></div>
      ${bossHtml}
      ${run.forgeReady().length ? `<div class="forgebanner">FORGE READY: you have ${EVOLVE_COST}+ ${run.forgeReady().map((e) => ELEMENTS[e].name).join(', ')} cores. Open the Spell Editor's Forge tab to evolve them into an Ultimate!</div>` : ''}
      <h4>ENEMY MIX THIS ROUND</h4><div class="shares">${shares}</div>
      ${plan.tip ? `<p class="tip2">TIP: ${plan.tip}</p>` : ''}
      <h4>YOUR LOADOUT</h4><div class="pslots">${slots}</div>
      <div class="rbtns"><button class="big" data-a="shop">Shop <small>◈ ${Math.floor(run.coins)}</small></button><button class="big ${run.forgeReady().length ? 'glow' : ''}" data-a="editor">Spell Editor${run.forgeReady().length ? ' (FORGE READY!)' : ''}</button><button class="big primary" data-a="go">Start Round ${r}</button></div>
    </div></div>`);
    n.querySelectorAll<HTMLCanvasElement>('canvas[data-boss]').forEach((cv) => {
      try {
        const img = this.game.textures.get(`boss${cv.dataset.boss}`).getSourceImage() as CanvasImageSource;
        const c = cv.getContext('2d')!; c.imageSmoothingEnabled = false; c.drawImage(img, 0, 0, 96, 96);
      } catch { /* texture not ready */ }
    });
    n.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
      if (!b) return;
      audio.play('ui');
      if (b.dataset.a === 'editor') openEditor(this, run);
      else if (b.dataset.a === 'shop') showShop(this, run);
      else if (b.dataset.a === 'go') { run.startRound(); this.pop('prep'); }
    });
    this.push('prep', n, (e) => {
      if ((e.key === 'e' || e.key === 'E') && this.stack[this.stack.length - 1]?.kind === 'prep') { openEditor(this, run); return true; }
      if ((e.key === 'Enter') && this.stack[this.stack.length - 1]?.kind === 'prep') { run.startRound(); this.pop('prep'); return true; }
      return false;
    });
  }

  togglePause() {
    const run = this.run;
    if (!run || run.over) return;
    if (this.stack.length) { if (this.stack[this.stack.length - 1].kind === 'pause') this.pop('pause'); return; }
    const n = el(`<div class="overlay"><div class="panel pausep">
      <h2>Paused</h2>
      <div class="btns">
        <button class="big" data-a="resume">Resume</button>
        ${run.sandbox ? '<button class="big" data-a="editor">Spell Editor</button>' : '<p class="muted">Spell editing opens between rounds.</p>'}
        <button class="big" data-a="overview">🔮 Spell Overview</button>
        <button class="big" data-a="journal">📜 Journal</button>
        <button class="big" data-a="retry">Restart Run</button>
        <button class="big danger" data-a="quit">Quit to Menu</button>
      </div>
      <div class="sett"></div>
    </div></div>`);
    $('.sett', n).appendChild(this.settingsPanel(true));
    n.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
      if (!b) return;
      audio.play('ui');
      const a = b.dataset.a;
      if (a === 'resume') this.pop('pause');
      else if (a === 'editor') this.openEditorFromPlay();
      else if (a === 'journal') this.showJournal();
      else if (a === 'overview') showSpellOverview(this, run);
      else if (a === 'retry') this.retry();
      else if (a === 'quit') this.quitToMenu();
    });
    this.push('pause', n);
  }

  openEditorFromPlay() {
    const run = this.run;
    if (!run || run.over || !(run.sandbox || run.phase === 'prep')) return;
    if (this.stack.length && this.stack[this.stack.length - 1].kind === 'editor') return;
    openEditor(this, run);
  }

  retry() {
    this.run?.abandon();
    if (!this.opts) return;
    const o = this.opts;
    const sc = this.game.scene.getScene('Game');
    this.clearLayers();
    sc.scene.restart(o);
  }
  quitToMenu() {
    this.run?.abandon();
    this.clearLayers();
    this.hud.hide();
    this.run = null;
    this.game.scene.stop('Game');
    this.game.scene.start('Menu');
    this.showMenu();
  }

  /* ------------------------------ rewards ------------------------------ */

  showReward(run: Run, mode: 'levelup' | 'cache') {
    let rewards = generateRewards(run, mode);
    const n = el(`<div class="overlay lv"><div class="panel rewardp">
      <div class="rtitle"><small>${mode === 'cache' ? 'BOSS RUNE CACHE' : 'LEVEL UP'}</small><h2>${mode === 'cache' ? 'Choose a Rune' : 'Choose a Stat Boost'}</h2></div>
      <div class="cards"></div>
      <div class="rbtns">
        ${mode === 'levelup' ? '<button class="big" data-a="reroll"></button>' : ''}
      </div>
      <p class="tip">Press 1 / 2 / 3 to choose. ${mode === 'cache' ? 'Runes go into your pool: place them in the Spell Editor.' : 'Level-ups boost your stats. Runes and spell upgrades are in the shop.'}</p>
    </div></div>`);
    const cards = $('.cards', n);
    const rerollBtn = n.querySelector('[data-a=reroll]') as HTMLElement | null;
    const choose = (r: Reward) => {
      r.apply(run);
      audio.play('pick');
      this.pop(mode);
    };
    const render = () => {
      cards.innerHTML = rewards.map((r, i) => `<div class="card r-${r.rarity}" data-i="${i}" style="--rc:${RARITY[r.rarity].color};--c:${r.color}">
        <div class="ck">${i + 1}</div><div class="cicon">${r.icon}</div><div class="cname">${r.title}</div>
        <div class="crar">${RARITY[r.rarity].name} · ${r.kind === 'rune' ? KIND_LABEL[RUNE_BY_ID[r.rune!].kind] : 'Upgrade'}</div>
        <p>${r.desc}</p><div class="ctag">${r.tag}</div></div>`).join('');
      if (rerollBtn) { rerollBtn.textContent = `🎲 Reroll (${this.rerollsLeft})`; (rerollBtn as HTMLButtonElement).disabled = this.rerollsLeft <= 0; }
    };
    render();
    n.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const card = t.closest('.card') as HTMLElement | null;
      if (card) { choose(rewards[+card.dataset.i!]); return; }
      const b = t.closest('button[data-a]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.a === 'editor') openEditor(this, run);
      else if (b.dataset.a === 'reroll' && this.rerollsLeft > 0) { this.rerollsLeft--; run.rerolls = this.rerollsLeft; rewards = generateRewards(run, mode); audio.play('ui'); render(); }
    });
    this.push(mode, n, (e) => {
      if (['1', '2', '3'].includes(e.key) && this.stack[this.stack.length - 1].kind === mode) {
        const r = rewards[+e.key - 1];
        if (r) { choose(r); return true; }
      }
      return false;
    });
  }

  showMutation(run: Run, sp: Run['spells'][number], track: typeof MUT_TRACKS[number]) {
    const n = el(`<div class="overlay lv mut"><div class="panel rewardp">
      <div class="rtitle"><small>SPELL MUTATION · ${track.title.toUpperCase()}</small><h2>${sp.c.name}</h2>
      <p class="sub">This spell has ${track.why}. It is evolving, choose how.</p></div>
      <div class="cards two">${track.options.map((o, i) => `<div class="card r-epic mutcard" data-i="${i}" style="--rc:#c26bff;--c:#c26bff">
        <div class="ck">${i + 1}</div><div class="cicon">${o.icon}</div><div class="cname">${o.name}</div><div class="crar">Mutation · lasts this run</div><p>${o.desc}</p></div>`).join('')}</div>
      <p class="tip">Press 1 / 2 to choose. Mutations reset when the run ends.</p>
    </div></div>`);
    const choose = (i: number) => {
      run.applyMutation(sp, track, track.options[i].id);
      run.announce(`MUTATED: ${track.options[i].name}`, '#c26bff', sp.c.name);
      run.fx.ring(run.player.x, run.player.y, 0xc26bff, 10, 200, 0.6);
      audio.play('level');
      this.pop('mutation');
    };
    n.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest('.card') as HTMLElement | null;
      if (c) choose(+c.dataset.i!);
    });
    this.push('mutation', n, (e) => {
      if (e.key === '1' || e.key === '2') { choose(+e.key - 1); return true; }
      return false;
    });
  }

  /* ------------------------------ game over ------------------------------ */

  showGameOver(s: RunSummary) {
    const total = s.spells.reduce((a, b) => a + b.damage, 0) || 1;
    const best = [...s.spells].sort((a, b) => b.damage - a.damage)[0];
    const disc = s.discoveries.map((d) => {
      if (d.startsWith('reaction:')) { const r = REACTION_BY_ID[d.slice(9)]; return `${r.icon} ${r.name}`; }
      return `🧩 ${d.slice(6)}`;
    });
    const n = el(`<div class="overlay go ${s.won ? 'win' : 'lose'}"><div class="panel gop">
      <h1>${s.won ? 'VICTORY' : 'DEFEATED'}</h1>
      <p class="sub">${s.won ? 'The Void Architect is no more. Your spells are legend.' : 'Your spellbook falls silent… but the runes remember.'}</p>
      <div class="stats">
        <div><b>${fmtTime(s.time)}</b><span>Survived${s.quick ? ' (quick)' : ''}</span></div>
        <div><b>${s.kills}</b><span>Enemies defeated</span></div>
        <div><b>${Math.round(s.damage).toLocaleString()}</b><span>Total damage</span></div>
        <div><b>${s.level}</b><span>Level reached</span></div>
        <div><b>${s.bosses}</b><span>Bosses slain</span></div>
        <div><b>${s.round}/${FINAL_ROUND}</b><span>Round reached</span></div>
      </div>
      ${best ? `<div class="best">Most effective spell: <b>${best.name}</b> — ${Math.round(best.damage / total * 100)}% of damage</div>` : ''}
      <div class="sbars">${s.spells.map((sp) => `<div class="sbar"><span>${sp.elements.map((e) => ELEMENTS[e as keyof typeof ELEMENTS].icon).join('')} ${sp.name}</span><div><i style="width:${sp.damage / total * 100}%"></i></div><em>${Math.round(sp.damage).toLocaleString()} · ${sp.kills} kills</em></div>`).join('')}</div>
      ${disc.length ? `<div class="disc"><h3>Discovered this run</h3>${disc.map((d) => `<span>${d}</span>`).join('')}</div>` : ''}
      <div class="shards">+${s.shards} ◆ Arcane Shards <small>(${store.d.shards} total)</small></div>
      <div class="btns row"><button class="big primary" data-a="retry">Try Again <small>R</small></button><button class="big" data-a="grim">◆ Grimoire</button><button class="big" data-a="menu">Menu</button></div>
    </div></div>`);
    n.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
      if (!b) return;
      audio.play('ui');
      if (b.dataset.a === 'retry') this.retry();
      else if (b.dataset.a === 'menu') this.quitToMenu();
      else if (b.dataset.a === 'grim') this.showGrimoire();
    });
    this.push('gameover', n);
    saveNow();
  }

  /* ------------------------------ main menu ------------------------------ */

  showMenu() {
    this.menuEl?.remove();
    const st = store.d;
    const unlockedForms = RUNES.filter((r) => r.kind === 'form' && store.isUnlocked(r.id));
    st.starter.core = ''; // every run starts with plain Arcane; elements come from rewards
    if (!store.isUnlocked(st.starter.form)) st.starter.form = 'f_projectile';
    const n = el(`<div class="menu">
      <div class="logo"><div class="l1">SPELL</div><div class="l2">ARCHITECT</div><p>Build your magic. Break the horde.</p></div>
      <div class="starter">
        <h3>Choose your starting Form. You begin with plain Arcane magic and find elements as you go.</h3>
        <div class="srow forms">${unlockedForms.map((r) => runeChipHtml(r, `${st.starter.form === r.id ? 'sel' : ''}" data-form="${r.id}`)).join('')}</div>
      </div>
      <div class="btns">
        <button class="big primary" data-a="play">Begin Run</button>
        <label class="quick"><input type="checkbox" ${st.settings.quick ? 'checked' : ''}/> Accelerated test mode <small>(12s rounds, gentler enemies)</small></label>
        <div class="row">
          <button class="big" data-a="grim">◆ Grimoire <small>${st.shards}</small></button>
          <button class="big" data-a="journal">📜 Journal</button>
        </div>
        <div class="row"><button class="big" data-a="sandbox">Sandbox</button><button class="big" data-a="history">📊 Run History</button></div>
        <div class="row">
          <button class="big" data-a="settings">⚙ Settings</button>
          <button class="big" data-a="help">? How to Play</button>
        </div>
      </div>
      <footer>Runs ${st.stats.runs} · Victories ${st.stats.wins} · Best ${fmtTime(st.stats.bestTime)} · ${st.stats.kills.toLocaleString()} enemies slain</footer>
    </div>`);
    n.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const c = t.closest('[data-core]') as HTMLElement | null, f = t.closest('[data-form]') as HTMLElement | null;
      if (f) { st.starter.form = f.dataset.form!; save(); audio.play('ui'); this.showMenu(); return; }
      const b = t.closest('button[data-a]') as HTMLElement | null;
      if (!b) return;
      audio.init(); audio.play('ui');
      switch (b.dataset.a) {
        case 'play': this.startRun(); break;
        case 'sandbox': this.startRun(true); break;
        case 'grim': this.showGrimoire(); break;
        case 'journal': this.showJournal(); break;
        case 'history': this.showHistory(); break;
        case 'settings': this.showSettings(); break;
        case 'help': this.showHelp(); break;
      }
    });
    $('.quick input', n).addEventListener('change', (e) => { st.settings.quick = (e.target as HTMLInputElement).checked; save(); });
    this.menuEl = n;
    this.root.appendChild(n);
  }

  startRun(sandbox = false) {
    const st = store.d;
    const opts: RunOpts = { quick: st.settings.quick, core: '', form: st.starter.form, sandbox };
    this.menuEl?.remove(); this.menuEl = null;
    this.game.scene.stop('Menu');
    this.game.scene.start('Game', opts);
  }

  /* ------------------------------ modal screens ------------------------------ */

  modal(title: string, body: HTMLElement | string, cls = ''): HTMLElement {
    const n = el(`<div class="overlay"><div class="panel modalp ${cls}"><div class="mhead"><h2>${title}</h2><button class="x" data-a="close">X</button></div><div class="mbody"></div></div></div>`);
    const b = $('.mbody', n);
    if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
    n.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-a=close]') || e.target === n) this.closeModal(n); });
    return n;
  }
  closeModal(n: HTMLElement) {
    const i = this.stack.findIndex((l) => l.el === n);
    if (i >= 0) { this.stack.splice(i, 1); n.remove(); const top = this.stack[this.stack.length - 1]; if (top) top.el.classList.remove('hidden'); else if (this.run && !this.run.over) this.run.frozen = false; }
    else n.remove();
    if (this.menuEl) this.menuEl.classList.remove('hidden');
  }
  openModal(n: HTMLElement, kind: string) {
    if (this.run) {
      this.push(kind, n, (e) => { if (e.key === 'Escape' && this.stack[this.stack.length - 1]?.el === n) { this.closeModal(n); return true; } return false; });
    } else {
      this.menuEl?.classList.add('hidden');
      this.root.appendChild(n);
      const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { this.closeModal(n); window.removeEventListener('keydown', h); } };
      window.addEventListener('keydown', h);
    }
  }

  settingsPanel(compact = false): HTMLElement {
    const s = store.settings;
    const n = el(`<div class="settings ${compact ? 'compact' : ''}">
      <label>Master <input type="range" min="0" max="1" step="0.05" data-k="master" value="${s.master}"></label>
      <label>Effects <input type="range" min="0" max="1" step="0.05" data-k="sfx" value="${s.sfx}"></label>
      <label>Music <input type="range" min="0" max="1" step="0.05" data-k="music" value="${s.music}"></label>
      <label class="chk"><input type="checkbox" data-k="muted" ${s.muted ? 'checked' : ''}> Mute all</label>
      <label class="chk"><input type="checkbox" data-k="shake" ${s.shake ? 'checked' : ''}> Screen shake</label>
      <label class="chk"><input type="checkbox" data-k="numbers" ${s.numbers ? 'checked' : ''}> Damage numbers</label>
    </div>`);
    n.addEventListener('input', (e) => {
      const i = e.target as HTMLInputElement;
      const k = i.dataset.k as keyof typeof s;
      if (!k) return;
      (s as unknown as Record<string, number | boolean>)[k] = i.type === 'checkbox' ? i.checked : +i.value;
      audio.applyVolumes(); save();
    });
    return n;
  }

  showSettings() {
    const body = el('<div></div>');
    body.appendChild(this.settingsPanel());
    const reset = el('<button class="big danger resetbtn">Reset all progress</button>');
    let armed = false;
    reset.addEventListener('click', () => {
      if (!armed) { armed = true; reset.textContent = 'Click again to ERASE unlocks, journal and settings'; return; }
      store.reset(); this.closeModal(m); this.showMenu();
    });
    body.appendChild(reset);
    const m = this.modal('Settings', body);
    this.openModal(m, 'settings');
  }

  showHelp() {
    const m = this.modal('How to Play', `<div class="help">
      <p><b>Rounds.</b> The run is 20 rounds. Survive each timed round, then you get a break to read the briefing, pick rewards and edit your spells. <b>Every 5th round is a boss.</b> Spells can only be edited between rounds.</p>
      <p><b>Move</b> with <kbd>WASD</kbd> or arrows. Spells cast on their own. <kbd>Space</kbd> fires an Ultimate once you own one. <kbd>Esc</kbd> pauses.</p>
      <p><b>Every spell is a FORM</b> in one of your slots (Projectile, Beam, Orb, Aura, Mine, Nova, Meteor). Socket <b>one Core</b> into it for its element; launched Forms inherit it. With no Core a Form deals plain <b>Arcane</b> damage.</p>
      <p><b>Elements hit harder than Arcane</b> and add an effect (fire burns, ice slows, poison stacks...). But <b>attuned enemies resist their own element</b> and bosses can be fully <b>immune</b> to some. Arcane is never resisted, and the briefing before each round shows what is coming. Use different slots for different elements.</p>
      <p><b>Augments.</b> <span style="color:${KIND_COLOR.behavior}">Behaviors</span> change how a Form acts, <span style="color:${KIND_COLOR.modifier}">Modifiers</span> tune its numbers. A <span style="color:${KIND_COLOR.trigger}">Trigger</span> launches more Forms when it fires. The editor writes your whole chain as plain sentences.</p>
      <p><b>Reactions.</b> Elements from different slots interact with each other's puddles, clouds and statuses. Each reaction deals <b>both</b> damage types. The editor's Reactions tab shows which ones your loadout can trigger.</p>
      <p><b>Evolution.</b> Collect ${EVOLVE_COST} copies of the same Core and forge an evolved Core in the editor's Forge tab: +40% damage, a new passive, and an <b>Ultimate</b> on Space. The editor and briefing flash when you can forge.</p>
      <p><b>Shop.</b> Kills and cleared rounds earn coins. After every round, spend them on new Cores, Forms and runes (rerollable stock), spell capacity, extra slots and buffs, or sell runes you don't need. <b>Level-ups</b> give stat boosts; boss caches give a choice of strong runes.</p>
      <p><b>Capacity</b> limits runes per spell. <b>Mutations</b> evolve spells that perform well. Spend Arcane Shards in the Grimoire to unlock more runes (behaviors, triggers, modifiers). The <b>Sandbox</b> lets you test any build against any enemy.</p>
    </div>`);
    this.openModal(m, 'help');
  }

  showGrimoire() {
    const kinds: RuneKind[] = ['core', 'form', 'behavior', 'trigger', 'modifier'];
    const build = () => {
      const body = el(`<div class="grim"><div class="shardbar">◆ <b>${store.d.shards}</b> Arcane Shards · ${store.d.unlocked.filter((id) => !RUNE_BY_ID[id]?.evolved).length}/${RUNES.filter((r) => !r.evolved && !r.merged).length} runes unlocked</div>${kinds.map((k) => `
        <h3 style="color:${KIND_COLOR[k]}">${KIND_LABEL[k]} Runes</h3><div class="ggrid">${RUNES.filter((r) => r.kind === k && !r.evolved && !r.merged).map((r) => {
          const un = store.isUnlocked(r.id);
          return `<div class="gcard ${un ? 'un' : 'lock'}" style="--c:${runeColor(r)};--rc:${RARITY[r.rarity].color}">
            <div class="gi">${r.icon}</div><div class="gb"><b>${r.name}</b><small>${RARITY[r.rarity].name} · cost ${r.cost}</small><p>${r.desc}</p></div>
            ${un ? '<span class="ok">Unlocked</span>' : `<button data-u="${r.id}" ${store.d.shards < r.unlock ? 'disabled' : ''}>◆ ${r.unlock}</button>`}</div>`;
        }).join('')}</div>`).join('')}</div>`);
      return body;
    };
    let body = build();
    const m = this.modal('Grimoire', body, 'wide');
    const refresh = () => { const nb = build(); body.replaceWith(nb); body = nb; $('.mbody', m).innerHTML = ''; $('.mbody', m).appendChild(nb); };
    m.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-u]') as HTMLElement | null;
      if (!b) return;
      const r = RUNE_BY_ID[b.dataset.u!];
      if (store.unlock(r.id, r.unlock)) { audio.play('pick'); refresh(); }
    });
    this.openModal(m, 'grimoire');
  }

  showJournal() {
    const j = store.d.journal;
    const reacts = REACTIONS.map((r) => reactionCardHtml(r, null, j.reactions[r.id] ?? 0)).join('');
    const combos = Object.entries(j.combos).sort((a, b) => b[1].count - a[1].count);
    const comboHtml = combos.length ? combos.map(([sig, c]) => `<div class="jcard"><div class="gi">🧩</div><div><b>${c.name}</b><small>${sig}</small><small>Built ${c.count}×</small></div></div>`).join('') : '<p class="muted">No combinations recorded yet. Build a spell with 3+ runes.</p>';
    const baseRunes = RUNES.filter((r) => !r.merged);
    const seen = baseRunes.filter((r) => j.runes[r.id]).length;
    const m = this.modal('Discovery Journal', `<div class="journal">
      <h3>Elemental reactions <small>${Object.keys(j.reactions).length}/${REACTIONS.length} discovered</small></h3><p class="muted">Reactions deal BOTH damage types (split evenly), so an enemy that resists one element still takes the other. You need the listed elements somewhere in your loadout.</p><div class="jgrid">${reacts}</div>
      <h3>Spell combinations <small>${combos.length}</small></h3><div class="jgrid">${comboHtml}</div>
      <h3>Runes encountered <small>${seen}/${baseRunes.length}</small></h3>
      <div class="jruns">${baseRunes.map((r) => j.runes[r.id] ? runeChipHtml(r) : '<div class="rchip unk"><span class="ri">?</span></div>').join('')}</div>
    </div>`, 'wide');
    this.openModal(m, 'journal');
  }
  /** Saved runs (local, plus synced with the hub's sync key when present). */
  showHistory() {
    const body = el('<div class="history"></div>');
    const fmtD = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const draw = (runs: RunRecord[], note: string) => {
      const rows = runs.filter((r) => !r.sandbox).map((r) => `<div class="hrow ${r.result}">
        <div class="hh"><b>${r.result === 'won' ? 'VICTORY' : r.result === 'lost' ? 'DEFEATED' : 'ABANDONED'}</b><span>R${r.reachedRound} · ${fmtTime(r.time)} · LV ${r.level}</span><span>${r.kills} kills · ${r.damage.toLocaleString()} dmg</span><em>${fmtD(r.endedAt)}</em></div>
        <div class="hd hidden">
          <p>${r.deathCause ? `Killed by <b>${r.deathCause}</b>. ` : ''}Damage taken ${r.taken}. Bosses ${r.bosses}. Reactions ${r.reactions}. Seed ${r.seed}.</p>
          <p><b>Relics:</b> ${r.relics.map((id) => RELIC_BY_ID[id]?.name ?? id).join(', ') || 'none'}</p>
          <p><b>Spells:</b></p>${r.spells.map((sp) => `<div class="hs">${sp.name} <small>${sp.damage.toLocaleString()} dmg · ${sp.cost}/${sp.cap} cap${sp.evolved ? ' · evolved' : ''}</small><small>${sp.forms.join(' → ')}</small></div>`).join('') || '<small>none</small>'}
          <p><b>Rounds:</b></p><div class="rl">${r.roundLog.map((x) => `<span title="${x.secs}s · ${x.kills} kills · ${x.damage} dmg · took ${x.taken}">R${x.round}${x.boss ? '★' : ''} ${x.hpEnd}/${x.maxHp}hp</span>`).join('')}</div>
        </div></div>`).join('');
      body.innerHTML = `<p class="muted">${note}</p>${rows || '<p class="muted">No finished runs yet. Play one!</p>'}`;
    };
    draw(loadRuns(), syncAvailable() ? 'Syncing with your hub…' : 'Saved on this device. Open the game from your hub (same site) to sync across devices.');
    body.addEventListener('click', (e) => { const h = (e.target as HTMLElement).closest('.hrow'); h?.querySelector('.hd')?.classList.toggle('hidden'); });
    syncRuns().then((r) => draw(r.runs, r.ok ? 'Synced with your hub.' : 'Saved on this device.'));
    const m = this.modal('Run History', body, 'wide');
    this.openModal(m, 'history');
  }
}

export const ui = new UI();

export function initUI(game: Phaser.Game) { ui.init(game); }
export type { UI };
