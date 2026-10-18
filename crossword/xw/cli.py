import argparse, glob, json, os, sys, time
from . import words as W
from .grid import Puzzle, PUZZLES, ROOT
from .fill import autofill
from .layout import generate


def parse_cell(s):
    r, c = s.replace(' ', '').split(',')
    return int(r), int(c)


def load(a):
    return Puzzle.load(a.puzzle)


def show(p, a=None):
    print(p.render())
    errs, warns, st = p.check()
    print(f'\n{st["entries"]} entries · {st["blacks"]} blacks · {st["filled"]}/{st["white"]} letters filled'
          + (f' · {len(errs)} errors' if errs else '') + (f' · {len(warns)} warnings' if warns else ''))


def lex_args(a):
    return {'min_score': a.min_score, 'themes': tuple(a.theme or ())}


# ---- commands
def c_setup(a):
    W.setup(update=a.update)
    W.build()
    print('themed dictionaries:', ', '.join(W.theme_names()))


def c_build(a):
    W.build()


def c_new(a):
    path = Puzzle.path(a.puzzle)
    if os.path.exists(path):
        raise SystemExit(f'{path} exists')
    p = Puzzle.new(a.size, a.title or a.puzzle, a.author or '')
    p.data['date'] = a.date or time.strftime('%Y-%m-%d')
    p.name = a.puzzle
    p.save()
    reindex()
    print(f'created {os.path.relpath(path, ROOT)}')


def c_show(a):
    p = load(a)
    if a.numbered:
        print(p.render_numbered())
    else:
        show(p)


def c_black(a):
    p = load(a)
    for cs in a.cells:
        r, c = parse_cell(cs)
        p.set_black(r, c, on=not a.undo, sym=not a.no_sym)
    p.save(); show(p)


def c_white(a):
    a.undo = True
    c_black(a)


def c_check(a):
    p = load(a)
    errs, warns, st = p.check()
    show(p)
    print(f'\nlength mix: ' + ', '.join(f'{k}:{v}' for k, v in st['by_len'].items()))
    for e in errs:
        print('  ERROR  ', e)
    for w in warns:
        print('  warn   ', w)
    if not errs:
        print('  ok: symmetric, connected, every entry >= 3')
    return 1 if errs else 0


def c_put(a):
    p = load(a)
    p.put(p.slot(a.slot), a.word)
    p.save(); show(p)


def c_clear(a):
    p = load(a)
    if a.slot == 'all':
        p.g = [['#' if ch == '#' else '.' for ch in r] for r in p.g]
    else:
        for sid in a.slot.split(','):
            p.clear_entry(p.slot(sid))
    p.save(); show(p)


def c_theme(a):
    """Place a theme entry anywhere: caps both ends in black, mirrors the caps."""
    p = load(a)
    r, c = parse_cell(a.at)
    w = W.norm(a.word)
    dr, dc = (0, 1) if a.dir.upper().startswith('A') else (1, 0)
    cells = [(r + dr * i, c + dc * i) for i in range(len(w))]
    if not all(p.inb(*x) for x in cells):
        raise SystemExit('does not fit')
    for (rr, cc), ch in zip(cells, w):
        if p.g[rr][cc] not in ('.', ch):
            raise SystemExit(f'conflict at ({rr},{cc}): {p.g[rr][cc]}')
    for (rr, cc), ch in zip(cells, w):
        p.g[rr][cc] = ch
    for end in ((r - dr, c - dc), (cells[-1][0] + dr, cells[-1][1] + dc)):
        if p.inb(*end):
            p.set_black(*end)
    p.data.setdefault('theme', []).append({'word': w, 'at': [r, c], 'dir': a.dir.upper()[0],
                                           'note': a.note or ''})
    p.save(); show(p)


def c_cands(a):
    p = load(a)
    s = p.slot(a.slot)
    pat = p.pattern(s)
    lex = W.Lexicon(**lex_args(a))
    ws = lex.match(pat, limit=a.n)
    print(f'{s.id} {pat}  ({len(ws)}{"+" if len(ws) == a.n else ""} shown)')
    for w in ws:
        print(f'  {w:<{len(s) + 2}}{lex.score(w)}')


def c_words(a):
    lex = W.Lexicon(**lex_args(a))
    for w in lex.match(a.pattern, limit=a.n):
        print(f'{w:<22}{lex.score(w)}')


def c_layout(a):
    p = load(a)
    res = generate(p, tries=a.tries, seed=a.seed, blacks=(a.min_blacks, a.max_blacks), min_entries=a.min_entries)
    if not res:
        raise SystemExit('no valid layout found; loosen --min-blacks or add tries')
    for i, (sc, q) in enumerate(res[:a.show], 1):
        _, _, st = q.check()
        print(f'\n#{i}  score {sc:.1f}  {st["entries"]} entries  {st["blacks"]} blacks  '
              + ' '.join(f'{k}:{v}' for k, v in st['by_len'].items()))
        print(q.render(coords=False))
    if a.write:
        sc, q = res[a.write - 1]
        p.g = q.g
        p.save()
        print(f'\nwrote layout #{a.write} to {a.puzzle}')


def quality(p, lex, n=10):
    rows = [(lex.score(p.word(s)), s.id, p.word(s)) for s in p.slots() if p.word(s)]
    if not rows:
        return
    avg = sum(r[0] for r in rows) / len(rows)
    rows.sort()
    print(f'\nfill quality: avg score {avg:.1f} over {len(rows)} entries (50 = solid, 25 = meh, 0 = not in list)')
    print('weakest: ' + ', '.join(f'{w} {i} ({sc})' for sc, i, w in rows[:n]))


def c_quality(a):
    p = load(a)
    quality(p, W.Lexicon(min_score=0, themes=tuple(a.theme or ())), a.n)


def c_fill(a):
    p = load(a)
    errs, _, _ = p.check()
    if any(not e.startswith('duplicate') for e in errs):
        print('fix grid errors first:'); [print('  ', e) for e in errs]; return 1
    extra = {w: 90 for w in (p.data.get('words') or [])}
    la = lex_args(a)
    la['extra'] = {W.norm(w): 90 for w in (p.data.get('words') or [])}
    t = time.time()

    def prog(att, best, total, el):
        print(f'  attempt {att:>3}: best {best}/{total} entries  ({el:.0f}s)', flush=True)

    res = autofill(p, la, timeout=a.timeout, seed=a.seed, branch=a.branch, on_progress=prog)
    print(f'{"FILLED" if res.ok else "no complete fill"} in {res.seconds:.1f}s, {res.nodes:,} nodes, {res.restarts} attempt(s)')
    if res.ok or a.partial:
        p.g = res.grid
        p.save()
    if res.grid:
        q = Puzzle({'size': p.size, 'grid': [''.join(r) for r in res.grid]})
        print(q.render())
        quality(q, W.Lexicon(min_score=0, themes=tuple(a.theme or ()), extra=la['extra']))
    if not res.ok:
        print('\nmost-contested entries (consider moving blacks near these):', ', '.join(res.stuck) or '-')
        if not a.partial:
            print('(grid unchanged; use --partial to save the best attempt)')
        return 2
    return 0


def c_add(a):
    w = W.norm(a.word)
    line = w + (f';{a.score}' if a.score is not None else '')
    with open(W.CUSTOM, 'a') as f:
        f.write(line + '\n')
    W.build(verbose=False)
    print(f'added {line}')


def c_clue(a):
    p = load(a)
    s = p.slot(a.slot)
    p.data.setdefault('clues', {})[s.key] = a.text
    p.save()
    print(f'{s.id} {p.pattern(s)}: {a.text}')


def c_list(a):
    p = load(a)
    clues = p.data.get('clues', {})
    for d, name in (('A', 'ACROSS'), ('D', 'DOWN')):
        print(name)
        for s in p.slots():
            if s.dir == d:
                print(f'  {s.num:>3}. {p.pattern(s):<16} {clues.get(s.key, "")}')


def reindex():
    out = []
    for f in sorted(glob.glob(os.path.join(PUZZLES, '*.json'))):
        if os.path.basename(f) == 'index.json':
            continue
        d = json.load(open(f, encoding='utf8'))
        full = sum(1 for r in d['grid'] for ch in r if ch == '.') == 0
        out.append({'id': os.path.basename(f)[:-5], 'title': d.get('title', ''), 'author': d.get('author', ''),
                    'date': d.get('date', ''), 'size': d['size'], 'complete': full,
                    'clued': bool(d.get('clues'))})
    with open(os.path.join(PUZZLES, 'index.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')


def c_index(a):
    reindex(); print('puzzles/index.json updated')


def main(argv=None):
    ap = argparse.ArgumentParser(prog='xw', description='NYT-style crossword construction')
    sp = ap.add_subparsers(dest='cmd', required=True)

    def cmd(name, fn, help, puzzle=True):
        s = sp.add_parser(name, help=help)
        if puzzle:
            s.add_argument('puzzle', help='puzzle name (puzzles/NAME.json)')
        s.set_defaults(fn=fn)
        return s

    def lexopts(s):
        s.add_argument('--min-score', type=int, default=30)
        s.add_argument('--theme', action='append', help='themed dictionary, e.g. tech (repeatable)')

    s = cmd('setup', c_setup, 'clone the three word-list repos and build the master list', False)
    s.add_argument('--update', action='store_true')
    cmd('build', c_build, 'rebuild master list (after editing custom.txt)', False)
    s = cmd('new', c_new, 'start a puzzle')
    s.add_argument('--size', type=int, default=15); s.add_argument('--title'); s.add_argument('--author'); s.add_argument('--date')
    s = cmd('show', c_show, 'print the grid'); s.add_argument('--numbered', action='store_true')
    s = cmd('black', c_black, 'add black squares (row,col ...; mirrored 180 degrees)')
    s.add_argument('cells', nargs='+'); s.add_argument('--no-sym', action='store_true'); s.set_defaults(undo=False)
    s = cmd('white', c_white, 'remove black squares'); s.add_argument('cells', nargs='+'); s.add_argument('--no-sym', action='store_true')
    cmd('check', c_check, 'validate against NYT construction rules')
    s = cmd('put', c_put, 'write a word into an entry, e.g. put mon 17A ASTRONOMY'); s.add_argument('slot'); s.add_argument('word')
    s = cmd('clear', c_clear, "blank entries ('17A,5D' or 'all')"); s.add_argument('slot')
    s = cmd('theme', c_theme, 'place a theme entry at row,col and cap it with mirrored blacks')
    s.add_argument('at'); s.add_argument('dir'); s.add_argument('word'); s.add_argument('--note')
    s = cmd('cands', c_cands, 'ranked candidates for an entry given its crossings'); s.add_argument('slot'); s.add_argument('-n', type=int, default=25); lexopts(s)
    s = cmd('layout', c_layout, 'propose black-square layouts around any placed letters')
    s.add_argument('--tries', type=int, default=120); s.add_argument('--seed', type=int, default=1)
    s.add_argument('--show', type=int, default=3); s.add_argument('--write', type=int, default=0)
    s.add_argument('--min-blacks', type=int, default=34); s.add_argument('--max-blacks', type=int, default=42); s.add_argument('--min-entries', type=int, default=68)
    s = cmd('fill', c_fill, 'autofill all empty squares'); lexopts(s)
    s.add_argument('--timeout', type=int, default=60); s.add_argument('--seed', type=int, default=1)
    s.add_argument('--branch', type=int, default=30); s.add_argument('--partial', action='store_true')
    s = cmd('clue', c_clue, 'set a clue'); s.add_argument('slot'); s.add_argument('text')
    s = cmd('quality', c_quality, 'score the current fill, list weakest entries'); s.add_argument('-n', type=int, default=10); lexopts(s)
    cmd('list', c_list, 'list entries and clues')
    s = cmd('words', c_words, 'search the word list by pattern, e.g. xw words "?A?E"', False)
    s.add_argument('pattern'); s.add_argument('-n', type=int, default=40); lexopts(s)
    s = cmd('add', c_add, 'add a custom word (score default 90; 0 bans)', False); s.add_argument('word'); s.add_argument('score', type=int, nargs='?')
    cmd('index', c_index, 'refresh puzzles/index.json for the site', False)
    a = ap.parse_args(argv)
    try:
        r = a.fn(a)
    except (KeyError, ValueError) as e:
        raise SystemExit(f'error: {e.args[0] if e.args else e}')
    if a.cmd in ('black', 'white', 'put', 'clear', 'theme', 'layout', 'fill', 'clue') and getattr(a, 'puzzle', None):
        reindex()
    return r or 0
