// Procedural WebAudio: all sound effects and a small generative music loop. No asset files.
import { store } from './save';

type Sfx =
  | 'arcane' | 'fire' | 'ice' | 'lightning' | 'poison' | 'water' | 'gravity'
  | 'hit' | 'kill' | 'hurt' | 'gem' | 'level' | 'reaction' | 'boom' | 'boss' | 'ui' | 'pick' | 'warn' | 'win' | 'lose' | 'freeze';

class AudioSys {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfxG!: GainNode;
  musG!: GainNode;
  noiseBuf: AudioBuffer | null = null;
  last: Record<string, number> = {};
  musicTimer: number | undefined;
  step = 0;
  intensity = 0;

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch { return; }
    const c = this.ctx;
    this.master = c.createGain();
    this.sfxG = c.createGain();
    this.musG = c.createGain();
    this.sfxG.connect(this.master);
    this.musG.connect(this.master);
    const comp = c.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(c.destination);
    const len = c.sampleRate;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    this.startMusic();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = store.settings;
    this.master.gain.value = s.muted ? 0 : s.master;
    this.sfxG.gain.value = s.sfx;
    this.musG.gain.value = s.music * 0.35;
  }

  private throttle(name: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.last[name] ?? 0) < ms) return false;
    this.last[name] = now;
    return true;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0, dest?: AudioNode) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest ?? this.sfxG);
    o.start(t); o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass', slide = 0) {
    const c = this.ctx!;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (slide) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfxG);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  play(name: Sfx) {
    if (!this.ctx || store.settings.muted) return;
    const lim: Record<string, number> = {
      fire: 60, ice: 60, lightning: 50, poison: 80, water: 80, gravity: 100, hit: 35, kill: 30, gem: 40, hurt: 120,
      reaction: 80, boom: 50, freeze: 80,
    };
    if (!this.throttle(name, lim[name] ?? 0)) return;
    switch (name) {
      case 'arcane': this.tone(700, 0.12, 'triangle', 0.07, 300); this.tone(1050, 0.1, 'sine', 0.04, 200, 0.03); break;
      case 'fire': this.noise(0.18, 0.18, 900, 0.8, 'bandpass', -500); this.tone(180, 0.12, 'sawtooth', 0.05, -80); break;
      case 'ice': this.tone(1400, 0.14, 'triangle', 0.08, -600); this.tone(2100, 0.08, 'sine', 0.04, -900); break;
      case 'lightning': this.noise(0.1, 0.16, 3500, 2, 'highpass'); this.tone(900, 0.07, 'square', 0.04, -700); break;
      case 'poison': this.tone(220, 0.2, 'sine', 0.09, 120); this.noise(0.12, 0.06, 500, 3); break;
      case 'water': this.tone(520, 0.14, 'sine', 0.09, 400); break;
      case 'gravity': this.tone(110, 0.3, 'sine', 0.14, -60); this.tone(55, 0.3, 'triangle', 0.12); break;
      case 'hit': this.noise(0.05, 0.12, 1800, 1.5); break;
      case 'kill': this.tone(300, 0.08, 'square', 0.05, -200); this.noise(0.08, 0.08, 900, 1); break;
      case 'hurt': this.tone(150, 0.25, 'sawtooth', 0.18, -100); this.noise(0.15, 0.15, 400); break;
      case 'gem': this.tone(880 + Math.random() * 300, 0.08, 'sine', 0.05); break;
      case 'level': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.12, 0, i * 0.08)); break;
      case 'reaction': this.tone(660, 0.18, 'square', 0.07, 400); this.tone(990, 0.2, 'triangle', 0.06, 300, 0.05); this.noise(0.15, 0.1, 2400, 1); break;
      case 'boom': this.noise(0.35, 0.3, 300, 0.7, 'lowpass', -200); this.tone(90, 0.3, 'sine', 0.2, -50); break;
      case 'boss': this.tone(70, 1.1, 'sawtooth', 0.15, -20); this.tone(105, 1.1, 'square', 0.07, -30); this.noise(0.8, 0.12, 200, 0.6, 'lowpass'); break;
      case 'ui': this.tone(660, 0.06, 'triangle', 0.06); break;
      case 'pick': this.tone(520, 0.1, 'triangle', 0.09); this.tone(780, 0.14, 'triangle', 0.09, 0, 0.07); break;
      case 'warn': this.tone(300, 0.14, 'square', 0.05, 0); break;
      case 'freeze': this.tone(1800, 0.2, 'triangle', 0.07, -1200); this.noise(0.1, 0.1, 5000, 2, 'highpass'); break;
      case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.12, 0, i * 0.14)); break;
      case 'lose': [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.5, 'sawtooth', 0.09, -10, i * 0.2)); break;
    }
  }

  /** Slow generative minor-pentatonic loop; intensity (0..1) adds a pulse layer. */
  private startMusic() {
    const c = this.ctx!;
    const scale = [0, 3, 5, 7, 10, 12, 15, 17];
    const root = 110;
    const tick = () => {
      if (!this.ctx || store.settings.muted || store.settings.music <= 0) return;
      const t = this.step++;
      const bar = Math.floor(t / 16);
      const rootShift = [0, 0, -2, -5][bar % 4];
      if (t % 16 === 0) {
        this.tone(root * Math.pow(2, rootShift / 12), 3.2, 'sine', 0.35, 0, 0, this.musG);
        this.tone(root * 1.5 * Math.pow(2, rootShift / 12), 3.2, 'triangle', 0.12, 0, 0, this.musG);
      }
      if (t % 2 === 0 && Math.random() < 0.55) {
        const n = scale[Math.floor(Math.random() * scale.length)] + rootShift;
        this.tone(root * 2 * Math.pow(2, n / 12), 0.9, 'triangle', 0.1, 0, 0, this.musG);
      }
      if (this.intensity > 0.2 && t % 4 === 0) this.tone(root * Math.pow(2, rootShift / 12), 0.2, 'square', 0.05 * this.intensity, -20, 0, this.musG);
      if (this.intensity > 0.55 && t % 2 === 1) this.noise(0.05, 0.02 * this.intensity, 6000, 1, 'highpass');
    };
    void c;
    this.musicTimer = window.setInterval(tick, 260);
  }
}

export const audio = new AudioSys();
