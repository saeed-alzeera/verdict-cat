// Run analytics: every run is saved locally and, when the hub's sync key is present (same origin as the hub),
// pushed to the verdict-cat sync worker (namespace "spell-runs") so history is available on every device.

export interface SpellRec { name: string; element: string; damage: number; cost: number; cap: number; forms: string[]; evolved: boolean }
export interface RoundRec {
  round: number; boss: boolean; secs: number; kills: number; damage: number; taken: number;
  hpEnd: number; maxHp: number; coins: number; level: number; spells: SpellRec[]; relics: string[];
}
export interface RunRecord {
  id: string; v: 1; startedAt: number; endedAt: number;
  result: 'won' | 'lost' | 'abandoned'; quick: boolean; sandbox: boolean; seed: number; startForm: string;
  reachedRound: number; time: number; level: number; kills: number; damage: number; taken: number;
  hurtBy: Record<string, number>; deathCause: string; shards: number; bosses: number; reactions: number;
  spells: SpellRec[]; relics: string[]; roundLog: RoundRec[]; discoveries: string[];
}

const KEY = 'spell-architect-runs-v1';
const WORKER = 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';
const SYNC_KEY = 'verdict-cat-sync-key';
const NS = 'spell-runs';
const MAX = 80;

export function loadRuns(): RunRecord[] {
  try { return (JSON.parse(localStorage.getItem(KEY) || '[]') as RunRecord[]).sort((a, b) => b.endedAt - a.endedAt); } catch { return []; }
}
function writeRuns(list: RunRecord[]) {
  const l = [...list].sort((a, b) => b.endedAt - a.endedAt).slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* quota */ }
}

export const syncAvailable = () => { try { return !!localStorage.getItem(SYNC_KEY); } catch { return false; } };

async function wfetch(path: string, init: RequestInit = {}) {
  const key = localStorage.getItem(SYNC_KEY) || '';
  const r = await fetch(WORKER + path, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`sync ${r.status}`);
  return r.json();
}

export function saveRunRecord(rec: RunRecord) {
  const list = loadRuns().filter((r) => r.id !== rec.id);
  list.push(rec);
  writeRuns(list);
  if (syncAvailable() && !rec.sandbox) {
    wfetch(`/sync/${NS}`, { method: 'POST', body: JSON.stringify({ entries: { [rec.id]: { value: rec, ts: rec.endedAt } } }) }).catch(() => { /* offline: stays local */ });
  }
}

/** Merge runs from the sync server into local storage. Returns the merged list. */
export async function syncRuns(): Promise<{ runs: RunRecord[]; ok: boolean }> {
  const local = loadRuns();
  if (!syncAvailable()) return { runs: local, ok: false };
  try {
    const res = await wfetch(`/sync/${NS}`);
    const remote = (res.entries ?? {}) as Record<string, { value: RunRecord | null; ts: number }>;
    const byId = new Map(local.map((r) => [r.id, r]));
    const push: Record<string, { value: RunRecord; ts: number }> = {};
    for (const [id, e] of Object.entries(remote)) if (e.value && !byId.has(id)) byId.set(id, e.value);
    for (const r of local) if (!remote[r.id] && !r.sandbox) push[r.id] = { value: r, ts: r.endedAt };
    writeRuns([...byId.values()]);
    if (Object.keys(push).length) await wfetch(`/sync/${NS}`, { method: 'POST', body: JSON.stringify({ entries: push }) }).catch(() => undefined);
    return { runs: loadRuns(), ok: true };
  } catch { return { runs: local, ok: false }; }
}
