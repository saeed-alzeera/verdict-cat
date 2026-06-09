(function(w) {
  var GIST_DESC = 'verdict-cat reading progress';
  var GIST_FILE = 'verdict-cat-progress.json';
  var LS_PAT    = 'verdict-cat-pat';
  var LS_GIST   = 'verdict-cat-gist-id';
  var API       = 'https://api.github.com';

  function h(pat) {
    return { 'Authorization': 'token ' + pat, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
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

    // Pull remote progress into localStorage
    pull: async function() {
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return;
      try {
        var resp = await fetch(API + '/gists/' + c.gistId, { headers: h(c.pat) });
        if (!resp.ok) return;
        var data = await resp.json();
        var remote = JSON.parse((data.files[GIST_FILE] || {}).content || '{}');
        Object.keys(remote).forEach(function(k) {
          if (k.startsWith('epub-progress:')) localStorage.setItem(k, remote[k]);
        });
      } catch(e) {}
    },

    // Push all local progress to gist (silent fail — localStorage is always the fast path)
    push: async function() {
      var c = w.Gist.credentials();
      if (!c.pat || !c.gistId) return;
      try {
        var progress = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.startsWith('epub-progress:')) progress[k] = localStorage.getItem(k);
        }
        await fetch(API + '/gists/' + c.gistId, {
          method: 'PATCH', headers: h(c.pat),
          body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(progress, null, 2) } } })
        });
      } catch(e) {}
    }
  };
})(window);
