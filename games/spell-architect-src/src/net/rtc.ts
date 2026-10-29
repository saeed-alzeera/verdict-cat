// WebRTC peer manager. The host accepts a connection from each joiner; the joiner opens one to the host. Four data channels per
// peer, each with the delivery semantics its traffic needs (see proto.ts):
//   ctl  reliable + ordered       JSON: lobby, round flow, rewards, results
//   inp  unreliable               joiner -> host input commands (sent redundantly, so loss costs nothing)
//   st   unreliable               host -> joiner state datagrams (a stale snapshot is worthless: never retransmitted)
//   fx   unreliable, 250 ms life  host -> joiner cosmetic effects (retransmitted briefly, then dropped)
// Because the state channels are unordered and never retransmit, a lost or late packet cannot block the ones behind it.
import { closeRoom, createRoom, joinRoom, lockRoom, pollSignal, roomInfo, sendSignal, type SignalMsg } from './signaling';
import { FX_LIFETIME_MS, PROTO, protoHash } from './proto';

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

const GATHER_TIMEOUT = 5000;
const GATHER_QUIET = 1200;
const CONNECT_TIMEOUT = 25000;
/** A snapshot is not queued behind more than this many bytes: the channel is congested, so skip it instead of building latency. */
const MAX_BUFFERED = 48 * 1024;

/** Wait for ICE gathering so the offer/answer carries its candidates (no trickle: one message each way). Resolves when gathering
 *  completes, or once candidates have gone quiet (a blocked STUN server must not stall the handshake), or at the hard cap. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let seen = 0, last = Date.now();
    const finish = () => { pc.removeEventListener('icegatheringstatechange', on); pc.removeEventListener('icecandidate', cand); clearInterval(iv); clearTimeout(cap); resolve(); };
    const on = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const cand = (e: Event) => { if ((e as RTCPeerConnectionIceEvent).candidate) { seen++; last = Date.now(); } };
    const iv = setInterval(() => { if (seen > 0 && Date.now() - last >= GATHER_QUIET) finish(); }, 150);
    const cap = setTimeout(finish, GATHER_TIMEOUT);
    pc.addEventListener('icegatheringstatechange', on);
    pc.addEventListener('icecandidate', cand);
  });
}

/* ------------------------------------------------------------------ test-only network impairment */

/** Simulated bad network for tests, applied on top of the real connection at the sender: packet loss (%), one-way delay and
 *  jitter (ms). Off unless `?netsim=loss,delay,jitter` is in the URL or window.__netsim is set. Never on for real players. */
export interface NetSim { loss: number; delay: number; jitter: number }
let fromUrl: NetSim | null | undefined;
export function netsim(): NetSim | null {
  const w = window as unknown as { __netsim?: NetSim };
  if (w.__netsim) return w.__netsim;
  if (fromUrl === undefined) {
    fromUrl = null;
    try {
      const q = new URLSearchParams(location.search).get('netsim');
      if (q) { const [loss, delay, jitter] = q.split(',').map(Number); fromUrl = { loss: loss || 0, delay: delay || 0, jitter: jitter || 0 }; }
    } catch { /* no window */ }
  }
  return fromUrl;
}
/** Send through the simulator. Unreliable traffic can be dropped and reordered; reliable traffic is only delayed, in order. */
function shaped(ch: RTCDataChannel, data: string | ArrayBuffer, reliable: boolean, state: { last: number }) {
  const sim = netsim();
  if (!sim || (!sim.loss && !sim.delay && !sim.jitter)) { ch.send(data as never); return; }
  if (!reliable && Math.random() * 100 < sim.loss) return;
  let wait = sim.delay + Math.random() * sim.jitter;
  const t = performance.now();
  if (reliable) { wait = Math.max(wait, state.last - t); state.last = t + wait; }
  setTimeout(() => { if (ch.readyState === 'open') ch.send(data as never); }, wait);
}

export interface ChanStats { msgs: number; bytes: number; maxBuffered: number; skipped: number; maxMsg: number }
const newStats = (): ChanStats => ({ msgs: 0, bytes: 0, maxBuffered: 0, skipped: 0, maxMsg: 0 });

/* ------------------------------------------------------------------ host */

export interface HostHandlers {
  onPeers(names: Record<string, string>): void; // everyone who has joined the room (connected or not)
  onOpen(id: string, rejoin: boolean): void;
  onClose(id: string, graceful: boolean): void;
  onCtl(id: string, msg: Record<string, unknown>): void;
  onInp(id: string, buf: ArrayBuffer): void;
  onError(message: string): void;
}

interface Link { pc: RTCPeerConnection; ctl: RTCDataChannel | null; inp: RTCDataChannel | null; st: RTCDataChannel | null; fx: RTCDataChannel | null; open: boolean; hello: boolean; ctlState: { last: number }; stats: { ctl: ChanStats; st: ChanStats; fx: ChanStats; inp: ChanStats } }

export class HostNet {
  code = '';
  private key = '';
  private links = new Map<string, Link>();
  private running = false;
  private abort: AbortController | null = null;
  private known = new Set<string>();
  names: Record<string, string> = {};

  constructor(public h: HostHandlers) {}

  async start(): Promise<string> {
    const r = await createRoom();
    this.code = r.code; this.key = r.hostKey;
    this.running = true;
    void this.loop();
    return this.code;
  }

  private async loop() {
    let after = 0;
    let fails = 0;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const r = await pollSignal(this.code, 'host', this.key, after, 15000, this.abort.signal);
        fails = 0;
        if (r.peers) { this.names = r.peers; this.h.onPeers(r.peers); }
        for (const m of r.msgs) { after = Math.max(after, m.n); void this.onSignal(m); }
        if (r.closed) break;
      } catch (e) {
        if (!this.running) break;
        if (++fails >= 5) { this.h.onError((e as Error).message); await new Promise((res) => setTimeout(res, 3000)); fails = 0; }
        else await new Promise((res) => setTimeout(res, 800));
      }
    }
  }

  private async onSignal(m: SignalMsg) {
    if (m.kind === 'bye') { this.drop(m.from, true); return; }
    if (m.kind !== 'offer') return;
    const rejoin = this.known.has(m.from);
    this.drop(m.from, false);
    try {
      const pc = new RTCPeerConnection(ICE);
      const link: Link = { pc, ctl: null, inp: null, st: null, fx: null, open: false, hello: false, ctlState: { last: 0 }, stats: { ctl: newStats(), st: newStats(), fx: newStats(), inp: newStats() } };
      this.links.set(m.from, link);
      const maybeOpen = () => {
        if (!link.open && link.hello && link.ctl?.readyState === 'open' && link.inp?.readyState === 'open' && link.st?.readyState === 'open' && link.fx?.readyState === 'open') {
          link.open = true; this.known.add(m.from); this.h.onOpen(m.from, rejoin);
        }
      };
      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        ch.binaryType = 'arraybuffer';
        if (ch.label === 'ctl') {
          link.ctl = ch;
          ch.onmessage = (e) => {
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(e.data as string); } catch { return; }
            if (msg.t === 'hello') {
              // refuse a joiner running a different build: ids and the wire format would not mean the same thing
              if (Number(msg.proto) !== PROTO || Number(msg.hash) !== protoHash()) { this.sendCtl(m.from, { t: 'reject', reason: 'Your game version does not match the host\'s. Refresh the page (Ctrl+F5) so both of you are on the latest version, then join again.' }); setTimeout(() => this.drop(m.from, false), 400); return; }
              link.hello = true; maybeOpen(); return;
            }
            if (link.open) this.h.onCtl(m.from, msg);
          };
        } else if (ch.label === 'inp') {
          link.inp = ch;
          ch.onmessage = (e) => { link.stats.inp.msgs++; link.stats.inp.bytes += (e.data as ArrayBuffer).byteLength; if (link.open) this.h.onInp(m.from, e.data as ArrayBuffer); };
        } else if (ch.label === 'st') link.st = ch;
        else if (ch.label === 'fx') link.fx = ch;
        ch.onopen = maybeOpen;
        ch.onclose = () => { if (this.links.get(m.from) === link) this.drop(m.from, false); }; // a late close of a replaced link must not kill its successor
        maybeOpen();
      };
      pc.onconnectionstatechange = () => { if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.links.get(m.from) === link) this.drop(m.from, false); };
      await pc.setRemoteDescription(JSON.parse(m.data));
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      await sendSignal(this.code, 'host', this.key, m.from, 'answer', JSON.stringify(pc.localDescription));
    } catch (e) {
      this.h.onError(`Could not connect a player: ${(e as Error).message}`);
      this.drop(m.from, false);
    }
  }

  private drop(id: string, graceful: boolean) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id);
    const wasOpen = l.open;
    l.open = false;
    try { l.ctl?.close(); l.inp?.close(); l.st?.close(); l.fx?.close(); l.pc.close(); } catch { /* already closed */ }
    if (wasOpen) this.h.onClose(id, graceful);
  }
  /** Forget a peer for good (a graceful leave, or its grace period ran out). */
  forget(id: string) { this.known.delete(id); this.drop(id, true); }

  ids(): string[] { return [...this.links.entries()].filter(([, l]) => l.open).map(([id]) => id); }

  sendCtl(id: string, msg: Record<string, unknown>) {
    const l = this.links.get(id);
    if (l?.ctl?.readyState === 'open') { const s = JSON.stringify(msg); l.stats.ctl.msgs++; l.stats.ctl.bytes += s.length; shaped(l.ctl, s, true, l.ctlState); }
  }
  broadcastCtl(msg: Record<string, unknown>) { for (const id of this.ids()) this.sendCtl(id, msg); }

  /** False while a channel to this peer is congested (the caller then skips the snapshot). */
  ready(id: string): boolean {
    const l = this.links.get(id);
    if (!l?.open || !l.st) return false;
    const b = l.st.bufferedAmount;
    if (b > l.stats.st.maxBuffered) l.stats.st.maxBuffered = b;
    if (b > MAX_BUFFERED) { l.stats.st.skipped++; return false; }
    return true;
  }
  private unreliable(id: string, which: 'st' | 'fx', buf: ArrayBuffer) {
    const l = this.links.get(id);
    const ch = l?.[which];
    if (!l || ch?.readyState !== 'open') return;
    const s = l.stats[which];
    if (which === 'fx' && ch.bufferedAmount > MAX_BUFFERED) { s.skipped++; return; }
    s.msgs++; s.bytes += buf.byteLength; if (buf.byteLength > s.maxMsg) s.maxMsg = buf.byteLength;
    if (ch.bufferedAmount > s.maxBuffered) s.maxBuffered = ch.bufferedAmount;
    shaped(ch, buf, false, l.ctlState);
  }
  sendSt(id: string, buf: ArrayBuffer) { this.unreliable(id, 'st', buf); }
  sendFx(id: string, buf: ArrayBuffer) { this.unreliable(id, 'fx', buf); }

  stats(id: string) { return this.links.get(id)?.stats ?? null; }

  /** The run has started: no new players, but players already in the room may reconnect. */
  async lockLobby() {
    const ok = await lockRoom(this.code, this.key).then(() => true, () => false);
    if (!ok) { await closeRoom(this.code, this.key); this.running = false; this.abort?.abort(); } // older server: no reconnects
  }

  close() {
    this.running = false;
    this.abort?.abort();
    void closeRoom(this.code, this.key);
    for (const id of [...this.links.keys()]) this.drop(id, true);
  }
}

/* ------------------------------------------------------------------ joiner */

export interface GuestHandlers {
  onCtl(msg: Record<string, unknown>): void;
  onSt(buf: ArrayBuffer): void;
  onFx(buf: ArrayBuffer): void;
  onClose(reason: string, graceful: boolean): void;
}

export class GuestNet {
  private pc: RTCPeerConnection | null = null;
  private ctl: RTCDataChannel | null = null;
  private inp: RTCDataChannel | null = null;
  private st: RTCDataChannel | null = null;
  private fx: RTCDataChannel | null = null;
  private closed = false;
  private ctlState = { last: 0 };
  private sigAfter = 0;
  peerId = '';
  peerKey = '';
  code = '';
  name = '';
  hostName = 'Host';
  stats = { ctl: newStats(), st: newStats(), fx: newStats(), inp: newStats() };

  constructor(public h: GuestHandlers) {}

  /** Join a room by code and open the connection to its host. Rejects with a readable message on failure. With `resume`, re-open
   *  the connection of a player already in the room (after a drop). */
  async connect(code: string, name: string, resume?: { peerId: string; peerKey: string }): Promise<void> {
    this.code = code; this.name = name; this.closed = false;
    const old = this.pc; this.pc = null;
    try { old?.close(); } catch { /* already closed */ }
    if (resume) { this.peerId = resume.peerId; this.peerKey = resume.peerKey; } else {
      const info = await roomInfo(code).catch((e: Error) => { throw new Error(e.message === 'No such room' ? 'No room with that code.' : e.message); });
      if (!info.open) throw new Error(info.players >= info.max ? 'That room is full.' : 'That room is closed or the game has already started.');
      const j = await joinRoom(code, name);
      this.peerId = j.peerId; this.peerKey = j.peerKey;
    }
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    const ctl = pc.createDataChannel('ctl');
    const inp = pc.createDataChannel('inp', { ordered: false, maxRetransmits: 0 });
    const st = pc.createDataChannel('st', { ordered: false, maxRetransmits: 0 });
    const fx = pc.createDataChannel('fx', { ordered: false, maxPacketLifeTime: FX_LIFETIME_MS });
    for (const c of [st, fx]) c.binaryType = 'arraybuffer';
    this.ctl = ctl; this.inp = inp; this.st = st; this.fx = fx;
    ctl.onmessage = (e) => { let m: Record<string, unknown>; try { m = JSON.parse(e.data as string); } catch { return; } this.stats.ctl.msgs++; this.stats.ctl.bytes += (e.data as string).length; this.h.onCtl(m); };
    st.onmessage = (e) => { const n = (e.data as ArrayBuffer).byteLength; this.stats.st.msgs++; this.stats.st.bytes += n; if (n > this.stats.st.maxMsg) this.stats.st.maxMsg = n; this.h.onSt(e.data as ArrayBuffer); };
    fx.onmessage = (e) => { this.stats.fx.msgs++; this.stats.fx.bytes += (e.data as ArrayBuffer).byteLength; this.h.onFx(e.data as ArrayBuffer); };
    let markOpen: () => void = () => {};
    const opened = new Promise<void>((resolve) => { markOpen = resolve; });
    const check = () => { if (ctl.readyState === 'open' && inp.readyState === 'open' && st.readyState === 'open' && fx.readyState === 'open') markOpen(); };
    for (const c of [ctl, inp, st, fx]) c.onopen = check;
    const gone = (why: string) => { if (!this.closed && this.pc === pc) { this.closed = true; this.h.onClose(why, false); } };
    ctl.onclose = () => gone('The host left the game.');
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') gone('Connection to the host was lost.'); };

    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    await sendSignal(code, this.peerId, this.peerKey, 'host', 'offer', JSON.stringify(pc.localDescription));

    // wait for the answer (long-poll), then for the channels to open
    const deadline = Date.now() + CONNECT_TIMEOUT;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      const r = await pollSignal(code, this.peerId, this.peerKey, this.sigAfter, 8000);
      for (const m of r.msgs) {
        this.sigAfter = Math.max(this.sigAfter, m.n); // never re-read an answer meant for an earlier attempt
        if (m.kind === 'answer') { await pc.setRemoteDescription(JSON.parse(m.data)); answered = true; }
        else if (m.kind === 'bye') throw new Error('The host closed the room.');
      }
      if (r.closed && !answered) throw new Error('The room was closed.');
    }
    if (!answered) throw new Error('The host did not answer. Make sure they are still on the lobby screen.');
    await Promise.race([
      opened,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Could not connect to the host (their network may block peer-to-peer connections).')), CONNECT_TIMEOUT)),
    ]);
    // identify ourselves: the host checks the game version before letting us in
    this.sendCtl({ t: 'hello', proto: PROTO, hash: protoHash(), name, resume: !!resume });
  }

  sendCtl(msg: Record<string, unknown>) { if (this.ctl?.readyState === 'open') { const s = JSON.stringify(msg); this.stats.ctl.msgs++; this.stats.ctl.bytes += s.length; shaped(this.ctl, s, true, this.ctlState); } }
  sendInp(buf: ArrayBuffer) {
    const ch = this.inp;
    if (ch?.readyState !== 'open') return;
    if (ch.bufferedAmount > MAX_BUFFERED) { this.stats.inp.skipped++; return; }
    this.stats.inp.msgs++; this.stats.inp.bytes += buf.byteLength;
    shaped(ch, buf, false, this.ctlState);
  }
  get connected() { return this.ctl?.readyState === 'open' && !this.closed; }

  close() {
    this.closed = true;
    const pc = this.pc;
    this.pc = null;
    try { this.ctl?.close(); this.inp?.close(); this.st?.close(); this.fx?.close(); pc?.close(); } catch { /* already closed */ }
  }
}
