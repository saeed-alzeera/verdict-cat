// Co-op end-to-end test: two browsers host/join through the real UI and play a round (shared XP, rewards, result merge, game over).
// Needs a built game being served and a signaling worker:
//   npm run build && npx vite preview --port 4173 &
//   (cd ../../sync-worker && npx wrangler dev --local --port 8799) &
//   NODE_PATH=$(npm root -g) node tests/coop.e2e.cjs      (playwright must be installed)
const { chromium } = require('playwright');
const run = (P, fn, arg) => P.evaluate(fn, arg);
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const A = await ctx.newPage(), B = await ctx.newPage();
  const errs = [];
  for (const [n, p] of [['A', A], ['B', B]]) { p.on('pageerror', (e) => errs.push(n + ' ' + e)); p.on('console', (m) => { if (m.type() === 'error') errs.push(n + ' ' + m.text()); }); }
  const base = 'http://localhost:4173/?mp=http://localhost:8799';
  await A.goto(base); await B.goto(base); await A.waitForTimeout(1500);
  await A.click('[data-a=mp]'); await A.fill('[data-name]', 'Alice'); await A.click('.mpbox [data-a=host]');
  await A.waitForSelector('.roomcode', { timeout: 20000 });
  const code = (await A.textContent('.roomcode')).replace('ROOM', '').trim();
  await B.click('[data-a=mp]'); await B.fill('[data-name]', 'Bob'); await B.fill('[data-code]', code); await B.click('.mpbox [data-a=join]');
  await B.waitForSelector('.lobbyp', { timeout: 40000 });
  // the guest customises: buy something so its build differs (extra coins + a power upgrade)
  const bBefore = await run(B, () => { const r = window.__SA_GAME.scene.getScene('Game').run; r.coins = 50; return { power: r.player.dmgMul, coins: r.coins }; });
  await B.click('[data-a=ready]'); await B.waitForTimeout(500);
  await A.click('[data-a=go]');
  await A.waitForTimeout(4000);
  // host: give shared XP, give the guest a cache reward, and a mutation-free state
  const mid = await run(A, () => {
    const r = window.__SA_GAME.scene.getScene('Game').run;
    const g = r.players[1];
    r.addXp(120);
    g.pushPending({ type: 'cache' });
    return { hostLvl: r.player.level, guestLvl: g.player.level, guestBoosts: g.boosts.length, hostBoosts: r.boosts.length };
  });
  console.log('host after xp', JSON.stringify(mid));
  await B.waitForTimeout(800);
  console.log('B mid', JSON.stringify(await run(B, () => { const r = window.__SA_GAME.scene.getScene('Game').run; return { phase: r.phase, lvl: r.player.level, pending: r.pending.map((p) => p.type), hp: r.player.hp }; })));
  // end the round on the host
  await run(A, () => window.__SA_GAME.scene.getScene('Game').run.endRound());
  await B.waitForSelector('#ui > .overlay', { timeout: 15000 });
  await B.waitForTimeout(500);
  const after = await run(B, () => { const r = window.__SA_GAME.scene.getScene('Game').run; return { phase: r.phase, round: r.round, lvl: r.player.level, boosts: r.boosts.length, coins: Math.round(r.coins), pending: r.pending.map((p) => p.type), maxHp: r.player.maxHp, dmgMul: Math.round(r.player.dmgMul * 100) / 100 }; });
  console.log('B after round 1', JSON.stringify(after), 'before', JSON.stringify(bBefore));
  const stackB = await B.evaluate(() => [...document.querySelectorAll('#ui > .overlay')].map((e) => e.className));
  console.log('B overlays', stackB);
  console.log('A phase', await run(A, () => { const r = window.__SA_GAME.scene.getScene('Game').run; return [r.phase, r.round]; }));
  // guest leaves the shop/prep (reward first) then readies
  await B.evaluate(() => window.__SA.ui.clearLayers());
  const wasReady = await B.evaluate(() => { const r = window.__SA_GAME.scene.getScene('Game').run; return r.phase; });
  console.log('B phase before ready', wasReady);
  // go to prep screen: pump shows the reward (cache) first, then shop, then prep; just force the prep overlay
  await B.evaluate(() => { const ui = window.__SA.ui; const r = window.__SA_GAME.scene.getScene('Game').run; r.pending.length = 0; r.shopOpened = true; ui.clearLayers(); ui.showPrep(r); });
  await B.click('[data-a=ready]'); await B.waitForTimeout(500);
  await A.evaluate(() => { const ui = window.__SA.ui; ui.clearLayers(); const r = window.__SA_GAME.scene.getScene('Game').run; r.shopOpened = true; ui.showPrep(r); });
  await A.click('[data-a=go]');
  await A.waitForTimeout(3000);
  console.log('A round 2', await run(A, () => { const r = window.__SA_GAME.scene.getScene('Game').run; return { phase: r.phase, round: r.round, players: r.players.length, gLvl: r.players[1].player.level, gDmg: r.players[1].player.dmgMul, gMaxHp: r.players[1].player.maxHp }; }));
  console.log('B round 2', await run(B, () => { const r = window.__SA_GAME.scene.getScene('Game').run; return { phase: r.phase, round: r.round }; }));
  // kill everyone -> game over on both
  await run(A, () => { const r = window.__SA_GAME.scene.getScene('Game').run; r.god = false; for (const p of r.players) { p.player.inv = 0; p.hurtPlayer(9999, 0, 0, 'test'); } });
  await B.waitForSelector('.gameover, .goverlay, .over', { timeout: 8000 }).catch(() => {});
  await B.waitForTimeout(800);
  console.log('B has gameover text:', (await B.textContent('#ui')).includes('DEFEATED'));
  console.log('A has gameover text:', (await A.textContent('#ui')).includes('DEFEATED'));
  console.log('errors', errs.slice(0, 8));
  await b.close();
})();
