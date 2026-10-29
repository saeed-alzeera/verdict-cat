# ✦ SPELL ARCHITECT

A top-down, Survivors-style action roguelite where **you design the spells**.
Instead of picking weapons, you collect modular magical **runes** and wire them together in a visual node editor:
Core (element) → Form (how it manifests) → Behaviors / Modifiers / Triggers → branching sub-spells.
Then you watch your creation interact with hordes, elemental puddles, poison clouds and bosses.

Built with **TypeScript + Vite + Phaser 3**, UI set in the bundled *Press Start 2P* font (OFL). 100% client-side, no backend, no external assets (all art and audio is generated procedurally at runtime), deployable to GitHub Pages.

## Quick start

```bash
npm install
npm run dev        # local dev server (http://localhost:5173)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build locally
```

Requires Node 18+.

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrow keys | Move (spells cast automatically) |
| `Space` | Fire an Ultimate (needs an equipped evolved Core) |
| Between rounds | Spell Editor opens from the round briefing (`E` in the Sandbox) |
| `Esc` / `P` | Pause / resume / close overlays |
| `1` `2` | Pick a mutation |
| `R` or `Enter` | Retry from the game-over / victory screen |

Editor: click a rune in the **Rune Pool**, then click a glowing card to place it (or drag runes onto cards, or use the dashed **+** buttons for a menu that also explains why a rune *can't* go somewhere). Drag chips and cards between cards to rearrange, drag them to the pool (or right-click / X) to remove them. Hover anything for a tooltip.

## The spell system

**A spell slot holds a Form. You socket a Core into it for its element, then augment it and chain more Forms off its triggers.**

| Category | Runes |
| --- | --- |
| **Form** (the spell's body, fills a slot) | Projectile, Beam, Orbiting Orb, Aura, Mine, Nova, Meteor |
| **Core** (element, socketed into a Form) | Fire, Ice, Lightning, Poison, Water, Gravity (no Core = plain Arcane magic) |
| **Behavior** | Split, Pierce, Bounce, Chain, Orbit, Homing, Pull, Expand |
| **Trigger** | On Hit, On Kill, On Expiry, On Critical Hit |
| **Modifier** | Duplicate, Accelerate, Grow, Increase Duration, Increase Area, Reduce Cooldown |

Rules (enforced by `checkAttach()` in `src/core/spell.ts`, which also produces the human-readable reasons shown in the editor):

* A **Form** goes in a spell slot, or under a Trigger. Each Form has one **Core socket**; with no Core it is plain **Arcane**: launched Forms do NOT inherit the parent's element, so mixing elements in one spell means collecting a second Core for the child Form.
* **Behaviors** and **Modifiers** attach to a Form (each behavior only works with compatible forms; modifiers stack up to their limit).
* A **Trigger** attached to a Form launches the Forms placed under it (up to three). Those Forms can have their own Core, augments and triggers, so chains read like sentences: *"Launches a Fireball that splits into 3 smaller copies. When it hits an enemy, it releases a Frost Nova."* Split copies keep your triggers.
* Every rune costs **Spell Capacity**; each slot has its own capacity (12 to start, raised in the shop).
* Safety against runaway loops: trigger nesting is limited (3 deep), runtime event depth is capped (4), and there are global entity and per-frame spawn budgets, per-source trigger cooldowns and an event-queue cap.

The editor shows each slot as nested cards (Form → Core socket, augment chips, trigger blocks → launched Forms), with a plain-language **What it does** story written beside it.

### Elemental interactions (systemic, not scripted upgrades)

Defined in `src/game/combat.ts`, listed in the in-game **Journal**:

* ⚡ **Lightning + Water puddle** → electrified puddle that shocks everything inside (and spreads to nearby puddles).
* 🔌 **Lightning + Wet enemy** → +50% damage and conduction arcs to other wet enemies.
* 💥 **Fire + Poison cloud** → gas explosion that chain-ignites neighbouring clouds. Burning enemies ignite clouds they stand in.
* 🧊 **Ice + Wet enemy** → instant flash-freeze. 3 chills also freeze. Frozen enemies take +25% damage.
* ♨️ **Fire + Wet enemy** → steam burst; **Fire + puddle** → evaporation. **Ice + puddle** → slowing ice sheet.
* 🧪 **Lightning chain + Poisoned enemy** → Toxic Arc spreads poison. Poisoned enemies spread infection on death.
* 🔥 **Burning enemies** spread fire to neighbours and burst when they die.
* 🌀 **Gravity** pulls enemies into whatever is hazardous; wells collapse for bonus damage when they end.

### Spell mutations

Each spell tracks its own performance (burning kills, chain jumps, enemies captured, freezes, infections spread, soaked enemies, reactions, kills). Reaching a milestone offers a choice of two mutations (e.g. *Inferno Blast* / *Pyre Heart*, *Forked Lightning* / *Overcharge*, *Event Horizon* / *Singularity*). Mutations last for the run only.

### Rounds

A run is **20 rounds**. Each normal round is a 45 s survival timer (12 s in accelerated mode); **every 5th round is a boss** (Stone Warden, Plague Matron, Storm Colossus, Void Architect) and ends when the boss falls. Between rounds the field is swept, rewards are chosen, and you get a **briefing** (enemy mix with attunements, boss resistances, tips) before you edit your spells and start the next round. Level-ups apply a random stat boost **instantly**, mid-round, with a floating label; between rounds you get the shop.

### Attunement, resistance and Arcane

* **Elements hit harder than Arcane** (a Form with no Core) and carry an effect (fire burns, ice chills/freezes, poison stacks, water soaks, lightning chains, gravity pulls). Every Form has its own Core socket, so one spell can mix elements (a Fire projectile whose On Hit releases a Lightning Nova). A Form with no Core is Arcane. The editor's **Reaction potential** panel lists what your elements can do together.
* **Attuned enemies resist their own element** (a glowing badge above them) and are weak to counters (fire: weak to ice/water, ice: fire, lightning: gravity, poison: fire, water: lightning, gravity: poison). Neutral enemies take full damage from everything. Early rounds are mostly neutral; from round 6 most enemies are attuned.
* **Bosses can be fully immune** to elements. **Arcane is never resisted**, so it is always the fallback.

### How reactions work

Reactions come from simple systemic rules, not scripted upgrades. Each reaction needs two elements that can be in **different slots** (they share puddles, clouds and statuses) and **deals both damage types, split evenly**, so a resisted type still leaves the other. Examples: *Lightning + Water puddle* electrifies it; *Fire + Poison cloud* detonates it (fire + poison damage); *Ice + Wet* flash-freezes (ice + water damage). The editor's **Reactions** tab lists every reaction, its ingredients, which ones your current loadout can trigger, and what it deals.

### Crumbling floor

The arena is a small 11x11 tile map. Every round a seeded share of the tiles falls away in three waves: 10% in round 1, 20% from round 2 on. It resets every round (not cumulative). Doomed tiles crack and pulse red for a few seconds first. The remaining floor always stays connected. Enemies on a cracking tile run for solid ground, path around holes, and die if they are still there when it drops; you take 12% max HP and are put back on solid floor. Implemented in `src/game/arena.ts`.

### Shop and economy

Enemies drop **coins** as pickups (roughly 1 per ten kills; elites pay 3; clearing a round and bosses pay a bonus) and XP is awarded directly on kill. A **Magnet** drop vacuums every pickup. After each round the **shop** is deliberately small: **4 offers** (3 runes plus a relic, Cores roll like any other common rune) and **3 random permanent upgrades** picked from Capacity +2, Spell Slot, Spell Power, Haste, Vitality, Keen Edge crit and Healing Draught. A reroll refreshes both. There is no limit on purchases per visit, but upgrades are capped per run, prices climb for every copy of a rune you already own, there are per-rune ownership caps and the reroll cost rises each time. Runes sell for half. Level-ups give stat boosts only.

### Rarity and Triggers

In the editor's **Forge / Merge** tab, two same-type triggers from your pool (On Hit, On Kill, On Critical Hit) merge into one trigger with the summed chance (max 80%): two 20% On Hits become one 40% On Hit. Trigger chance can never exceed 90% after relics.

Everything except Cores has a rarity. **On Hit / On Kill / On Critical Hit** are not guaranteed: they come in tiers that fire 20% (Common), 45% (Uncommon), 60% (Rare) and 80% (Epic) of the time.

### Relics

Passive items with conditions, found from bosses, elites and the shop. Wear up to **6**; extra relics wait in a **stash** and can be swapped in the editor/shop **Relics** tab between rounds. Common to Legendary, plus **cursed** relics with a real downside (Glass Cannon Idol, Gambler's Dice, Hungry Purse). Active relics show on the HUD with live counters.

### Run history

Every run (won, lost or abandoned) is recorded with its spells, relics, per-round log and cause of death. See them under **Run History** in the main menu. When the game is served from the verdict-cat hub (the `verdict-cat-sync-key` is in localStorage), runs sync to the hub's sync worker namespace `spell-runs`.

### Evolutions and Ultimates

Collect **6 copies of the same Core** (pool or equipped, including Cores in nested trigger Forms) and **forge** an evolved Core in the editor's **Forge** tab (the Forge tab and the round briefing glow when you can): Inferno, Glacier, Tempest, Pestilence, Tsunami, Singularity. An evolved Core gives +40% damage, a new passive, and unlocks that element's **Ultimate** on `Space` (Meteor Storm, Absolute Zero, Thunderstorm, Plague Wave, Tidal Surge, Event Horizon). Ultimates recharge over 45 s and faster with kills.

### Online co-op

Main menu → **🌐 Online Co-op**. One player **hosts** and gets a 5-character room code (click the code on the prep screen to copy a join link such as `.../games/spell-architect/?join=ABCDE`); up to 3 friends **join**. Everyone shares one arena, one horde, one boss and one round timer, but each player keeps their own spells, runes, shop, relics, coins, stat boosts and cache/relic rewards (every player gets a boss cache and relic pick). Between rounds each player shops and edits on their own and presses **Ready**; the host starts the round once everyone is ready. XP is shared, so everyone levels together. A player at 0 health is down (spectating a teammate) and returns at the start of the next round; the run ends when everyone is down at once.

How it works: connections are peer-to-peer (WebRTC data channels). The **host's computer runs the only simulation** and every guest just sends its movement and draws what the host mirrors (the host sends the visible sprites, floor tiles, telegraphs, HUD data and sound cues about 20 times a second, roughly 3-6 KB per frame). The sync worker (`sync-worker/mp.js`, public `/mp/*` routes) only hands out room codes and relays the connection handshake; no game data passes through it. A guest's character is sent to the host as plain JSON when they press Ready and is validated first; the host's copy of it (level-ups, mutation progress, relic counters) is merged back into the guest's character after every round. Limits: no joining a run already in progress, no host migration (if the host leaves, the game ends for everyone), and strict networks that block peer-to-peer traffic can't connect because there is no TURN relay. To point the game at another signaling server (for example a local `wrangler dev`), open it with `?mp=http://localhost:8787`.

### Sandbox

The **Sandbox** (main menu) unlocks every rune and evolved core, gives 5 slots and huge capacity, and opens the editor any time. A side panel spawns any enemy type with any attunement (elite optional), bosses, toggles god mode and enemy dummies, clears the field, resets ultimate cooldowns and scales enemy strength.

### Persistence

Stored in `localStorage` (key `spell-architect-save-v1`): settings, **Arcane Shards**, unlocked runes, starting-spell choice, run stats and the **Discovery Journal** (reactions + spell combinations + runes seen). A new save starts with only six runes (Fire, Projectile, Nova, Pierce, On Hit, Grow); spend shards in the **Grimoire** to unlock the rest — progression adds variety, not raw power.

## Project layout

```
src/
  main.ts                 Phaser bootstrap
  data/
    runes.ts              ★ data-driven rune/element/form definitions
    mutations.ts          mutation tracks and their effects
    reactions.ts          reaction display data (journal)
  core/
    spell.ts              spell graph, validation, compilation, naming, estimates
    save.ts               localStorage persistence
    audio.ts              procedural WebAudio SFX + music
  game/
    run.ts                simulation state & main tick loop (one world; remote co-op players are "shell" Runs that inherit the world and own their personal state)
    arena.ts              crumbling floor tiles, flow-field navigation
    casting.ts            casting, per-form entity simulation, trigger event executor
    combat.ts             damage pipeline, statuses, elemental reactions, kills
    enemies.ts            archetypes, AI, spawn director
    bosses.ts             boss attack patterns
    rewards.ts            reward generation
    fx.ts                 pooled particles / bolts / numbers / shake
  gfx/textures.ts         procedural pixel-art generation
  scenes/                 Boot, Menu backdrop, Game (rendering glue)
  net/                    Co-op: coop.ts (host and guest sessions), rtc.ts (WebRTC), mirror.ts (snapshot codec), signaling.ts
  ui/                     DOM UI: menus, HUD, overlays, editor (editor.ts), overview.ts (spell overview pane), lobby.ts (co-op menus), styles.css
```

### Adding a rune

1. Add an entry to `RUNES` in `src/data/runes.ts` (kind, cost, rarity, compatible forms, `unlock` cost).
2. For a new *behavior/modifier/trigger* key, read it from `CForm.b` / `CForm.m` in `src/game/casting.ts` (the compiler in `core/spell.ts` already forwards every behavior/modifier key automatically). New cores/forms need matching entries in `ELEMENTS` / `FORMS` and a branch in `spawnEnt`.

## Testing hooks

The game exposes `window.__SA` (spell/graph helpers, reward generator, save store, UI) and `window.__SA_GAME` (the Phaser game). The simulation can be stepped without rendering, e.g. in the console:

```js
const run = __SA_GAME.scene.getScene('Game').run;
__SA_GAME.scene.getScene('Game').scene.pause();
for (let i = 0; i < 600; i++) run.tick(1 / 60);
```

## Deployment (GitHub Pages)

`vite.config.ts` uses `base: './'`, so the build works under any repository path.

1. Push to GitHub (default branch `main` or `master`).
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. `.github/workflows/deploy.yml` installs, builds and publishes `dist/` on every push (or run it manually from the *Actions* tab).

## License

Code and procedurally generated assets are original; do whatever you like with them.
