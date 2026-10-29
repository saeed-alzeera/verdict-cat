import Phaser from 'phaser';
import { Run, ARENA, type RunOpts } from '../game/run';
import { ui } from '../ui/ui';
import { GuestSession, HostSession } from '../net/coop';
import { NetOverlay } from '../net/overlay';

export class GameScene extends Phaser.Scene {
  run!: Run;
  pSpr!: Phaser.GameObjects.Image;
  pShadow!: Phaser.GameObjects.Image;
  keys!: Record<string, Phaser.Input.Keyboard.Key>;
  opts!: RunOpts;
  zoom = 1;
  coop: HostSession | GuestSession | null = null;
  private netOverlay: NetOverlay | null = null;

  constructor() { super('Game'); }

  init(data: RunOpts) { this.opts = data; }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor('#06040b');
    this.add.tileSprite(0, 0, ARENA, ARENA, 'floor').setOrigin(0).setTileScale(2).setDepth(0);
    const g = this.add.graphics().setDepth(1);
    g.lineStyle(8, 0x6a4cc0, 0.9).strokeRect(0, 0, ARENA, ARENA);
    g.lineStyle(24, 0x6a4cc0, 0.15).strokeRect(-8, -8, ARENA + 16, ARENA + 16);
    this.pShadow = this.add.image(0, 0, 'shadow').setScale(3).setDepth(4).setAlpha(0.8);
    this.pSpr = this.add.image(0, 0, 'wiz0').setScale(3).setDepth(8);
    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as Record<string, Phaser.Input.Keyboard.Key>;
    this.run = new Run(this, this.opts);
    this.run.onAnnounce = (t, c, s) => ui.announce(t, c, s);
    this.run.onEnd = (s) => ui.showGameOver(s);
    ui.beginRun(this.run, this.opts);
    const mp = this.opts.mp;
    this.coop = null;
    if (mp?.role === 'host' && mp.host) this.coop = new HostSession(this.run, this, mp.host, mp.code, mp.name);
    else if (mp?.role === 'guest' && mp.guest) {
      this.coop = new GuestSession(this.run, this, mp.guest, mp);
      this.pSpr.setVisible(false); this.pShadow.setVisible(false); // shown from the joiner's own prediction once a round is on
    }
    if (this.coop) this.netOverlay = new NetOverlay(() => this.coop);
    this.applyZoom();
    this.scale.on('resize', this.applyZoom, this);
    this.events.once('shutdown', () => { this.scale.off('resize', this.applyZoom, this); this.coop?.leave(); this.coop?.destroy(); this.coop = null; this.netOverlay?.destroy(); this.netOverlay = null; ui.endRun(); });
    cam.centerOn(this.run.player.x, this.run.player.y);
  }

  applyZoom() {
    const w = this.scale.width, h = this.scale.height;
    this.zoom = Phaser.Math.Clamp(Math.min(w / 1280, h / 720), 0.8, 1.6);
    this.cameras.main.setZoom(this.zoom);
    if (this.run) { this.run.viewW = w / this.zoom; this.run.viewH = h / this.zoom; }
  }

  update(_t: number, dtMs: number) {
    const run = this.run;
    if (!run) return;
    const k = this.keys;
    run.input.x = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    run.input.y = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    if (ui.blocking) { run.input.x = 0; run.input.y = 0; }
    ui.pump(run);
    const cam = this.cameras.main;
    const sm = run.fx.shakeMag;
    const sx = sm > 0 ? (Math.random() - 0.5) * sm * 2 : 0, sy = sm > 0 ? (Math.random() - 0.5) * sm * 2 : 0;
    const co = this.coop;
    if (co instanceof GuestSession) {
      // a joiner does not simulate the world: it predicts its own wizard, sends its input and draws what the host replicates
      co.frame(dtMs / 1000, run.input);
      co.drawSelf(this.pSpr, this.pShadow);
      const t = co.inFight ? co.cameraTarget() : run.player;
      cam.centerOn(Math.round(t.x + sx), Math.round(t.y + sy));
      ui.hud.update(run);
      return;
    }
    run.tick(dtMs / 1000);
    run.syncSprites(this.pSpr, this.pShadow);
    // a downed host watches a teammate
    const tp = run.down ? (run.nearestPlayer(run.player.x, run.player.y) ?? run).player : run.player;
    cam.centerOn(Math.round(tp.x + sx), Math.round(tp.y + sy));
    co?.frame(dtMs / 1000);
    ui.hud.update(run);
  }
}
