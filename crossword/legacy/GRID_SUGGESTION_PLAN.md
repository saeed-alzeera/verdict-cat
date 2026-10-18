# Plan: Smarter crossword grid suggestion (ACROSS/DOWN aware, loose scaffold)

## Context

The crossword creator (`games/crossword/index.html`, a single self-contained vanilla-JS
file) has a "Suggest Layout" feature that is too dumb to be useful:

- **It ignores direction.** Input is a flat `WORD: clue` list; the generator itself
  decides across vs. down by greedily packing words longest-first and alternating H/V.
  The user has no control over which words are across and which are down.
- **It over-blacks.** After packing, *every* non-word cell becomes a black square
  (`generateLayout`, lines ~1348-1351), producing a tight, fully-committed skeleton
  instead of a loose scaffold.
- **It silently drops words** it can't interlock (`stillUnplaced`, lines ~1345-1346).
- **It throws away the placements.** `generateLayout` returns only `{size, blacks}`.
  The actual letters are re-derived later by `placeImportedEntries` → `compatSlots`
  (matching words to slots purely by length + letter compatibility, lines ~1169-1174),
  which frequently can't disambiguate and pops the manual "Assign panel."

**Desired outcome:** the user types an explicit `ACROSS:` section and a `DOWN:` section
(each a list of `WORD: clue` lines). The generator lays those words down in their
declared directions, interlocking where letters match, and produces a **mostly-empty
scaffold**: words placed, only minimal black caps at word ends, everything else white.
The user takes this half-finished grid into the Design stage and tweaks it by hand.

This is a self-contained change to one file. No framework, no build, no tests exist
(static GitHub Pages site).

---

## Confirmed design decisions

1. **Input format:** require `ACROSS:` / `DOWN:` section headers. Old flat format is no
   longer accepted (preview shows a format error until headers are present).
2. **Blacking:** minimal caps only — black the single cell immediately before a word's
   start and immediately after its end (along the word's direction) so `computeGrid`
   derives the correct slot length. Everything else stays white/empty.
3. **Non-crossing words:** place them loosely anyway, each in its own open row (across)
   or column (down), rather than dropping them.

---

## Changes (all in `games/crossword/index.html`)

### 1. Parser: `parseImport(text)` (~lines 1155-1167) — rewrite to be section-aware

Return a flat, direction-tagged array so existing iterators keep working:

```js
// returns [{word, clue, dir:'across'|'down'}]
function parseImport(text) {
  const out = [];
  let dir = null;
  for (let raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^across:?$/i.test(line)) { dir = 'across'; continue; }
    if (/^down:?$/i.test(line))   { dir = 'down';   continue; }
    if (!dir) continue;                 // lines before any header are ignored (headers required)
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const word = line.slice(0, colon).trim().toUpperCase().replace(/[^A-Z]/g, '');
    const clue = line.slice(colon + 1).trim();
    if (word && clue) out.push({ word, clue, dir });
  }
  return out;
}
```

Callers that iterate `for (const {word, clue} of entries)` (`handleImport` ~1176,
`placeImportedEntries` ~1356) keep working — they just ignore the new `dir` field.

### 2. Import UI copy (~lines 356-361) — reflect the required format

- Drop-zone hint (line ~358): change `One entry per line: <code>WORD: clue text</code>`
  to describe the sectioned format.
- Textarea placeholder (line ~361): show a small example:
  `ACROSS:` / `APPLE: A red fruit` / `DOWN:` / `BREAD: Baked from dough`.

### 3. `updateImportPreview()` (~lines 1240-1261) — validate + show per-direction counts

- If parsed entries are empty (no headers or no valid lines), show the format-error
  message and keep the "Suggest Layout" button disabled.
- Otherwise show counts split by direction, e.g. `4 across · 3 down · lengths 3–7`,
  still rendering the word chips (optionally grouped/labelled A/D).

### 4. `suggestGridSize(entries)` (~lines 1263-1276) — keep, but ensure loose-fit room

Keep the count-bucket heuristic and `maxLen + 1` floor. Add headroom so loosely-placed
(non-crossing) words have spare rows/columns: bump the floor toward
`maxLen + 2` and consider the *larger* of the across/down counts. Cap at 21, keep odd.
(Tune during implementation; exact numbers are not load-bearing.)

### 5. `generateLayout(entries)` (~lines 1278-1354) — the core rewrite

Reuse the existing `get/set/canPlace/doPlace` scaffolding (lines 1283-1315) but:

- **Honor declared direction.** A word's direction is fixed by `entry.dir`
  (`'across'` → H, `'down'` → V) instead of being chosen by the packer.
- **Seed** with the longest word (prefer an across word) placed near center.
- **Interlock pass:** repeatedly, for each not-yet-placed word, scan already-placed
  words of the *opposite* direction for a shared letter, score candidate crossings by
  centrality (reuse the current `-(|nr-N/2|+|nc-N/2|)` score), and place the best.
  Loop until no further crossing placements are possible. `canPlace`'s existing
  adjacency guards (empty cell before/after; perpendicular-neighbor clearance at
  non-crossing cells) already prevent parallel touching and accidental words.
- **Loose pass** (the "place anyway" behavior): for each still-unplaced word, find an
  open band in its own direction — a fully-empty run of `len` cells with vertical/
  horizontal clearance (and empty cap positions), scanning rows (across) or columns
  (down), skipping a line between placements. Place it there with no crossing. If the
  grid genuinely has no room, collect it as unplaced and surface a count in the banner.
- **Minimal caps instead of full black-out:** replace the "black every empty cell" loop
  (lines 1348-1351) with: for each placed word, add `"r,c"` to `blacks` for the cell one
  step before its start and one step after its end (if in-bounds and currently empty).
  Do **not** black the rest of the grid.
- **Return the real placements** so they can be threaded through:
  ```js
  return { size:N, blacks, placements, placed: placements.length, total: entries.length };
  ```
  where `placements = [{word, clue, r, c, dir}]`.

### 6. Thread placements into the Fill stage (eliminate re-guessing)

- **Suggest handler** (~lines 1397-1414): store the result —
  `S.suggestedPlacements = placements` (add the field to state `S`, ~lines 575-586) —
  in addition to setting `S.gridSize`/`S.blacks`. Update the banner to use the returned
  `placed`/`total`.
- **`btn-skip-to-design`** (~lines 1416-1420) and any re-import path: clear
  `S.suggestedPlacements = null` so stale placements are never reused for a hand-made grid.
- **`btn-go-fill`** (~lines 697-716), in the `freshGrid` branch: if
  `S.suggestedPlacements?.length`, call a new `placeSuggested(S.suggestedPlacements)`
  instead of `placeImportedEntries(...)`.
- **New `placeSuggested(placements)`:** for each `{word, clue, r, c, dir}`, find the slot
  with `slot.row === r && slot.col === c && slot.direction === dir` (deterministic — the
  slot's start cell is its `(row,col)`), then `putWord(slot, word, clue)`. If the user
  edited blacks in the Design stage so a start cell no longer begins a matching slot,
  fall back to the existing `compatSlots` logic for that one word (which may still route
  it to the Assign panel). Finish with `renderFillGrid()` / `renderCluePane()` / status.
- Keep `placeImportedEntries` / `handleImport` / the Assign panel as-is for the
  "Re-import .txt into an existing grid" toolbar path (fill stage, ~line 409).

---

## Critical files

- `games/crossword/index.html` — the only file. Functions to touch:
  `parseImport` (~1155), import UI markup (~356-361), `updateImportPreview` (~1240),
  `suggestGridSize` (~1263), `generateLayout` (~1278), state `S` (~575),
  `btn-suggest-layout` handler (~1397), `btn-go-fill` handler (~697),
  `btn-skip-to-design` handler (~1416), plus a new `placeSuggested` helper.
- Reuse existing: `computeGrid` (~657, slot/numbering — unchanged), `putWord` (~1030),
  `compatSlots` (~1169, fallback only), `renderFillGrid`/`renderCluePane`.

## Data contract (unchanged downstream)

`computeGrid` still consumes `S.blacks` (Set of `"r,c"`) + `S.gridSize` and produces
`S.slots` (`{id, num, direction, row, col, length, cells}`). The rewrite only changes
*which* cells are black (minimal caps) and adds `S.suggestedPlacements` for direct fill.

---

## Verification (manual, in a browser)

No test harness exists; verify by opening the file directly
(`open games/crossword/index.html` or serve the repo root).

1. **Parsing/preview:** paste a sectioned list, e.g.
   ```
   ACROSS:
   APPLE: A red fruit
   RIVER: Flows to the sea
   DOWN:
   PEAR: Green fruit
   ROSE: Thorny flower
   ```
   Confirm the preview shows correct across/down counts and enables "Suggest Layout".
   Confirm a list with **no** `ACROSS:`/`DOWN:` headers shows the format error and keeps
   the button disabled.
2. **Suggestion:** click "Suggest Layout". In the Design stage confirm the grid is
   **mostly white** (only small black caps around words), across words run horizontally,
   down words vertically, and words that share a letter interlock. Confirm the banner
   reports words placed / total.
3. **Loose placement:** include a down word that shares no letter with any across word;
   confirm it still appears (in its own column), not dropped.
4. **Threading:** click "Build Grid →". Confirm every suggested word lands in its exact
   slot with its clue pre-filled and **no Assign panel** appears for the untouched
   suggestion.
5. **Hand-tweak still works:** in Design, toggle a few blacks, Build Grid, and confirm
   words whose start cells still align are placed and any displaced word falls back
   gracefully (compatSlots / Assign panel) rather than erroring.
6. **Regression:** "Design Grid Manually →" (skip) and fill-stage "Re-import .txt" and
   "Autofill" all still behave as before.
