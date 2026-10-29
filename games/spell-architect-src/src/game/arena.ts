// The arena floor: an 11x11 grid of tiles. Each round a seeded share of the tiles crumbles away in three waves
// (10% in round 1, 20% from round 2 on; it resets every round, it is not cumulative). Doomed tiles flash and
// crack for a few seconds first. The tiles that remain are always connected, so nobody is ever stranded.
import type Phaser from 'phaser';

export const TILE = 100;
export const TN = 11;
export const ARENA = TILE * TN;

const SOLID = 0, WARN = 1, FALL = 2, VOID = 3;
const CENTER = (TN >> 1) * TN + (TN >> 1);
const WAVES = 3;
const WAVE_AT = [0.16, 0.44, 0.72]; // fraction of the round at which each wave is announced
const FALL_ANIM = 0.5;
/** How strongly the collapse favours the edges and corners (0 = uniform). A corner is ~9x as likely as a centre tile to go early; half of all falling tiles come from the outer ring. */
const EDGE_BIAS = 8;

function rng(seed: number) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Share of the floor that falls away during a round (not cumulative): 10% in round 1, then 20% at most. */
export const MAX_FALL_SHARE = 0.2;
export const fallShare = (round: number) => Math.min(MAX_FALL_SHARE, 0.1 * round);

export const tileOf = (x: number, y: number) => {
  const tx = Math.max(0, Math.min(TN - 1, (x / TILE) | 0)), ty = Math.max(0, Math.min(TN - 1, (y / TILE) | 0));
  return ty * TN + tx;
};
export const tileCx = (i: number) => (i % TN) * TILE + TILE / 2;
export const tileCy = (i: number) => Math.floor(i / TN) * TILE + TILE / 2;

export class Arena {
  state = new Uint8Array(TN * TN);
  timer = new Float32Array(TN * TN);
  waves: number[][] = [];
  warned = 0;
  fell = 0;
  elapsed = 0;
  warnLen = 4;
  roundLen = 45;
  active = false;
  version = 0;
  flow = new Float32Array(TN * TN).fill(1e9);
  private flowFor = -1;
  private flowVer = -1;

  /** Solid again, no waves queued. */
  reset() {
    this.state.fill(SOLID); this.timer.fill(0);
    this.waves = []; this.warned = 0; this.fell = 0; this.elapsed = 0; this.active = false;
    this.version++;
  }

  /** Choose this round's doomed tiles. Removal order keeps the remaining floor connected at every step. */
  start(round: number, seed: number, roundLen: number, enabled: boolean) {
    this.reset();
    if (!enabled) return;
    this.roundLen = roundLen;
    this.warnLen = Math.max(2, Math.min(4, roundLen / 8));
    const r = rng(round * 4093 + seed * 131 + 7);
    const target = Math.round(fallShare(round) * TN * TN);
    // Weighted shuffle (Efraimidis-Spirakis): tiles further from the middle are likelier to go first, corners most of all,
    // but the weights are mild enough that inner tiles still fall regularly.
    const keyed: { t: number; k: number }[] = [];
    const half = (TN - 1) / 2, maxD = Math.hypot(half, half);
    for (let i = 0; i < TN * TN; i++) {
      if (i === CENTER) continue;
      const d = Math.hypot((i % TN) - half, Math.floor(i / TN) - half) / maxD; // 0 centre .. 1 corner
      const w = 1 + EDGE_BIAS * d * d;
      keyed.push({ t: i, k: Math.pow(Math.max(1e-9, r()), 1 / w) });
    }
    keyed.sort((a, b) => b.k - a.k);
    const order = keyed.map((x) => x.t);
    const gone = new Uint8Array(TN * TN);
    const removed: number[] = [];
    for (const t of order) {
      if (removed.length >= target) break;
      gone[t] = 1;
      if (this.connected(gone)) removed.push(t); else gone[t] = 0;
    }
    const per = Math.ceil(removed.length / WAVES);
    for (let w = 0; w < WAVES; w++) this.waves.push(removed.slice(w * per, (w + 1) * per));
    this.active = removed.length > 0;
  }

  private connected(gone: Uint8Array): boolean {
    const seen = new Uint8Array(TN * TN);
    const stack = [CENTER];
    seen[CENTER] = 1;
    let n = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % TN, cy = (c / TN) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= TN || ny >= TN) continue;
        const k = ny * TN + nx;
        if (seen[k] || gone[k]) continue;
        seen[k] = 1; n++; stack.push(k);
      }
    }
    let total = 0;
    for (let i = 0; i < gone.length; i++) if (!gone[i]) total++;
    return n === total;
  }

  /** Advances the schedule. Returns tiles that warned / fell this step. */
  update(dt: number): { warned: number[]; fell: number[] } {
    const out = { warned: [] as number[], fell: [] as number[] };
    if (!this.active) return out;
    this.elapsed += dt;
    while (this.warned < WAVES && this.elapsed >= WAVE_AT[this.warned] * this.roundLen) {
      for (const t of this.waves[this.warned]) { if (this.state[t] === SOLID) { this.state[t] = WARN; this.timer[t] = this.warnLen; } }
      out.warned.push(...this.waves[this.warned]);
      this.warned++; this.version++;
    }
    for (let i = 0; i < this.state.length; i++) {
      const s = this.state[i];
      if (s === WARN) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) { this.state[i] = FALL; this.timer[i] = FALL_ANIM; out.fell.push(i); this.version++; }
      } else if (s === FALL) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) { this.state[i] = VOID; this.version++; }
      }
    }
    return out;
  }

  /** True while any tile can still crumble (used for the HUD hint). */
  get pending(): boolean { return this.active && (this.warned < WAVES || this.state.some((s) => s === WARN)); }
  get voids(): boolean { return this.active && this.state.some((s) => s >= FALL); }

  solid(x: number, y: number): boolean { return this.state[tileOf(x, y)] < FALL; }
  doomed(x: number, y: number): boolean { return this.state[tileOf(x, y)] === WARN; }
  stateOf(i: number): number { return this.state[i]; }

  /** Nearest solid tile centre (preferring tiles that are not about to fall). */
  nearestSolid(x: number, y: number, safe = true): [number, number] {
    let best = -1, bd = Infinity;
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      for (let i = 0; i < this.state.length; i++) {
        const s = this.state[i];
        if (pass === 0 && safe ? s !== SOLID : s >= FALL) continue;
        const d = (tileCx(i) - x) ** 2 + (tileCy(i) - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best < 0) return [ARENA / 2, ARENA / 2];
    // land inside the tile, as close to the original point as possible
    const cx = tileCx(best), cy = tileCy(best), m = TILE / 2 - 14;
    return [Math.max(cx - m, Math.min(cx + m, x)), Math.max(cy - m, Math.min(cy + m, y))];
  }

  /** Puts a point on solid floor if it is not already. */
  fix(x: number, y: number): [number, number] { return this.solid(x, y) ? [x, y] : this.nearestSolid(x, y, false); }

  /** Slide-resolve a move from (ox,oy) to (e.x,e.y) against fallen tiles. */
  constrain(e: { x: number; y: number }, ox: number, oy: number) {
    if (this.solid(e.x, e.y)) return;
    if (this.solid(e.x, oy)) { e.y = oy; return; }
    if (this.solid(ox, e.y)) { e.x = ox; return; }
    if (this.solid(ox, oy)) { e.x = ox; e.y = oy; return; }
    const [x, y] = this.nearestSolid(e.x, e.y, false);
    e.x = x; e.y = y;
  }

  /** Straight line from a to b crosses no fallen tile. */
  clear(ax: number, ay: number, bx: number, by: number): boolean {
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(d / 40);
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      if (this.state[tileOf(ax + (bx - ax) * k, ay + (by - ay) * k)] >= FALL) return false;
    }
    return true;
  }

  /** Walking distances to the player's tile (doomed tiles cost extra so enemies route around them). */
  private computeFlow(px: number, py: number) {
    const src = tileOf(px, py);
    if (src === this.flowFor && this.version === this.flowVer) return;
    this.flowFor = src; this.flowVer = this.version;
    const dist = this.flow;
    dist.fill(1e9);
    const done = new Uint8Array(TN * TN);
    dist[src] = 0;
    for (let iter = 0; iter < TN * TN; iter++) {
      let u = -1, ud = 1e9;
      for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      const ux = u % TN, uy = (u / TN) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = ux + dx, ny = uy + dy;
        if (nx < 0 || ny < 0 || nx >= TN || ny >= TN) continue;
        const k = ny * TN + nx;
        if (this.state[k] >= FALL) continue;
        if (dx && dy && (this.state[uy * TN + nx] >= FALL || this.state[ny * TN + ux] >= FALL)) continue;
        const w = (dx && dy ? 1.41 : 1) + (this.state[k] === WARN ? 3 : 0);
        if (ud + w < dist[k]) dist[k] = ud + w;
      }
    }
  }

  /** Where a walker at (x,y) should head to reach the player: straight at them, or around the holes. */
  goal(x: number, y: number, px: number, py: number): [number, number] {
    if (!this.voids || this.clear(x, y, px, py)) return [px, py];
    this.computeFlow(px, py);
    const cur = tileOf(x, y);
    const cx = cur % TN, cy = (cur / TN) | 0;
    let best = -1, bd = this.flow[cur];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= TN || ny >= TN) continue;
      const k = ny * TN + nx;
      if (this.state[k] >= FALL) continue;
      if (dx && dy && (this.state[cy * TN + nx] >= FALL || this.state[ny * TN + cx] >= FALL)) continue;
      if (this.flow[k] < bd) { bd = this.flow[k]; best = k; }
    }
    return best < 0 ? [px, py] : [tileCx(best), tileCy(best)];
  }

  /** Random solid tile centre at least `minD` from (x,y); falls back to the farthest one. */
  randomSpot(x: number, y: number, minD: number): [number, number] {
    const ok: number[] = [];
    let far = CENTER, fd = -1;
    for (let i = 0; i < this.state.length; i++) {
      if (this.state[i] !== SOLID) continue;
      const d = Math.hypot(tileCx(i) - x, tileCy(i) - y);
      if (d >= minD) ok.push(i);
      if (d > fd) { fd = d; far = i; }
    }
    const t = ok.length ? ok[(Math.random() * ok.length) | 0] : far;
    return [tileCx(t) + (Math.random() - 0.5) * (TILE - 30), tileCy(t) + (Math.random() - 0.5) * (TILE - 30)];
  }

  /** Paint the floor overlay: cracks and a red pulse on doomed tiles, shrinking dark tiles as they fall. */
  draw(g: Phaser.GameObjects.Graphics, time: number) {
    g.clear();
    if (!this.active) return;
    for (let i = 0; i < this.state.length; i++) {
      const s = this.state[i];
      if (s === SOLID) continue;
      const x = (i % TN) * TILE, y = Math.floor(i / TN) * TILE;
      if (s === WARN) {
        const left = this.timer[i];
        const rate = left < 1.2 ? 14 : 6;
        const pulse = 0.5 + 0.5 * Math.sin(time * rate + i);
        g.fillStyle(0xff3a3a, 0.12 + 0.2 * pulse + (left < 1.2 ? 0.12 : 0));
        g.fillRect(x, y, TILE, TILE);
        g.lineStyle(3, 0xff6a5a, 0.55 + 0.4 * pulse);
        g.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
        // cracks
        g.lineStyle(2, 0x2a0608, 0.85);
        const o = (i * 53) % 17;
        g.beginPath();
        g.moveTo(x + 12 + o, y + 8); g.lineTo(x + 40, y + 36); g.lineTo(x + 34, y + 58); g.lineTo(x + 66, y + 80); g.lineTo(x + 78, y + 94);
        g.moveTo(x + 40, y + 36); g.lineTo(x + 78, y + 28); g.lineTo(x + 92, y + 50);
        g.strokePath();
      } else if (s === FALL) {
        const k = Math.max(0, this.timer[i] / FALL_ANIM);
        const inset = (1 - k) * (TILE / 2);
        g.fillStyle(0x06040b, 1 - k * 0.6);
        g.fillRect(x + inset * 0.2, y + inset * 0.2, TILE - inset * 0.4, TILE - inset * 0.4);
        g.fillStyle(0x06040b, 0.9);
        g.fillRect(x + inset, y + inset, TILE - inset * 2, TILE - inset * 2);
      } else {
        g.fillStyle(0x06040b, 1);
        g.fillRect(x, y, TILE, TILE);
        // lit edge where the floor still stands
        g.lineStyle(3, 0x6a4cc0, 0.7);
        const edge = (nx: number, ny: number, x1: number, y1: number, x2: number, y2: number) => {
          if (nx < 0 || ny < 0 || nx >= TN || ny >= TN || this.state[ny * TN + nx] < FALL) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.strokePath(); }
        };
        const cx = i % TN, cy = (i / TN) | 0;
        edge(cx - 1, cy, x, y, x, y + TILE); edge(cx + 1, cy, x + TILE, y, x + TILE, y + TILE);
        edge(cx, cy - 1, x, y, x + TILE, y); edge(cx, cy + 1, x, y + TILE, x + TILE, y + TILE);
      }
    }
  }
}
