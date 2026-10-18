"""Backtracking autofill: MRV slot ordering, bitset domains, forward checking,
randomized restarts. Existing letters are never changed."""
import random, time
from .words import Lexicon


class Result:
    def __init__(self):
        self.ok = False
        self.grid = None      # list[list[str]] of best state
        self.depth = 0        # most slots assigned in any attempt
        self.stuck = []       # slot ids that hit a dead end most often
        self.nodes = 0
        self.restarts = 0
        self.seconds = 0.0


def autofill(p, lex_args, timeout=60, branch=30, jitter=8, seed=1, restart_nodes=4000, on_progress=None):
    """Try to complete p's grid. Returns Result; p is untouched (caller applies res.grid)."""
    t0 = time.time()
    res = Result()
    slots = p.slots()
    n = len(slots)
    cell_slots = {}
    for i, s in enumerate(slots):
        for k, rc in enumerate(s.cells):
            cell_slots.setdefault(rc, []).append((i, k))
    fails = {}
    best_depth = -1
    attempt = 0
    while time.time() - t0 < timeout:
        attempt += 1
        lex = Lexicon(seed=seed + attempt, **lex_args)
        rng = random.Random(seed * 7919 + attempt)
        g = [row[:] for row in p.g]
        dom = []
        used = set()
        done = [False] * n
        bad = False
        for i, s in enumerate(slots):
            m = lex.full(len(s))
            for k, (r, c) in enumerate(s.cells):
                if g[r][c] != '.':
                    m &= lex.letter_mask(len(s), k, g[r][c])
            dom.append(m)
            w = ''.join(g[r][c] for r, c in s.cells)
            if '.' not in w:
                done[i] = True
                if w in used:
                    bad = True
                used.add(w)
            elif m == 0:
                bad = True
                fails[s.id] = fails.get(s.id, 0) + 1
        if bad:
            res.grid, res.stuck = g, sorted(fails, key=fails.get, reverse=True)[:5]
            res.seconds = time.time() - t0
            return res  # the grid as given can't be completed (dead slot / duplicate)
        pre_done = sum(done)
        nodes = [0]

        def choose():
            bi, bc = -1, 1 << 60
            for i in range(n):
                if not done[i]:
                    c = dom[i].bit_count()
                    if c < bc:
                        bi, bc = i, c
                        if c <= 1:
                            break
            return bi

        def candidates(i):
            ws = lex.words(len(slots[i]))
            m, out = dom[i], []
            while m and len(out) < branch:
                low = m & -m
                w = ws[low.bit_length() - 1]
                m ^= low
                if w not in used:
                    out.append(w)
            if jitter and len(out) > 1:
                out.sort(key=lambda w: -(lex.score(w) + rng.random() * jitter))
            return out

        def solve(depth):
            nonlocal best_depth
            if depth - pre_done > best_depth:
                best_depth = depth - pre_done
                res.grid = [row[:] for row in g]
                res.depth = best_depth
            i = choose()
            if i < 0:
                return True
            if time.time() - t0 > timeout or nodes[0] > restart_nodes:
                return False
            s = slots[i]
            L = len(s)
            for w in candidates(i):
                nodes[0] += 1
                saved_dom = dom[:]
                changed = []
                ok = True
                for k, (r, c) in enumerate(s.cells):
                    if g[r][c] == '.':
                        g[r][c] = w[k]
                        changed.append((r, c))
                        for j, kk in cell_slots[(r, c)]:
                            if j != i and not done[j]:
                                dom[j] &= lex.letter_mask(len(slots[j]), kk, w[k])
                                if dom[j] == 0:
                                    ok = False
                                    fails[slots[j].id] = fails.get(slots[j].id, 0) + 1
                                    break
                        if not ok:
                            break
                if ok:
                    done[i] = True
                    used.add(w)
                    if solve(depth + 1):
                        return True
                    used.discard(w)
                    done[i] = False
                for r, c in changed:
                    g[r][c] = '.'
                dom[:] = saved_dom
                if nodes[0] > restart_nodes or time.time() - t0 > timeout:
                    return False
            return False

        ok = solve(pre_done)
        res.nodes += nodes[0]
        res.restarts = attempt
        if on_progress:
            on_progress(attempt, best_depth, n - pre_done, time.time() - t0)
        if ok:
            res.ok, res.grid = True, [row[:] for row in g]
            break
        restart_nodes = int(restart_nodes * 1.15)
    res.stuck = sorted(fails, key=fails.get, reverse=True)[:6]
    res.seconds = time.time() - t0
    return res
