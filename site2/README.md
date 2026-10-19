# CW V2

Standalone crossword constructor with a Crosshare-style autofiller. No hub, no password, no shared scripts;
served from `/site2/` by the existing Pages deploy.

- `index.html`: grid editor, clue bar, side word list, grid checks, autofill preview. Saves to this browser
  (localStorage) and imports/exports the same puzzle JSON as `crossword/puzzles/`.
- `worddb.js`: word database. `words[len]` sorted by score plus a bitset per (length, position, letter), so
  pattern matching is an AND of bitsets (`matchingBitmap`, `updateBitmap`, `numMatches`, `matchingWords`).
- `autofill-worker.js`: best-first, cost-minimising backtracking in a Web Worker (50ms slices, stale results
  dropped, cached solution reused when the grid only extends it).

- `blackfill.js`: black-square autofiller (see below). Pure functions, also loadable from Node.

## Export

**Export .puz** downloads an Across Lite v1.3 file (checksums included; empty squares are written as `-`). **Save JSON** keeps the editable puzzle, including banned words, and is what **Import** reads.

## Eliminating autofill

When autofill proposes a fill, each proposed word shows as a chip in the Autofill panel. **✕** bans that word and refills without it; banned words show struck through, and **↺** allows one again. Bans are saved with the puzzle (`banned` in the exported JSON, the same key `xw nix` uses).

## Custom list and black squares

Words typed into **Add a word** (Place, or **Add to list**) join a custom list kept in this browser. **Place** with an empty box places the words already on the list. Each chip shows how many entries of its length the current grid has. **Generate black squares**
replaces the black pattern (and clears letters and clues; **Undo** restores them) with a symmetric NYT-style one: 180° symmetry,
all entries 3+ letters, connected, no 2x2 black blocks, at most 78 entries on a 15x15 (140 on a 21x21). It anneals over
patterns, scoring the slots of each length the list needs (strong penalty for fewer slots than words), then checks the best
patterns exactly: how many words fit in the grid at once with their crossings agreeing, and how many (word, entry) placements
belong to such an arrangement. The words are not placed; use Add a word for that.

## OR / AND in Add words

The **Add words** box understands `or` and `and`:

- `SAEED or ALJAR` places exactly one of the two (the layout that costs the grid the fewest options). `|` and `/` also mean or.
- `HAPPY and BIRTHDAY` places both; if either cannot be placed the whole placement is refused instead of dropping one. `&` also means and.
- `or` binds tighter than `and`: `SAEED or ALJAR and HAPPY` is (SAEED or ALJAR) and HAPPY.
- Parentheses group and nest to any depth: `HAPPY and (BIRTHDAY or CAKES)`, `A or (B and (C or D))`. A group with `and` inside is placed all-or-nothing.
- Plain lists (commas / new lines) behave as before: placed as far as they fit.

## Word list

`worddb.json` is the word database: Crosshare's `{"words": {"3": [[word, tier], ...], ...}}` (lengths 3-15, tiers 0-3,
about 497k words) with the precomputed bitmaps removed, because they are rebuilt on load. It is fetched once, then kept in
IndexedDB (bump `DB_VERSION` in `index.html` when the file changes). Tier 0 is the worst but still usable (cost 10); 1, 2, 3
cost 1, 0.1, 0.01. Entries longer than 15 letters have no words.

The **Word list** button replaces the database with your own `WORD;score` text file (0 bans, 60+ is cheapest), stored in
IndexedDB in that browser; **Use default** goes back. `words.txt` (gitignored) is only a local fallback if `worddb.json` is
missing.

## Not implemented

Bars (vBars/hBars) and rebus squares.
