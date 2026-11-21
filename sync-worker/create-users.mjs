// Creates N accounts with random usernames and passwords and prints them.
// Usage: OWNER_KEY=<owner sync key> node sync-worker/create-users.mjs [count]
import { randomBytes } from 'node:crypto';

const WORKER = process.env.WORKER_URL || 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';
const key = process.env.OWNER_KEY;
const count = parseInt(process.argv[2] || '10', 10);
if (!key) { console.error('Set OWNER_KEY to the owner sync key.'); process.exit(1); }

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const pick = (n) => Array.from(randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');

for (let i = 0; i < count; i++) {
  const username = 'cat-' + pick(6);
  const password = pick(16);
  const r = await fetch(WORKER + '/admin/users', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) { console.error(username, 'failed:', r.status, await r.text()); continue; }
  console.log(username + '\t' + password);
}
