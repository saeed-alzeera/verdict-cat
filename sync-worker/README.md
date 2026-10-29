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

## Spell Architect co-op signaling (`/mp/*`, public)

Online co-op in Spell Architect is peer-to-peer over WebRTC. This worker only
hands out 5-character room codes and relays the connection handshake (SDP
offers/answers); no game data passes through it. The routes need no sync key:
each room has its own random host key and per-guest keys, and expires after two
hours. They live in a small Durable Object per room (`MPRoom`, migration `v2`),
logic in `mp.js`, tests in `mp.test.mjs` (`node --test sync-worker/mp.test.mjs`).

| Method | Path | |
| --- | --- | --- |
| POST | `/mp/rooms` | create a room -> `{ code, hostKey }` |
| GET | `/mp/rooms/:code` | `{ open, players, max, names }` |
| POST | `/mp/rooms/:code/join` | `{ name }` -> `{ peerId, peerKey }` (max 4 players) |
| POST | `/mp/rooms/:code/signal` | `{ as, key, to, kind, data }`, kind is offer / answer / ice / bye |
| GET | `/mp/rooms/:code/signal?as=&key=&after=&wait=` | long-poll the mailbox |
| POST | `/mp/rooms/:code/close` | `{ key }` (host only) |

Deploying this change runs the `v2` migration that adds the `MPRoom` class.
