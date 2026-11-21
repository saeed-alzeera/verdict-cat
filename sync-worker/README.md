# verdict-cat-sync

Cloudflare Worker that replaces the GitHub gist (progress / regions / snippets
sync) and the GitHub Contents API (book uploads), so nothing in the site
depends on a GitHub personal access token any more.

- **Sync state** — SQLite-backed Durable Object (`SyncStore`). Merged
  last-writer-wins per key on the server, so a stale device can't overwrite
  newer data.
- **Books** — epubs and covers are stored as 1 MiB chunks in the same
  Durable Object (so everything runs on Cloudflare's free plan; no R2 and no
  card needed). Uploads are capped at 25 MB. Reads and writes both need a
  valid key: books are private. The Pages login proxies `/files/*` with the
  session key so `<img>` and the epub reader work same-origin.
- **Auth** — `Authorization: Bearer <key>`. Two kinds of key:
  - the **owner key**, the `SYNC_KEY` Worker secret. Full access, and its data
    stays in the original namespaces; only this key can use Clyde, create
    invites and manage accounts.
  - a **per-user key** `vck_<uid>_<secret>`, generated at signup. It only reads
    and writes that user's own sync namespaces (stored as `u<uid>:<ns>`).
    Only `SHA-256(secret)` is stored for checking requests; the key itself is
    stored AES-GCM-encrypted under a key derived from the user's password, so
    logging in on a new device returns the same key.

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
4. The old GitHub-gist fallback and "Import from old gist" were removed.

## Accounts

Signup is invite-only. Create an invite in `admin.html` (owner key), send the
code privately, and the person picks a username and password on the Library or
hub page. There is no email and no password reset: someone still signed in on a
device can change the password; otherwise a lost password means the account
cannot be signed into on a new device. Passwords are PBKDF2-SHA256 (100,000
iterations, the Workers maximum) with a per-user salt. Login is rate limited
(5 free failures per username and per IP, then exponential lockout up to
15 minutes) and signup is limited to 5 per hour per IP. Books are one shared
catalogue; users can delete only what they uploaded, the owner can delete any.
No storage quota. Existing data stays with the owner key; accounts start empty.

## API

| Method | Path | Auth | |
| --- | --- | --- | --- |
| GET | `/ping` | key | check a key |
| POST | `/auth/signup` | invite | `{username, password, invite}` -> `{key}` |
| POST | `/auth/login` | – | `{username, password}` -> `{key}` |
| GET | `/auth/me` | key | `{username, owner}` |
| POST | `/auth/password` | key | `{password}` set a new password |
| POST | `/auth/rotate` | key | `{password}` new key; old key stops working |
| DELETE | `/auth/account` | key | delete account and its sync data |
| GET/POST | `/admin/invites` | owner | list / create invite codes |
| DELETE | `/admin/invites/:code` | owner | revoke an unused invite |
| GET | `/admin/users` | owner | list accounts |
| POST | `/admin/users` | owner | `{username, password}` create an account without an invite (see `create-users.mjs`) |
| POST | `/admin/users/:name/(disable\|enable)` | owner | block / unblock an account |
| GET | `/sync/:ns` | key | all entries `{ key: { value, ts } }` |
| POST | `/sync/:ns` | key | `{ entries }` merged LWW; returns merged namespace |
| GET | `/books` | key | catalogue (includes `hidden` markers) |
| PUT | `/books/:slug` | key | multipart `title`, `author`, `epub`, optional `cover` |
| DELETE | `/books/:slug` | key | removes an upload; for a book baked into `library.html` records a hidden marker |
| GET | `/files/*` | key | epub / cover bytes |

Namespaces in use: `progress`, `regions`, `docs`.

## Clyde (send prompts to Claude Code)

`POST /clyde/run` with `{ "prompt": "...", "parent": "<run id, optional>" }` (owner key required) fires a
Claude Code routine, starting a new session, and returns `{ ok, id }`. The
prompt is wrapped with instructions to answer in plain-text Markdown and to
POST the final answer to `/clyde/result/:id` (authorised by a one-time per-run
secret in an `X-Clyde-Secret` header, or by the sync key). The page polls `GET /clyde/run/:id` (sync key) for
`{ status: running|done|timeout, result }`; runs time out after 10 minutes and
are pruned after 30 days. The routine's environment must be allowed to reach
`verdict-cat-sync.saeed-a-alzeera.workers.dev`. One-time setup:

1. At claude.ai/code/routines create a routine for this repo (prompt e.g.
   "Carry out the request that follows.") and add an **API** trigger; copy the
   routine id (`trig_...`) and the token (shown once).
2. `cd sync-worker && npx wrangler secret put CLYDE_ROUTINE_ID` and
   `npx wrangler secret put CLYDE_ROUTINE_TOKEN`.

A reply passes `parent`. Each run is still a fresh session, so the worker
prepends the previous prompts and answers in the thread (up to 5 turns, each
truncated) to the new task.

## Loading the original books

`books-manifest.json` lists the 20 books that used to live in `books/` in the
repo. To load them into the private store from a folder holding the original
files (`<dir>/*.epub` and `<dir>/covers/*`):

```sh
OWNER_KEY=<owner sync key> node sync-worker/upload-books.mjs /path/to/books
```

It is safe to re-run; each book is a PUT to `/books/:slug`.
