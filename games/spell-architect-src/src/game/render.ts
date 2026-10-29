// How enemies and wizards look. Shared by the host's simulation (syncSprites) and by a co-op joiner, who only receives the few
// numbers that decide the look (position, facing, status, sprite scale) and draws the animation itself at its own frame rate.
import { ELEMENTS } from '../data/runes';
import type { Img } from './types';

export const attuneTint = (a: string): number => {
  const c = a in ELEMENTS ? ELEMENTS[a as keyof typeof ELEMENTS].color : 0xffffff;
  const l = (v: number) => Math.round(255 - (255 - v) * 0.85);
  return (l((c >> 16) & 255) << 16) | (l((c >> 8) & 255) << 8) | l(c & 255);
};

export interface EnemyLook { id: number; x: number; y: number; sc: number; r: number; face: number; spawnT: number }

/** The tint key of an enemy's current status: 0 none, 1 hit flash, 2 frozen, 3 burning, 4 poisoned, 5 wet, 6 buffed, 7 elite, 8 attuned. */
export function tintKey(e: { flash: number; freeze: number; burn: number; poison: number; wet: number; buff: number; aff: string; elite: boolean }): number {
  if (e.flash > 0) return 1;
  if (e.freeze > 0) return 2;
  if (e.burn > 0) return 3;
  if (e.poison > 0) return 4;
  if (e.wet > 0) return 5;
  if (e.buff > 0) return 6;
  if (e.aff !== 'neutral') return 8;
  if (e.elite) return 7;
  return 0;
}

export function applyTint(spr: Img, key: number, aff: string) {
  switch (key) {
    case 0: spr.clearTint(); break;
    case 1: spr.setTintFill(0xffffff); break;
    case 2: spr.setTint(0x9fd8ff); break;
    case 3: spr.setTint(0xffb27a); break;
    case 4: spr.setTint(0xb0ff90); break;
    case 5: spr.setTint(0xa6c4ff); break;
    case 6: spr.setTint(0xffe27a); break;
    case 7: spr.setTint(0xffd9a0); break;
    case 8: spr.setTint(attuneTint(aff)); break;
  }
}

/** Position, squash-and-stretch and fade of an enemy (and its shadow and element badge) for game time `time`. */
export function poseEnemy(e: EnemyLook, spr: Img, shadow: Img, badge: Img | null, time: number) {
  const t = time * 9 + e.id;
  const bob = Math.sin(t) * 0.06;
  const fadeIn = e.spawnT > 0 ? 1 - e.spawnT / 0.3 : 1;
  spr.setPosition(e.x, e.y - e.sc * 2 + Math.abs(Math.sin(t)) * -2).setFlipX(e.face < 0)
    .setScale(e.sc * (1 + bob), e.sc * (1 - bob)).setAlpha(fadeIn).setDepth(5 + e.y / 4000);
  shadow.setPosition(e.x, e.y + e.r * 0.7).setAlpha(0.7 * fadeIn);
  if (badge) badge.setPosition(e.x, e.y - e.r - 12 + Math.sin(time * 5 + e.id) * 2).setAlpha(0.8 * fadeIn).setScale(0.85 + 0.12 * Math.sin(time * 8 + e.id));
}

export interface WizardLook { x: number; y: number; faceX: number; walking: boolean; walkT: number; hurt: boolean; inv: boolean; down: boolean }

/** The wizard sprite: walk cycle, idle sway, damage flash and i-frame blink. `tint` colours a teammate (0 = none). */
export function poseWizard(spr: Img, shadow: Img, w: WizardLook, time: number, tint = 0) {
  const frame = w.walking ? Math.floor(w.walkT * 8) % 2 : Math.floor(time * 2) % 2;
  spr.setTexture(`wiz${frame}`).setPosition(w.x, w.y - 8).setFlipX(w.faceX < 0).setDepth(8 + w.y / 4000).setScale(3, 3 * (1 + 0.03 * Math.sin(time * 6)));
  if (w.hurt) spr.setTintFill(0xff5a5a); else if (tint) spr.setTint(tint); else spr.clearTint();
  spr.setAlpha(w.down ? 0.25 : w.inv ? (Math.floor(time * 20) % 2 ? 0.45 : 1) : 1);
  shadow.setPosition(w.x, w.y + 12).setAlpha(w.down ? 0.2 : 0.8);
}
