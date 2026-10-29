# Rituals: scope

**Status:** proposal, nothing built. **Goal:** a run-long goal system that rewards playing well and building with intent. A Ritual is a contract with a few objectives that must all be met within a few rounds; meet them and you get a permanent upgrade for the rest of the run.

## Why this, and why now

The saved runs (see `analytics-2026-10-29.md`) show two things Rituals can address:

1. **Health is a run-long budget that nothing refills.** Eight normal-mode runs took 104-189 total damage (mean 128) against 100 max HP, and HP at the end of a round averaged 80% after round 1, 40% after round 2 and about 0% after round 3. The only sources of permanent defence today are a few shop upgrades and random level-up boosts. Rituals give skilled play a way to earn durable survivability (and other perks) beyond luck.
2. **Decisions between rounds are thin.** Players use 1-2 of their 3 slots, and the cheapest path is to stack one spell (in the quick-mode win, one spell did 89% of all damage). Objectives such as "run 3 elements", "use every slot" or "land 3 different reactions" give a reason to build wide, and the reward makes it worth the opportunity cost.

## Design pillars

- **All-or-nothing, clearly stated up front.** You see every objective and the exact reward before accepting. No hidden conditions.
- **Spans several rounds.** 2-4 rounds, so a ritual is a plan, not a single-round chore.
- **Optional and costly.** Accepting spends coins and a ritual slot; failing wastes both. Declining is always fine.
- **Rewards are permanent for the run** (reset next run), stackable but capped, never meta-progression, so it cannot trivialise the shard economy.
- **Built on existing hooks.** Objectives are counters driven by events the game already raises (kills, crits, reactions, damage taken, round end, forge...).

## How it plays

1. **Offer.** On the between-round prep screen (and in the shop) a **Rituals** row shows 2 offered rituals (rerolled with the shop reroll). Each card shows: name, tier (I-III), objectives (with numbers), duration in rounds, the reward, and the coin cost.
2. **Accept.** Pay the cost; the ritual starts at the next round. You begin with 1 ritual slot; a second slot unlocks at round 8 (or as a ritual reward). Only one ritual per tier may be active.
3. **Track.** A compact HUD tracker (under the party panel position) shows each active objective as `label  progress / target` with a bar, and rounds left. Objectives turn green when met; a toast fires on each.
4. **Resolve.** At the end of the final round of the ritual: all objectives met → **fulfilled**, reward applied immediately with a banner; otherwise → **lapsed** ("the ritual fades"), no further penalty. Objectives that are per-round (e.g. "take 15 or less damage") are checked each round and fail the ritual the first time they are missed, which lets a lapsed ritual end early and frees the slot.
5. **Repeat.** A fulfilled/lapsed ritual's slot is free next prep. The same ritual does not reappear in the same run.

### Tiers

| Tier | Duration | Objectives | Cost | Typical reward |
| --- | --- | --- | --- | --- |
| I | 2 rounds | 2 | 6-10 coins | minor perk (e.g. +6% damage, +15 max HP) |
| II | 3 rounds | 2-3 | 12-20 coins | solid perk (e.g. +0.2 HP/s regen, +3 capacity on every spell) |
| III | 4 rounds | 3 | 20-35 coins | build-defining perk (e.g. 7th relic slot, a free forge, an extra spell slot) |

## Objective catalogue (v1)

Each objective is `{ id, text, scope, metric, target(round, tier) }`. `scope` is `round` (must hold every round of the ritual), `total` (accumulates over the whole ritual) or `once` (must happen at least once).

| Group | Objective | Scope | Driven by |
| --- | --- | --- | --- |
| Survive | Take at most N damage in a round | round | `hurtPlayer` |
| Survive | Finish every round above X% health | round | `endRound` |
| Survive | Never fall into the void | total | `fallPlayer` |
| Kill | Kill N enemies | total | `killEnemy` |
| Kill | Kill N enemies with a specific element in your loadout | total | `killEnemy` + element |
| Kill | Kill N elites / defeat the boss in under T seconds | total / once | `killEnemy`, `onBossDeath` |
| Spells | Land N critical hits | total | `onCrit` |
| Spells | Trigger N reactions, or M *different* reactions in one round | total / round | `reaction` |
| Spells | Freeze N enemies / spread poison to N enemies | total | `freezeEnemy`, plague spread |
| Build | Have 3+ elements equipped | round | `recomputeMods` |
| Build | Use every spell slot | round | spell list |
| Build | Fill N% of capacity on a spell | round | `spellCost` |
| Economy | Collect N coins | total | coin pickup |
| Economy | End a round holding N+ coins (don't spend) | round | `endRound` |
| Craft | Forge an evolved Core | once | `forge` |

**Selection** reuses the reward system's relevance weighting: objectives are sampled so they are *achievable but not free* for the current build (an element objective only names an element you could plausibly equip; a "use every slot" objective is not offered if you cannot buy a slot). Each ritual mixes at least one **build** or **survive** objective with a **kill/spell** objective, so it cannot be completed by one behaviour alone.

**Targets scale with the round** from measured baselines (current data: round 1 about 0.9 kills/s and 20 damage taken; round 2 about 3 kills/s and 49 damage taken): `target = baseline(round) × tierFactor`, where `tierFactor` is roughly 0.8 / 1.0 / 1.25 for I / II / III on "do more" objectives and 1.2 / 0.9 / 0.7 on "take less" objectives. The baselines should be refreshed from analytics once more normal-mode runs exist.

## Rewards (permanent for the run)

Pool, with caps so rewards cannot stack without limit:

- **Power:** +6/+10/+15% damage; −6% cooldown; +4% crit chance; +0.25 crit multiplier.
- **Survival:** +15/+25 max HP (and heal that amount); +0.15/+0.25 HP/s regeneration (cap 0.8 total); first hit each round is halved; round-start heal +5%.
- **Build:** +3 capacity on every spell; +1 spell slot (max 5); +1 relic slot (7th); forge costs 1 fewer Core; one extra shop offer.
- **Economy:** +25% coins; shop prices −8% (cap −25%); one free reroll per visit.

The reward is chosen when the ritual is generated and shown on the card, so the player is choosing between known quantities. Higher tiers draw from the stronger rows. Survival rewards are intentionally prominent because that is where the data says runs die.

## Data model and code touchpoints

New `game/rituals.ts` (modelled on `relics.ts`):

```ts
interface Objective { id: string; text: (t: number) => string; scope: 'round'|'total'|'once'; target: number; /* resolved at offer time */ }
interface RitualDef { id: string; name: string; icon: string; tier: 1|2|3; rounds: number; cost: number; objectives: Objective[]; reward: RewardId; seed: number }
interface ActiveRitual { def: RitualDef; startRound: number; progress: number[]; done: boolean[]; state: 'active'|'fulfilled'|'lapsed' }
```

`Run` gains `rituals: ActiveRitual[]`, `ritualSlots`, `ritualsSeen: string[]` (per player: shells own theirs). One function `ritualEvent(run, type, payload)` is called from the sites that already notify relics:

| Event | Existing site |
| --- | --- |
| kill / crit / reaction / cast | `onKill`, `onCrit`, `onReaction`, `onCast` in `relics.ts` (add one line each) |
| damage taken | `Run.hurtPlayer` |
| void fall | `Run.fallPlayer` |
| round start / end | `Run.startRound`, `Run.endRound` |
| boss defeated | `Run.onBossDeath` |
| coins collected | `Run.updatePickups` |
| forge | `Run.forge` |
| loadout changed | `Run.recompile` / `recomputeMods` |

Other files: `shop.ts` (ritual offers + reroll), `ui/shop.ts` and `ui.ts` `showPrep` (offer row), `ui.ts` Hud (tracker), `analytics.ts` (record offers/accepts/outcomes per round), `rewards.ts` (reward application helpers), `ui/overview.ts` (show active rituals). Roughly 600-800 lines including UI, plus tests.

## Analytics and tuning

Add to the run record: `rituals: { id, tier, offeredRound, acceptedRound, result: 'fulfilled'|'lapsed'|'abandoned', progress }[]`. Target completion rates: tier I about 70%, II about 45%, III about 25%. If a ritual is fulfilled much more often than that it is too easy; if an objective is never completed it is a trap. Reward value should be set from measured effect on rounds survived once data exists.

## Co-op

Rituals are **per player** in v1 (each shell owns its own list; events are resolved through `Run.owner(sp)` / the shell that was hit, as the relic hooks already are). The host evaluates progress; each guest's progress rides along in the existing 20 Hz snapshot metadata (a few numbers per objective) for the HUD, and the final result is applied through the existing round-result merge (the reward is just a change to the guest's build). A later **team ritual** (shared objectives, shared reward) is a natural extension.

## Risks and mitigations

- **Perverse incentives** (stalling, farming): objectives are counters over a fixed-length round, so stalling just loses time; "don't spend coins" objectives are capped by the shop's price curve; per-round caps on farmable counters.
- **Build warping / frustration:** rituals are optional and show everything up front; failing costs only the coins.
- **Snowballing:** rewards are capped per category and gated by tier; survival perks have diminishing caps.
- **Clutter:** at most 2 active rituals; the tracker collapses to a one-line summary while the fight is busy.
- **Correctness of counters:** each objective is a pure counter with a unit test that replays recorded event streams; the bot harness runs full rounds and asserts completion rates.
- **Save/analytics growth:** ritual records are tiny; run history already caps at 80 runs.

## Build plan

1. **Engine (day 1-2):** `rituals.ts` with the event hook, 8 objectives, 6 rewards, activation/resolution, tests that drive events directly.
2. **UI (day 2-3):** offer row in the prep screen/shop, accept flow, HUD tracker, toasts, overview entry.
3. **Data and tuning (day 3-4):** analytics fields, bot harness for completion rates, first balance pass, README.
4. **Phase 2:** remaining objectives, tier III rewards (relic slot, spell slot), unlock via Grimoire, co-op progress sync, team rituals.

## Decisions for you

1. **Where are rituals offered?** Recommend the prep/briefing screen (a deliberate "plan the next rounds" moment) with the same reroll as the shop.
2. **What does failure cost?** Recommend only the coins paid. Harsher options (a curse, losing a relic) make rituals feel like traps while HP attrition is already the main cause of death.
3. **How many at once?** Recommend 1 at start, 2 from round 8.
4. **Known vs mystery rewards?** Recommend known; mystery rewards remove the planning that makes this fun.
5. **Gate behind Grimoire shards?** Recommend yes: unlocking Rituals (and tier III) with shards keeps the first runs simple, consistent with the constrained starter set.
6. **Per-player vs team rituals in co-op?** Recommend per-player first.
