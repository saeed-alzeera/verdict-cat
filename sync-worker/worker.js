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
 *   GET    /files/*                R2 object (epubs, covers)
 */
import { DurableObject } from 'cloudflare:workers';

const MAX_EPUB_BYTES = 40 * 1024 * 1024;  // body is buffered; Workers have 128MB of memory
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

export class SyncStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT, ts INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
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

  // Returns the removed row (so the caller can delete its R2 objects), or
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

    // Public reads: catalogue and files.
    if (isRead && parts[0] === 'files' && parts.length > 1) {
      const key = parts.slice(1).join('/');
      const obj = await env.BOOKS.get(key);
      if (!obj) return fail(404, 'Not found');
      const headers = new Headers(CORS);
      obj.writeHttpMetadata(headers);
      headers.set('ETag', obj.httpEtag);
      headers.set('Cache-Control', 'public, max-age=3600');
      return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
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
        await env.BOOKS.put(epubKey, await epub.arrayBuffer(), { httpMetadata: { contentType: 'application/epub+zip' } });

        let coverKey = existing && !existing.hidden ? existing.cover_key : null;
        if (cover && typeof cover !== 'string' && cover.size > 0) {
          const ext = extFor(cover);
          const newKey = 'covers/' + slug + '.' + ext;
          await env.BOOKS.put(newKey, await cover.arrayBuffer(), { httpMetadata: { contentType: ext === 'png' ? 'image/png' : 'image/jpeg' } });
          if (coverKey && coverKey !== newKey) await env.BOOKS.delete(coverKey);
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
          if (keys.length) await env.BOOKS.delete(keys);
        }
        return json({ ok: true, hidden: !removed });
      }
    }

    return fail(404, 'Not found');
  },
};
