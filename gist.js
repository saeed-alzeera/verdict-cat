(function(w) {
  var GIST_DESC = 'verdict-cat reading progress';
  var GIST_FILE = 'verdict-cat-progress.json';
  var LS_PAT    = 'verdict-cat-pat';
  var LS_GIST   = 'verdict-cat-gist-id';
  var API       = 'https://api.github.com';
  var TS_SUFFIX = ':ts';

  // Custom regions (numbers.html) live in the same gist as a second file,
  // reusing the same PAT/gist-id connection.
  var GIST_FILE_REGIONS   = 'verdict-cat-regions.json';
  var LS_REGION_PREFIX    = 'vc-region:';
  var LS_REGION_TOMB_PREFIX = 'vc-region-tomb:';

  // Markdown documents (markdown-editor.html): one gist file per document.
  var GIST_FILE_MD_INDEX  = 'verdict-cat-markdown-index.json';
  var LS_DOC_PREFIX       = 'vc-md-doc:';
  var LS_DOC_TOMB_PREFIX  = 'vc-md-tomb:';

  function docFile(id) { return 'md-' + id + '.md'; }

  // Gist responses truncate large files; fall back to the raw URL for those.
  async function fileText(f) {
    if (f.truncated && f.raw_url) {
      var r = await fetch(f.raw_url);
      if (r.ok) return await r.text();
    }
    return f.content || '';
  }

  function h(pat) {
    return { 'Authorization': 'token ' + pat, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
  }

  function tsKey(k) { return k + TS_SUFFIX; }

  // Every localStorage write to an epub-progress key should go through this so
  // the timestamp used for merge decisions always matches the value it guards.
  function touch(key, ts) {
    try { localStorage.setItem(tsKey(key), String(ts)); } catch(e) {}
  }

  w.Gist = {
    isConnected: function() {
      return !!(localStorage.getItem(LS_PAT) && localStorage.getItem(LS_GIST));
    },
    credentials: function() {
      return { pat: localStorage.getItem(LS_PAT), gistId: localStorage.getItem(LS_GIST) };
    },
    save: function(pat, gistId) {
      localStorage.setItem(LS_PAT, pat);
      localStorage.setItem(LS_GIST, gistId);
    },
    clear: function() {
      localStorage.removeItem(LS_PAT);
      localStorage.removeItem(LS_GIST);
    },

    // Records that a progress key was just written locally, so pull() can
    // tell whether a remote value is actually newer before overwriting it.
    touchProgress: function(key, ts) {
      touch(key, ts || Date.now());
    },

    // Find existing verdict-cat gist or create a new one
    connect: async function(pat) {
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
    pull: async function() {
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
    push: async function() {
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
    pullRegions: async function() {
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
    pushRegions: async function() {
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

    // ── Markdown documents (markdown-editor.html) ─────────────────────────
    // Each document lives at localStorage['vc-md-doc:<id>'] = {id,title,body,updatedAt}.
    // In the gist, every document's body is its own file (md-<id>.md) so it
    // stays readable on GitHub, and a small index file holds title/updatedAt
    // per id plus deletion tombstones. Merge rule is the same as regions:
    // the newer updatedAt wins, and a deletion beats any older edit.
    docs: {
      list: function() {
        var out = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(LS_DOC_PREFIX) === 0) {
            try { out.push(JSON.parse(localStorage.getItem(k))); } catch(e) {}
          }
        }
        return out.sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      },
      get: function(id) {
        try { return JSON.parse(localStorage.getItem(LS_DOC_PREFIX + id)); } catch(e) { return null; }
      },
      // Callers set updatedAt when the user actually edits; pull() passes the
      // remote timestamp through unchanged.
      put: function(doc) {
        var d = { id: doc.id, title: doc.title || '', body: doc.body || '', updatedAt: doc.updatedAt || Date.now() };
        localStorage.setItem(LS_DOC_PREFIX + d.id, JSON.stringify(d));
        localStorage.removeItem(LS_DOC_TOMB_PREFIX + d.id);
        return d;
      },
      remove: function(id) {
        localStorage.removeItem(LS_DOC_PREFIX + id);
        localStorage.setItem(LS_DOC_TOMB_PREFIX + id, String(Date.now()));
      }
    },

    // Merge remote documents into localStorage. Returns {ok, changed:[ids]}.
    pullDocs: async function() {
      var res = { ok: false, changed: [] };
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return res;
      try {
        var resp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
        if (!resp.ok) return res;
        var data = await resp.json();
        var idx = data.files[GIST_FILE_MD_INDEX]
          ? JSON.parse(await fileText(data.files[GIST_FILE_MD_INDEX]) || '{}') : {};
        var rdocs = idx.docs || {};
        var rdel = idx.deletions || {};

        for (var id in rdocs) {
          var m = rdocs[id];
          var tombTs = parseInt(localStorage.getItem(LS_DOC_TOMB_PREFIX + id) || '0', 10);
          var cur = w.Gist.docs.get(id);
          if (!(m.updatedAt > (cur ? cur.updatedAt : 0) && m.updatedAt > tombTs)) continue;
          var f = data.files[docFile(id)];
          if (!f) continue;
          var body = await fileText(f);
          body = body.replace(/\r\n/g, '\n');
          if (body === '\n') body = '';
          // Re-check after the await: a local edit made meanwhile must win.
          cur = w.Gist.docs.get(id);
          if (cur && cur.updatedAt >= m.updatedAt) continue;
          w.Gist.docs.put({ id: id, title: m.title, body: body, updatedAt: m.updatedAt });
          res.changed.push(id);
        }
        for (var did in rdel) {
          var ts = rdel[did];
          var local = w.Gist.docs.get(did);
          if (ts > (local ? local.updatedAt : 0)) {
            var oldTomb = parseInt(localStorage.getItem(LS_DOC_TOMB_PREFIX + did) || '0', 10);
            localStorage.removeItem(LS_DOC_PREFIX + did);
            localStorage.setItem(LS_DOC_TOMB_PREFIX + did, String(Math.max(ts, oldTomb)));
            if (local) res.changed.push(did);
          }
        }
        res.ok = true;
      } catch(e) {}
      return res;
    },

    // Push local documents + tombstones. Only files whose local copy is newer
    // than the remote index entry are uploaded; remote-only docs are left alone.
    pushDocs: async function() {
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return false;
      try {
        var getResp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
        if (!getResp.ok) return false;
        var data = await getResp.json();
        var idx = data.files[GIST_FILE_MD_INDEX]
          ? JSON.parse(await fileText(data.files[GIST_FILE_MD_INDEX]) || '{}') : {};
        var rdocs = idx.docs || {};
        var rdel = idx.deletions || {};
        var ndocs = Object.assign({}, rdocs);
        var ndel = Object.assign({}, rdel);
        var files = {};

        w.Gist.docs.list().forEach(function(d) {
          var rts = rdocs[d.id] ? rdocs[d.id].updatedAt : 0;
          if (d.updatedAt <= (ndel[d.id] || 0)) return;
          var fname = docFile(d.id);
          if (d.updatedAt > rts || (d.updatedAt === rts && !data.files[fname])) {
            files[fname] = { content: d.body || '\n' };
            ndocs[d.id] = { title: d.title || '', updatedAt: d.updatedAt };
          }
        });
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(LS_DOC_TOMB_PREFIX) === 0) {
            var tid = k.slice(LS_DOC_TOMB_PREFIX.length);
            var tts = parseInt(localStorage.getItem(k) || '0', 10);
            if (tts > (ndel[tid] || 0)) ndel[tid] = tts;
          }
        }
        // Drop any doc a deletion supersedes, and its file.
        Object.keys(ndocs).forEach(function(id) {
          if ((ndel[id] || 0) > ndocs[id].updatedAt) {
            delete ndocs[id];
            if (data.files[docFile(id)]) files[docFile(id)] = null;
          }
        });

        var next = JSON.stringify({ docs: ndocs, deletions: ndel });
        if (Object.keys(files).length === 0 && next === JSON.stringify({ docs: rdocs, deletions: rdel })) return true;
        files[GIST_FILE_MD_INDEX] = { content: JSON.stringify({ docs: ndocs, deletions: ndel }, null, 2) };
        var resp = await fetch(API + '/gists/' + c.gistId, {
          method: 'PATCH', headers: h(c.pat), body: JSON.stringify({ files: files })
        });
        return resp.ok;
      } catch(e) { return false; }
    },

    // Pull first so a stale local push can't clobber another device's newer
    // edit, then push local changes out. Returns {ok, changed:[ids]}.
    syncDocs: async function() {
      var res = await w.Gist.pullDocs();
      if (!res.ok) return res;
      res.ok = await w.Gist.pushDocs();
      return res;
    }
  };
})(window);
