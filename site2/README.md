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

`words.txt` is not committed (same reason as `crossword/wordlists/built/`: one upstream source has no licence).
Either build one locally (`python3 crossword/xw.py setup`, then copy `crossword/wordlists/built/master.txt` to
`site2/words.txt`), or use the **Word list** button to load any `WORD;score` text file. It is stored in
IndexedDB in that browser. `custom.txt` (committed) is always merged in.
Score 0 bans a word; scores map to cost on a log scale (60 and above is cheapest).

## Not implemented

Bars (vBars/hBars) and rebus squares.
