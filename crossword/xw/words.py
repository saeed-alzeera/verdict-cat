"""Word lists: fetch the three upstream sources, merge them with your custom
words, and serve fast pattern lookups.

Scoring (0-100, higher = better fill):
  christophsjones/crossword-wordlist   its own 2-50 score
  nzfeng/crossword-dataset (MsFit)     hand-curated; +10 boost, floor 40
  stephthegeek/Crossword-Dictionaries  themed .dict files (value 80), opt-in per fill
  wordlists/custom.txt                 yours; default 90, `;0` bans a word
"""
import os, re, random, subprocess
from .grid import ROOT

WL = os.path.join(ROOT, 'wordlists')
VENDOR = os.path.join(WL, 'vendor')
BUILT = os.path.join(WL, 'built')
MASTER = os.path.join(BUILT, 'master.txt')
CUSTOM = os.path.join(WL, 'custom.txt')
SOURCES = {
    'crossword-wordlist': 'https://github.com/christophsjones/crossword-wordlist',
    'crossword-dataset': 'https://github.com/nzfeng/crossword-dataset',
    'Crossword-Dictionaries': 'https://github.com/stephthegeek/Crossword-Dictionaries',
}
DEFAULT_CUSTOM_SCORE = 90
NONALPHA = re.compile('[^A-Z]')


def norm(s):
    return NONALPHA.sub('', s.upper())


def setup(update=False):
    os.makedirs(VENDOR, exist_ok=True)
    for name, url in SOURCES.items():
        d = os.path.join(VENDOR, name)
        if os.path.isdir(d):
            if update:
                subprocess.run(['git', '-C', d, 'pull', '--ff-only', '-q'], check=True)
                print(f'updated {name}')
            else:
                print(f'have {name}')
        else:
            subprocess.run(['git', 'clone', '--depth', '1', '-q', url, d], check=True)
            print(f'cloned {name}')


def _read(path):
    with open(path, encoding='utf8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                yield line


def _scored(path):
    for line in _read(path):
        w, _, sc = line.rpartition(';')
        if not w:
            w, sc = sc, ''
        try:
            yield norm(w), int(sc) if sc else None
        except ValueError:
            yield norm(line), None


def read_custom():
    out = {}
    if os.path.exists(CUSTOM):
        for w, sc in _scored(CUSTOM):
            if w:
                out[w] = DEFAULT_CUSTOM_SCORE if sc is None else sc
    return out


def theme_dict(name):
    p = os.path.join(VENDOR, 'Crossword-Dictionaries', name + '.dict')
    if not os.path.exists(p):
        raise SystemExit(f'no theme dictionary {name!r} (try: {", ".join(theme_names()) or "run `xw setup`"})')
    return {w: sc or 80 for w, sc in _scored(p) if len(w) >= 3}


def theme_names():
    d = os.path.join(VENDOR, 'Crossword-Dictionaries')
    return sorted(f[:-5] for f in os.listdir(d) if f.endswith('.dict')) if os.path.isdir(d) else []


def build(verbose=True):
    cj = os.path.join(VENDOR, 'crossword-wordlist', 'crossword_wordlist.txt')
    raw = os.path.join(VENDOR, 'crossword-dataset', 'raw')
    if not os.path.exists(cj):
        setup()
    words = {}
    for w, sc in _scored(cj):
        if 3 <= len(w) <= 21 and sc:
            words[w] = max(words.get(w, 0), sc)
    n_cj = len(words)
    n_ms = 0
    for fn in ('core.txt', 'contemporary.txt', 'idioms.txt'):
        p = os.path.join(raw, fn)
        if not os.path.exists(p):
            continue
        for w, _ in _scored(p):
            if 3 <= len(w) <= 21:
                n_ms += 1
                words[w] = min(60, max(words.get(w, 0), 30) + 10)
    custom = read_custom()
    for w, sc in custom.items():
        if sc <= 0:
            words.pop(w, None)
        else:
            words[w] = sc
    os.makedirs(BUILT, exist_ok=True)
    with open(MASTER, 'w') as f:
        for w, sc in sorted(words.items(), key=lambda kv: (-kv[1], kv[0])):
            f.write(f'{w};{sc}\n')
    if verbose:
        print(f'built {len(words):,} words -> {os.path.relpath(MASTER, ROOT)} '
              f'(crossword-wordlist {n_cj:,}, MsFit {n_ms:,}, custom {len(custom)})')
    return words


def curated_set():
    """Normalized entries of the hand-curated MsFit lists (core, contemporary, idioms)."""
    raw = os.path.join(VENDOR, 'crossword-dataset', 'raw')
    out = set()
    for fn in ('core.txt', 'contemporary.txt', 'idioms.txt'):
        p = os.path.join(raw, fn)
        if os.path.exists(p):
            out.update(w for w, _ in _scored(p) if 3 <= len(w) <= 21)
    return out


class Lexicon:
    """Words with scores plus bitset indexes for pattern matching.

    Within a length, words are ordered best-score-first (ties shuffled by
    `seed`), so the lowest set bit of any candidate mask is the best word.
    """

    def __init__(self, min_score=25, themes=(), seed=0, extra=None, curated=False):
        if not os.path.exists(MASTER) or os.path.getmtime(MASTER) < os.path.getmtime(CUSTOM if os.path.exists(CUSTOM) else MASTER):
            build(verbose=False)
        self.scores = {}
        for w, sc in _scored(MASTER):
            self.scores[w] = sc
        for t in themes:
            for w, sc in theme_dict(t).items():
                self.scores[w] = max(self.scores.get(w, 0), sc)
        for w, sc in (extra or {}).items():
            self.scores[w] = sc
        if curated:   # only hand-curated words (plus anything passed in `extra`)
            keep = curated_set() | set(extra or {})
            self.scores = {w: sc for w, sc in self.scores.items() if w in keep}
        self.min_score = min_score
        self.seed = seed
        self._by_len = {}
        self._idx = {}

    def score(self, w):
        return self.scores.get(w, 0)

    def _length(self, L):
        if L in self._by_len:
            return self._by_len[L]
        rng = random.Random(self.seed * 1_000_003 + L)
        ws = [w for w, s in self.scores.items() if len(w) == L and s >= self.min_score]
        rng.shuffle(ws)
        ws.sort(key=lambda w: -self.scores[w])
        nbytes = (len(ws) + 7) // 8 + 1
        buckets = [[bytearray(nbytes) for _ in range(26)] for _ in range(L)]
        for i, w in enumerate(ws):
            b, bit = i >> 3, 1 << (i & 7)
            for p, ch in enumerate(w):
                buckets[p][ord(ch) - 65][b] |= bit
        masks = [[int.from_bytes(buckets[p][k], 'little') for k in range(26)] for p in range(L)]
        full = (1 << len(ws)) - 1
        self._by_len[L] = ws
        self._idx[L] = (masks, full)
        return ws

    def words(self, L):
        return self._length(L)

    def full(self, L):
        self._length(L)
        return self._idx[L][1]

    def letter_mask(self, L, pos, ch):
        self._length(L)
        return self._idx[L][0][pos][ord(ch) - 65]

    def mask(self, pattern):
        """Bitmask of words matching a pattern like 'C?T?E'."""
        L = len(pattern)
        m = self.full(L)
        for p, ch in enumerate(pattern):
            if ch != '?':
                m &= self.letter_mask(L, p, ch)
        return m

    def match(self, pattern, limit=None):
        pattern = pattern.upper()
        L = len(pattern)
        ws = self.words(L)
        m = self.mask(pattern)
        out = []
        while m:
            low = m & -m
            out.append(ws[low.bit_length() - 1])
            if limit and len(out) >= limit:
                break
            m ^= low
        return out
