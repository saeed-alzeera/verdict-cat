(function(w) {
  var GIST_DESC = 'verdict-cat reading progress';
  var GIST_FILE = 'verdict-cat-progress.json';
  var LS_PAT    = 'verdict-cat-pat';
  var LS_GIST   = 'verdict-cat-gist-id';
  var API       = 'https://api.github.com';
  var TS_SUFFIX = ':ts';

  // Preferred backend: the verdict-cat-sync Cloudflare Worker, authenticated
  // with a sync key that doesn't expire. The GitHub gist code below is kept
  // as a fallback for devices that only have a (legacy) personal access token.
  var WORKER    = 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';
  var LS_KEY    = 'verdict-cat-sync-key';
  var WORKER_ID = 'worker';  // sentinel returned by connect() for worker mode
  var GIST_FILE_DOCS = {     // legacy gist file per synced document
    'text-transport': 'verdict-cat-text-transport.json'
  };

  // Custom regions (numbers.html) live in the same gist as a second file,
  // reusing the same PAT/gist-id connection.
  var GIST_FILE_REGIONS   = 'verdict-cat-regions.json';
  var LS_REGION_PREFIX    = 'vc-region:';
  var LS_REGION_TOMB_PREFIX = 'vc-region-tomb:';

  function h(pat) {
    return { 'Authorization': 'token ' + pat, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
  }

  function tsKey(k) { return k + TS_SUFFIX; }

  function looksLikeGithubToken(s) {
    return /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/.test(s) || /^[a-f0-9]{40}$/.test(s);
  }

  function syncKey() { return localStorage.getItem(LS_KEY) || ''; }
  function mode() {
    if (syncKey()) return 'worker';
    if (localStorage.getItem(LS_PAT) && localStorage.getItem(LS_GIST)) return 'gist';
    return null;
  }

  // Worker request helper. Records the last failure on Gist.lastError so
  // pages can show a sync problem instead of failing silently.
  async function wfetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Authorization': 'Bearer ' + syncKey() }, opts.headers || {});
    var resp;
    try {
      resp = await fetch(WORKER + path, Object.assign({}, opts, { headers: headers }));
    } catch(e) {
      w.Gist.lastError = 'Network error — could not reach sync server.';
      throw e;
    }
    if (resp.status === 401) {
      w.Gist.lastError = 'Sync key rejected — reconnect with a valid key.';
      throw new Error(w.Gist.lastError);
    }
    if (!resp.ok) {
      var detail = '';
      try { detail = (await resp.json()).error || ''; } catch(e) {}
      w.Gist.lastError = 'Sync server error (' + resp.status + ')' + (detail ? ': ' + detail : '') + '.';
      throw new Error(w.Gist.lastError);
    }
    w.Gist.lastError = null;
    return resp.json();
  }

  async function workerGetNs(ns) {
    return (await wfetch('/sync/' + ns)).entries || {};
  }
  async function workerPostNs(ns, entries, keepalive) {
    return (await wfetch('/sync/' + ns, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: entries }), keepalive: !!keepalive
    })).entries || {};
  }

  // Every localStorage write to an epub-progress key should go through this so
  // the timestamp used for merge decisions always matches the value it guards.
  function touch(key, ts) {
    try { localStorage.setItem(tsKey(key), String(ts)); } catch(e) {}
  }

  w.Gist = {
    // 'worker' | 'gist' | null — which backend this device is using.
    mode: mode,
    lastError: null,
    workerUrl: WORKER,
    syncKey: syncKey,
    isGithubToken: looksLikeGithubToken,

    isConnected: function() {
      return mode() !== null;
    },
    credentials: function() {
      return { pat: localStorage.getItem(LS_PAT), gistId: localStorage.getItem(LS_GIST) };
    },
    // connect() returns WORKER_ID for a sync key; anything else is a gist id.
    save: function(secret, id) {
      if (id === WORKER_ID) {
        localStorage.setItem(LS_KEY, secret);
        // If this device still has the old gist connection, carry its data over.
        if (localStorage.getItem(LS_PAT) && localStorage.getItem(LS_GIST)) {
          w.Gist.importLegacy().catch(function() {});
        }
        return;
      }
      localStorage.setItem(LS_PAT, secret);
      localStorage.setItem(LS_GIST, id);
    },
    clear: function() {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_PAT);
      localStorage.removeItem(LS_GIST);
    },

    // Records that a progress key was just written locally, so pull() can
    // tell whether a remote value is actually newer before overwriting it.
    touchProgress: function(key, ts) {
      touch(key, ts || Date.now());
    },

    // Connect with either a sync key (worker) or a legacy GitHub token (gist).
    // Returns WORKER_ID for the former, the gist id for the latter.
    connect: async function(secret) {
      if (!looksLikeGithubToken(secret)) {
        var resp0;
        try {
          resp0 = await fetch(WORKER + '/ping', { headers: { 'Authorization': 'Bearer ' + secret } });
        } catch(e) { throw new Error('Could not reach the sync server.'); }
        if (resp0.status === 401) throw new Error('Sync key not recognised.');
        if (!resp0.ok) throw new Error('Sync server error (' + resp0.status + ').');
        return WORKER_ID;
      }
      return w.Gist._connectGist(secret);
    },

    // Find existing verdict-cat gist or create a new one (legacy)
    _connectGist: async function(pat) {
      var resp = await fetch(API + '/gists?per_page=100', { headers: h(pat) });
      if (!resp.ok) throw new Error('Token invalid or network error (' + resp.status + ')');
      var list = await resp.json();
      var found = list.find(function(g) { return g.description === GIST_DESC; });
      if (found) return found.id;
      var create = await fetch(API + '/gists', {
        method: 'POST', headers: h(pat),
        body: JSON.stringify({ description: GIST_DESC, public: false, files: { [GIST_FILE]: { content: '{}' } } })
      });
      if (!create.ok) throw new Error('Could not create gist (' + create.status + ')');
      return (await create.json()).id;
    },

    // Pull remote progress and merge into localStorage. Each remote entry is
    // {cfi, ts}; a remote value only overwrites the local one when it is
    // actually newer, so a stale pull (or a pull racing an unsynced local
    // change) can never clobber more recent progress. Returns the set of
    // progress keys that were changed by this pull, so callers can react
    // (e.g. jump the reader to the newly-synced position).
    _gistPull: async function() {
      var changed = [];
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return changed;
      try {
        var resp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
        if (!resp.ok) return changed;
        var data = await resp.json();
        var remote = JSON.parse((data.files[GIST_FILE] || {}).content || '{}');
        Object.keys(remote).forEach(function(k) {
          if (!k.startsWith('epub-progress:')) return;
          var entry = remote[k];
          // Back-compat: older gists stored the raw CFI string directly.
          var remoteCfi = (entry && typeof entry === 'object') ? entry.cfi : entry;
          var remoteTs  = (entry && typeof entry === 'object' && entry.ts) ? entry.ts : 0;
          if (!remoteCfi) return;
          var localTs = parseInt(localStorage.getItem(tsKey(k)) || '0', 10);
          if (remoteTs > localTs) {
            localStorage.setItem(k, remoteCfi);
            touch(k, remoteTs);
            changed.push(k);
          }
        });
      } catch(e) {}
      return changed;
    },

    // Push local progress to gist, merged against whatever is already there —
    // a local key only overwrites the remote entry when its timestamp is at
    // least as new, mirroring the guard pull() uses. Without this, a stale
    // local copy (e.g. from a slow/failed pull) would blindly overwrite
    // newer progress synced from another device (silent fail — localStorage
    // is always the fast path).
    _gistPush: async function() {
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return false;
      try {
        var local = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.startsWith('epub-progress:') && !k.endsWith(TS_SUFFIX)) {
            var ts = parseInt(localStorage.getItem(tsKey(k)) || '0', 10) || Date.now();
            local[k] = { cfi: localStorage.getItem(k), ts: ts };
          }
        }
        var getResp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
        var remote = {};
        if (getResp.ok) {
          var data = await getResp.json();
          try { remote = JSON.parse((data.files[GIST_FILE] || {}).content || '{}'); } catch(e) {}
        }
        var merged = Object.assign({}, remote);
        Object.keys(local).forEach(function(k) {
          var remoteEntry = remote[k];
          var remoteTs = (remoteEntry && typeof remoteEntry === 'object' && remoteEntry.ts) ? remoteEntry.ts : 0;
          if (local[k].ts >= remoteTs) merged[k] = local[k];
        });
        var resp = await fetch(API + '/gists/' + c.gistId, {
          method: 'PATCH', headers: h(c.pat),
          body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(merged, null, 2) } } })
        });
        return resp.ok;
      } catch(e) { return false; }
    },

    // Push local progress, then pull — so a manual "Sync" action reconciles
    // in both directions instead of only fetching. Returns the keys pull()
    // changed, if any.
    sync: async function() {
      await w.Gist.push();
      return await w.Gist.pull();
    },

    // ── Custom regions (numbers.html) ─────────────────────────────────────
    // Each region lives at localStorage['vc-region:<id>'] = {id,name,countryCodes,updatedAt}.
    // A deleted region leaves a tombstone at 'vc-region-tomb:<id>' = deletedAt,
    // so pull() knows not to resurrect it from a remote that hasn't seen the delete yet.

    // Pull remote regions and merge into localStorage (remote wins only when newer
    // than both the local region and any local deletion tombstone for that id).
    _gistPullRegions: async function() {
      var changed = false;
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return changed;
      try {
        var resp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
        if (!resp.ok) return changed;
        var data = await resp.json();
        var file = data.files[GIST_FILE_REGIONS];
        var remote = file ? JSON.parse(file.content || '{}') : {};
        var remoteRegions = remote.regions || {};
        var remoteDeletions = remote.deletions || {};

        Object.keys(remoteRegions).forEach(function(id) {
          var r = remoteRegions[id];
          var localKey = LS_REGION_PREFIX + id;
          var tombKey = LS_REGION_TOMB_PREFIX + id;
          var localTs = 0;
          var localRaw = localStorage.getItem(localKey);
          if (localRaw) { try { localTs = JSON.parse(localRaw).updatedAt || 0; } catch(e) {} }
          var tombTs = parseInt(localStorage.getItem(tombKey) || '0', 10);
          if (r.updatedAt > localTs && r.updatedAt > tombTs) {
            localStorage.setItem(localKey, JSON.stringify({ id: id, name: r.name, countryCodes: r.countryCodes, updatedAt: r.updatedAt }));
            localStorage.removeItem(tombKey);
            changed = true;
          }
        });
        Object.keys(remoteDeletions).forEach(function(id) {
          var ts = remoteDeletions[id];
          var localKey = LS_REGION_PREFIX + id;
          var localRaw = localStorage.getItem(localKey);
          var localTs = 0;
          if (localRaw) { try { localTs = JSON.parse(localRaw).updatedAt || 0; } catch(e) {} }
          if (ts > localTs) {
            localStorage.removeItem(localKey);
            localStorage.setItem(LS_REGION_TOMB_PREFIX + id, String(ts));
            changed = true;
          }
        });
      } catch(e) {}
      return changed;
    },

    // Push all local regions + deletion tombstones to the gist (silent fail).
    _gistPushRegions: async function() {
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return false;
      try {
        var regions = {};
        var deletions = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k) continue;
          if (k.indexOf(LS_REGION_PREFIX) === 0) {
            var id = k.slice(LS_REGION_PREFIX.length);
            try {
              var r = JSON.parse(localStorage.getItem(k));
              regions[id] = { name: r.name, countryCodes: r.countryCodes, updatedAt: r.updatedAt };
            } catch(e) {}
          } else if (k.indexOf(LS_REGION_TOMB_PREFIX) === 0) {
            var did = k.slice(LS_REGION_TOMB_PREFIX.length);
            deletions[did] = parseInt(localStorage.getItem(k) || '0', 10);
          }
        }
        var resp = await fetch(API + '/gists/' + c.gistId, {
          method: 'PATCH', headers: h(c.pat),
          body: JSON.stringify({ files: { [GIST_FILE_REGIONS]: { content: JSON.stringify({ regions: regions, deletions: deletions }, null, 2) } } })
        });
        return resp.ok;
      } catch(e) { return false; }
    },

    // Pull first so a stale local push can't clobber another device's newer
    // region, then push local state back (so this device's own edits sync out).
    syncRegions: async function() {
      var changed = await w.Gist.pullRegions();
      await w.Gist.pushRegions();
      return changed;
    },

    // ── Worker backend ────────────────────────────────────────────────────
    // Namespaces are merged last-writer-wins per key on the server, so a
    // stale device can never overwrite newer data and there is no
    // read-modify-write race.

    _workerPull: async function() {
      var changed = [];
      try {
        var remote = await workerGetNs('progress');
        Object.keys(remote).forEach(function(k) {
          if (!k.startsWith('epub-progress:')) return;
          var e = remote[k];
          if (!e || !e.value) return;
          var localTs = parseInt(localStorage.getItem(tsKey(k)) || '0', 10);
          if (e.ts > localTs) {
            localStorage.setItem(k, e.value);
            touch(k, e.ts);
            changed.push(k);
          }
        });
      } catch(e) {}
      return changed;
    },

    _workerPush: async function() {
      try {
        var entries = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.startsWith('epub-progress:') && !k.endsWith(TS_SUFFIX)) {
            var ts = parseInt(localStorage.getItem(tsKey(k)) || '0', 10) || Date.now();
            entries[k] = { value: localStorage.getItem(k), ts: ts };
          }
        }
        if (!Object.keys(entries).length) return true;
        await workerPostNs('progress', entries);
        return true;
      } catch(e) { return false; }
    },

    // Regions: 'r:<id>' = {name,countryCodes} @ updatedAt, 't:<id>' = tombstone @ deletedAt.
    _workerPullRegions: async function() {
      var changed = false;
      try {
        var remote = await workerGetNs('regions');
        Object.keys(remote).forEach(function(k) {
          var e = remote[k];
          if (k.indexOf('r:') === 0 && e && e.value) {
            var id = k.slice(2);
            var localKey = LS_REGION_PREFIX + id;
            var localTs = 0;
            var localRaw = localStorage.getItem(localKey);
            if (localRaw) { try { localTs = JSON.parse(localRaw).updatedAt || 0; } catch(x) {} }
            var tombTs = parseInt(localStorage.getItem(LS_REGION_TOMB_PREFIX + id) || '0', 10);
            var tomb = remote['t:' + id];
            var remoteTombTs = tomb ? tomb.ts : 0;
            if (e.ts > localTs && e.ts > tombTs && e.ts > remoteTombTs) {
              localStorage.setItem(localKey, JSON.stringify({ id: id, name: e.value.name, countryCodes: e.value.countryCodes, updatedAt: e.ts }));
              localStorage.removeItem(LS_REGION_TOMB_PREFIX + id);
              changed = true;
            }
          } else if (k.indexOf('t:') === 0) {
            var did = k.slice(2);
            var lk = LS_REGION_PREFIX + did;
            var lraw = localStorage.getItem(lk);
            var lts = 0;
            if (lraw) { try { lts = JSON.parse(lraw).updatedAt || 0; } catch(x) {} }
            if (e.ts > lts) {
              var had = localStorage.getItem(LS_REGION_TOMB_PREFIX + did);
              localStorage.removeItem(lk);
              localStorage.setItem(LS_REGION_TOMB_PREFIX + did, String(e.ts));
              if (lraw || !had) changed = true;
            }
          }
        });
      } catch(e) {}
      return changed;
    },

    _workerPushRegions: async function() {
      try {
        var entries = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k) continue;
          if (k.indexOf(LS_REGION_PREFIX) === 0) {
            try {
              var r = JSON.parse(localStorage.getItem(k));
              entries['r:' + k.slice(LS_REGION_PREFIX.length)] = { value: { name: r.name, countryCodes: r.countryCodes }, ts: r.updatedAt || 0 };
            } catch(e) {}
          } else if (k.indexOf(LS_REGION_TOMB_PREFIX) === 0) {
            entries['t:' + k.slice(LS_REGION_TOMB_PREFIX.length)] = { value: null, ts: parseInt(localStorage.getItem(k) || '0', 10) };
          }
        }
        if (!Object.keys(entries).length) return true;
        await workerPostNs('regions', entries);
        return true;
      } catch(e) { return false; }
    },

    // ── Dispatch (public API used by the pages) ───────────────────────────
    pull:        function() { return mode() === 'worker' ? w.Gist._workerPull()        : w.Gist._gistPull(); },
    push:        function() { return mode() === 'worker' ? w.Gist._workerPush()        : w.Gist._gistPush(); },
    pullRegions: function() { return mode() === 'worker' ? w.Gist._workerPullRegions() : w.Gist._gistPullRegions(); },
    pushRegions: function() { return mode() === 'worker' ? w.Gist._workerPushRegions() : w.Gist._gistPushRegions(); },

    // ── Whole-document sync (e.g. text-transport snippets) ────────────────
    // Last-writer-wins on the whole value. pullDoc returns the parsed value,
    // or null when nothing is stored / sync is unavailable.
    pullDoc: async function(name) {
      var m = mode();
      try {
        if (m === 'worker') {
          var remote = await workerGetNs('docs');
          var e = remote[name];
          return e && e.value != null ? e.value : null;
        }
        if (m === 'gist') {
          var c = w.Gist.credentials();
          var resp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
          if (!resp.ok) return null;
          var data = await resp.json();
          var file = data.files[GIST_FILE_DOCS[name]];
          return file ? JSON.parse(file.content || 'null') : null;
        }
      } catch(e) {}
      return null;
    },
    pushDoc: async function(name, value) {
      var m = mode();
      try {
        if (m === 'worker') {
          var entries = {}; entries[name] = { value: value, ts: Date.now() };
          await workerPostNs('docs', entries);
          return true;
        }
        if (m === 'gist') {
          var c = w.Gist.credentials();
          var files = {}; files[GIST_FILE_DOCS[name]] = { content: JSON.stringify(value, null, 2) };
          var r = await fetch(API + '/gists/' + c.gistId, { method: 'PATCH', headers: h(c.pat), body: JSON.stringify({ files: files }) });
          return r.ok;
        }
      } catch(e) {}
      return false;
    },

    // ── Raw namespace access (worker only) ─────────────────────────────────
    // For pages that keep their own per-key {value, ts} state (e.g. crossword).
    // pullNs returns null when sync is unavailable or fails.
    pullNs: async function(ns) {
      if (mode() !== 'worker') return null;
      try { return await workerGetNs(ns); } catch(e) { return null; }
    },
    // keepalive lets the request finish while the page is unloading.
    pushNs: async function(ns, entries, keepalive) {
      if (mode() !== 'worker') return false;
      try { await workerPostNs(ns, entries, keepalive); return true; } catch(e) { return false; }
    },

    // ── One-time import from the old gist into the worker ─────────────────
    // Safe to run repeatedly: entries merge by timestamp. Pass a GitHub token
    // to import on a device that has a sync key but never had the gist set up.
    importLegacy: async function(pat) {
      if (!syncKey()) throw new Error('Connect with a sync key first.');
      pat = pat || localStorage.getItem(LS_PAT);
      if (!pat) throw new Error('No GitHub token available to import from.');
      var gistId = localStorage.getItem(LS_GIST);
      if (!gistId || pat !== localStorage.getItem(LS_PAT)) {
        var lr = await fetch(API + '/gists?per_page=100', { headers: h(pat) });
        if (!lr.ok) throw new Error('GitHub token invalid or revoked (' + lr.status + ')');
        var found = (await lr.json()).find(function(g) { return g.description === GIST_DESC; });
        if (!found) return { progress: 0, regions: 0, docs: 0 };
        gistId = found.id;
      }
      var resp = await fetch(API + '/gists/' + gistId, { headers: h(pat) });
      if (!resp.ok) throw new Error('Could not read old gist (' + resp.status + ')');
      var files = (await resp.json()).files || {};
      var counts = { progress: 0, regions: 0, docs: 0 };

      if (files[GIST_FILE]) {
        var prog = JSON.parse(files[GIST_FILE].content || '{}');
        var pe = {};
        Object.keys(prog).forEach(function(k) {
          if (!k.startsWith('epub-progress:')) return;
          var v = prog[k];
          var cfi = (v && typeof v === 'object') ? v.cfi : v;
          var ts = (v && typeof v === 'object' && v.ts) ? v.ts : 1;
          if (cfi) pe[k] = { value: cfi, ts: ts };
        });
        counts.progress = Object.keys(pe).length;
        if (counts.progress) await workerPostNs('progress', pe);
      }
      if (files[GIST_FILE_REGIONS]) {
        var reg = JSON.parse(files[GIST_FILE_REGIONS].content || '{}');
        var re = {};
        Object.keys(reg.regions || {}).forEach(function(id) {
          var r = reg.regions[id];
          re['r:' + id] = { value: { name: r.name, countryCodes: r.countryCodes }, ts: r.updatedAt || 1 };
        });
        Object.keys(reg.deletions || {}).forEach(function(id) {
          re['t:' + id] = { value: null, ts: reg.deletions[id] || 1 };
        });
        counts.regions = Object.keys(re).length;
        if (counts.regions) await workerPostNs('regions', re);
      }
      var de = {};
      Object.keys(GIST_FILE_DOCS).forEach(function(name) {
        var f = files[GIST_FILE_DOCS[name]];
        if (f) { try { de[name] = { value: JSON.parse(f.content || 'null'), ts: 1 }; } catch(e) {} }
      });
      counts.docs = Object.keys(de).length;
      // ts:1 means "older than anything edited since" — never clobbers newer worker data.
      if (counts.docs) await workerPostNs('docs', de);
      return counts;
    },

    // ── Books (uploads without GitHub) ────────────────────────────────────
    books: {
      list: async function() {
        var resp = await fetch(WORKER + '/books', { cache: 'no-store' });
        if (!resp.ok) throw new Error('Book catalogue unavailable (' + resp.status + ')');
        return (await resp.json()).books || [];
      },
      // opts: { slug, title, author, epub: File|Blob, cover?: Blob }
      upload: async function(opts) {
        if (!syncKey()) throw new Error('Connect with your sync key to upload books.');
        var fd = new FormData();
        fd.append('title', opts.title);
        fd.append('author', opts.author);
        fd.append('epub', opts.epub, opts.slug + '.epub');
        if (opts.cover) fd.append('cover', opts.cover, opts.slug + '.' + (opts.cover.type === 'image/png' ? 'png' : 'jpg'));
        return (await wfetch('/books/' + encodeURIComponent(opts.slug), { method: 'PUT', body: fd })).book;
      },
      remove: async function(slug) {
        if (!syncKey()) throw new Error('Connect with your sync key to delete books.');
        return wfetch('/books/' + encodeURIComponent(slug), { method: 'DELETE' });
      }
    }
  };
})(window);
