# CW V2

Standalone crossword constructor with a Crosshare-style autofiller. No hub, no password, no shared scripts;
served from `/site2/` by the existing Pages deploy.

- `index.html`: grid editor, clue bar, side word list, grid checks, autofill preview. Saves to this browser
  (localStorage) and imports/exports the same puzzle JSON as `crossword/puzzles/`.
- `worddb.js`: word database. `words[len]` sorted by score plus a bitset per (length, position, letter), so
  pattern matching is an AND of bitsets (`matchingBitmap`, `updateBitmap`, `numMatches`, `matchingWords`).
- `autofill-worker.js`: best-first, cost-minimising backtracking in a Web Worker (50ms slices, stale results
  dropped, cached solution reused when the grid only extends it).

## Word list

`worddb.json` is the word database: Crosshare's `{"words": {"3": [[word, tier], ...], ...}}` (lengths 3-15, tiers 0-3,
about 497k words) with the precomputed bitmaps removed, because they are rebuilt on load. It is fetched once, then kept in
IndexedDB (bump `DB_VERSION` in `index.html` when the file changes). Tier 0 is the worst but still usable (cost 10); 1, 2, 3
cost 1, 0.1, 0.01. `custom.txt` is merged on top (score 0 bans a word). Entries longer than 15 letters have no words.

The **Word list** button replaces the database with your own `WORD;score` text file (0 bans, 60+ is cheapest), stored in
IndexedDB in that browser; **Use default** goes back. `words.txt` (gitignored) is only a local fallback if `worddb.json` is
missing.

## Not implemented

Bars (vBars/hBars) and rebus squares.
