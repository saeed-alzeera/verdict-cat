# verdict-cat-sync

Cloudflare Worker that replaces the GitHub gist (progress / regions / snippets
sync) and the GitHub Contents API (book uploads), so nothing in the site
depends on a GitHub personal access token any more.

- **Sync state** — SQLite-backed Durable Object (`SyncStore`). Merged
  last-writer-wins per key on the server, so a stale device can't overwrite
  newer data.
- **Books** — epubs and covers are stored as 1 MiB chunks in the same
  Durable Object (so everything runs on Cloudflare's free plan; no R2 and no
  card needed). Uploads are capped at 25 MB. Reads are public (as the repo
  files were); writes need the sync key.
- **Auth** — a random secret, `SYNC_KEY`, sent as `Authorization: Bearer …`.
  It never expires; rotate it by setting a new secret.

## One-time setup

1. Make sure the `CLOUDFLARE_API_TOKEN` repo secret can edit **Workers
   Scripts** (this also covers Durable Objects).
2. Generate a key and set it as a Worker secret:

   ```sh
   openssl rand -hex 24                      # copy this value
   cd sync-worker && npx wrangler secret put SYNC_KEY
   ```

   (The secret can be set before or after the first deploy; run the workflow
   once from the Actions tab, or merge to `main`.)
3. On each device, open the hub → **Sync Key**, paste the key, save.
4. To carry over existing data from the old gist, open **Sync Key** again and
   press **Import from old gist** (paste the old GitHub token first if the
   device no longer has it). Safe to repeat; it never overwrites newer data.

## API

| Method | Path | Auth | |
| --- | --- | --- | --- |
| GET | `/ping` | key | check a key |
| GET | `/sync/:ns` | key | all entries `{ key: { value, ts } }` |
| POST | `/sync/:ns` | key | `{ entries }` merged LWW; returns merged namespace |
| GET | `/books` | – | catalogue (includes `hidden` markers) |
| PUT | `/books/:slug` | key | multipart `title`, `author`, `epub`, optional `cover` |
| DELETE | `/books/:slug` | key | removes an upload; for a book baked into `library.html` records a hidden marker |
| GET | `/files/*` | – | epub / cover bytes |

Namespaces in use: `progress`, `regions`, `docs`.

## Clyde (send prompts to Claude Code)

`POST /clyde/run` with `{ "prompt": "..." }` (sync key required) fires a
Claude Code routine, starting a new session, and returns `{ ok, id }`. The
prompt is wrapped with instructions to answer in plain-text Markdown and to
POST the final answer to `/clyde/result/:id` (authorised by a one-time per-run
secret, not the sync key). The page polls `GET /clyde/run/:id` (sync key) for
`{ status: running|done|timeout, result }`; runs time out after 10 minutes and
are pruned after 30 days. The routine's environment must be allowed to reach
`verdict-cat-sync.saeed-a-alzeera.workers.dev`. One-time setup:

1. At claude.ai/code/routines create a routine for this repo (prompt e.g.
   "Carry out the request that follows.") and add an **API** trigger; copy the
   routine id (`trig_...`) and the token (shown once).
2. `cd sync-worker && npx wrangler secret put CLYDE_ROUTINE_ID` and
   `npx wrangler secret put CLYDE_ROUTINE_TOKEN`.
