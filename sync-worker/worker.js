/*
 * gastat-data-aggregator sync + book storage.
 *
 * Replaces the GitHub gist (progress/regions/snippets sync) and the GitHub
 * Contents API (book uploads) so the site no longer depends on a personal
 * access token that can expire or be revoked.
 *
 *   Auth: writes (and all /sync reads) need  Authorization: Bearer <key>.
 *         <key> is either the owner key (SYNC_KEY Worker secret; full access,
 *         data in the original unprefixed namespaces) or a per-user key
 *         "vck_<uid>_<secret>" created at signup. A user key only ever reads and
 *         writes that user's own sync namespaces. Book catalogue and files are
 *         public to read, matching the public repo they used to live in.
 *
 *   POST   /auth/signup            { username, password, invite } -> { key, username }
 *   POST   /auth/login             { username, password }         -> { key, username }
 *   GET    /auth/me                -> { username, owner }
 *   GET    /auth/names             -> { users: [username, ...] }  enabled accounts (any valid key; used by Scrabble's player list)
 *   POST   /auth/password          { password }  (key required)  set a new password
 *   POST   /auth/rotate            { password }  (key required)  new key, old one dies
 *   DELETE /auth/account           (key required) deletes the account and its sync data
 *   GET/POST /admin/invites, DELETE /admin/invites/:code, GET /admin/users,
 *   POST /admin/users { username, password }, POST /admin/users/:name/password { password }, POST /admin/users/:name/(admin|unadmin) (owner key only; admin users can use the rest of /admin but not Clyde or the owner's data), DELETE /admin/users/:name, POST /admin/users/:name/(disable|enable)   owner key only
 *
 *   GET    /ping                   auth check
 *   GET    /sync/:ns               -> { entries: { key: { value, ts } } }
 *   POST   /sync/:ns               { entries: { key: { value, ts } } }
 *                                  last-writer-wins per key; returns merged ns
 *   GET    /books                  -> { books: [...] }  (key required; includes hidden markers)
 *   PUT    /books/:slug            multipart: title, author, epub, [cover]
 *   DELETE /books/:slug            removes files; for a slug with no upload
 *                                  (a book baked into library.html) records a
 *                                  "hidden" marker instead
 *   GET    /files/*                epub / cover bytes (key required)
 */
import { DurableObject } from 'cloudflare:workers';

// Files are stored as 1 MiB chunks in the Durable Object's SQLite (a row is
// limited to 2 MB), and move to/from the DO in one RPC message (32 MiB limit).
const CHUNK_BYTES = 1024 * 1024;
const MAX_EPUB_BYTES = 25 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,150}$/;
const CLYDE_MAX_RESULT = 100000;
const CLYDE_THREAD_TURNS = 5;     // earlier turns handed to a follow-up
const CLYDE_TURN_PROMPT_CHARS = 4000;
const CLYDE_TURN_RESULT_CHARS = 6000;
const CLYDE_TIMEOUT_MS = 10 * 60 * 1000;
const CLYDE_KEEP_MS = 30 * 24 * 3600 * 1000;
const NS_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const USER_KEY_RE = /^vck_([0-9a-f]{16})_([A-Za-z0-9_-]{32})$/;
// Cloudflare Workers caps WebCrypto PBKDF2 at 100,000 iterations.
const PBKDF2_ITER = 100000;
const LOGIN_FREE_FAILS = 5;            // failures allowed before lockout starts
const LOGIN_LOCK_MAX_MS = 15 * 60 * 1000;
const SIGNUP_PER_HOUR = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Clyde-Secret',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

function fail(status, message) {
  return json({ error: message }, status);
}

function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function wrapPrompt(prompt, resultUrl, secret) {
  return [
    'This request comes from the Clyde page. Carry out the task at the bottom.',
    '',
    'When you are finished, send your final answer back by writing it to a temporary file and running:',
    `curl -sS -X POST '${resultUrl}' -H 'X-Clyde-Secret: ${secret}' -H 'Content-Type: text/markdown' --data-binary @<file>`,
    '',
    'Rules for the answer:',
    '- Markdown format, plain text only.',
    '- Never include hyperlinks. Do not write [text](url) links or clickable URLs; if a URL matters, write it inside backticks.',
    '- Do not mention the posting step. If the task fails, post a short explanation of why instead.',
    '',
    'Task:',
    prompt,
  ].join('\n');
}

// ── Accounts ────────────────────────────────────────────────────────────
const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function toB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function randomB64url(bytes) {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
async function sha256Bytes(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : new Uint8Array(p)));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

// One PBKDF2 run per login yields dk. From it: a verifier (proves the
// password) and a wrapping key (decrypts the user's sync key, which is never
// stored in the clear, so a login on a new device can hand the same key back).
async function derive(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const dk = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, base, 256);
  return {
    verifier: toHex(await sha256Bytes('verify', dk)),
    wrapRaw: await sha256Bytes('wrap', dk),
  };
}
async function wrapKey(wrapRaw, plaintext) {
  const k = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(plaintext)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return toB64(out);
}
async function unwrapKey(wrapRaw, blob) {
  const k = await crypto.subtle.importKey('raw', wrapRaw, 'AES-GCM', false, ['decrypt']);
  const all = fromB64(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, k, all.slice(12));
  return new TextDecoder().decode(pt);
}
function newUserKey(uid) {
  return 'vck_' + uid + '_' + randomB64url(24);
}
async function credentialRecord(password, key) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { verifier, wrapRaw } = await derive(password, salt);
  const secret = USER_KEY_RE.exec(key)[2];  // the secret may itself contain '_'
  return {
    salt: toB64(salt), pw_verifier: verifier,
    key_hash: await sha256Hex(secret), key_wrapped: await wrapKey(wrapRaw, key),
  };
}

// Resolves a request to { uid, owner, prefix } or null. The owner key is the
// original SYNC_KEY secret; its data stays in the unprefixed namespaces.
async function authenticate(request, env, store) {
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given) return null;
  if (env.SYNC_KEY && (await sameSecret(given, env.SYNC_KEY))) {
    return { uid: 'owner', owner: true, prefix: '', username: null };
  }
  const m = USER_KEY_RE.exec(given);
  if (!m) return null;
  const user = await store.userByUid(m[1]);
  if (!user || user.disabled) return null;
  if (!(await sameSecret(await sha256Hex(m[2]), user.key_hash))) return null;
  return { uid: user.uid, owner: false, admin: !!user.admin, prefix: 'u' + user.uid + ':', username: user.username };
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

export class SyncStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT, ts INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      );
      CREATE TABLE IF NOT EXISTS blob_meta (
        key TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blob_chunks (
        key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (key, idx)
      );
      CREATE TABLE IF NOT EXISTS books (
        slug TEXT PRIMARY KEY, title TEXT, author TEXT,
        epub_key TEXT, cover_key TEXT, hidden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        salt TEXT NOT NULL, pw_verifier TEXT NOT NULL,
        key_hash TEXT NOT NULL, key_wrapped TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, label TEXT, created_at INTEGER NOT NULL,
        used_by TEXT, used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS attempts (
        k TEXT PRIMARY KEY, count INTEGER NOT NULL, first_ts INTEGER NOT NULL, until INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Who uploaded a book (null for books that predate accounts).
    try { this.sql.exec('ALTER TABLE books ADD COLUMN uploader TEXT'); } catch (e) { /* already there */ }
    try { this.sql.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already there */ }
  }

  // ── Accounts ───────────────────────────────────────────────────────────
  userByUid(uid) {
    return [...this.sql.exec('SELECT * FROM users WHERE uid = ?', uid)][0] || null;
  }
  userByName(username) {
    return [...this.sql.exec('SELECT * FROM users WHERE username = ?', username)][0] || null;
  }
  listUsers() {
    return [...this.sql.exec('SELECT uid, username, disabled, admin, created_at FROM users ORDER BY created_at')];
  }
  // Atomically spends an invite and creates the account. Returns an error string or null.
  createUser(u, invite) {
    let err = null;
    this.ctx.storage.transactionSync(() => {
      const inv = [...this.sql.exec('SELECT used_by FROM invites WHERE code = ?', invite)][0];
      if (!inv || inv.used_by) { err = 'Invite code is invalid or already used'; return; }
      if (this.userByName(u.username)) { err = 'That username is taken'; return; }
      this.sql.exec(
        `INSERT INTO users (uid, username, salt, pw_verifier, key_hash, key_wrapped, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        u.uid, u.username, u.salt, u.pw_verifier, u.key_hash, u.key_wrapped, Date.now()
      );
      this.sql.exec('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?', u.username, Date.now(), invite);
    });
    return err;
  }
  // Owner-created account (no invite). Returns an error string or null.
  createUserDirect(u) {
    let err = null;
    this.ctx.storage.transactionSync(() => {
      if (this.userByName(u.username)) { err = 'That username is taken'; return; }
      this.sql.exec(
        `INSERT INTO users (uid, username, salt, pw_verifier, key_hash, key_wrapped, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        u.uid, u.username, u.salt, u.pw_verifier, u.key_hash, u.key_wrapped, Date.now()
      );
    });
    return err;
  }
  setCredentials(uid, c) {
    this.sql.exec(
      'UPDATE users SET salt = ?, pw_verifier = ?, key_hash = ?, key_wrapped = ? WHERE uid = ?',
      c.salt, c.pw_verifier, c.key_hash, c.key_wrapped, uid
    );
  }
  setAdmin(username, flag) {
    this.sql.exec('UPDATE users SET admin = ? WHERE username = ?', flag ? 1 : 0, username);
    return this.sql.exec('SELECT 1 FROM users WHERE username = ?', username).toArray().length > 0;
  }
  setDisabled(username, flag) {
    this.sql.exec('UPDATE users SET disabled = ? WHERE username = ?', flag ? 1 : 0, username);
    return this.sql.exec('SELECT 1 FROM users WHERE username = ?', username).toArray().length > 0;
  }
  deleteUser(uid) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM kv WHERE ns LIKE ?', 'u' + uid + ':%');
      this.sql.exec('DELETE FROM users WHERE uid = ?', uid);
    });
  }
  createInvite(code, label) {
    this.sql.exec('INSERT INTO invites (code, label, created_at) VALUES (?, ?, ?)', code, label, Date.now());
  }
  listInvites() {
    return [...this.sql.exec('SELECT code, label, created_at, used_by, used_at FROM invites ORDER BY created_at DESC')];
  }
  deleteInvite(code) {
    this.sql.exec('DELETE FROM invites WHERE code = ? AND used_by IS NULL', code);
  }

  // ── Rate limits ────────────────────────────────────────────────────────
  // Seconds a login on any of these keys must still wait (0 = allowed).
  lockWait(keys) {
    const now = Date.now();
    let wait = 0;
    for (const k of keys) {
      const r = [...this.sql.exec('SELECT until FROM attempts WHERE k = ?', k)][0];
      if (r && r.until > now) wait = Math.max(wait, Math.ceil((r.until - now) / 1000));
    }
    return wait;
  }
  loginFailed(keys) {
    const now = Date.now();
    for (const k of keys) {
      const r = [...this.sql.exec('SELECT count FROM attempts WHERE k = ?', k)][0];
      const count = (r ? r.count : 0) + 1;
      const over = count - LOGIN_FREE_FAILS;
      const until = over >= 0 ? now + Math.min(LOGIN_LOCK_MAX_MS, 30000 * Math.pow(2, over)) : 0;
      this.sql.exec(
        `INSERT INTO attempts (k, count, first_ts, until) VALUES (?, ?, ?, ?)
         ON CONFLICT (k) DO UPDATE SET count = excluded.count, until = excluded.until`,
        k, count, now, until
      );
    }
  }
  loginOk(keys) {
    for (const k of keys) this.sql.exec('DELETE FROM attempts WHERE k = ?', k);
  }
  // Counts a signup attempt for this IP; false when over the hourly limit.
  signupAllowed(ip) {
    const k = 'signup:' + ip, now = Date.now();
    const r = [...this.sql.exec('SELECT count, first_ts FROM attempts WHERE k = ?', k)][0];
    if (!r || now - r.first_ts > 3600000) {
      this.sql.exec(
        `INSERT INTO attempts (k, count, first_ts, until) VALUES (?, 1, ?, 0)
         ON CONFLICT (k) DO UPDATE SET count = 1, first_ts = excluded.first_ts`, k, now);
      return true;
    }
    if (r.count >= SIGNUP_PER_HOUR) return false;
    this.sql.exec('UPDATE attempts SET count = count + 1 WHERE k = ?', k);
    return true;
  }

  getNs(ns) {
    const out = {};
    for (const r of this.sql.exec('SELECT key, value, ts FROM kv WHERE ns = ?', ns)) {
      out[r.key] = { value: r.value === null ? null : JSON.parse(r.value), ts: r.ts };
    }
    return out;
  }

  mergeNs(ns, entries) {
    this.ctx.storage.transactionSync(() => {
      for (const [key, e] of Object.entries(entries)) {
        this.sql.exec(
          `INSERT INTO kv (ns, key, value, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, ts = excluded.ts
           WHERE excluded.ts >= kv.ts`,
          ns, key, JSON.stringify(e.value ?? null), e.ts
        );
      }
    });
    return this.getNs(ns);
  }

  // ── Clyde runs (kv rows in ns 'clyde-run') ─────────────────────────────
  getRun(id) {
    const r = [...this.sql.exec("SELECT value FROM kv WHERE ns = 'clyde-run' AND key = ?", id)][0];
    return r ? JSON.parse(r.value) : null;
  }

  putRun(id, rec) {
    this.sql.exec(
      `INSERT INTO kv (ns, key, value, ts) VALUES ('clyde-run', ?, ?, ?)
       ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
      id, JSON.stringify(rec), Date.now()
    );
  }

  deleteRun(id) {
    this.sql.exec("DELETE FROM kv WHERE ns = 'clyde-run' AND key = ?", id);
  }

  pruneRuns(olderThanMs) {
    this.sql.exec("DELETE FROM kv WHERE ns = 'clyde-run' AND ts < ?", Date.now() - olderThanMs);
  }

  // ── File storage (epubs, covers) ───────────────────────────────────────
  putBlob(key, type, bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
    const etag = '"' + Date.now().toString(36) + '-' + buf.byteLength.toString(36) + '"';
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM blob_chunks WHERE key = ?', key);
      for (let off = 0, idx = 0; off < buf.byteLength || idx === 0; off += CHUNK_BYTES, idx++) {
        this.sql.exec('INSERT INTO blob_chunks (key, idx, data) VALUES (?, ?, ?)', key, idx, buf.slice(off, off + CHUNK_BYTES));
      }
      this.sql.exec(
        `INSERT INTO blob_meta (key, type, size, etag) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET type = excluded.type, size = excluded.size, etag = excluded.etag`,
        key, type, buf.byteLength, etag
      );
    });
  }

  // Returns { type, etag, size } and, unless metaOnly, the bytes as an ArrayBuffer.
  getBlob(key, metaOnly) {
    const meta = [...this.sql.exec('SELECT type, size, etag FROM blob_meta WHERE key = ?', key)][0];
    if (!meta) return null;
    if (metaOnly) return { type: meta.type, etag: meta.etag, size: meta.size };
    const out = new Uint8Array(meta.size);
    let off = 0;
    for (const r of this.sql.exec('SELECT data FROM blob_chunks WHERE key = ? ORDER BY idx', key)) {
      const chunk = new Uint8Array(r.data);
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    return { type: meta.type, etag: meta.etag, size: meta.size, bytes: out.buffer };
  }

  deleteBlobs(keys) {
    this.ctx.storage.transactionSync(() => {
      for (const key of keys) {
        this.sql.exec('DELETE FROM blob_chunks WHERE key = ?', key);
        this.sql.exec('DELETE FROM blob_meta WHERE key = ?', key);
      }
    });
  }

  listBooks() {
    return [...this.sql.exec(
      'SELECT slug, title, author, epub_key, cover_key, hidden, created_at FROM books ORDER BY created_at'
    )];
  }

  getBook(slug) {
    return [...this.sql.exec('SELECT * FROM books WHERE slug = ?', slug)][0] || null;
  }

  putBook(b) {
    this.sql.exec(
      `INSERT INTO books (slug, title, author, epub_key, cover_key, hidden, created_at, uploader)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET title = excluded.title, author = excluded.author,
         epub_key = excluded.epub_key, cover_key = excluded.cover_key, hidden = 0,
         uploader = excluded.uploader`,
      b.slug, b.title, b.author, b.epub_key, b.cover_key, b.created_at, b.uploader
    );
  }

  // Returns the removed row (so the caller can delete its files), or
  // null if there was none — in which case a hidden marker is recorded.
  removeBook(slug) {
    const row = this.getBook(slug);
    if (row && !row.hidden) {
      this.sql.exec('DELETE FROM books WHERE slug = ?', slug);
      return row;
    }
    this.sql.exec(
      `INSERT INTO books (slug, title, author, epub_key, cover_key, hidden, created_at)
       VALUES (?, '', '', NULL, NULL, 1, ?) ON CONFLICT (slug) DO NOTHING`,
      slug, Date.now()
    );
    return null;
  }
}

function bookJson(row, origin) {
  const file = (k) => (k ? origin + '/files/' + k : null);
  return {
    slug: row.slug, title: row.title, author: row.author,
    epub: file(row.epub_key), cover: file(row.cover_key),
    hidden: !!row.hidden, createdAt: row.created_at,
  };
}

function extFor(file) {
  if (/png/i.test(file.type) || /\.png$/i.test(file.name || '')) return 'png';
  return 'jpg';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const store = env.STORE.get(env.STORE.idFromName('main'));
    const origin = url.origin;
    const isRead = request.method === 'GET' || request.method === 'HEAD';

    // Catalogue and files need a valid key: books are not public.
    if (isRead && (parts[0] === 'files' || parts[0] === 'books')) {
      if (!(await authenticate(request, env, store))) return fail(401, 'Sign in required');
    }
    if (isRead && parts[0] === 'files' && parts.length > 1) {
      const key = parts.slice(1).join('/');
      const meta = await store.getBlob(key, true);
      if (!meta) return fail(404, 'Not found');
      const headers = new Headers(CORS);
      headers.set('Content-Type', meta.type);
      headers.set('ETag', meta.etag);
      headers.set('Cache-Control', 'private, max-age=3600');
      // Revalidating clients skip the (comparatively expensive) chunk read.
      if (request.headers.get('If-None-Match') === meta.etag) return new Response(null, { status: 304, headers });
      if (request.method === 'HEAD') {
        headers.set('Content-Length', String(meta.size));
        return new Response(null, { headers });
      }
      const file = await store.getBlob(key);
      return new Response(file.bytes, { headers });
    }
    if (isRead && parts[0] === 'books' && parts.length === 1) {
      const rows = await store.listBooks();
      return json({ books: rows.map((r) => bookJson(r, origin)) });
    }

    // Clyde result callback: authenticated by the per-run secret, not the sync key.
    if (parts[0] === 'clyde' && parts[1] === 'result' && parts.length === 3 && request.method === 'POST') {
      const run = await store.getRun(parts[2]);
      // The secret travels in X-Clyde-Secret: some sandboxes' proxies rewrite the
      // Authorization header with the sync key, so that header can't carry it.
      // A valid sync key in Authorization is accepted too.
      const given = request.headers.get('X-Clyde-Secret') || url.searchParams.get('s') || '';
      const who0 = given ? null : await authenticate(request, env, store);
      const ok = run && ((given && (await sameSecret(given, run.secret))) || (who0 && who0.owner));
      if (!ok) return fail(401, 'Invalid run or secret');
      if (run.status !== 'running') return fail(409, 'Run already finished');
      let text;
      if ((request.headers.get('Content-Type') || '').includes('application/json')) {
        try { const b = await request.json(); text = b && typeof b.result === 'string' ? b.result : ''; }
        catch (e) { return fail(400, 'Invalid JSON'); }
      } else {
        text = await request.text();
      }
      text = text.trim();
      if (!text) return fail(400, 'Empty result');
      if (text.length > CLYDE_MAX_RESULT) text = text.slice(0, CLYDE_MAX_RESULT) + '\n\n(truncated)';
      await store.putRun(parts[2], { ...run, status: 'done', result: text, finished: Date.now() });
      return json({ ok: true });
    }

    // ── Account creation / login (no key yet) ────────────────────────────
    if (parts[0] === 'auth' && parts.length === 2 && request.method === 'POST' &&
        (parts[1] === 'signup' || parts[1] === 'login')) {
      const body = await readJson(request);
      const username = body && typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      const password = body && typeof body.password === 'string' ? body.password : '';
      if (!USERNAME_RE.test(username)) return fail(400, 'Username must be 3-24 characters: a-z, 0-9, - or _');
      if (!password) return fail(400, 'Password required');
      if (password.length > 256) return fail(400, 'Password too long');
      const ip = clientIp(request);

      if (parts[1] === 'signup') {
        const invite = body && typeof body.invite === 'string' ? body.invite.trim().toLowerCase() : '';
        if (!invite) return fail(400, 'Invite code required');
        if (!(await store.signupAllowed(ip))) return fail(429, 'Too many signups from this network. Try again later.');
        const uid = randomHex(8);
        const key = newUserKey(uid);
        const rec = { uid, username, ...(await credentialRecord(password, key)) };
        const err = await store.createUser(rec, invite);
        if (err) return fail(err.startsWith('That') ? 409 : 403, err);
        return json({ ok: true, username, key });
      }

      // login
      const lockKeys = ['login:u:' + username, 'login:ip:' + ip];
      const wait = await store.lockWait(lockKeys);
      if (wait) return json({ error: `Too many attempts. Try again in ${wait} seconds.` }, 429, { 'Retry-After': String(wait) });
      const user = await store.userByName(username);
      // Unknown usernames still pay for a hash, so timing doesn't reveal them.
      const salt = user ? fromB64(user.salt) : new Uint8Array(16);
      const { verifier, wrapRaw } = await derive(password, salt);
      if (!user || user.disabled || !(await sameSecret(verifier, user.pw_verifier))) {
        await store.loginFailed(lockKeys);
        return fail(401, 'Wrong username or password');
      }
      await store.loginOk(lockKeys);
      let key;
      try { key = await unwrapKey(wrapRaw, user.key_wrapped); } catch (e) { return fail(500, 'Could not recover key'); }
      return json({ ok: true, username, key });
    }

    // Everything below needs a key.
    const who = await authenticate(request, env, store);
    if (!who) return fail(401, 'Invalid or missing sync key');

    if (parts[0] === 'ping' && parts.length === 1) return json({ ok: true });

    if (parts[0] === 'auth') {
      if (parts[1] === 'me' && parts.length === 2 && request.method === 'GET') {
        return json({ username: who.username, owner: who.owner, admin: who.owner || !!who.admin });
      }
      if (parts[1] === 'names' && parts.length === 2 && request.method === 'GET') {
        const users = (await store.listUsers()).filter((u) => !u.disabled).map((u) => u.username);
        return json({ users });
      }
      if (who.owner) return fail(400, 'The owner key is not an account');
      if (parts[1] === 'password' && parts.length === 2 && request.method === 'POST') {
        const body = await readJson(request);
        const password = body && typeof body.password === 'string' ? body.password : '';
        if (!password) return fail(400, 'Password required');
        if (password.length > 256) return fail(400, 'Password too long');
        const key = (request.headers.get('Authorization') || '').slice(7);
        await store.setCredentials(who.uid, await credentialRecord(password, key));
        return json({ ok: true });
      }
      if (parts[1] === 'rotate' && parts.length === 2 && request.method === 'POST') {
        const body = await readJson(request);
        const password = body && typeof body.password === 'string' ? body.password : '';
        const user = await store.userByUid(who.uid);
        const { verifier } = await derive(password, fromB64(user.salt));
        if (!password || !(await sameSecret(verifier, user.pw_verifier))) return fail(401, 'Wrong password');
        const key = newUserKey(who.uid);
        await store.setCredentials(who.uid, await credentialRecord(password, key));
        return json({ ok: true, key });
      }
      if (parts[1] === 'account' && parts.length === 2 && request.method === 'DELETE') {
        await store.deleteUser(who.uid);
        return json({ ok: true });
      }
      return fail(404, 'Not found');
    }

    // Owner-only: invites, user management, Clyde.
    if (parts[0] === 'admin') {
      if (!who.owner && !who.admin) return fail(403, 'Admin only');
      if (parts[1] === 'users' && parts.length === 4 && request.method === 'POST' &&
          (parts[3] === 'admin' || parts[3] === 'unadmin')) {
        if (!who.owner) return fail(403, 'Owner only');
        const found = await store.setAdmin(parts[2], parts[3] === 'admin');
        return found ? json({ ok: true }) : fail(404, 'No such user');
      }
      if (parts[1] === 'invites' && parts.length === 2 && request.method === 'GET') {
        return json({ invites: await store.listInvites() });
      }
      if (parts[1] === 'invites' && parts.length === 2 && request.method === 'POST') {
        const body = await readJson(request);
        const label = body && typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
        const hex = randomHex(8);
        const code = hex.match(/.{4}/g).join('-');
        await store.createInvite(code, label);
        return json({ ok: true, code });
      }
      if (parts[1] === 'invites' && parts.length === 3 && request.method === 'DELETE') {
        await store.deleteInvite(parts[2]);
        return json({ ok: true });
      }
      if (parts[1] === 'users' && parts.length === 2 && request.method === 'GET') {
        return json({ users: await store.listUsers() });
      }
      if (parts[1] === 'users' && parts.length === 2 && request.method === 'POST') {
        const body = await readJson(request);
        const username = body && typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
        const password = body && typeof body.password === 'string' ? body.password : '';
        if (!USERNAME_RE.test(username)) return fail(400, 'Username must be 3-24 characters: a-z, 0-9, - or _');
        if (!password || password.length > 256) return fail(400, 'Password required (max 256 characters)');
        const uid = randomHex(8);
        const rec = { uid, username, ...(await credentialRecord(password, newUserKey(uid))) };
        const err = await store.createUserDirect(rec);
        if (err) return fail(409, err);
        return json({ ok: true, username });
      }
      if (parts[1] === 'users' && parts.length === 4 && parts[3] === 'password' && request.method === 'POST') {
        const body = await readJson(request);
        const password = body && typeof body.password === 'string' ? body.password : '';
        if (!password || password.length > 256) return fail(400, 'Password required (max 256 characters)');
        const user = await store.userByName(parts[2]);
        if (!user) return fail(404, 'No such user');
        // The old key is wrapped under the old password, so a reset issues a new key
        // and signs the user out everywhere else.
        await store.setCredentials(user.uid, await credentialRecord(password, newUserKey(user.uid)));
        return json({ ok: true });
      }
      if (parts[1] === 'users' && parts.length === 3 && request.method === 'DELETE') {
        const user = await store.userByName(parts[2]);
        if (!user) return fail(404, 'No such user');
        await store.deleteUser(user.uid);
        return json({ ok: true });
      }
      if (parts[1] === 'users' && parts.length === 4 && request.method === 'POST' &&
          (parts[3] === 'disable' || parts[3] === 'enable')) {
        const found = await store.setDisabled(parts[2], parts[3] === 'disable');
        return found ? json({ ok: true }) : fail(404, 'No such user');
      }
      return fail(404, 'Not found');
    }
    if (parts[0] === 'clyde' && !who.owner) return fail(403, 'Owner only');

    // Clyde: forward a prompt to a Claude Code routine, which starts a new
    // session that reads and executes it, then posts its answer back to
    // /clyde/result/:id. The routine token lives only here as a Worker secret.
    if (parts[0] === 'clyde' && parts[1] === 'run' && parts.length === 2 && request.method === 'POST') {
      if (!env.CLYDE_ROUTINE_ID || !env.CLYDE_ROUTINE_TOKEN) {
        return fail(503, 'Clyde is not configured yet (CLYDE_ROUTINE_ID / CLYDE_ROUTINE_TOKEN secrets missing)');
      }
      let body;
      try { body = await request.json(); } catch (e) { return fail(400, 'Invalid JSON'); }
      const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return fail(400, 'prompt required');
      if (prompt.length > 20000) return fail(413, 'Prompt too long (max 20,000 characters)');

      // A reply continues a thread: each run is a fresh session, so the earlier
      // prompts and answers are handed over as context.
      let parent = null, task = prompt;
      if (body.parent != null) {
        if (typeof body.parent !== 'string') return fail(400, 'Bad parent');
        const turns = [];
        let cur = body.parent;
        for (let n = 0; cur && n < CLYDE_THREAD_TURNS; n++) {
          const r = await store.getRun(cur);
          if (!r) { if (n === 0) return fail(404, 'Unknown parent run'); break; }
          if (n === 0) parent = body.parent;
          turns.unshift(
            `User: ${String(r.prompt || '').slice(0, CLYDE_TURN_PROMPT_CHARS)}\n\nAnswer: ${String(r.result || '(no answer)').slice(0, CLYDE_TURN_RESULT_CHARS)}`
          );
          cur = r.parent;
        }
        task = `Earlier in this conversation (oldest first):\n\n${turns.join('\n\n---\n\n')}\n\n=====\nNew message from the user (this is what to answer now):\n${prompt}`;
      }

      const id = crypto.randomUUID();
      const secret = randomHex(24);
      await store.pruneRuns(CLYDE_KEEP_MS);
      await store.putRun(id, { status: 'running', secret, created: Date.now(), result: null, prompt, parent });

      const text = wrapPrompt(task, `${origin}/clyde/result/${id}`, secret);
      let resp;
      try {
        resp = await fetch(
          `https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(env.CLYDE_ROUTINE_ID)}/fire`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.CLYDE_ROUTINE_TOKEN}`,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'experimental-cc-routine-2026-04-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
          }
        );
      } catch (e) {
        await store.deleteRun(id);
        return fail(502, 'Could not reach the runner');
      }
      let data = null;
      try { data = await resp.json(); } catch (e) {}
      if (!resp.ok) {
        await store.deleteRun(id);
        const msg = (data && data.error && data.error.message) || `Runner returned ${resp.status}`;
        return fail(resp.status === 401 || resp.status === 403 ? 502 : resp.status, msg);
      }
      return json({ ok: true, id });
    }

    if (parts[0] === 'clyde' && parts[1] === 'run' && parts.length === 3 && request.method === 'GET') {
      const run = await store.getRun(parts[2]);
      if (!run) return fail(404, 'Unknown run');
      let status = run.status;
      if (status === 'running' && Date.now() - run.created > CLYDE_TIMEOUT_MS) status = 'timeout';
      return json({ status, result: run.result || null, created: run.created });
    }

    if (parts[0] === 'sync' && parts.length === 2) {
      const ns = parts[1];
      if (!NS_RE.test(ns) || ns === 'clyde-run') return fail(400, 'Bad namespace');
      const scoped = who.prefix + ns;
      if (request.method === 'GET') return json({ entries: await store.getNs(scoped) });
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return fail(400, 'Invalid JSON'); }
        const entries = body && body.entries;
        if (!entries || typeof entries !== 'object') return fail(400, 'entries required');
        for (const e of Object.values(entries)) {
          if (!e || !Number.isFinite(e.ts)) return fail(400, 'Each entry needs a numeric ts');
        }
        return json({ entries: await store.mergeNs(scoped, entries) });
      }
    }

    if (parts[0] === 'books' && parts.length === 2) {
      const slug = parts[1];
      if (!SLUG_RE.test(slug)) return fail(400, 'Bad slug');

      if (request.method === 'PUT') {
        let form;
        try { form = await request.formData(); } catch (e) { return fail(400, 'Expected multipart form'); }
        const epub = form.get('epub');
        const cover = form.get('cover');
        const title = String(form.get('title') || '').trim();
        const author = String(form.get('author') || '').trim();
        if (!title || !author) return fail(400, 'title and author are required');
        if (!epub || typeof epub === 'string') return fail(400, 'epub file is required');
        if (epub.size > MAX_EPUB_BYTES) return fail(413, 'epub too large');
        if (cover && typeof cover !== 'string' && cover.size > MAX_COVER_BYTES) return fail(413, 'cover too large');

        const existing = await store.getBook(slug);
        if (!who.owner && existing && !existing.hidden && existing.uploader !== who.uid) {
          return fail(403, 'That slug belongs to another upload');
        }
        const epubKey = 'books/' + slug + '.epub';
        await store.putBlob(epubKey, 'application/epub+zip', await epub.arrayBuffer());

        let coverKey = existing && !existing.hidden ? existing.cover_key : null;
        if (cover && typeof cover !== 'string' && cover.size > 0) {
          const ext = extFor(cover);
          const newKey = 'covers/' + slug + '.' + ext;
          await store.putBlob(newKey, ext === 'png' ? 'image/png' : 'image/jpeg', await cover.arrayBuffer());
          if (coverKey && coverKey !== newKey) await store.deleteBlobs([coverKey]);
          coverKey = newKey;
        }

        await store.putBook({
          slug, title, author, epub_key: epubKey, cover_key: coverKey,
          created_at: existing && !existing.hidden ? existing.created_at : Date.now(),
          uploader: who.uid,
        });
        return json({ book: bookJson(await store.getBook(slug), origin) });
      }

      if (request.method === 'DELETE') {
        if (!who.owner) {
          const row = await store.getBook(slug);
          if (!row || row.hidden || row.uploader !== who.uid) return fail(403, 'You can only delete books you uploaded');
        }
        const removed = await store.removeBook(slug);
        if (removed) {
          const keys = [removed.epub_key, removed.cover_key].filter(Boolean);
          if (keys.length) await store.deleteBlobs(keys);
        }
        return json({ ok: true, hidden: !removed });
      }
    }

    return fail(404, 'Not found');
  },
};
