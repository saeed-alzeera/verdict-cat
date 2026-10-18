"""Black-square pattern generator: random 180-degree-symmetric layouts that obey
NYT rules (every entry >= 3, all squares checked, connected), keeping any
letters already in the grid white."""
import random
from .grid import Puzzle


def _runs_ok(g, n, r, c):
    for line in ([g[r][j] for j in range(n)], [g[i][c] for i in range(n)]):
        run = 0
        for ch in line + ['#']:
            if ch == '#':
                if 0 < run < 3:
                    return False
                run = 0
            else:
                run += 1
    return True


def _connected(g, n):
    start = next(((r, c) for r in range(n) for c in range(n) if g[r][c] != '#'), None)
    total = sum(ch != '#' for row in g for ch in row)
    seen, st = {start}, [start]
    while st:
        r, c = st.pop()
        for q in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
            if 0 <= q[0] < n and 0 <= q[1] < n and g[q[0]][q[1]] != '#' and q not in seen:
                seen.add(q); st.append(q)
    return len(seen) == total


def _entries(g, n, threes=False):
    cnt = t = 0
    for r in range(n):
        for c in range(n):
            if g[r][c] == '#':
                continue
            if (c == 0 or g[r][c - 1] == '#') and c + 1 < n and g[r][c + 1] != '#':
                cnt += 1
                t += (c + 3 >= n or g[r][c + 3] == '#')
            if (r == 0 or g[r - 1][c] == '#') and r + 1 < n and g[r + 1][c] != '#':
                cnt += 1
                t += (r + 3 >= n or g[r + 3][c] == '#')
    return (cnt, t) if threes else cnt


def _asym(g, n):
    return sum(1 for r in range(n) for c in range(n)
               if (r, c) < (n - 1 - r, n - 1 - c) and (g[r][c] == '#') != (g[n - 1 - r][n - 1 - c] == '#'))


def _try_layout(p, rng, target_blacks, max_entries, sample=24, asym=0):
    """Greedy: repeatedly black the symmetric pair (best of a random sample) that adds the
    most entries without breaking a rule. With asym > 0, single unmirrored squares are
    also candidates while the unmatched-pair count stays within the allowance."""
    n = p.size
    g = [row[:] for row in p.g]
    nb = sum(ch == '#' for row in g for ch in row)
    cells = [(r, c) for r in range(n) for c in range(n) if g[r][c] == '.' and (r, c) <= (n - 1 - r, n - 1 - c)]
    while nb < target_blacks:
        rng.shuffle(cells)
        best, best_e = None, -1
        tried = 0
        for r, c in cells:
            if g[r][c] != '.':
                continue
            mr, mc = n - 1 - r, n - 1 - c
            singles = [(r, c)]
            if asym:
                singles = [(r, c), (mr, mc)] if rng.random() < 0.35 else []
            options = []
            if g[mr][mc] == '.':
                options.append(((r, c), (mr, mc)))
            if asym and g[mr][mc] == '.' and (r, c) != (mr, mc):
                options.extend([((x, y),) for x, y in singles if g[x][y] == '.'])
            for cellset in options:
                for x, y in cellset:
                    g[x][y] = '#'
                ok = all(_runs_ok(g, n, x, y) for x, y in cellset) and _connected(g, n) and _asym(g, n) <= asym
                e, t3 = _entries(g, n, True) if ok else (-1, 0)
                for x, y in cellset:
                    g[x][y] = '.'
                if ok and e <= max_entries:
                    tried += 1
                    v = e - 1.6 * t3 + rng.random() * 7
                    if v > best_e:
                        best, best_e = cellset, v
                    if tried >= sample:
                        break
            if tried >= sample:
                break
        if best is None:
            break
        for x, y in best:
            g[x][y] = '#'
        nb += len(best)
    return Puzzle({'size': n, 'grid': [''.join(row) for row in g], **{k: v for k, v in p.data.items() if k == 'allow_asym'}})


def score(q, want_entries=76, want=None):
    errs, warns, st = q.check()
    if errs:
        return None
    bl = st['by_len']
    long_ = sum(v for k, v in bl.items() if k >= 12)
    mid = sum(v for k, v in bl.items() if 5 <= k <= 9)
    s = 0.0
    s -= 1.5 * abs(st['entries'] - want_entries)
    s -= 2.0 * max(0, bl.get(3, 0) - 16)           # NYT dailies run ~10-16 threes
    s -= 3.0 * max(0, long_ - 4)                    # a few long slots are great, many are brutal
    s -= 0.7 * abs(long_ - 3) if long_ < 2 else 0
    s -= 4.0 * len([w for w in warns if '2x2' in w])
    for L, need in (want or {}).items():
        s -= 6.0 * max(0, need - bl.get(L, 0))   # must-include words need slots of their length
    s += 0.9 * sum(v for k, v in bl.items() if 6 <= k <= 10)   # variety: 6-10s feel like real fill
    s -= 0.6 * max(0, bl.get(4, 0) - 26)
    return s


def generate(p, tries=300, seed=1, blacks=(34, 42), min_entries=68, max_entries=78, want=None, asym=0):
    rng = random.Random(seed)
    seen, out = set(), []
    for _ in range(tries):
        target = rng.randint(*blacks)
        q = _try_layout(p, rng, target, max_entries, asym=asym)
        key = ''.join(''.join(r) for r in q.g)
        if key in seen:
            continue
        seen.add(key)
        sc = score(q, want=want)
        if sc is not None and len(q.blacks()) >= blacks[0] and len(q.slots()) >= min_entries:
            out.append((sc, q))
    out.sort(key=lambda t: -t[0])
    return out
