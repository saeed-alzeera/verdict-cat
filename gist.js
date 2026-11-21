(function(w) {
  var TS_SUFFIX = ':ts';

  // Sync backend: the verdict-cat-sync Cloudflare Worker. Each person has their
  // own account (username + password chosen on this site, no real-world
  // identity) and an auto-generated sync key. The key is what every request
  // sends; the password is only for getting the key onto a new device.
  var WORKER    = 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';
  var LS_KEY    = 'verdict-cat-sync-key';
  var LS_USER   = 'verdict-cat-username';
  var WORKER_ID = 'worker';  // sentinel returned by connect()

  // Custom regions (numbers.html) are synced in the 'regions' namespace.
  var LS_REGION_PREFIX    = 'vc-region:';
  var LS_REGION_TOMB_PREFIX = 'vc-region-tomb:';

  function tsKey(k) { return k + TS_SUFFIX; }

  function syncKey() { return localStorage.getItem(LS_KEY) || ''; }
  function mode() { return syncKey() ? 'worker' : null; }

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
      w.Gist.lastError = 'Sync key rejected — sign in again.';
      throw new Error(w.Gist.lastError);
    }
    if (!resp.ok) {
      var detail = '';
      try { detail = (await resp.json()).error || ''; } catch(e) {}
      w.Gist.lastError = detail || ('Sync server error (' + resp.status + ').');
      throw new Error(w.Gist.lastError);
    }
    w.Gist.lastError = null;
    return resp.json();
  }

  // Auth calls that run before there is a key (signup / login).
  async function authPost(path, body) {
    var resp;
    try {
      resp = await fetch(WORKER + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } catch(e) { throw new Error('Could not reach the sync server.'); }
    var data = {};
    try { data = await resp.json(); } catch(e) {}
    if (!resp.ok) throw new Error(data.error || ('Sync server error (' + resp.status + ').'));
    return data;
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

  function setSession(key, username) {
    localStorage.setItem(LS_KEY, key);
    if (username) localStorage.setItem(LS_USER, username); else localStorage.removeItem(LS_USER);
  }

  w.Gist = {
    // 'worker' | null — whether this device has a sync key.
    mode: mode,
    lastError: null,
    workerUrl: WORKER,
    syncKey: syncKey,
    username: function() { return localStorage.getItem(LS_USER) || ''; },

    isConnected: function() {
      return mode() !== null;
    },
    // save(key) stores a key pasted by hand (owner key, or a per-user key).
    save: function(secret) {
      localStorage.setItem(LS_KEY, secret);
    },
    clear: function() {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_USER);
      // Also end the server-side session, or the cookie would keep this device signed in.
      try { fetch('/__logout', { method: 'POST', keepalive: true, credentials: 'same-origin' }); } catch(e) {}
    },

    // Records that a progress key was just written locally, so pull() can
    // tell whether a remote value is actually newer before overwriting it.
    touchProgress: function(key, ts) {
      touch(key, ts || Date.now());
    },

    // Check a pasted sync key. Returns WORKER_ID when the server accepts it.
    connect: async function(secret) {
      var resp0;
      try {
        resp0 = await fetch(WORKER + '/ping', { headers: { 'Authorization': 'Bearer ' + secret } });
      } catch(e) { throw new Error('Could not reach the sync server.'); }
      if (resp0.status === 401) throw new Error('Sync key not recognised.');
      if (!resp0.ok) throw new Error('Sync server error (' + resp0.status + ').');
      return WORKER_ID;
    },

    // ── Accounts ───────────────────────────────────────────────────────────
    account: {
      signup: async function(username, password, invite) {
        var d = await authPost('/auth/signup', { username: username, password: password, invite: invite });
        setSession(d.key, d.username);
        return d;
      },
      login: async function(username, password) {
        var d = await authPost('/auth/login', { username: username, password: password });
        setSession(d.key, d.username);
        return d;
      },
      me: function() { return wfetch('/auth/me'); },
      changePassword: function(password) {
        return wfetch('/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password }) });
      },
      // Issues a new key and signs every other device out.
      rotateKey: async function(password) {
        var d = await wfetch('/auth/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password }) });
        setSession(d.key, w.Gist.username());
        return d;
      },
      remove: async function() {
        await wfetch('/auth/account', { method: 'DELETE' });
        w.Gist.clear();
      },
      // Owner key only.
      invites: {
        list: async function() { return (await wfetch('/admin/invites')).invites || []; },
        create: async function(label) {
          return wfetch('/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: label || '' }) });
        },
        remove: function(code) { return wfetch('/admin/invites/' + encodeURIComponent(code), { method: 'DELETE' }); }
      },
      users: {
        list: async function() { return (await wfetch('/admin/users')).users || []; },
        create: function(username, password) {
          return wfetch('/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, password: password }) });
        },
        setAdmin: function(name, flag) {
          return wfetch('/admin/users/' + encodeURIComponent(name) + '/' + (flag ? 'admin' : 'unadmin'), { method: 'POST' });
        },
        setPassword: function(name, password) {
          return wfetch('/admin/users/' + encodeURIComponent(name) + '/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password }) });
        },
        remove: function(name) { return wfetch('/admin/users/' + encodeURIComponent(name), { method: 'DELETE' }); },
        setDisabled: function(name, disabled) {
          return wfetch('/admin/users/' + encodeURIComponent(name) + '/' + (disabled ? 'disable' : 'enable'), { method: 'POST' });
        }
      }
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

    // onlyKey: push just that one progress key (what the reader does). With no
    // key, every key that has a real timestamp is pushed. A key with no
    // timestamp is never pushed: inventing "now" for it would let a stale
    // position beat newer progress from another device.
    _workerPush: async function(onlyKey, keepalive) {
      try {
        var entries = {};
        function add(k) {
          if (!k || !k.startsWith('epub-progress:') || k.endsWith(TS_SUFFIX)) return;
          var ts = parseInt(localStorage.getItem(tsKey(k)) || '0', 10);
          var val = localStorage.getItem(k);
          if (!ts || !val) return;
          entries[k] = { value: val, ts: ts };
        }
        if (onlyKey) add(onlyKey);
        else for (var i = 0; i < localStorage.length; i++) add(localStorage.key(i));
        if (!Object.keys(entries).length) return true;
        // keepalive lets the request finish while the page is unloading.
        await workerPostNs('progress', entries, keepalive);
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
    pull:        function() { return w.Gist._workerPull(); },
    push:        function(key, keepalive) { return w.Gist._workerPush(key, keepalive); },
    pullRegions: function() { return w.Gist._workerPullRegions(); },
    pushRegions: function() { return w.Gist._workerPushRegions(); },

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

    // ── Books (uploads without GitHub) ────────────────────────────────────
    books: {
      list: async function() {
        // Books are private: the list needs the key, and file URLs are rewritten
        // to the same-origin /files/ proxy (cookie-gated by the Pages login).
        var resp = await fetch(WORKER + '/books', { cache: 'no-store', headers: { 'Authorization': 'Bearer ' + syncKey() } });
        if (!resp.ok) throw new Error('Book catalogue unavailable (' + resp.status + ')');
        var local = function(u) { return u && u.indexOf(WORKER + '/files/') === 0 ? u.slice(WORKER.length) : u; };
        return ((await resp.json()).books || []).map(function(b) {
          b.epub = local(b.epub); b.cover = local(b.cover); return b;
        });
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

  // ── Account dialog ─────────────────────────────────────────────────────────
  // Self-contained modal: sign in / create account (invite code) / paste a key,
  // and, once signed in, show the key and manage the account.
  // opts: { onChange(): called after sign in/out, onClose(): called on dismiss }
  var dialogCss = '#vc-acct{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '#vc-acct .box{background:#1a1d23;color:#e8eaed;border:1px solid #2e3238;border-radius:14px;padding:22px;width:100%;max-width:380px;max-height:92vh;overflow:auto}' +
    '#vc-acct h2{font-size:17px;font-weight:600;margin-bottom:6px}#vc-acct p{font-size:13px;color:#8b9099;line-height:1.5;margin-bottom:12px}' +
    '#vc-acct .tabs{display:flex;gap:6px;margin-bottom:14px}#vc-acct .tabs button{flex:1;padding:7px 4px;font-size:12px;border-radius:8px;border:1px solid #2e3238;background:transparent;color:#8b9099;cursor:pointer}' +
    '#vc-acct .tabs button.on{background:#5b9bd5;border-color:#5b9bd5;color:#fff}' +
    '#vc-acct input{width:100%;padding:10px 12px;margin-bottom:10px;background:#0f1117;color:#e8eaed;border:1px solid #2e3238;border-radius:8px;font-size:14px;outline:none}#vc-acct input:focus{border-color:#5b9bd5}' +
    '#vc-acct .btn{width:100%;padding:10px;margin-top:2px;margin-bottom:8px;border-radius:8px;border:1px solid #2e3238;background:#2a2e36;color:#e8eaed;font-size:14px;cursor:pointer}' +
    '#vc-acct .btn.pri{background:#5b9bd5;border-color:#5b9bd5;color:#fff}#vc-acct .btn.bad{color:#e05c5c}#vc-acct .btn:disabled{opacity:.5;cursor:default}' +
    '#vc-acct .msg{min-height:1.2em;font-size:12px;margin-bottom:10px;color:#8b9099}#vc-acct .msg.err{color:#e05c5c}#vc-acct .msg.ok{color:#4caf82}' +
    '#vc-acct .keybox{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;background:#0f1117;border:1px solid #2e3238;border-radius:8px;padding:10px;margin-bottom:10px}' +
    '#vc-acct .note{font-size:11.5px;color:#8b9099;background:#0f1117;border:1px solid #2e3238;border-radius:8px;padding:9px 10px;margin-bottom:12px;line-height:1.45}';

  w.Gist.showAccountDialog = function(opts) {
    opts = opts || {};
    var old = document.getElementById('vc-acct'); if (old) old.remove();
    if (!document.getElementById('vc-acct-css')) {
      var st = document.createElement('style'); st.id = 'vc-acct-css'; st.textContent = dialogCss; document.head.appendChild(st);
    }
    var root = document.createElement('div'); root.id = 'vc-acct';
    var box = document.createElement('div'); box.className = 'box'; root.appendChild(box);
    document.body.appendChild(root);

    function close() { root.remove(); if (opts.onClose) opts.onClose(); }
    function changed() { if (opts.onChange) opts.onChange(); }
    root.addEventListener('mousedown', function(e) { if (e.target === root) close(); });
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function input(type, ph, ac) { var i = el('input'); i.type = type; i.placeholder = ph; i.autocomplete = ac || 'off'; i.autocapitalize = 'none'; i.spellcheck = false; return i; }
    function button(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.addEventListener('click', fn); return b; }
    function run(btn, msg, fn) {
      var label = btn.textContent; btn.disabled = true; msg.className = 'msg'; msg.textContent = '';
      fn().then(function() { btn.disabled = false; btn.textContent = label; }, function(err) {
        btn.disabled = false; btn.textContent = label; msg.className = 'msg err'; msg.textContent = err.message || 'Something went wrong.';
      });
    }

    function signedOut(tab) {
      box.textContent = '';
      box.appendChild(el('h2', '', 'Sync'));
      box.appendChild(el('p', '', 'Your account keeps your reading progress and lets you upload books. Pick any username and password; nothing links it to a real identity.'));
      var tabs = el('div', 'tabs');
      [['in', 'Sign in'], ['up', 'Create account'], ['key', 'Paste key']].forEach(function(t) {
        var b = el('button', tab === t[0] ? 'on' : '', t[1]); b.addEventListener('click', function() { signedOut(t[0]); }); tabs.appendChild(b);
      });
      box.appendChild(tabs);
      var msg = el('div', 'msg');
      var go;
      if (tab === 'key') {
        var k = input('password', 'Sync key');
        go = button('Connect', 'pri', function() { run(go, msg, async function() {
          var v = k.value.trim(); if (!v) throw new Error('Paste a key first.');
          await w.Gist.connect(v); w.Gist.save(v); signedIn(); changed();
        }); });
        box.appendChild(k); box.appendChild(msg); box.appendChild(go);
      } else {
        var u = input('text', 'Username', 'username');
        var p = input('password', 'Password', tab === 'up' ? 'new-password' : 'current-password');
        box.appendChild(u); box.appendChild(p);
        var inv = null;
        if (tab === 'up') {
          inv = input('text', 'Invite code (from Saeed)');
          box.appendChild(inv);
          box.appendChild(el('div', 'note', 'There is no email and no password reset. If you forget the password you can still use this device (and any others already signed in), but you cannot sign in on a new one.'));
        }
        go = button(tab === 'up' ? 'Create account' : 'Sign in', 'pri', function() { run(go, msg, async function() {
          var name = u.value.trim().toLowerCase();
          if (!name || !p.value) throw new Error('Enter a username and password.');
          if (tab === 'up') await w.Gist.account.signup(name, p.value, inv.value.trim());
          else await w.Gist.account.login(name, p.value);
          signedIn(); changed();
        }); });
        p.addEventListener('keydown', function(e) { if (e.key === 'Enter') go.click(); });
        box.appendChild(msg); box.appendChild(go);
      }
      box.appendChild(button('Not now', '', close));
    }

    function signedIn() {
      box.textContent = '';
      var name = w.Gist.username();
      box.appendChild(el('h2', '', name ? 'Signed in as ' + name : 'Connected'));
      box.appendChild(el('p', '', name ? 'Reading progress, regions and snippets sync to this account on every device where you sign in.' : 'This device uses a sync key pasted by hand.'));
      var msg = el('div', 'msg');
      var keyBox = el('div', 'keybox'); keyBox.style.display = 'none'; keyBox.textContent = w.Gist.syncKey();
      var show = button('Show / copy sync key', '', function() {
        keyBox.style.display = keyBox.style.display === 'none' ? '' : 'none';
        try { navigator.clipboard.writeText(w.Gist.syncKey()); msg.className = 'msg ok'; msg.textContent = 'Key copied.'; } catch(e) {}
      });
      box.appendChild(show); box.appendChild(keyBox);
      if (name) {
        var np = input('password', 'New password', 'new-password');
        var cp = button('Change password', '', function() { run(cp, msg, async function() {
          if (!np.value) throw new Error('Enter a new password.');
          await w.Gist.account.changePassword(np.value); np.value = ''; msg.className = 'msg ok'; msg.textContent = 'Password changed.';
        }); });
        var rp = input('password', 'Current password (to rotate key)', 'current-password');
        var rk = button('Rotate key (signs out other devices)', '', function() { run(rk, msg, async function() {
          if (!rp.value) throw new Error('Enter your current password.');
          await w.Gist.account.rotateKey(rp.value); rp.value = ''; keyBox.textContent = w.Gist.syncKey(); msg.className = 'msg ok'; msg.textContent = 'New key issued. Other devices must sign in again.'; changed();
        }); });
        box.appendChild(np); box.appendChild(cp); box.appendChild(rp); box.appendChild(rk);
      }
      box.appendChild(msg);
      box.appendChild(button('Sign out of this device', '', function() { w.Gist.clear(); signedOut('in'); changed(); }));
      if (name) {
        var del = button('Delete account and its synced data', 'bad', function() {
          if (!confirm('Delete this account and everything synced to it? Local progress on this device stays. This cannot be undone.')) return;
          run(del, msg, async function() { await w.Gist.account.remove(); signedOut('in'); changed(); });
        });
        box.appendChild(del);
      }
      box.appendChild(button('Close', '', close));
    }

    if (w.Gist.isConnected()) signedIn(); else signedOut(opts.tab || 'in');
  };

})(window);
