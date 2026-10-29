// Network readout for co-op (toggle with F3, or open the game with ?netdebug): ping, interpolation buffer, loss, bandwidth,
// frame rate and prediction corrections on a joiner; per-joiner traffic and snapshot cost on the host.
import type { GuestSession, HostSession } from './coop';

interface HostPeer { st?: { bytes: number; maxBuffered: number; skipped: number }; cmdQueue?: number; offline?: boolean }
interface HostInfo { snap: { snaps: number; cpuSum: number; cpuMax: number; lastWorld: number; lastDgrams: number; enemies: number; imgs: number } }

export class NetOverlay {
  private el: HTMLElement;
  private on = false;
  private last = { t: performance.now(), st: 0, inp: 0, snaps: 0, frames: 0, fx: 0, bytes: 0 };
  private timer = 0;

  constructor(private co: () => HostSession | GuestSession | null) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:70;padding:6px 8px;background:rgba(0,0,0,.72);color:#9fffb0;font:10px/1.5 monospace;white-space:pre;pointer-events:none;display:none';
    document.body.appendChild(this.el);
    try { if (new URLSearchParams(location.search).has('netdebug')) this.set(true); } catch { /* no window */ }
    window.addEventListener('keydown', this.key);
    this.timer = window.setInterval(() => this.refresh(), 500);
  }

  private key = (e: KeyboardEvent) => { if (e.key === 'F3') { e.preventDefault(); this.set(!this.on); } };
  private set(on: boolean) { this.on = on; this.el.style.display = on ? 'block' : 'none'; }

  private refresh() {
    const co = this.co();
    if (!this.on || !co) return;
    const now = performance.now();
    const dt = (now - this.last.t) / 1000;
    this.last.t = now;
    if (co.role === 'guest') {
      const i = co.netInfo();
      const n = i.net;
      const down = (n.stBytes + n.fxBytes - this.last.bytes) / dt / 1024; this.last.bytes = n.stBytes + n.fxBytes;
      const hz = (n.complete - this.last.snaps) / dt; this.last.snaps = n.complete;
      const fps = (i.perf.frames - this.last.frames) / dt; this.last.frames = i.perf.frames;
      const seen = n.complete + n.lost;
      this.el.textContent = [
        `JOINER   ping ${n.rtt.toFixed(0)} ms   buffer ${n.delay.toFixed(0)} ms   jitter ${n.jitter.toFixed(0)} ms`,
        `snapshots ${hz.toFixed(0)}/s   down ${down.toFixed(0)} KB/s   lost ${seen ? ((n.lost / (seen + n.lost)) * 100).toFixed(1) : '0.0'}%   partial ${n.incomplete}`,
        `fps ${fps.toFixed(0)}   decode ${(n.decodeMs / Math.max(1, n.datagrams)).toFixed(2)} ms/pkt   draw ${(n.renderMs / Math.max(1, n.renders)).toFixed(2)} ms`,
        `prediction corrections ${i.pred.corrections} (avg ${(i.pred.errSum / Math.max(1, i.pred.corrections)).toFixed(1)} px, max ${i.pred.errMax.toFixed(0)}, snaps ${i.pred.snaps})`,
        `objects ${i.counts.enemies} enemies  ${i.counts.imgs} sprites`,
      ].join('\n');
    } else {
      const i = co.netInfo() as unknown as HostInfo;
      const s = i.snap;
      const hz = (s.snaps - this.last.snaps) / dt; this.last.snaps = s.snaps;
      const lines = [`HOST   snapshots ${hz.toFixed(0)}/s   cost ${(s.cpuSum / Math.max(1, s.snaps)).toFixed(2)} ms (max ${s.cpuMax.toFixed(1)})   world ${s.lastWorld} B / ${s.lastDgrams} pkts   ${s.enemies} enemies ${s.imgs} sprites`];
      for (const [k, v] of Object.entries(i as unknown as Record<string, HostPeer>)) if (k !== 'snap' && v.st) lines.push(`${k}${v.offline ? ' (offline)' : ''}: sent ${(v.st.bytes / 1024).toFixed(0)} KB   queued max ${v.st.maxBuffered} B   skipped ${v.st.skipped}   input backlog ${v.cmdQueue}`);
      this.el.textContent = lines.join('\n');
    }
  }

  destroy() { window.clearInterval(this.timer); window.removeEventListener('keydown', this.key); this.el.remove(); }
}
