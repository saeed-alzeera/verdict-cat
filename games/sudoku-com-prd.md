# Product Requirements Document: Sudoku.com

**Product:** Sudoku.com (by Easybrain)
**Platforms:** Web (sudoku.com), iOS, Android
**Research Date:** July 2026

---

## Overview

Sudoku.com is a free-to-play online and mobile Sudoku platform developed by Easybrain. It is among the most downloaded puzzle apps globally, with 30M+ users. The product offers classic and variant Sudoku gameplay with engagement loops built around daily challenges, seasonal events, tournaments, and a trophy/achievement system.

---

## 1. Core Game Modes

### 1.1 Classic Sudoku
The standard 9×9 Sudoku grid. Fill every row, column, and 3×3 box with digits 1–9, each appearing exactly once.

**Difficulty Levels (6 tiers):**

| Level | Description |
|-------|-------------|
| Easy | More pre-filled cells; suitable for beginners |
| Medium | Requires basic solving techniques |
| Hard | Fewer givens; requires intermediate strategies |
| Expert | High difficulty; intended for experienced players |
| Master / Evil | Very high difficulty; advanced techniques required |
| Extreme | Maximum difficulty; fewest givens; for puzzle masters |

Each level has a dedicated URL (`/easy/`, `/medium/`, `/hard/`, `/expert/`, `/master/`, `/extreme/`) with an unlimited supply of generated puzzles.

### 1.2 Killer Sudoku
Combines classic Sudoku with arithmetic cage constraints. Cells are grouped into cages with a target sum; no digit may repeat within a cage.

**Difficulty Levels:** Easy, Medium, Hard, Expert

**Additional Features:** Daily Challenges specific to Killer, monthly rewards, seasonal events, hints.

### 1.3 Storybook Mode
A themed puzzle mode where completing puzzles progresses a narrative or visual story. Specific mechanics are surface-level (narrative wrapping around classic puzzle solving); distinct from competitive or daily modes.

### 1.4 Postcards Mode
A seasonal/collection mode in which solving puzzles rewards players with illustrated postcard collectibles. Tied to Seasonal Events to earn unique postcard rewards.

### 1.5 Sudoku Match *(Mobile)*
A real-time multiplayer variant where players compete head-to-head solving the same puzzle. Available as a separate Easybrain app (`com.easybrain.sudoku.match`).

---

## 2. Daily & Recurring Content

### 2.1 Daily Sudoku
- One fresh Classic puzzle per day, calibrated to a fixed difficulty rotation.
- URL: `/challenges/daily-sudoku`
- Archive access: players can navigate back to past daily puzzles by date.
- Completing daily puzzles increments the daily streak counter.

### 2.2 Puzzle Archive
- URL: `/challenges`
- Calendar UI for selecting any past date.
- Allows replay of missed daily puzzles.

### 2.3 Seasonal Events
- Time-limited thematic events tied to holidays or seasons.
- Completing event puzzles earns exclusive medals and postcard collectibles.
- Events appear in the Postcards section of the nav.

### 2.4 Tournaments
- URL: `/tournaments`
- Players compete by solving puzzles to accumulate points.
- Points determine leaderboard rank.
- Leaderboard positions award medals (Bronze, Silver, Gold tiers implied).
- Open to all registered users; no stated entry fee.

---

## 3. Gameplay Tools & Assistance

| Feature | Description |
|---------|-------------|
| **Hints** | Reveals a correct digit for the selected cell; limited supply (premium unlocks more). |
| **Auto-Check** | Toggle-on mode that immediately highlights incorrect entries in red after each move. |
| **Notes / Candidates** | Allows pencil-marking candidate digits into a cell. Notes auto-clear when a definitive digit is placed in the same row, column, or box. |
| **Highlight Duplicates** | Visually flags repeated digits in the same row, column, or 3×3 box to prevent errors. |
| **Undo / Redo** | Steps backward or forward through move history. |
| **Timer** | Elapsed time displayed per puzzle session; used for personal records and tournament scoring. |
| **Mistake Counter** | Tracks cumulative errors made during a session. |

---

## 4. Progression & Rewards

### 4.1 Statistics
- Per-difficulty tracking: puzzles solved, best time, average time.
- Streak tracking: current daily streak and longest streak.
- Accessible from a dedicated Stats screen.

### 4.2 Awards / Trophies
- URL: `/awards`
- Permanent trophy cabinet displaying all earned rewards.
- Sources: Daily Challenge completions, Seasonal Event participation, Tournaments.

### 4.3 Achievements
- Implicit milestone-based achievements tied to puzzle counts, streaks, and difficulty completions.

---

## 5. Learning & Reference

### 5.1 Rules / How to Play
- URL: `/sudoku-rules/` and `/how-to-play/sudoku-rules-for-complete-beginners/`
- Step-by-step beginner guide.
- Explanation of solving techniques (X-Wing, Swordfish, etc.) with dedicated sub-pages per technique.

### 5.2 Solving Techniques Index
Individual pages for advanced strategies:
- X-Wing (`/sudoku-rules/h-wing/`)
- Swordfish (`/sudoku-rules/swordfish/`)
- Additional techniques linked from the Rules hub.

### 5.3 Sudoku Solver Tool
- Interactive solver that accepts a partially-filled grid and produces a solution.
- Accessible from main navigation.

### 5.4 Tips Section
- Curated tips for improving solve times and technique.

---

## 6. Printable Puzzles

- URL: `/sudoku-printable`
- Generates printer-friendly PDF/HTML puzzle sheets.
- Available across multiple difficulty levels (Easy through Extreme/Evil).
- Free; no account required.

---

## 7. User Account & Settings

### 7.1 Account
- Optional registration/login to persist progress, streaks, and trophies across devices.
- Used as identity for leaderboard participation in Tournaments.

### 7.2 Settings
| Setting | Options |
|---------|---------|
| Color Theme | 3 built-in themes (light / dark / alternate) |
| Auto-Check | On / Off |
| Highlight Duplicates | On / Off |
| Note Auto-Clear | On / Off |
| Sound / Haptics | On / Off *(mobile)* |

---

## 8. Monetization

| Tier | Price | What's included |
|------|-------|----------------|
| Free | $0 | All puzzles, all modes; ad-supported; limited hints |
| Premium (monthly) | ~$4.99/mo | No ads; unlimited hints; possibly exclusive themes |
| Premium (one-time) | ~$14.99 | Lifetime ad-free and hint unlock |

Ads are interstitial and banner; shown between puzzles in the free tier.

---

## 9. Platform & Navigation

### 9.1 Navigation Structure (Web)

```
sudoku.com/
├── Classic Sudoku
│   ├── /easy/
│   ├── /medium/
│   ├── /hard/
│   ├── /expert/
│   ├── /master/ (Evil)
│   └── /extreme/
├── Killer Sudoku (/killer/)
│   ├── /killer/easy/
│   ├── /killer/medium/
│   ├── /killer/hard/
│   └── /killer/expert/
├── Storybook
├── Postcards
├── Tournament (/tournaments)
├── Daily Challenges (/challenges)
│   └── Daily Sudoku (/challenges/daily-sudoku)
├── Awards (/awards)
├── Rules (/sudoku-rules/)
├── Printable (/sudoku-printable)
├── Sudoku Solver
├── Tips
└── Settings
```

### 9.2 Platform Support
- **Web:** Responsive; full feature parity.
- **iOS:** Native app (`id1193508329`); App Store.
- **Android:** Native app (`com.easybrain.sudoku.android`); Google Play.
- **Tablet:** Portrait and landscape mode supported natively on mobile.

---

## 10. Key Metrics & Scale

- 30M+ registered users (as of Easybrain announcements).
- #1 Sudoku app by daily downloads on both App Store and Google Play (per Easybrain).
- 10,000+ puzzles in the Classic library.

---

## 11. Competitive Differentiators

| Feature | Sudoku.com | Typical Competitor |
|---------|-----------|-------------------|
| Puzzle volume | 10,000+ | 1,000–5,000 |
| Difficulty tiers | 6 (Classic), 4 (Killer) | 4–5 |
| Killer Sudoku variant | Yes | Rare on web |
| Tournaments w/ leaderboard | Yes | Uncommon |
| Auto-cleaning notes | Yes | Sometimes |
| Daily archive | Yes | Rare |
| Storybook / Postcards modes | Yes | Unique |

---

## Sources

- [Sudoku.com – Play Free Sudoku Online](https://sudoku.com/)
- [Killer Sudoku – sudoku.com](https://sudoku.com/killer)
- [Online Tournaments – sudoku.com](https://sudoku.com/tournaments)
- [Sudoku Awards – sudoku.com](https://sudoku.com/awards)
- [Daily Sudoku – sudoku.com](https://sudoku.com/challenges/daily-sudoku)
- [Printable Sudoku – sudoku.com](https://sudoku.com/sudoku-printable)
- [Sudoku.com on Google Play](https://play.google.com/store/apps/details?id=com.easybrain.sudoku.android)
- [Easybrain – Sudoku.com App](https://easybrain.com/sudoku)
- [LoveSudoku vs Sudoku.com Comparison 2026](https://lovesudoku.net/en/articles/lovesudoku-vs-sudokucom-featurebyfeature-mobile-comparison-review-2026/)
- [Best Sudoku Apps 2026 – SudokuPulse](https://sudokupulse.com/articles/best-sudoku-apps/)
