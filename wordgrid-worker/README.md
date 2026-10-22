# verdict-cat-wordgrid

Cloudflare Worker for **online Wordgrid rooms** (2–4 players). It runs the same
`games/wordgrid/engine.js` as the browser, but the server is the referee: it
deals the tiles, validates every move, and sends each player only their own rack.

## Keys — one key for you, none for friends

| Credential | Held by | Lets you |
| --- | --- | --- |
| your sync key | only you | **create** rooms |
| invite token (in the invite link) | friends you send it to | take a free seat in that one room, before it starts |
| seat token (per player, per room) | that player's browser | play as that seat; rejoin after a refresh |

There is **nothing to configure on Cloudflare**. When you create a room, this Worker asks the
sync worker (service binding `SYNC`, calling its `/ping`) whether the key is valid, so the key is
never copied here and rotating it needs no change. Friends never see or store it: they join with
the invite link alone. This Worker has no access to the sync worker's data (separate Durable
Object and code); it only learns yes/no. A leaked invite link only gets someone a seat in one room.

## Deploy

Merge to `main` (or run **Deploy Wordgrid Worker** from the Actions tab). It deploys to
`https://verdict-cat-wordgrid.<your-subdomain>.workers.dev`; if your subdomain differs from the one
hard-coded in `games/wordgrid/index.html`, update `DEFAULT_WORKER` there. Add any custom site
domain to `ALLOWED_ORIGINS` in `wrangler.toml`. The `verdict-cat-sync` Worker must already exist
(the binding points at it by name).

## Using it

1. Open the Wordgrid card on the homepage (`games/wordgrid/`); your sync key is picked up automatically if this device has it (otherwise paste it once),
   choose 2–4 seats, pick your name and icon, **Create room**.
2. Send the invite link. A friend opens it, sees a name/icon page **prefilled from their last
   game** (nothing is assumed — they press *Join*), and lands in the waiting room.
3. Host presses **Start game**. Everyone plays from their own device; refreshing resumes the seat.

## API

| Method | Path | Auth | |
| --- | --- | --- | --- |
| POST | `/rooms` | sync key | `{seats, name, icon}` → `{roomId, seat, token, invite}` |
| POST | `/r/:id/join` | invite or seat token | `{invite \| token, name, icon}` → `{seat, token, name, icon}` |
| GET | `/r/:id/ws?t=<seat token>` | seat token | WebSocket |
| GET | `/ping` | sync key | check a key |

WebSocket messages (client → server): `start`, `play {placements}`, `pass`, `swap {indices}`,
`resign`, `rematch` (host, after game over), `ping`. The server answers every change with a
fresh `{type:"state"}` view per seat, or `{type:"error", message}` to the sender.

## Notes

- One SQLite-backed Durable Object per room; rooms delete themselves after 7 idle days.
- The word list is shipped inside the Worker and checked with a substring scan, so a cold
  start doesn't parse 170k words (free-plan CPU limit is 10 ms).
- CORS and WebSocket upgrades are limited to `ALLOWED_ORIGINS`.
- Not built yet: turn timers / auto-skip for absent players, spectators, chat.

## Local development

```sh
printf 'SYNC_KEY=devkey\n' > .dev.vars     # git-ignored; compares the key locally instead of asking the sync worker
npx wrangler dev --port 8787
python3 -m http.server 8765                     # from the repo root
# in the browser console on the game page:  localStorage.wordgrid_worker = 'http://127.0.0.1:8787'
```

Tests: `node games/wordgrid/engine.test.js && node wordgrid-worker/src/room.test.js`
