"""Backtracking autofill: MRV slot ordering, bitset domains, forward checking,
randomized restarts. Existing letters are never changed.

`required` is a list of groups of alternative words, e.g. [('JWANA',), ('ALJAR', 'HAMOOD')].
Every group must be satisfied by exactly one of its words appearing in the grid;
the unused alternatives are kept out. Required words are placed first, picking the
group with the fewest viable slots, so crowded must-include lists still fill."""
import random, time
from .words import Lexicon


HARD_LETTERS = set('JWFHGKMYZXQV')


def hardness(w):
    return sum(ch in HARD_LETTERS for ch in w)


class Result:
    def __init__(self):
        self.ok = False
        self.grid = None      # list[list[str]] of best state
        self.depth = 0        # most slots assigned in any attempt
        self.stuck = []       # slot ids that hit a dead end most often
        self.unplaced = []    # required groups missing from the best attempt
        self.nodes = 0
        self.restarts = 0
        self.seconds = 0.0


def autofill(p, lex_args, timeout=60, branch=30, jitter=8, seed=1, restart_nodes=4000,
             required=(), on_progress=None):
    """Try to complete p's grid. Returns Result; p is untouched (caller applies res.grid)."""
    t0 = time.time()
    res = Result()
    slots = p.slots()
    n = len(slots)
    required = [tuple(g) for g in required]
    by_len = {}
    for i, s in enumerate(slots):
        by_len.setdefault(len(s), []).append(i)
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
        index = {}

        def bit(w):
            L = len(w)
            if L not in index:
                index[L] = {x: j for j, x in enumerate(lex.words(L))}
            return index[L].get(w)

        g = [row[:] for row in p.g]
        dom, used, done = [], set(), [False] * n
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
        sat = [any(w in used for w in grp) for grp in required]
        for gi, grp in enumerate(required):          # pre-placed alternative blocks the others
            if sat[gi]:
                used.update(grp)
        for grp in required:
            for w in grp:
                if bit(w) is None and w not in used:
                    print(f'note: {w} is not in the word list at this --min-score')
        if bad:
            res.grid, res.stuck = g, sorted(fails, key=fails.get, reverse=True)[:5]
            res.seconds = time.time() - t0
            return res
        pre_done = sum(done)
        nodes = [0]
        hard_at = []          # centers of placed hard required words, to keep new ones far away

        def center(i):
            cs = slots[i].cells
            return (sum(r for r, _ in cs) / len(cs), sum(c for _, c in cs) / len(cs))

        def far(i):
            if not hard_at:
                return 0.0
            ci = center(i)
            return min(abs(ci[0] - r) + abs(ci[1] - c) for r, c in hard_at)

        def options(grp):
            out = []
            for w in grp:
                if w in used:
                    continue
                b = bit(w)
                if b is None:
                    continue
                for i in by_len.get(len(w), ()):
                    if not done[i] and (dom[i] >> b) & 1:
                        out.append((i, w))
            return out

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
                res.unplaced = [grp for gi, grp in enumerate(required) if not sat[gi]]
            if time.time() - t0 > timeout or nodes[0] > restart_nodes:
                return False
            pend = [gi for gi in range(len(required)) if not sat[gi]]
            gsel = None
            if pend:
                best = None
                for gi in pend:
                    opts = options(required[gi])
                    if not opts:
                        return False
                    if best is None or len(opts) < len(best[1]):
                        best = (gi, opts)
                gsel, opts = best
                rng.shuffle(opts)
                if hard_at:    # hard words (J, W, F, ...) go far from ones already placed
                    opts.sort(key=lambda o: -(far(o[0]) if hardness(o[1]) >= 2 else 0) + rng.random() * 3)
                opts = opts[:branch]
            else:
                i = choose()
                if i < 0:
                    return True
                opts = [(i, w) for w in candidates(i)]
            for i, w in opts:
                s = slots[i]
                nodes[0] += 1
                saved = dom[:]
                changed, ok = [], True
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
                    added = [x for x in ((w,) if gsel is None else required[gsel]) if x not in used]
                    used.update(added)
                    pushed = gsel is not None and hardness(w) >= 2
                    if pushed:
                        hard_at.append(center(i))
                    flipped = []
                    for gi, grp in enumerate(required):   # a plain slot choice may satisfy a group
                        if not sat[gi] and w in grp:
                            sat[gi] = True; flipped.append(gi)
                            for x in grp:
                                if x not in used:
                                    used.add(x); added.append(x)
                    if gsel is not None and not sat[gsel]:
                        sat[gsel] = True; flipped.append(gsel)
                    if solve(depth + 1):
                        return True
                    for x in added:
                        used.discard(x)
                    if pushed:
                        hard_at.pop()
                    for gi in flipped:
                        sat[gi] = False
                    done[i] = False
                for r, c in changed:
                    g[r][c] = '.'
                dom[:] = saved
                if nodes[0] > restart_nodes or time.time() - t0 > timeout:
                    return False
            return False

        ok = solve(pre_done)
        res.nodes += nodes[0]
        res.restarts = attempt
        if on_progress:
            on_progress(attempt, best_depth, n - pre_done, time.time() - t0)
        if ok:
            res.ok, res.grid, res.unplaced = True, [row[:] for row in g], []
            break
        restart_nodes = int(restart_nodes * 1.15)
    res.stuck = sorted(fails, key=fails.get, reverse=True)[:6]
    res.seconds = time.time() - t0
    return res
