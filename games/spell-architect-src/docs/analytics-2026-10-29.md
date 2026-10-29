# Run analytics review (29 Oct 2026)

Source: the `spell-runs` namespace on the sync worker. **9 runs**: 8 normal-mode losses and 1 accelerated-mode (quick) win. All normal runs were on the build before the gradual-difficulty, instant-level-up and starter-rune changes, so this is the baseline that motivated them. N is tiny; treat the numbers as direction, not statistics.

## Headline

**Every normal-mode run died in rounds 2-4 (five of eight in round 3). Nobody has seen a boss in normal mode.** Death is attrition, not a spike: total damage taken at death was 104-189 (mean 128) against 100-120 max HP, and HP is never meaningfully refilled.

| Metric | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Damage taken per completed round (mean, range) | 20 (0-55) | 49 (27-74) | 79 (n=1) |
| HP at end of round, share of max | 80% | 40% | ~0% |
| Kills per second | 0.87 | 3.0 | n/a |
| Damage per second | 16 | 76 | n/a |

Damage taken grows about 2.4x then 1.6x per round while there is almost no recovery (regen 0, round-start heal 2%, rare hearts), so the run is lost on a budget of roughly one health bar.

## Findings

1. **Trash melee is the damage source.** Swarmers 44%, grunts 34%, archer projectiles 9%, chargers 8%, void 2% (no boss damage at all). Swarmers are the biggest single hurter despite having the least HP: they arrive in fast packs and hit on contact. The round-2 even-round swarm ring (14+ at once) was in place for these runs.
2. **Round 1 is dead time with the starter.** All seven projectile runs dealt 543-581 damage and 27-33 kills in round 1 (about 16 dps). The one Beam start dealt 1,826 damage and 108 kills in round 1 and arrived at round 2 with 74% HP, about 3x the output. By round 2 builds jump to about 76 dps (rewards/shop), so the starter spell is far weaker than anything the player gets next. 8 of 9 starts were Projectile (the default).
3. **Deaths come at the end of the round unless you enter it nearly dead.** Six of eight died 35-47 s into a 45 s round, when density is highest and HP lowest. The two that died early (11 s and 19 s) had entered the round on 18% and 1% HP. The less HP on entry, the sooner the death; the HP you carry in decides the round before it starts.
4. **Builds stay small.** Slots used per run: 1, 2, 2, 3, 1, 2, 2, 1 (mean 1.75 of 3); only 2 of 14 spells hit their capacity cap. 6 of 8 runs had zero relics (the other two had one). On Kill ("of Reaping") is on the main spell in 4 of 8 final builds.
5. **Reactions vary wildly.** 0 reactions in two runs (pure Arcane builds) versus 52-213 in the others. Both zero-reaction runs died in rounds 2-3, but that is two runs.
6. **Quick mode is not a balance proxy.** The one full 20-round clear was accelerated mode (12 s rounds, enemy HP ×0.55, damage ×0.6): 245 total damage taken over 20 rounds and 615,525 damage dealt, 89% of it from a single spell, with 6 relics (including cursed Glass Cannon Idol and Gambler's Dice) and 60% of damage taken from projectiles. Normal mode and quick mode behave like different games; the rounds 5-20 content (bosses, attunement mix, late enemies) is **unvalidated** in normal mode.
7. **Void damage was small (2%)** and only in one run; the crumbling floor is not what is killing players. The floor cap and corner/edge bias are safe to keep.

## What this suggests

- **Add a health income.** Even a small baseline regen (0.1-0.2 HP/s is about 5-9 HP per 45 s round), a larger round-start heal (about 8-10%), or hearts that drop in proportion to damage taken would break the attrition spiral without making fights easier. Current scarcity left no recovery lever at all. Rituals (see `rituals.md`) can add earned regen/HP later.
- **Cut swarmer pressure, not swarmer count.** Lower contact damage (5 to 3-4) or give a short post-hit invulnerability/knockback so a pack cannot chain hits; keep the visual threat.
- **Make the starter pull its weight.** Raise Arcane Bolt output or cadence (target 25-30 dps in round 1) or equalise Beam/Nova/Projectile starters; consider letting Beam back into the starter set.
- **Fix the early shop/slot funnel.** Slots 2-3 are underused; consider a cheap first extra slot or a free second Form early so builds diversify before round 4.
- **Instrument for next time.** Log damage taken per enemy type per round, time-in-round of each hit, shop purchases/skips, coins spent, and entry/exit HP per round; record the build version on each run so analyses can separate eras; keep quick-mode runs out of balance analysis (tag already exists: `quick`).
- **Get normal-mode data past round 4.** After the difficulty ramp, collect 15-20 normal runs before tuning bosses and late rounds.

## Follow-up (what was changed in response)

Baseline regen 0.15 HP/s, round-start heal 6% (was 2%), swarmer contact damage 5 to 3.4, and a fading "apprentice's focus" damage bonus (+60% round 1 to +0% by round 5). With HP carried between rounds (no resets), a kiting bot that equips its spare runes now clears rounds 1-3 in 3 of 3 trials and reached the round 5 boss once; the human runs above never got past round 4. Re-check with fresh run data.
