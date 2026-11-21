// Loads the books listed in books-manifest.json into the sync Worker's private
// storage. Usage: OWNER_KEY=<owner sync key> node sync-worker/upload-books.mjs <dir>
// <dir> holds the original files: <dir>/<epub> and <dir>/covers/<cover>.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = process.env.WORKER_URL || 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';
const key = process.env.OWNER_KEY;
const dir = process.argv[2];
if (!key || !dir) { console.error('Usage: OWNER_KEY=... node upload-books.mjs <books dir>'); process.exit(1); }

const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'books-manifest.json'), 'utf8'));
let failed = 0;
for (const b of manifest) {
  try {
    const fd = new FormData();
    fd.append('title', b.title);
    fd.append('author', b.author);
    fd.append('epub', new Blob([await readFile(join(dir, b.epub))], { type: 'application/epub+zip' }), b.slug + '.epub');
    if (b.cover) {
      const type = b.cover.endsWith('.png') ? 'image/png' : 'image/jpeg';
      fd.append('cover', new Blob([await readFile(join(dir, 'covers', b.cover))], { type }), b.slug + (type === 'image/png' ? '.png' : '.jpg'));
    }
    const r = await fetch(WORKER + '/books/' + b.slug, { method: 'PUT', headers: { Authorization: 'Bearer ' + key }, body: fd });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()));
    console.log('ok  ', b.title);
  } catch (e) { failed++; console.error('FAIL', b.title, e.message); }
}
process.exit(failed ? 1 : 0);
