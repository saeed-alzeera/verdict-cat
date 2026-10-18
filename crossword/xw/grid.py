"""Puzzle model: grid, slots, numbering, NYT-rule validation, ASCII rendering.

Grid rows are strings: '#' black square, '.' empty white, 'A'-'Z' letter.
Clues are keyed by the entry's start cell ("A3,0" = across starting row 3,
col 0) so they survive renumbering when black squares move.
"""
import json, os
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUZZLES = os.path.join(ROOT, 'puzzles')


class Slot:
    __slots__ = ('num', 'dir', 'cells', 'id')

    def __init__(self, num, d, cells):
        self.num, self.dir, self.cells = num, d, cells
        self.id = f'{num}{d}'

    @property
    def start(self):
        return self.cells[0]

    @property
    def key(self):  # stable clue key
        return f'{self.dir}{self.start[0]},{self.start[1]}'

    def __len__(self):
        return len(self.cells)


class Puzzle:
    def __init__(self, data):
        self.data = data
        self.size = data['size']
        self.g = [list(r) for r in data['grid']]

    # ---- io
    @staticmethod
    def path(name):
        if name.endswith('.json') or os.sep in name:
            return name
        return os.path.join(PUZZLES, name + '.json')

    @classmethod
    def load(cls, name):
        with open(cls.path(name), encoding='utf8') as f:
            p = cls(json.load(f))
        p.name = name
        return p

    @classmethod
    def new(cls, size=15, title='Untitled', author=''):
        return cls({'title': title, 'author': author, 'date': '', 'size': size,
                    'grid': ['.' * size] * size, 'clues': {}, 'theme': [], 'notes': ''})

    def save(self, name=None):
        name = name or self.name
        self.data['grid'] = [''.join(r) for r in self.g]
        self.data['size'] = self.size
        with open(self.path(name), 'w', encoding='utf8') as f:
            json.dump(self.data, f, indent=1, ensure_ascii=False)
            f.write('\n')

    # ---- cells
    def inb(self, r, c):
        return 0 <= r < self.size and 0 <= c < self.size

    def mirror(self, r, c):
        return self.size - 1 - r, self.size - 1 - c

    def black(self, r, c):
        return self.g[r][c] == '#'

    def blacks(self):
        return [(r, c) for r in range(self.size) for c in range(self.size) if self.g[r][c] == '#']

    # ---- slots
    def slots(self):
        n, g = self.size, self.g
        out, num = [], 0
        for r in range(n):
            for c in range(n):
                if g[r][c] == '#':
                    continue
                sa = (c == 0 or g[r][c - 1] == '#') and c + 1 < n and g[r][c + 1] != '#'
                sd = (r == 0 or g[r - 1][c] == '#') and r + 1 < n and g[r + 1][c] != '#'
                if not (sa or sd):
                    continue
                num += 1
                if sa:
                    cc = c
                    cells = []
                    while cc < n and g[r][cc] != '#':
                        cells.append((r, cc)); cc += 1
                    out.append(Slot(num, 'A', cells))
                if sd:
                    rr = r
                    cells = []
                    while rr < n and g[rr][c] != '#':
                        cells.append((rr, c)); rr += 1
                    out.append(Slot(num, 'D', cells))
        return out

    def slot(self, ident):
        ident = ident.upper()
        for s in self.slots():
            if s.id == ident:
                return s
        raise KeyError(f'no entry {ident} (numbering changes when black squares move)')

    def pattern(self, s):
        return ''.join(self.g[r][c] if self.g[r][c] != '.' else '?' for r, c in s.cells)

    def word(self, s):
        p = self.pattern(s)
        return p if '?' not in p else None

    # ---- editing
    def set_black(self, r, c, on=True, sym=True):
        pts = [(r, c)] + ([self.mirror(r, c)] if sym else [])
        for pr, pc in pts:
            if on and self.g[pr][pc] not in '#.':
                raise ValueError(f'({pr},{pc}) holds {self.g[pr][pc]}; clear it first')
        for pr, pc in pts:
            self.g[pr][pc] = '#' if on else '.'

    def put(self, s, word):
        word = word.upper()
        if len(word) != len(s):
            raise ValueError(f'{s.id} has {len(s)} squares, {word} has {len(word)}')
        for (r, c), ch in zip(s.cells, word):
            if self.g[r][c] not in ('.', ch):
                raise ValueError(f'{s.id}: {word} conflicts with {self.g[r][c]} at ({r},{c})')
        for (r, c), ch in zip(s.cells, word):
            self.g[r][c] = ch

    def clear_entry(self, s, keep_crossed=True):
        """Blank an entry. Letters shared with a fully-filled crossing entry are kept."""
        crossed = set()
        if keep_crossed:
            for o in self.slots():
                if o.dir != s.dir and self.word(o) and set(o.cells) & set(s.cells):
                    crossed |= set(o.cells)
        for r, c in s.cells:
            if (r, c) not in crossed:
                self.g[r][c] = '.'

    # ---- rules
    def check(self, daily=True):
        """Returns (errors, warnings, stats) against NYT construction norms."""
        n, g = self.size, self.g
        errs, warns = [], []
        for r in range(n):
            for c in range(n):
                mr, mc = self.mirror(r, c)
                if (g[r][c] == '#') != (g[mr][mc] == '#'):
                    errs.append(f'asymmetric: ({r},{c}) vs ({mr},{mc})')
                    break
            else:
                continue
            break
        # runs shorter than 3, in both directions
        for d in 'AD':
            for i in range(n):
                run = []
                for j in range(n + 1):
                    r, c = (i, j) if d == 'A' else (j, i)
                    if j < n and g[r][c] != '#':
                        run.append((r, c))
                    else:
                        if 0 < len(run) < 3:
                            errs.append(f'entry under 3 letters at {run[0]} ({"across" if d == "A" else "down"}, {len(run)})')
                        run = []
        white = [(r, c) for r in range(n) for c in range(n) if g[r][c] != '#']
        if white:
            seen, q = {white[0]}, deque([white[0]])
            while q:
                r, c = q.popleft()
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    p = (r + dr, c + dc)
                    if self.inb(*p) and g[p[0]][p[1]] != '#' and p not in seen:
                        seen.add(p); q.append(p)
            if len(seen) != len(white):
                errs.append(f'grid is not connected ({len(white) - len(seen)} squares cut off)')
        sl = self.slots()
        nb = len(self.blacks())
        lim_w = 78 if n <= 15 else 140
        lim_b = 42 if n <= 15 else 80
        if n <= 15 and len(sl) > lim_w:
            warns.append(f'{len(sl)} entries (NYT daily max {lim_w})')
        if nb > lim_b:
            warns.append(f'{nb} black squares (NYT guideline ~{lim_b} max)')
        for r in range(n - 1):
            for c in range(n - 1):
                if all(g[r + a][c + b] == '#' for a in (0, 1) for b in (0, 1)):
                    warns.append(f'2x2 black block at ({r},{c})')
        words = {}
        for s in sl:
            w = self.word(s)
            if w:
                words.setdefault(w, []).append(s.id)
        for w, ids in words.items():
            if len(ids) > 1:
                errs.append(f'duplicate entry {w}: {", ".join(ids)}')
        by_len = {}
        for s in sl:
            by_len[len(s)] = by_len.get(len(s), 0) + 1
        stats = {'size': n, 'entries': len(sl), 'blacks': nb, 'by_len': dict(sorted(by_len.items())),
                 'filled': sum(1 for r in g for ch in r if ch not in '#.'),
                 'white': len(white)}
        return errs, warns, stats

    # ---- display
    def render(self, mark=None, coords=True):
        n = self.size
        nums = {s.start: s.num for s in self.slots() if s.dir == 'A' or s.dir == 'D'}
        lines = []
        if coords:
            lines.append('    ' + ''.join(f'{c:<3d}' for c in range(n)))
        for r in range(n):
            row = []
            for c in range(n):
                ch = self.g[r][c]
                cell = '██' if ch == '#' else (' ' + (ch if ch != '.' else '·'))
                if mark and (r, c) in mark and ch != '#':
                    cell = '[' + (ch if ch != '.' else '·') + ']'
                row.append(cell.ljust(3) if cell != '██' else '███')
            lines.append((f'{r:>2}  ' if coords else '') + ''.join(row))
        return '\n'.join(lines)

    def render_numbered(self):
        nums = {}
        for s in self.slots():
            nums[s.start] = s.num
        n = self.size
        out = []
        for r in range(n):
            top, mid = [], []
            for c in range(n):
                ch = self.g[r][c]
                if ch == '#':
                    top.append('█████'); mid.append('█████')
                else:
                    top.append(f'{nums.get((r, c), ""):<5}')
                    mid.append(f'  {ch if ch != "." else "·"}  ')
            out += [''.join(top), ''.join(mid)]
        return '\n'.join(out)
