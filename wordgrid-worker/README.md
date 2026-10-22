# verdict-cat-wordgrid

Cloudflare Worker for **online Wordgrid rooms** (2–4 players). It runs the same
`games/wordgrid/engine.js` as the browser, but the server is the referee: it
deals the tiles, validates every move, and sends each player only their own rack.

## Keys — kept separate from the sync key

| Credential | Held by | Lets you |
| --- | --- | --- |
| `WORDGRID_KEY` (Worker secret) | only you | **create** rooms |
| invite token (in the invite link) | friends you send it to | take a free seat in that one room, before it starts |
| seat token (per player, per room) | that player's browser | play as that seat; rejoin after a refresh |

`WORDGRID_KEY` is unrelated to `SYNC_KEY` and this Worker has no access to the sync
worker's progress, notes or books. A leaked game key can create rooms and nothing else;
a leaked invite link only gets someone a seat in one room.

## One-time setup

```sh
openssl rand -hex 24                          # copy this value
cd wordgrid-worker && npx wrangler secret put WORDGRID_KEY
```

Then merge to `main` (or run **Deploy Wordgrid Worker** from the Actions tab). The
Worker deploys to `https://verdict-cat-wordgrid.<your-subdomain>.workers.dev`; if your
subdomain differs from the one hard-coded in `games/wordgrid/online.html`, update
`DEFAULT_WORKER` there. Add any custom site domain to `ALLOWED_ORIGINS` in `wrangler.toml`.

Rotate the key any time by running `wrangler secret put WORDGRID_KEY` again (existing
rooms keep working; only new room creation needs the new key).

## Using it

1. Open `games/wordgrid/online.html`, paste the game key once (remembered on that device),
   choose 2–4 seats, pick your name and icon, **Create room**.
2. Send the invite link. A friend opens it, sees a name/icon page **prefilled from their last
   game** (nothing is assumed — they press *Join*), and lands in the waiting room.
3. Host presses **Start game**. Everyone plays from their own device; refreshing resumes the seat.

## API

| Method | Path | Auth | |
| --- | --- | --- | --- |
| POST | `/rooms` | game key | `{seats, name, icon}` → `{roomId, seat, token, invite}` |
| POST | `/r/:id/join` | invite or seat token | `{invite \| token, name, icon}` → `{seat, token, name, icon}` |
| GET | `/r/:id/ws?t=<seat token>` | seat token | WebSocket |
| GET | `/ping` | game key | check a key |

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
printf 'WORDGRID_KEY=devkey\n' > .dev.vars     # git-ignored
npx wrangler dev --port 8787
python3 -m http.server 8765                     # from the repo root
# in the browser console on the game page:  localStorage.wordgrid_worker = 'http://127.0.0.1:8787'
```

Tests: `node games/wordgrid/engine.test.js && node wordgrid-worker/src/room.test.js`
