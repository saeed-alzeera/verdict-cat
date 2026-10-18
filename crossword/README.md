# Crossword

NYT-style crossword constructor. Two halves that share one file format (`puzzles/*.json`):

- **`xw` CLI** (Python 3, stdlib only) — where black squares and fill get built, with Claude working
  alongside you in a session. Layout generation, theme placement, candidate lookup, autofill, NYT-rule checks.
- **`index.html`** — NYT-styled solver and constructor in the browser. Opens any puzzle in `puzzles/`;
  Build mode edits the grid, clues and black squares (with live rule checks and word suggestions).

## Setup

```
python3 crossword/xw.py setup        # clones the three word-list repos, builds the master list
```

Word lists (cloned into `wordlists/vendor/`, not committed):
[crossword-wordlist](https://github.com/christophsjones/crossword-wordlist) (scored base list),
[crossword-dataset / MsFit](https://github.com/nzfeng/crossword-dataset) (hand-curated, gets a score boost),
[Crossword-Dictionaries](https://github.com/stephthegeek/Crossword-Dictionaries) (themed; opt in with `--theme tech`).
Your own words live in `wordlists/custom.txt` (default score 90; `;0` bans a word) — `xw add WORD [score]`.

## Typical session

```
xw new mypuzzle --title "..." --author "..."
xw theme mypuzzle 3,0 A UNDERTHEWEATHER     # theme entries first; caps are blacked + mirrored
xw layout mypuzzle --show 3                  # propose black squares around them
xw layout mypuzzle --write 2                 # take #2 (then nudge with: xw black / xw white)
xw check mypuzzle                            # symmetry, connectivity, min length, counts, dupes
xw fill mypuzzle --min-score 40 --partial    # autofill; keeps every letter already placed
xw fill mypuzzle --must JWANA ALJAR/HAMOOD   # words that must appear (A/B = exactly one); saved in the puzzle
xw layout mypuzzle --want 5:8,7:4            # favor layouts with enough slots of the lengths you need
xw quality mypuzzle                          # weakest entries -> swap with xw cands 17A / xw put
xw clue mypuzzle 17A "..." ; xw list mypuzzle
```

Run as `python3 crossword/xw.py <command>` (alias it to `xw`). Rows/cols are zero-indexed;
entries are addressed by number+direction (`17A`), which can renumber when blacks move — clues are
stored by start cell so they survive that.

## Site and CLI hand-off

Puzzles are plain JSON in `crossword/puzzles/` and are committed. Build in the browser, then **Export** (or
**Copy JSON**), drop the file in `puzzles/` (or paste it to Claude), and keep going with `xw`. The reverse is
just `git pull` and reload.

The site's word suggestions read `wordlists/built/master.txt` if it is served, otherwise `custom.txt`.
The built list is gitignored because one source repo ships without a license.
