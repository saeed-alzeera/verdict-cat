/*
 * verdict-cat sync + book storage.
 *
 * Replaces the GitHub gist (progress/regions/snippets sync) and the GitHub
 * Contents API (book uploads) so the site no longer depends on a personal
 * access token that can expire or be revoked.
 *
 *   Auth: writes (and all /sync reads) need  Authorization: Bearer <SYNC_KEY>
 *         where SYNC_KEY is a Worker secret. Book catalogue and files are
 *         public to read, matching the public repo they used to live in.
 *
 *   GET    /ping                   auth check
 *   GET    /sync/:ns               -> { entries: { key: { value, ts } } }
 *   POST   /sync/:ns               { entries: { key: { value, ts } } }
 *                                  last-writer-wins per key; returns merged ns
 *   GET    /books                  -> { books: [...] }  (includes hidden markers)
 *   PUT    /books/:slug            multipart: title, author, epub, [cover]
 *   DELETE /books/:slug            removes files; for a slug with no upload
 *                                  (a book baked into library.html) records a
 *                                  "hidden" marker instead
 *   GET    /files/*                epub / cover bytes
 *   /mp/*                   PUBLIC multiplayer signaling for Spell Architect
 *                           (room codes + WebRTC handshake only; see mp.js)
 */
import { DurableObject } from 'cloudflare:workers';
import { MPRoomCore, handleMp } from './mp.js';

// Files are stored as 1 MiB chunks in the Durable Object's SQLite (a row is
// limited to 2 MB), and move to/from the DO in one RPC message (32 MiB limit).
const CHUNK_BYTES = 1024 * 1024;
const MAX_EPUB_BYTES = 25 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,150}$/;
const NS_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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

async function authorized(request, env) {
  if (!env.SYNC_KEY) return false;
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const enc = new TextEncoder();
  // Hash both sides so the compare is constant-time regardless of length.
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.SYNC_KEY)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** One Durable Object per multiplayer room code; all logic lives in MPRoomCore (mp.js). */
export class MPRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new MPRoomCore(ctx.storage);
  }
  create(hostKey, now) { return this.core.create(hostKey, now); }
  info() { return this.core.info(); }
  join(name) { return this.core.join(name); }
  signal(as, key, to, kind, data) { return this.core.signal(as, key, to, kind, data); }
  poll(as, key, after, waitMs) { return this.core.poll(as, key, after, waitMs); }
  lock(key) { return this.core.lock(key); }
  close(key) { return this.core.close(key); }
  async alarm() { await this.core.expire(); }
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
    `);
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
      `INSERT INTO books (slug, title, author, epub_key, cover_key, hidden, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (slug) DO UPDATE SET title = excluded.title, author = excluded.author,
         epub_key = excluded.epub_key, cover_key = excluded.cover_key, hidden = 0`,
      b.slug, b.title, b.author, b.epub_key, b.cover_key, b.created_at
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

    // Multiplayer signaling is public (it never touches the sync data) and has its own per-room keys.
    if (parts[0] === 'mp') return handleMp(request, env, parts);

    // Public reads: catalogue and files.
    if (isRead && parts[0] === 'files' && parts.length > 1) {
      const key = parts.slice(1).join('/');
      const meta = await store.getBlob(key, true);
      if (!meta) return fail(404, 'Not found');
      const headers = new Headers(CORS);
      headers.set('Content-Type', meta.type);
      headers.set('ETag', meta.etag);
      headers.set('Cache-Control', 'public, max-age=3600');
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

    // Everything below needs the sync key.
    if (!(await authorized(request, env))) return fail(401, 'Invalid or missing sync key');

    if (parts[0] === 'ping' && parts.length === 1) return json({ ok: true });

    if (parts[0] === 'sync' && parts.length === 2) {
      const ns = parts[1];
      if (!NS_RE.test(ns)) return fail(400, 'Bad namespace');
      if (request.method === 'GET') return json({ entries: await store.getNs(ns) });
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return fail(400, 'Invalid JSON'); }
        const entries = body && body.entries;
        if (!entries || typeof entries !== 'object') return fail(400, 'entries required');
        for (const e of Object.values(entries)) {
          if (!e || !Number.isFinite(e.ts)) return fail(400, 'Each entry needs a numeric ts');
        }
        return json({ entries: await store.mergeNs(ns, entries) });
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
        });
        return json({ book: bookJson(await store.getBook(slug), origin) });
      }

      if (request.method === 'DELETE') {
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
