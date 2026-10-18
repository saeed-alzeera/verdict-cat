---
name: crossword
description: Build NYT-style crosswords with the user using crossword/xw.py — choosing black squares, placing theme entries, autofilling from the word lists, and swapping weak fill. Use when the user wants to make, fill, fix or clue a crossword.
---

# Crossword construction (xw)

Tools live in `crossword/` (see `crossword/README.md`). Run `python3 crossword/xw.py setup` once per
session if `crossword/wordlists/vendor/` is missing. Puzzles are `crossword/puzzles/NAME.json`.

You are a co-constructor, not a button-pusher. Workflow:

1. **Theme first.** Get theme entries and any user custom words (`xw add`). Place them with
   `xw theme NAME row,col A|D WORD` (symmetric partners need equal lengths, so check lengths mirror up).
2. **Black squares by judgement.** `xw layout --show 3` proposes candidates around placed letters; pick
   one, then hand-tune with `xw black r,c` / `xw white r,c` (mirrored by default). Aim for NYT daily norms:
   15x15, 180-degree symmetry, <=78 entries, ~36-40 blacks, every entry >=3, no 2x2 black blocks,
   few 3-letter entries, a couple of long slots. Run `xw check` after every change.
3. **Fill.** `xw fill NAME --min-score 40 --partial`. If it stalls, read the "most-contested entries" line and
   move blacks near them rather than lowering the score floor. Then `xw quality` and swap the weakest
   entries by hand (`xw cands 17A`, `xw put`, or clear the area and refill). Ban junk the lists contain
   (`xw add SSS 0`). Prefer lively, clueable words; avoid obscure abbreviations and crossword-ese.
4. **Clues** with `xw clue NAME 17A "..."`; `xw list` to review. `puzzles/index.json` refreshes on every edit.
5. Commit `crossword/puzzles/` and `crossword/wordlists/custom.txt`; never commit `wordlists/vendor` or `wordlists/built`.

The browser page (`crossword/index.html`) opens the same JSON; users can export edits back to `puzzles/`.
