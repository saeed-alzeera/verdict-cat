// Persistent settings + progression (localStorage, with safe fallbacks).
import { RUNES } from '../data/runes';

export interface Settings {
  master: number; sfx: number; music: number; muted: boolean; shake: boolean; numbers: boolean; quick: boolean;
}
export interface SaveData {
  v: 1;
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

function fresh(): SaveData {
  return {
    v: 1,
    settings: { master: 0.7, sfx: 0.8, music: 0.5, muted: false, shake: true, numbers: true, quick: false },
    shards: 0,
    unlocked: RUNES.filter((r) => r.unlock === 0).map((r) => r.id),
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
      d.unlocked = d.unlocked.filter((id) => RUNES.some((r) => r.id === id));
      for (const r of RUNES) if (r.unlock === 0 && !d.unlocked.includes(r.id)) d.unlocked.push(r.id);
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
  isUnlocked(id: string) { return data.unlocked.includes(id); },
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
