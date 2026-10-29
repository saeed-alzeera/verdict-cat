// Persistent settings + progression (localStorage, with safe fallbacks).
import { RUNES, RUNE_BY_ID, STARTER_RUNES } from '../data/runes';

export interface Settings {
  master: number; sfx: number; music: number; muted: boolean; shake: boolean; numbers: boolean; quick: boolean;
}
export interface SaveData {
  v: 1;
  /** 2 = constrained starter set (see STARTER_RUNES). Older saves are reset to it and refunded their shard purchases. */
  unlockVer?: number;
  settings: Settings;
  shards: number;
  unlocked: string[];
  journal: {
    reactions: Record<string, number>;
    combos: Record<string, { name: string; count: number }>;
    runes: Record<string, number>;
  };
  stats: { runs: number; wins: number; bestTime: number; kills: number; shardsEarned: number };
  starter: { core: string; form: string };
}

const KEY = 'spell-architect-save-v1';
/** Runes that cost shards even before the starter set was trimmed (only these are refunded on migration). */
const LEGACY_PAID = ['b_bounce', 'b_chain', 'b_orbit', 'b_pull', 'b_expand', 't_expiry', 't_crit', 'm_dup', 'm_acc', 'm_area'];

function fresh(): SaveData {
  return {
    v: 1,
    settings: { master: 0.7, sfx: 0.8, music: 0.5, muted: false, shake: true, numbers: true, quick: false },
    shards: 0,
    unlockVer: 2,
    unlocked: [...STARTER_RUNES],
    journal: { reactions: {}, combos: {}, runes: {} },
    stats: { runs: 0, wins: 0, bestTime: 0, kills: 0, shardsEarned: 0 },
    starter: { core: 'c_fire', form: 'f_projectile' },
  };
}

let data: SaveData = load();

function load(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SaveData>;
      const f = fresh();
      const d: SaveData = {
        ...f, ...p,
        settings: { ...f.settings, ...(p.settings ?? {}) },
        journal: { ...f.journal, ...(p.journal ?? {}) },
        stats: { ...f.stats, ...(p.stats ?? {}) },
        starter: { ...f.starter, ...(p.starter ?? {}) },
      } as SaveData;
      // make sure default unlocks always exist (new runes added in later versions)
      if (p.unlockVer !== 2) {
        // earlier builds started with almost everything unlocked: refund what was bought, then start from the small set
        for (const id of d.unlocked) { const r = RUNE_BY_ID[id]; if (r && !STARTER_RUNES.includes(id) && LEGACY_PAID.includes(id)) d.shards += r.unlock; }
        d.unlocked = [...STARTER_RUNES];
        d.unlockVer = 2;
      }
      d.unlocked = d.unlocked.filter((id) => RUNES.some((r) => r.id === id));
      for (const id of STARTER_RUNES) if (!d.unlocked.includes(id)) d.unlocked.push(id);
      const kind = (id: string) => RUNES.find((r) => r.id === id)?.kind;
      if (d.starter.core && kind(d.starter.core) !== 'core') d.starter.core = 'c_fire';
      if (kind(d.starter.form) !== 'form') d.starter.form = 'f_projectile';
      return d;
    }
  } catch { /* ignore */ }
  return fresh();
}

let timer: number | undefined;
export function save() {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
  }, 300);
}
export function saveNow() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

export const store = {
  get d() { return data; },
  get settings() { return data.settings; },
  isUnlocked(id: string): boolean { const t = RUNE_BY_ID[id]?.tierOf; return t ? data.unlocked.includes(t) : data.unlocked.includes(id); },
  unlock(id: string, cost: number): boolean {
    if (data.unlocked.includes(id) || data.shards < cost) return false;
    data.shards -= cost;
    data.unlocked.push(id);
    saveNow();
    return true;
  },
  addShards(n: number) { data.shards += n; data.stats.shardsEarned += n; save(); },
  discoverReaction(id: string): boolean {
    const first = !data.journal.reactions[id];
    data.journal.reactions[id] = (data.journal.reactions[id] ?? 0) + 1;
    if (first) saveNow(); else save();
    return first;
  },
  discoverCombo(sig: string, name: string): boolean {
    const j = data.journal.combos;
    const first = !j[sig];
    if (first) j[sig] = { name, count: 0 };
    j[sig].count++;
    if (first) saveNow(); else save();
    return first;
  },
  seeRune(id: string) { data.journal.runes[id] = (data.journal.runes[id] ?? 0) + 1; save(); },
  reset() { data = fresh(); saveNow(); },
};
