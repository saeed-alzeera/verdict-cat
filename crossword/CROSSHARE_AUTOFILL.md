# Crosshare autofiller: findings

Method: REA drove headless Chromium to `crosshare.org/construct`. The shipped Next.js chunks, including the autofill Web Worker, were downloaded and read statically. The solver was not run or observed filling a grid, so everything below is inferred from the shipped JavaScript.

Relevant chunks:
- `00ymqvlmd8w74.js`: grid builder UI, worker wiring, side word list.
- `072eihqnj-f82.js`: word DB loading, bitmap matching, grid/entry helpers.
- `0azwxdm7p0eqy.js` (plus `turbopack-worker-*.js`): the solver worker.

## 1. Word database

- A single `worddb.json` is downloaded once from Firebase Storage, validated, and stored in IndexedDB (`db_version=2` in localStorage).
- Format: `words[len] = [[word, score], ...]`, sorted by score, plus `bitmaps["{len}{letter}{pos}"] = int[]`.
- Each bitmap is a bitset over `words[len]`. A set bit means the word at that index has that letter at that position.
- Scores 0 to 3 map to costs: 0 -> 10, 1 -> 1, 2 -> 0.1, 3 -> 0.01.

## 2. Pattern matching with bitsets

- `matchingBitmap("A?C")` ANDs the bitmaps for (len 3, A at 0) and (len 3, C at 2). No scan of the word list is needed.
- `numMatches` counts set bits. `matchingWords(len, bitmap)` turns set bits back into `[word, score]` pairs.
- `updateBitmap` ANDs one more letter into an existing bitmap. It is used when a crossing entry gains a letter.

## 3. Worker protocol

- The builder starts a Web Worker and posts `loaddb`. On every grid change it posts `autofill` with `{grid, width, height, vBars, hBars}`.
- The worker replies with `autofill-result`, and `autofill-complete` when done.
- Stale results are dropped: a result is applied only if the grid it was solved for still matches the current grid.
- Past results are cached. A cached solution is reused if the new grid only extends it.
- The solver runs in 50ms slices via a `MessageChannel`, so the UI never blocks. A new grid or a `cancel` message discards the old solver.

## 4. Search algorithm

Best-first, cost-minimizing backtracking:
- **Most-constrained first:** unfilled entries are sorted by `numMatchesForEntry`, fewest matches first.
- **Pruning:** skip used words and any word that pushes total grid cost over the best known solution. For each crossing, if the new letter leaves an empty bitmap, reject the word and remember that letter as dead for that cell.
- **Independent regions:** `stableSubsets` splits the grid into regions that share no unfilled crossings and solves them one at a time.
- **Tie-breaking and retries:** costs get noise (`+0.01*Math.random()`). A discrepancy-style retry takes the second-best choice at a branch while budget remains (initial limit 10).
- **Output:** the first solution is posted immediately. Search continues and replaces it if a cheaper one is found.

## 5. How the side word list stays in sync with the board

The side list is a pure function of the current grid and the selected entry, recomputed on each render, so it updates whenever a fill changes:
1. Build the pattern from the selected entry's cells (`?` or space for blanks).
2. Compute `matchingWords(len, matchingBitmap(pattern))`.
3. **Cross-conflict filter:** for each blank cell, put the candidate's letter into the crossing entry's pattern. Drop the candidate if that crossing's bitmap is empty. Results are memoized per cell.

Step 3 is what makes the list better than a plain pattern match: it only shows words that leave every crossing entry with at least one possible fill.

## 6. Comparison with `crossword/index.html`

Already present:
- `render()` calls `renderCands(curSlot())`, which rebuilds the pattern from `G` and regex-matches `words.get(len)` (capped at 60) on every render. So steps 1 and 2 already update live.

Missing:
- The cross-conflict filter (step 3). Suggestions can leave a crossing slot unfillable.
- Exclusion of words already placed elsewhere in the grid.

Minor:
- `renderCands(A)` is called twice in `render()` (once inside the build-mode branch, once after).
- Each call regex-scans the whole length bucket.

Suggested change (not made): in `renderCands`, for each candidate, substitute its letters into each crossing slot's pattern and keep it only if at least one word matches that pattern. Also skip words already in the grid.
