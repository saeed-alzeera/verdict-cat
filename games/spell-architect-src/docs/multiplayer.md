# Online co-op: architecture, root causes and measurements

This documents the rewrite of the co-op networking (protocol version 4). The previous design (commit `b2a82dd`, files `net/mirror.ts` and the old `net/coop.ts`) is gone; the references below point at that commit.

## Why the old design felt bad: root causes (each measured, not assumed)

Measured on the old build with two Chromium processes, one hosting and one joining over real WebRTC on loopback (RTT about 15 ms), 480x270 viewport, software GL.

| # | Root cause | Where (old build) | Evidence |
|---|---|---|---|
| 1 | **Wrong sprites.** The host sent each sprite's texture as its index in `scene.textures.getTextureKeys()` sorted by name. That list also contains Phaser's own textures, one per `Text` object, keyed by a random UUID that differs on every machine and in number (host 77 keys, joiner 78). Sorting then shifts every index after the first UUID, so the same number names a different texture on each side. | `mirror.ts:16` (`textureTable`), used by `encodeFrame` and `MirrorLayer` | **12 of 38** real sprite textures resolved to a different texture on the joiner (10 of 38 on a second run). |
| 2 | **The joiner's own character waited for the network.** The camera followed the host's `me` position, interpolated about `delay` ms in the past (85-300 ms, adaptive), and nothing moved until the host had simulated the input and echoed it back. | `coop.ts:538` (`cameraTarget`), `mirror.ts:147,169` (`delay`) | Key press to camera movement on the joiner: **227 ms** with the link idle and RTT of about 15 ms, **622 ms** under a swarm. This is the "controlling a delayed character" feeling; on a real network RTT is added on top. |
| 3 | **Snapshots were too big for an unreliable channel.** `encodeFrame` serialised every visible Phaser image (up to 700 particles at 23 bytes each) into one message sent with `maxRetransmits: 0`. SCTP fragments anything over about 1200 bytes, and a lost fragment discards the whole message. | `mirror.ts:56`, `coop.ts:245` | 10 KB mean (p95 13.4 KB) per snapshot with 170 enemies, about 9 fragments, at 14 snapshots/s = 138 KB/s per joiner. With a 9-fragment message, 2% packet loss drops about 17% of snapshots and 5% loss about 37%. |
| 4 | **Cosmetic effects were synchronised as sprites.** Particles, rings, bolts and damage numbers are local pooled objects driven by the host's `Math.random`, yet every one of them was replicated frame by frame. | `mirror.ts:collect` scans `scene.children` | Most of the bytes in #3. |
| 5 | **Snapshot cadence tied to host frames.** `acc` was reset to 0 after each send, so the interval was the next multiple of the host's frame time. | `coop.ts:220-224` | 14 snapshots/s observed instead of the nominal 20. |
| 6 | **Image identity was the pooled Phaser object.** Ids came from a `WeakMap` over images that the game pool reuses for different entities, so an id could change owner between two snapshots; the joiner patched this with a distance heuristic (`< 220 px`) when interpolating. | `mirror.ts:7-13`, `mirror.ts:203` | Source reading; the duplicate/ghost-sprite class of bug. |
| 7 | **Input was one lossy "latest state" message.** `[1, ix, iy]` was sent only when it changed plus a 200 ms heartbeat, unreliable and unstamped. A lost key-release left the wizard walking until the heartbeat, and the host applied whatever arrived last for its own frame length rather than what the joiner pressed for how long. | `coop.ts:471-476`, `coop.ts:150` | Source reading. |

Investigated and **not** the cause: snapshot decoding or drawing cost on the joiner (1.8 ms per frame on average with 170 enemies; its frame time was dominated by the software renderer, as on the host); head-of-line blocking (the snapshot channel was already unordered, no retransmit); competing simulations (the joiner never simulated); coordinate-system or camera mismatches (both sides use the same arena constants and `centerOn`). The 85-300 ms interpolation delay was a symptom amplifier for #2, not the root cause: tuning it (as attempted before) could never fix movement that depends on the network.

## The new architecture

Host-authoritative simulation, with the joiner predicting only what it can know for certain (its own movement) and replicating everything else.

```
 joiner                                             host
 keys -> Predictor.step (stepMove, same code)       Run.tick (variable dt, unchanged for solo)
   |  cmd {seq, ix, iy, dt}                           ^ shell.driveRemote: apply each queued cmd for exactly dt
   +--- inp (unreliable, last 32 cmds, ~66/s) ------> | (time metered at 1.15x real time: no speed hacking)
                                                      v
 Replica.render (interpolated, ~70-100 ms)  <--- st: Me (own state, ack) + World slices (<= 1000 B each), ~30 Hz
 effects played locally at their moment     <--- fx: particle/ring/bolt/text/sound events (250 ms lifetime)
 Predictor.reconcile: replay unacked cmds   <--- ctl: lobby, rounds, rewards, results, goodbye (reliable, JSON)
```

* **Prediction** (`net/predict.ts`, `game/move.ts`). Every rendered frame the joiner builds a command (stick direction as signed bytes, duration quantised to 1/4000 s), applies it immediately with `stepMove` (the very function the host uses), and remembers it. The host stamps each `Me` packet with the last command it applied; the joiner replays the unacknowledged ones on top of that state. The difference between that and what is on screen becomes a visual offset that decays with a 70-190 ms time constant, so corrections slide instead of snapping; only an error over 96 px (a fall into the void) snaps. The camera follows the predicted position.
* **Authority**. The host never guesses what a joiner is pressing: `Run.driveRemote` applies the queued commands for exactly the durations the joiner used, so both ends integrate identical steps. Time is metered (1.15x real time plus a 0.25 s burst allowance) so a modified client cannot move faster. Spells, damage, health, XP and rewards are host-only as before.
* **Replication** (`net/replicate.ts`). Records come from the simulation's own entities, never from the Phaser scene graph. Enemies are 12 bytes (id, type, status tint, affinity, position, scale, spawn fade); spell, bullet, pickup and zone sprites are generic image records keyed by `(owner id, slot)` (13-21 bytes); wizards, telegraphs and the floor have their own records. Every record carries a stable id, so a lost slice only delays those entities and an entity missing from a *complete* snapshot is removed. Slices are at most 1000 bytes, below the path MTU, so nothing is fragmented.
* **Stable ids**. Sprite ids are the position in `TEXTURE_KEYS` (the order `generateTextures` creates them in, identical on every machine running the same build). The joiner's first message is a hello carrying the protocol version and a hash of that table; a host that disagrees refuses the join with "refresh the page" advice instead of letting wrong sprites appear.
* **Effects** (`game/fx.ts`). `Fx` records every call (burst, spark, ring, bolt, text, shake, flash) before any local thinning or settings filter, plus the sounds. The joiner replays them on its own `Fx` when the interpolated world reaches the event's timestamp; its own particle budget and settings apply.
* **Interpolation** (`net/replica.ts`). Three samples per entity, drawn at host time `now - offset - delay`, where the offset is the minimum arrival-minus-timestamp over a 4 s window and `delay = 1.6 x gap + 2.5 x jitter + 10 ms` (45-200 ms; about 70-100 ms on a healthy link). The playback clock advances in real time and only steers gently toward the estimate, so a noisy estimate never makes the world jump. If starved, entities coast on their last velocity for at most 120 ms. Receiving a datagram only decodes numbers into arrays (about 0.1 ms); Phaser objects are touched once per rendered frame, from the existing pool.
* **Channels** (`net/rtc.ts`). `ctl` reliable and ordered; `inp` and `st` unordered with `maxRetransmits: 0`; `fx` unordered with `maxPacketLifeTime: 250`. The host skips a snapshot when a joiner's `st` channel has more than 48 KB queued, so latency never accumulates behind a congested link.
* **Reconnect**. After the game starts the room is *locked* (`/mp/rooms/:code/lock`: no newcomers) instead of closed. A dropped joiner retries with its existing peer key; the host kept its wizard standing down for 45 s and restores it. A graceful leave or a host that ends the game is told apart from a drop.
* **Fixed timestep: evaluated, not adopted.** The simulation steps with a variable `dt` capped at 50 ms, mutates Phaser objects in place and has no previous-state copy to interpolate, so a fixed step would need a render-interpolation layer for the host's own screen (a 144 Hz host would otherwise see 60 Hz motion) and would change single-player. What a fixed step buys here (identical integration on both ends) is obtained where it matters by replaying commands with their own durations. Snapshot cadence is decoupled from the frame rate by an accumulator.

Removed: `net/mirror.ts` (scene-graph scraping, the texture index table, the image-id `WeakMap`, the host's per-joiner view-culling message `view`, JSON snapshot meta) and the single `snap` channel.

## Measurements

Test rig: two separate Chromium processes (host, joiner), real WebRTC over loopback, signaling through the real worker (`wrangler dev --local`), 4-core container, software GL, 320x180 viewport (the old-build numbers above used 480x270). Frame times in this rig are CPU-bound by the software renderer and describe the rig, not real hardware. Impairment is **simulated**: packet loss, one-way delay and jitter injected at the sender on top of the real loopback connection (`window.__netsim`, test only); it is not a real WAN.

Clean link, same measurement for host and joiner (`n1`, 3-4 key presses each): key press to own camera moving: host 7 ms, joiner 10 ms (old: 227 ms; `tests/coop.perf.cjs` quiet phase, 10 presses: joiner p50 9 ms); steadiness of own movement (coefficient of variation of per-frame velocity, which in this rig mostly reflects frame-time noise): host 0.283, joiner 0.293; the host's wizard as drawn on the joiner 0.233.

170 enemies (`n2`): same 170 enemies on both sides, 170/170 with the same sprite (old: 12/38 textures wrong); drawn position 7 px behind the host on average (about 100 ms of walking); 77 KB/s to the joiner (old: 138 KB/s at 14 snapshots/s, here 27 snapshots/s), largest datagram 1000 B (old: about 10 KB); no lost, partial or dropped snapshots.

Simulated impairment, light combat with knockback (`n4`), joiner's key-to-camera latency p50:

| loss | one-way delay | measured RTT | key to camera (p50 / p95) | prediction corrections (mean / max) | partial snapshots |
|---|---|---|---|---|---|
| 0% | 0 | 16 ms | 16 / 52 ms | 14 px / 24 px | 0 |
| 2% | 40 ± 10 ms | 134 ms | 14 / 103 ms | 18 px / 24 px | 7 |
| 5% | 60 ± 20 ms | 160 ms | 14 / 353 ms | 24 px / 32 px | 29 |
| 10% | 100 ± 30 ms | 244 ms | 15 / 287 ms | 28 px / 35 px | 44 |

(12 key presses per row. The p95 outliers are single long frames of the software renderer, which also stall the host, not network waits; an earlier run of this scenario at 150 ms one-way delay, 330 ms RTT, gave the same p50.)

Local responsiveness does not depend on RTT. Corrections are knockback the host applied that the joiner could not know about yet; they are smoothed, never snapped (0 snaps in every run).

Soak (`n5`, 40 s of continuous joiner movement in a 80-enemy fight, clean and with 3% loss / 50 ± 15 ms): the host's input backlog stayed at a mean of about 1 command (max 5), no drift between the two clocks, zero corrections without damage, and the host's and joiner's final positions agreed (apart from the commands still in flight).

Costs: host replication about 0.3-1.1 ms per snapshot (including all joiners' packets); joiner decode about 0.1 ms per datagram and about 0.4-3 ms per frame to pose the world. Under a heavy swarm with 5 spells (`tests/coop.perf.cjs`) the rig itself ran at 40 ms frames for both players, so frame-rate conclusions from that scenario are limited to "the joiner is no slower than the host".

## Tests

* `tests/coop.perf.cjs`: responsiveness, host/joiner agreement (enemies, spell sprites), datagram sizes, prediction, on a clean link and under simulated impairment.
* `tests/coop.flow.cjs`: connection drop and automatic reconnect, host pause and resume, joiner leaves, host ends the game, version mismatch refused.
* `tests/coop.e2e.cjs`: lobby, ready flow, rewards, round result merge, game over.
* `sync-worker/mp.test.mjs`: signaling rooms, including the lock route.

Each file's header says how to run it (a built game on :4173 and the worker on :8799). The worker allows 12 room creations per 10 minutes per address; restart it between full runs.

## Not tested / known limits

* **No real remote devices or networks.** Everything above is loopback plus injected impairment. Real NAT traversal, mobile networks, Wi-Fi bufferbloat and browsers other than Chromium were not tested.
* **No TURN relay.** Players behind symmetric NAT or strict firewalls cannot connect peer-to-peer and will see "Could not connect to the host". A TURN service (for example Cloudflare's) would be the next step; it needs credentials the project does not have.
* Spells fire from the host's authoritative position of the joiner, which trails the joiner's predicted position by about half the RTT (about 11 px at 70 ms RTT); projectiles therefore appear to start slightly behind a moving joiner. Lag compensation for casting was not implemented.
* Enemy bodies and other players are drawn in the past (about 70-100 ms); the host's player is too, as seen by joiners.
* Each joiner is sent the whole arena (it is 1100 px square, always on screen); there is no interest management.
* No host migration; a joiner cannot join a run already in progress (a dropped player can come back).
