// Server-side gate for the whole Pages site. Nothing is served without a valid
// session cookie. The cookie holds the user's sync key (HttpOnly, so page
// scripts cannot read it) and is re-checked against the sync Worker, so
// disabling a user or rotating a key locks them out here too.
const WORKER = 'https://verdict-cat-sync.saeed-a-alzeera.workers.dev';
const COOKIE = 'vc_session';
const MAX_AGE = 60 * 60 * 24 * 30;
const cache = new Map(); // key -> expiry ms (per isolate, short-lived)

async function keyValid(key) {
  if (!key || key.length > 200) return false;
  const hit = cache.get(key);
  if (hit && hit > Date.now()) return true;
  try {
    const r = await fetch(WORKER + '/ping', { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) { cache.delete(key); return false; }
  } catch (e) { return false; }
  if (cache.size > 500) cache.clear();
  cache.set(key, Date.now() + 60000);
  return true;
}

function getCookie(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function cookie(value, maxAge) {
  return COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}

const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1117;color:#e8eaed;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
form{width:100%;max-width:340px;padding:24px;background:#1a1d23;border:1px solid #2e3238;border-radius:14px}
h1{font-size:20px;margin:0 0 6px}p{font-size:13px;color:#8b9099;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:10px;background:#0f1117;color:#e8eaed;border:1px solid #2e3238;border-radius:8px;font-size:15px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#5b9bd5;color:#fff;font-size:15px;cursor:pointer}
button:disabled{opacity:.5}a{display:block;margin-top:12px;font-size:12px;color:#8b9099;cursor:pointer}#e{color:#e05c5c;font-size:13px;min-height:18px;margin-bottom:8px}
</style></head><body><form id="f"><h1>Sign in</h1><p>Use your GASTAT DATA AGGREGATOR account.</p>
<input id="u" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus>
<input id="p" type="password" placeholder="Password" autocomplete="current-password">
<input id="i" placeholder="Invite code" autocomplete="off" style="display:none">
<div id="e"></div><button id="b">Sign in</button><a id="t">Have an invite? Create an account</a></form>
<script>
var up=false,W=${JSON.stringify(WORKER)};
document.getElementById('t').onclick=function(){up=!up;i.style.display=up?'':'none';b.textContent=up?'Create account':'Sign in';this.textContent=up?'Back to sign in':'Have an invite? Create an account'};
f.onsubmit=async function(ev){ev.preventDefault();b.disabled=true;e.textContent='';
try{
var body={username:u.value.trim(),password:p.value};if(up)body.invite=i.value.trim();
var r=await fetch(W+(up?'/auth/signup':'/auth/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
var d={};try{d=await r.json()}catch(x){}
if(!r.ok)throw new Error(d.error||'Sign in failed.');
var s=await fetch('/__session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:d.key})});
if(!s.ok)throw new Error('Sign in failed.');
localStorage.setItem('verdict-cat-sync-key',d.key);localStorage.setItem('verdict-cat-username',d.username||body.username);
location.replace(location.pathname+location.search);
}catch(x){e.textContent=x.message||'Sign in failed.';p.value='';b.disabled=false}};
</script></body></html>`;

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  if (url.pathname === '/__session' && request.method === 'POST') {
    let key = '';
    try { key = (await request.json()).key || ''; } catch (e) {}
    if (!(await keyValid(key))) return new Response('{"error":"Sign in failed."}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie(key, MAX_AGE), 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/__logout') {
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie('', 0), 'Cache-Control': 'no-store' } });
  }

  const key = getCookie(request);
  if (await keyValid(key)) {
    // Books live in private storage on the sync Worker; serve them same-origin
    // with the session's key so they are only reachable when signed in.
    if (url.pathname.startsWith('/files/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const headers = { Authorization: 'Bearer ' + key };
      const inm = request.headers.get('If-None-Match');
      if (inm) headers['If-None-Match'] = inm;
      const r = await fetch(WORKER + url.pathname, { method: request.method, headers });
      const out = new Headers(r.headers);
      out.set('Cache-Control', 'private, max-age=3600');
      return new Response(r.body, { status: r.status, headers: out });
    }
    return next();
  }

  const wantsPage = request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html');
  if (wantsPage) return new Response(LOGIN_HTML, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
}
