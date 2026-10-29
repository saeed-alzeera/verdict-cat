// WebRTC peer manager. The host accepts a data-channel connection from each guest; the guest opens one to the host.
// Two channels per peer: `ctl` (reliable, ordered JSON) for lobby/reward/round messages, and `snap` (unreliable, unordered,
// binary) for the 20 Hz world snapshots (host to guest) and the input stream (guest to host).
import { closeRoom, createRoom, joinRoom, pollSignal, roomInfo, sendSignal, type SignalMsg } from './signaling';

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

const GATHER_TIMEOUT = 5000;
const GATHER_QUIET = 1200;
const CONNECT_TIMEOUT = 25000;

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

export interface HostHandlers {
  onPeers(names: Record<string, string>): void; // everyone who has joined the room (connected or not)
  onOpen(id: string): void;
  onClose(id: string): void;
  onCtl(id: string, msg: Record<string, unknown>): void;
  onSnap(id: string, buf: ArrayBuffer): void;
  onError(message: string): void;
}

interface Link { pc: RTCPeerConnection; ctl: RTCDataChannel | null; snap: RTCDataChannel | null; open: boolean }

export class HostNet {
  code = '';
  private key = '';
  private links = new Map<string, Link>();
  private running = false;
  private abort: AbortController | null = null;
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
    if (m.kind === 'bye') { this.drop(m.from); return; }
    if (m.kind !== 'offer') return;
    this.drop(m.from, false);
    try {
      const pc = new RTCPeerConnection(ICE);
      const link: Link = { pc, ctl: null, snap: null, open: false };
      this.links.set(m.from, link);
      const maybeOpen = () => {
        if (!link.open && link.ctl?.readyState === 'open' && link.snap?.readyState === 'open') { link.open = true; this.h.onOpen(m.from); }
      };
      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        ch.binaryType = 'arraybuffer';
        if (ch.label === 'ctl') {
          link.ctl = ch;
          ch.onmessage = (e) => { try { this.h.onCtl(m.from, JSON.parse(e.data as string)); } catch { /* ignore malformed */ } };
        } else if (ch.label === 'snap') {
          link.snap = ch;
          ch.onmessage = (e) => this.h.onSnap(m.from, e.data as ArrayBuffer);
        }
        ch.onopen = maybeOpen;
        ch.onclose = () => this.drop(m.from);
        maybeOpen();
      };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(m.from); };
      await pc.setRemoteDescription(JSON.parse(m.data));
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      await sendSignal(this.code, 'host', this.key, m.from, 'answer', JSON.stringify(pc.localDescription));
    } catch (e) {
      this.h.onError(`Could not connect a player: ${(e as Error).message}`);
      this.drop(m.from);
    }
  }

  private drop(id: string, notify = true) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id);
    const wasOpen = l.open;
    try { l.ctl?.close(); l.snap?.close(); l.pc.close(); } catch { /* already closed */ }
    if (notify && wasOpen) this.h.onClose(id);
  }

  ids(): string[] { return [...this.links.entries()].filter(([, l]) => l.open).map(([id]) => id); }

  sendCtl(id: string, msg: Record<string, unknown>) {
    const ch = this.links.get(id)?.ctl;
    if (ch?.readyState === 'open') ch.send(JSON.stringify(msg));
  }
  broadcastCtl(msg: Record<string, unknown>) { for (const id of this.ids()) this.sendCtl(id, msg); }

  /** Unreliable snapshot; dropped when the channel is backed up rather than queued (stale frames are worthless). */
  sendSnap(id: string, buf: ArrayBuffer) {
    const ch = this.links.get(id)?.snap;
    if (ch?.readyState === 'open' && ch.bufferedAmount < 256 * 1024) ch.send(buf);
  }

  /** Stop accepting new players (the run has started); existing connections stay. */
  async closeLobby() { await closeRoom(this.code, this.key); this.running = false; this.abort?.abort(); }

  close() {
    this.running = false;
    this.abort?.abort();
    void closeRoom(this.code, this.key);
    for (const id of [...this.links.keys()]) this.drop(id, false);
  }
}

export interface GuestHandlers {
  onCtl(msg: Record<string, unknown>): void;
  onSnap(buf: ArrayBuffer): void;
  onClose(reason: string): void;
}

export class GuestNet {
  private pc: RTCPeerConnection | null = null;
  private ctl: RTCDataChannel | null = null;
  private snap: RTCDataChannel | null = null;
  private closed = false;
  peerId = '';
  hostName = 'Host';

  constructor(public h: GuestHandlers) {}

  /** Join a room by code and open the connection to its host. Rejects with a readable message on failure. */
  async connect(code: string, name: string): Promise<void> {
    const info = await roomInfo(code).catch((e: Error) => { throw new Error(e.message === 'No such room' ? 'No room with that code.' : e.message); });
    if (!info.open) throw new Error(info.players >= info.max ? 'That room is full.' : 'That room is closed.');
    const j = await joinRoom(code, name);
    this.peerId = j.peerId;
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    const ctl = pc.createDataChannel('ctl');
    const snap = pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 });
    snap.binaryType = 'arraybuffer';
    this.ctl = ctl; this.snap = snap;
    ctl.onmessage = (e) => { try { this.h.onCtl(JSON.parse(e.data as string)); } catch { /* ignore malformed */ } };
    snap.onmessage = (e) => this.h.onSnap(e.data as ArrayBuffer);
    let markOpen: () => void = () => {};
    const opened = new Promise<void>((resolve) => { markOpen = resolve; });
    const check = () => { if (ctl.readyState === 'open' && snap.readyState === 'open') markOpen(); };
    ctl.onopen = check; snap.onopen = check;
    const gone = (why: string) => { if (!this.closed) { this.closed = true; this.h.onClose(why); } };
    ctl.onclose = () => gone('The host left the game.');
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') gone('Connection to the host was lost.'); };

    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    await sendSignal(code, j.peerId, j.peerKey, 'host', 'offer', JSON.stringify(pc.localDescription));

    // wait for the answer (long-poll), then for the channels to open
    let after = 0;
    const deadline = Date.now() + CONNECT_TIMEOUT;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      const r = await pollSignal(code, j.peerId, j.peerKey, after, 8000);
      for (const m of r.msgs) {
        after = Math.max(after, m.n);
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
  }

  sendCtl(msg: Record<string, unknown>) { if (this.ctl?.readyState === 'open') this.ctl.send(JSON.stringify(msg)); }
  sendSnap(buf: ArrayBuffer) { if (this.snap?.readyState === 'open') this.snap.send(buf); }

  close() {
    this.closed = true;
    try { this.ctl?.close(); this.snap?.close(); this.pc?.close(); } catch { /* already closed */ }
  }
}
