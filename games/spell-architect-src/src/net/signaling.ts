// Client for the sync worker's public /mp/* routes: room codes and the WebRTC handshake only (see sync-worker/mp.js).

const DEFAULT_BASE = 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';

/** `?mp=http://localhost:8799` (or localStorage `sa-mp-base`) points the game at another signaling server, e.g. a local `wrangler dev`. */
export function mpBase(): string {
  try {
    const q = new URLSearchParams(location.search).get('mp');
    if (q) { localStorage.setItem('sa-mp-base', q); return q.replace(/\/$/, ''); }
    const s = localStorage.getItem('sa-mp-base');
    if (s) return s.replace(/\/$/, '');
  } catch { /* storage unavailable */ }
  return DEFAULT_BASE;
}

export interface SignalMsg { n: number; from: string; kind: 'offer' | 'answer' | 'ice' | 'bye'; data: string }
export interface PollResult { msgs: SignalMsg[]; closed: boolean; peers?: Record<string, string> }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(mpBase() + path, init); } catch { throw new Error('Could not reach the multiplayer server. Check your connection.'); }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Multiplayer server error (${res.status})`);
  return body as T;
}
const post = (path: string, body: unknown) => call<never>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);

export const createRoom = () => post('/mp/rooms', {}) as Promise<{ code: string; hostKey: string }>;
export const roomInfo = (code: string) => call<{ open: boolean; players: number; max: number; names: string[] }>(`/mp/rooms/${code}`);
export const joinRoom = (code: string, name: string) => post(`/mp/rooms/${code}/join`, { name }) as Promise<{ peerId: string; peerKey: string }>;
export const sendSignal = (code: string, as: string, key: string, to: string, kind: SignalMsg['kind'], data: string) =>
  post(`/mp/rooms/${code}/signal`, { as, key, to, kind, data });
export const pollSignal = (code: string, as: string, key: string, after: number, waitMs: number, signal?: AbortSignal) =>
  call<PollResult>(`/mp/rooms/${code}/signal?as=${encodeURIComponent(as)}&key=${key}&after=${after}&wait=${waitMs}`, { signal });
export const closeRoom = (code: string, key: string) => post(`/mp/rooms/${code}/close`, { key }).catch(() => undefined);
