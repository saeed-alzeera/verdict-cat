// Shared helpers for the co-op browser tests. A host and a joiner run in SEPARATE browser processes (two chromium instances) and
// talk over a real WebRTC connection brokered by the signaling worker (`wrangler dev --local --port 8799`).
// Software GL is slow, so tests use a small viewport; frame-time numbers describe this CPU-bound environment, not real machines.
const { chromium } = require('playwright');

exports.ARGS = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
exports.ev = (P, fn, arg) => P.evaluate(fn, arg);
exports.game = (P, fn, arg) => P.evaluate(`(${fn.toString()})(window.__SA_GAME.scene.getScene('Game'), ${JSON.stringify(arg ?? null)})`);

let failed = 0;
exports.check = (ok, msg) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${msg}`); if (!ok) failed++; };
exports.done = () => { console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed'); process.exit(failed ? 1 : 0); };

exports.stats = (a) => {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y), m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length), p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: a.length, mean: +m.toFixed(2), sd: +sd.toFixed(2), p50: +p(0.5).toFixed(2), p95: +p(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
};

/** Host a room in one browser, join it from another, ready up, start round 1. Resolves once both are in the fight. */
exports.session = async function (opt = {}) {
  const vp = opt.viewport || { width: 320, height: 180 };
  const base = `http://localhost:${opt.port || 4173}/?mp=http://localhost:${opt.worker || 8799}`;
  const bA = await chromium.launch({ args: exports.ARGS }), bB = await chromium.launch({ args: exports.ARGS });
  const A = await (await bA.newContext({ viewport: vp })).newPage(), B = await (await bB.newContext({ viewport: vp })).newPage();
  const errs = [];
  for (const [n, p] of [['host', A], ['joiner', B]]) { p.on('pageerror', (e) => errs.push(`${n} ${e}`)); p.on('console', (m) => { if (m.type() === 'error') errs.push(`${n} ${m.text()}`); }); }
  await A.goto(base); await B.goto(base); await A.waitForTimeout(1500);
  await A.click('[data-a=mp]'); await A.fill('[data-name]', 'Alice'); await A.click('.mpbox [data-a=host]');
  await A.waitForSelector('.roomcode', { timeout: 20000 });
  const code = (await A.textContent('.roomcode')).replace('ROOM', '').trim();
  // `mismatch`: the joiner pretends to run a different build (one extra texture changes the protocol fingerprint)
  if (opt.mismatch) await B.evaluate(() => window.__SA.TEXTURE_KEYS.push('__not_in_the_hosts_build__'));
  await B.click('[data-a=mp]'); await B.fill('[data-name]', 'Bob'); await B.fill('[data-code]', code); await B.click('.mpbox [data-a=join]');
  if (opt.mismatch) {
    await B.waitForSelector('[data-status].bad', { timeout: 40000 });
    return { A, B, bA, bB, errs, code, refused: await B.textContent('[data-status]'), close: async () => { await bA.close(); await bB.close(); } };
  }
  await B.waitForSelector('.lobbyp', { timeout: 40000 });
  await B.click('[data-a=ready]'); await B.waitForTimeout(500);
  await A.click('[data-a=go]'); await A.waitForTimeout(1500);
  return { A, B, bA, bB, errs, code, close: async () => { await bA.close(); await bB.close(); } };
};

/** Per-frame probes: frame times, camera position, and the key-press -> camera-moves latency. */
exports.install = (P) => P.evaluate(() => {
  const g = window.__SA_GAME, cam = g.scene.getScene('Game').cameras.main;
  const S = (window.__p = { t: [], cx: [], keyT: 0, moveT: 0, x0: 0 });
  g.events.on('postrender', () => { const t = performance.now(); S.t.push(t); S.cx.push(cam.scrollX); if (S.keyT && !S.moveT && Math.abs(cam.scrollX - S.x0) > 0.5) S.moveT = t; });
  window.addEventListener('keydown', () => { if (!S.keyT) { S.keyT = performance.now(); S.x0 = cam.scrollX; } }, true);
});
exports.arm = (P) => P.evaluate(() => { const S = window.__p; S.keyT = 0; S.moveT = 0; S.x0 = window.__SA_GAME.scene.getScene('Game').cameras.main.scrollX; });
exports.read = (P) => P.evaluate(() => ({ ...window.__p, t: window.__p.t.slice(), cx: window.__p.cx.slice() }));
exports.frameDeltas = (t) => { const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]); return d; };
/** Press a movement key `n` times (alternating directions so the wizard never sits against a wall) and time how long the camera
 *  takes to start moving after each press. */
exports.latency = async (P, n = 12) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = i % 2 ? 'a' : 'd';
    await P.waitForTimeout(250); await exports.arm(P); await P.keyboard.down(k); await P.waitForTimeout(380); await P.keyboard.up(k);
    const r = await exports.read(P); if (r.moveT) out.push(r.moveT - r.keyT);
  }
  return out;
};
