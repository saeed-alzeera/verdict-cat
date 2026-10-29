// Co-op wire protocol (version 4). One RTCPeerConnection per joiner, four data channels, each with the delivery semantics its
// traffic needs:
//
//   ctl  reliable, ordered    lobby, round flow, rewards, announcements, results            JSON, rare, small
//   inp  unreliable           joiner -> host: input commands (redundant, last N unacked)    ~3 bytes per command
//   st   unreliable           host -> joiner: `Me` (own state + HUD) and `World` snapshots   datagrams <= DGRAM bytes
//   fx   partial-reliable     host -> joiner: cosmetic effects and sounds, 250 ms lifetime   datagrams <= DGRAM bytes
//
// Snapshots are split into independent datagrams so one lost packet costs a slice of one snapshot, never the whole thing, and
// no packet is large enough for SCTP to fragment (a lost fragment would discard the entire message).
import { ELEMENTS } from '../data/runes';
import { textureHash } from '../gfx/textures';

export const PROTO = 4;
/** Largest payload we put in one datagram; under the ~1200 byte path MTU WebRTC data channels assume. */
export const DGRAM = 1000;
export const SNAP_HZ = 30;
export const FX_LIFETIME_MS = 250;

export const enum K { Me = 1, World = 2, Fx = 3, Cmd = 4 }
/** World snapshot sections. */
export const enum S { Floor = 1, Tels = 2, Players = 3, Enemies = 4, Imgs = 5 }
/** Owner kinds of a generic image record. */
export const enum O { Ent = 0, Bullet = 1, Pickup = 2, Zone = 3 }
/** Effect packet event types (the first six mirror FxKind). */
export const enum E { Sfx = 8 }

export const ETYPES = ['grunt', 'swarmer', 'archer', 'charger', 'armored', 'shaman'] as const;
export const BOSS_BASE = 16;
export const ELEMENT_IDS = Object.keys(ELEMENTS);
export const SFX_IDS = ['arcane', 'fire', 'ice', 'lightning', 'poison', 'water', 'gravity', 'hit', 'kill', 'hurt', 'gem', 'level', 'reaction', 'boom', 'boss', 'ui', 'pick', 'warn', 'win', 'lose', 'freeze'];
/** Sounds a joiner should hear because the host's world made them (not UI clicks). */
export const SFX_NET = new Set(['fire', 'ice', 'lightning', 'poison', 'water', 'gravity', 'hit', 'kill', 'hurt', 'boom', 'reaction', 'freeze', 'warn', 'boss', 'win', 'lose', 'level', 'arcane', 'gem', 'pick']);

export const PHASES = ['prep', 'fight', 'clearing', 'sandbox'] as const;

/** Position quantiser: signed 1/16 px (range +-2048 px; the arena is 1100 px). */
export const POS = 16;

/** Fingerprint of everything both ends must agree on for ids to mean the same thing. Exchanged in the hello. */
export function protoHash(): number {
  let h = textureHash() ^ (PROTO * 2654435761);
  for (const k of ELEMENT_IDS) for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Datagram header (host -> joiner on `st`): kind, snapshot number, host clock (ms), slice index and count. */
export const HDR = 9;

/** What the joiner needs to know about a snapshot that is not an entity. Decoded from the `Me` datagram. */
export interface MeMsg {
  seq: number; ts: number;
  paused: boolean; down: boolean; quick: boolean; tilesActive: boolean; hurt: boolean; inv: boolean;
  echo: number; hold: number; ack: number;
  x: number; y: number; vx: number; vy: number; speed: number; pullT: number; pullX: number; pullY: number;
  hp: number; mh: number; xp: number; xn: number; lv: number; coins: number;
  t: number; el: number; round: number; phase: string; kills: number;
  boss: { kind: number; hp: number; mh: number } | null;
  spells: { cd: number; live: number; ult: number }[];
  party: { pid: number; hp: number; mh: number; down: boolean }[];
}
