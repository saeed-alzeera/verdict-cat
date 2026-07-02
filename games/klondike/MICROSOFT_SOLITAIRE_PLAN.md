# Plan: Make Klondike a 1:1 Copy of Microsoft Solitaire

**Target**: Microsoft Solitaire Collection — Klondike mode (Windows 11 / web version)  
**Source file**: `games/klondike/index.html` (553 lines, self-contained)

---

## Gap Analysis: Current vs Microsoft Solitaire

| Feature | Current | Microsoft Solitaire | Priority |
|---|---|---|---|
| Auto-flip revealed cards | Manual click required | Automatic on card move | P0 |
| Draw mode | Draw 1 only | Draw 1 **and** Draw 3 (selectable) | P0 |
| Undo | None | Unlimited undo (button + Ctrl+Z) | P0 |
| Live timer | Hidden (shown at win only) | Visible clock counting up | P0 |
| Scoring | None | Standard score (Vegas optional) | P1 |
| Win animation | Static modal | Bouncing card cascade | P1 |
| Auto-complete | None | Button appears / auto-triggers | P1 |
| Card back designs | 1 (navy crosshatch) | Multiple selectable designs | P2 |
| Hints | None | Button highlights valid move | P2 |
| Sound effects | None | Card flip, placement, win jingle | P2 |
| Stock card count | Not shown | Count badge on stock pile | P2 |
| Right-click auto-move | None | Right-click sends card to foundation | P3 |
| Statistics tracking | None | Games played, won, win %, best time | P3 |
| Settings menu | None | Draw mode, scoring, deck back, sound | P3 |
| Empty pile visuals | Dashed border | Faint suit ghost on foundations, "K" silhouette on empty tableau | Polish |
| Waste pile fan (Draw 3) | N/A | Shows top 3 face-up cards fanned | P0 (if Draw 3) |
| Move animation | None | Smooth slide/fly to destination | Polish |

---

## Detailed Implementation Plan

### Phase 1 — Core Rules Corrections (P0)

#### 1.1 Auto-flip after card removal
**Current behavior**: Face-down cards at top of a tableau column show `cursor:pointer` and require a manual click to flip (`flipTop` called from `onclick`).  
**Target**: Whenever a card is moved away from a tableau column (drag-drop or double-click auto-move), if the new top card is face-down it flips automatically.

**Changes needed**:
- Remove `flip-hint` class and `onclick = () => flipTop(c)` from `renderTab` (lines 344–347).
- Create a helper `autoFlipCol(col)` that checks `G.tab[col]` — if non-empty and top card `f === false`, sets `f = true` and increments `G.moves` (or consider not counting flip-moves like MS does).
- Call `autoFlipCol(DR.col)` inside `removeFromSrc()` when `DR.src === 't'`.
- Call `autoFlipCol(col)` inside `autoMoveToFound` when `src === 't'`.
- Keep `flipTop` as an internal utility but remove it as a user-callable action.

```js
function autoFlipCol(col) {
  let cards = G.tab[col];
  if (cards.length > 0 && !cards[cards.length - 1].f) {
    cards[cards.length - 1].f = true;
    // MS does NOT count flip as a move in standard scoring
  }
}
```

---

#### 1.2 Draw 1 / Draw 3 mode
**Current behavior**: Always Draw 1. Stock click pops one card to waste.  
**Target**: Game starts with a mode selector. In Draw 3 mode, up to 3 cards are flipped per click and the waste shows the top 3 fanned (only the top-most is playable/draggable).

**Changes needed**:

**State**:
```js
G = { ..., drawMode: 1 }  // 1 or 3
```

**`drawStock` rewrite**:
```js
function drawStock() {
  if (G.won) return;
  if (G.stock.length === 0) {
    if (G.waste.length === 0) return;
    // recycle: in Draw 3, MS allows unlimited recycles
    G.stock = G.waste.slice().reverse().map(c => ({...c, f: false}));
    G.waste = [];
    G.moves++;
  } else {
    let n = Math.min(G.drawMode, G.stock.length);
    for (let i = 0; i < n; i++) {
      let c = G.stock.pop();
      c.f = true;
      G.waste.push(c);
    }
    G.moves++;
  }
  render();
}
```

**`renderWaste` for Draw 3** — show top 3 stacked with a horizontal fan (each offset ~18px to the right):
```js
function renderWaste() {
  let slot = document.getElementById('ws');
  slot.querySelectorAll('.card').forEach(e => e.remove());
  if (G.waste.length === 0) return;

  let show = G.drawMode === 3
    ? G.waste.slice(-3)   // last 3 (top 3)
    : [G.waste[G.waste.length - 1]];

  show.forEach((card, i) => {
    let el = makeCard(card);
    let isTop = (i === show.length - 1);
    // fan offset: each card 18px to the right in draw-3
    let offsetX = G.drawMode === 3 ? i * 18 : 0;
    el.style.cssText = `position:absolute;top:0;left:${offsetX}px;`;
    el.dataset.src = 'w';
    if (isTop) {
      el.addEventListener('mousedown', startDrag);
      el.addEventListener('touchstart', startDrag, {passive:false});
      el.ondblclick = () => autoMoveToFound('w', -1);
    }
    slot.appendChild(el);
  });
}
```

**Layout**: In Draw 3 mode the waste slot needs to be ~54px wider to accommodate the fan. Use a CSS class `#ws.draw3 { width: calc(var(--cw) + 36px); }` and toggle it based on mode.

**Mode selector UI**: Add a settings/gear button in `#bar` that opens a small panel (or show it on the New Game flow):
```html
<button id="settings-btn" onclick="toggleSettings()">⚙</button>
```
Settings panel (absolutely positioned below bar):
```html
<div id="settings-panel">
  <label>Draw mode</label>
  <div>
    <button onclick="setDraw(1)" id="d1btn" class="active">Draw 1</button>
    <button onclick="setDraw(3)" id="d3btn">Draw 3</button>
  </div>
</div>
```

---

#### 1.3 Undo (unlimited)
**Current behavior**: No undo.  
**Target**: Every user action is reversible via an Undo button or `Ctrl+Z`. MS allows unlimited undos.

**Changes needed**:

Add a history stack to state:
```js
let HISTORY = [];  // array of deep-copied G snapshots
```

Before any mutating action, push a snapshot:
```js
function saveSnapshot() {
  HISTORY.push(JSON.parse(JSON.stringify(G)));
}
```

Call `saveSnapshot()` at the top of: `drawStock`, `flipTop`, `autoMoveToFound`, `removeFromSrc` (before mutations in `drop`).

Undo function:
```js
function undo() {
  if (HISTORY.length === 0 || G.won) return;
  G = HISTORY.pop();
  render();
}
```

Wire up in HTML:
```html
<button id="undo-btn" onclick="undo()" title="Undo (Ctrl+Z)">↩ Undo</button>
```

Keyboard handler:
```js
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});
```

**MS scoring interaction**: In Standard scoring, undoing a move to foundation costs -15 points (same as manually moving it back). In the undo implementation above, restoring the old snapshot naturally reverts the score too, so no special penalty logic is needed.

---

#### 1.4 Live Timer
**Current behavior**: `G.t0 = Date.now()` captured at deal time; elapsed shown only in win dialog.  
**Target**: A `MM:SS` clock visible in the top bar that counts up during gameplay and stops on win.

**Changes needed**:

Add a `<span id="timer-stat">0:00</span>` to `#bar` (next to `#moves-stat`).

Add a `timerInterval` variable:
```js
let timerInterval = null;

function startTimer() {
  clearInterval(timerInterval);
  G.t0 = Date.now();
  timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimer() {
  if (G.won) { stopTimer(); return; }
  let s = Math.floor((Date.now() - G.t0) / 1000);
  let m = Math.floor(s / 60);
  document.getElementById('timer-stat').textContent =
    m + ':' + String(s % 60).padStart(2, '0');
}
```

Call `startTimer()` at end of `deal()` and `stopTimer()` in `checkWin()`.

---

### Phase 2 — Scoring & Win Experience (P1)

#### 2.1 Standard Scoring
Microsoft's "Standard" scoring rules:

| Action | Points |
|---|---|
| Waste → Tableau | +5 |
| Waste → Foundation | +10 |
| Tableau → Foundation | +10 |
| Flip tableau card | +5 |
| Foundation → Tableau (undo move) | -15 |
| Every 10 seconds elapsed (optional time penalty) | -2 |

Add `G.score = 0` to state and a `<span id="score-stat">Score: 0</span>` in the bar.

Wire `awardPoints(n)` calls into each action (in `drop`, `autoMoveToFound`, `autoFlipCol`).

```js
function awardPoints(n) {
  G.score = Math.max(0, G.score + n);
  document.getElementById('score-stat').textContent = 'Score: ' + G.score;
}
```

---

#### 2.2 Win Animation — Bouncing Card Cascade
**Current behavior**: Static "You Won! 🎉" modal.  
**Target**: The classic Windows Solitaire card bounce — each suit in sequence launches cards from the foundation piles; they bounce off the bottom of the screen and fly around.

**Implementation approach** — use CSS keyframe + JS:

```js
function triggerWinAnimation() {
  let overlay = document.getElementById('win-anim');
  overlay.style.display = 'block';

  // Spawn cards every 50ms from each foundation
  let delay = 0;
  for (let i = 0; i < 52; i++) {
    setTimeout(() => launchWinCard(i), delay);
    delay += 50;
  }

  // Show the win modal after 2 seconds
  setTimeout(() => document.getElementById('win').classList.add('on'), 2000);
}

function launchWinCard(index) {
  let el = document.createElement('div');
  el.className = 'win-card';
  // Random starting X from one of the 4 foundation slots
  let startX = 350 + (index % 4) * 82;  // approximate foundation X positions
  let vx = (Math.random() - 0.5) * 8;   // horizontal velocity
  let vy = -(Math.random() * 12 + 8);    // upward velocity
  let x = startX, y = 60;               // start at top (foundations)
  let gravity = 0.5;

  let suit = index % 4;
  let rank = Math.floor(index / 4) + 1;
  el.innerHTML = makeCard({s: suit, r: rank, f: true}).outerHTML;
  el.style.cssText = `position:fixed;z-index:10000;left:${x}px;top:${y}px;
    width:var(--cw);height:var(--ch);pointer-events:none;`;
  document.body.appendChild(el);

  function tick() {
    x += vx; y += vy; vy += gravity;
    if (y + CH() > window.innerHeight) {
      y = window.innerHeight - CH();
      vy = -Math.abs(vy) * 0.8;   // bounce with energy loss
    }
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    if (y < window.innerHeight + 200)  // still on screen (or near)
      requestAnimationFrame(tick);
    else
      el.remove();
  }
  requestAnimationFrame(tick);
}
```

Add `<div id="win-anim" style="display:none;position:fixed;inset:0;z-index:9998;pointer-events:none;"></div>` to the HTML.

---

#### 2.3 Auto-Complete
**Current behavior**: Player must manually move every card to the foundations.  
**Target**: When all tableau cards are face-up and stock/waste are empty (i.e., the game is mechanically won), an "Auto-complete" button appears. Clicking it animates cards flying to foundations one per 80ms.

**Detection logic**:
```js
function canAutoComplete() {
  if (G.stock.length > 0 || G.waste.length > 0) return false;
  return G.tab.every(col => col.every(card => card.f));
}
```

In `render()`, after drawing the tableau:
```js
let acBtn = document.getElementById('autocomplete-btn');
acBtn.style.display = canAutoComplete() && !G.won ? 'block' : 'none';
```

Auto-complete function:
```js
function autoComplete() {
  if (!canAutoComplete()) return;
  function step() {
    // Find any tableau card that can go to foundation, move it
    for (let c = 0; c < 7; c++) {
      let col = G.tab[c];
      if (col.length === 0) continue;
      let card = col[col.length - 1];
      if (canGoFound(card)) {
        col.pop();
        G.found[card.s].push(card);
        G.moves++;
        render();
        checkWin();
        if (!G.won) setTimeout(step, 80);
        return;
      }
    }
    // Also check waste
    if (G.waste.length > 0) {
      let card = G.waste[G.waste.length - 1];
      if (canGoFound(card)) {
        G.waste.pop();
        G.found[card.s].push(card);
        G.moves++;
        render();
        checkWin();
        if (!G.won) setTimeout(step, 80);
      }
    }
  }
  step();
}
```

Add button HTML:
```html
<button id="autocomplete-btn" onclick="autoComplete()" style="display:none">
  Auto-Complete
</button>
```

---

### Phase 3 — Visual Polish & Secondary Features (P2)

#### 3.1 Empty Pile Visual Improvements
**Current**: Dashed white border with emoji/arrow text hints.  
**Target**: Foundation slots show a large, faint, centered suit symbol (♠♥♦♣); empty tableau columns show a large, faint "K" silhouette.

Changes to `renderFound`:
- Foundation empty slots already show `.slot-hint` with the suit symbol — increase size to ~36px, opacity to 0.4, and use a proper card-table green that contrasts with `#1b4d30`.

Changes to `renderTab`:
- When `cards.length === 0`, add an inner div: `<div class="slot-k-hint">K</div>` styled with large faint text.

CSS additions:
```css
.slot-k-hint {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 36px; font-weight: 900;
  color: rgba(255,255,255,0.15);
  pointer-events: none;
}
.slot-hint { font-size: 30px; opacity: 0.35; }
```

---

#### 3.2 Card Back Designs
**Current**: Single navy crosshatch pattern.  
**Target**: At least 4 selectable back designs (like MS Solitaire's built-in collection).

Implement as CSS classes on a `#back-style` selector:

```css
.card.down.back-1 { /* current navy crosshatch */ }
.card.down.back-2 { background: #8B0000; /* deep red with diamond grid */ }
.card.down.back-3 { background: #006400; /* dark green with pattern */ }
.card.down.back-4 { background: #4B0082; /* indigo */ }
```

Store `G.backStyle = 'back-1'` in state (or localStorage for persistence), and apply it as an additional class in `makeCard` when `!card.f`.

Add a card-back picker to the settings panel (4 small previews of each back).

---

#### 3.3 Hints
**Target**: Press `H` or click Hint button to highlight one valid move by briefly adding a pulsing `.hint-glow` CSS animation to the source card.

**Logic** — find a valid move:
```js
function showHint() {
  // Priority: 1) waste/tab → foundation, 2) tab → tab, 3) draw stock
  let hint = findHintMove();
  if (!hint) {
    flashMessage('No moves available');
    return;
  }
  // Highlight source element
  let el = document.querySelector(`[data-src="${hint.src}"][data-c="${hint.col}"][data-i="${hint.i}"]`);
  if (el) {
    el.classList.add('hint-glow');
    setTimeout(() => el.classList.remove('hint-glow'), 1500);
  }
}
```

```css
@keyframes hint-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 220, 0, 0.8); }
  50%       { box-shadow: 0 0 0 8px rgba(255, 220, 0, 0); }
}
.hint-glow { animation: hint-pulse 0.6s ease 2; }
```

Wire to keyboard:
```js
document.addEventListener('keydown', e => {
  if (e.key === 'h' || e.key === 'H') showHint();
});
```

---

#### 3.4 Stock Card Count Badge
**Current**: No indication of how many cards remain in stock.  
**Target**: Small badge below/on the stock pile showing the count (e.g., "24").

```html
<div class="slot" id="ss" onclick="drawStock()">
  <div class="slot-hint" id="sh">🂠</div>
  <div id="stock-count"></div>
</div>
```

```css
#stock-count {
  position: absolute; bottom: 4px; right: 4px;
  font-size: 10px; font-weight: 700;
  color: rgba(255,255,255,0.7);
  pointer-events: none;
}
```

In `renderStock`, add:
```js
document.getElementById('stock-count').textContent =
  G.stock.length > 0 ? G.stock.length : '';
```

---

### Phase 4 — Extended Features (P3)

#### 4.1 Right-Click / Context-Menu to Auto-Move
**Target**: Right-clicking a face-up card at the top of a tableau column (or the waste top) automatically sends it to the foundation if legal.

```js
// In renderWaste, add to the waste top card element:
el.addEventListener('contextmenu', e => {
  e.preventDefault();
  autoMoveToFound('w', -1);
});

// In renderTab, add to each face-up top card:
el.addEventListener('contextmenu', e => {
  e.preventDefault();
  autoMoveToFound('t', c);
});
```

---

#### 4.2 Game Statistics
**Target**: Persistent stats: games played, games won, win percentage, best time, best score, current win streak.

Storage:
```js
function loadStats() {
  return JSON.parse(localStorage.getItem('klondike_stats') || '{}') || {
    played: 0, won: 0, bestTime: null, bestScore: 0, streak: 0
  };
}
function saveStats(stats) {
  localStorage.setItem('klondike_stats', JSON.stringify(stats));
}
```

Update in `newGame()` (increment `played`) and `checkWin()` (increment `won`, update `bestTime`, update `streak`).

Add a Stats button in `#bar` that opens a modal showing these numbers.

---

#### 4.3 Full Settings Panel
Combine all configurable options into one panel:

```
[ Settings ]
  Draw Mode:    [Draw 1]  [Draw 3]
  Scoring:      [Standard]  [Vegas]  [None]
  Card Back:    [■] [■] [■] [■]
  Sounds:       [On]  [Off]
  Animation:    [On]  [Off]
  [Close]  [New Game]
```

Settings persisted to `localStorage.setItem('klondike_settings', JSON.stringify(settings))`.

---

### Phase 5 — Animations (Polish)

#### 5.1 Card Move Animation
Rather than instant re-render, animate cards sliding from their source position to their destination using the FLIP technique (First, Last, Invert, Play):

1. Before mutating state: record the `getBoundingClientRect()` of all moving cards (First position).
2. Mutate state and re-render normally (DOM is now at Last position).
3. Compute the delta (Invert): subtract Last from First.
4. Apply `transform: translate(dx, dy)` instantly (zero-duration).
5. Trigger a CSS transition to `transform: translate(0,0)` (Play).

```js
const ANIM_DURATION = 150; // ms

function animateMove(cardEls, fromRects, toRects) {
  cardEls.forEach((el, i) => {
    let dx = fromRects[i].left - toRects[i].left;
    let dy = fromRects[i].top  - toRects[i].top;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = `transform ${ANIM_DURATION}ms ease`;
      el.style.transform = '';
    });
  });
}
```

#### 5.2 Deal Animation
On `newGame()`, deal cards one by one with a staggered `setTimeout`:
- All cards start stacked at the stock position (top-left area).
- Each card animates to its tableau position with a delay of `i * 30ms`.

#### 5.3 Card Flip Animation
When a face-down card auto-flips, animate a 3D Y-axis rotation:
```css
.card.flipping {
  animation: card-flip 0.3s ease forwards;
}
@keyframes card-flip {
  0%   { transform: rotateY(0deg); }
  50%  { transform: rotateY(90deg); }
  51%  { transform: rotateY(90deg); }  /* swap face content here */
  100% { transform: rotateY(0deg); }
}
```

---

## Implementation Order

```
Phase 1 (P0) — ~200 lines added/changed
  1.1  Auto-flip on card removal         (remove manual flip, add autoFlipCol)
  1.2  Draw 3 mode + waste fan           (drawStock + renderWaste + settings toggle)
  1.3  Unlimited undo                    (HISTORY stack + button + Ctrl+Z)
  1.4  Live timer                        (setInterval in bar)

Phase 2 (P1) — ~150 lines
  2.1  Standard scoring system           (awardPoints in each action)
  2.2  Win bounce animation              (launchWinCard physics loop)
  2.3  Auto-complete                     (detection + step timer)

Phase 3 (P2) — ~100 lines
  3.1  Empty pile visuals                (CSS + slot-k-hint divs)
  3.2  Card back designs                 (CSS classes + localStorage)
  3.3  Hints                             (findHintMove + hint-glow CSS)
  3.4  Stock card count badge            (stock-count span)

Phase 4 (P3) — ~100 lines
  4.1  Right-click auto-move             (contextmenu listeners)
  4.2  Game statistics                   (localStorage stats + modal)
  4.3  Full settings panel               (settings UI + persistence)

Phase 5 (Polish) — ~120 lines
  5.1  FLIP card move animation
  5.2  Deal animation
  5.3  Card flip animation
```

**Estimated total additions**: ~670 lines, bringing the file from 553 → ~1220 lines.

---

## Key Non-Obvious Details from Microsoft Solitaire

1. **Draw 3 recycle penalty**: MS allows unlimited recycles in Draw 3 but in "Vegas mode" charges $52 per new game. In Standard mode, recycling is free.

2. **Scoring on undo**: MS penalizes undo in Standard scoring by reversing the points awarded (move to foundation gives +10, undoing that costs -10, NOT -15). The -15 penalty only applies to manually dragging a card from foundation back to tableau.

3. **Auto-complete threshold**: Auto-complete becomes available when all 52 cards are face-up anywhere on the board (stock empty, waste empty, all tableau cards visible). Not just "mathematically winnable" — all cards must already be revealed.

4. **Waste in Draw 3**: Only the top card of the waste is draggable. The fanned display is purely decorative — the other 2 visible cards are not interactive.

5. **Draw 3 recycle**: In Draw 3, when stock is exhausted the entire waste is turned face-down back into the stock (in reverse order). The cards are NOT re-fanned immediately — they only show up as you draw again.

6. **Timer behavior**: MS timer starts on first action (first click/drag), not immediately on deal. Timer is paused when the settings panel is open.

7. **Move counting**: MS does not count automatic card flips as moves in the displayed counter. Only deliberate player actions (draw, drag, double-click) count.

8. **Foundation drag**: MS allows dragging cards FROM the foundation back to the tableau (with the -15 score penalty). The current implementation doesn't support this at all — add it by making foundation cards draggable with `data-src="f"` and `data-s=suitIndex`.

9. **Win detection timing**: MS checks for win after every card placement. The win screen only shows after the bounce animation completes (not immediately).

10. **Hint algorithm priority**: MS hints prioritize (in order): Ace/2 to foundation → top waste to foundation → turn over face-down card → move to foundation → King to empty column → other tableau moves. Never hints "draw from stock" as first priority.
