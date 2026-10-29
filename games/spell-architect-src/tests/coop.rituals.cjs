// Co-op rituals: a joiner accepts one in its own prep screen, the host evaluates it per player and sends the result back, and a
// forged (too easy) ritual is refused. Also: an elite's chest gives a choice of runes. See coop.perf.cjs for how to run.
const { session, game, check, done } = require('./_mp.cjs');
const J = JSON.stringify;
(async () => {
  const s = await session({ viewport: { width: 480, height: 270 }, beforeReady: async (A, B) => {
    await game(B, (sc) => { const r = sc.run, S = window.__SA.rituals; r.coins = 80; const d = S.makeRitual(r, 1); d.objectives = [{ id: 'kills', scope: 'total', target: 20 }, { id: 'hurtmax', scope: 'round', target: 200 }]; d.reward = 'maxhp'; r.shop.rituals.push(d); window.__acc = S.acceptRitual(r, d); });
  } });
  const { A, B } = s;
  check((await game(B, () => window.__acc)) === null, 'the joiner accepted a ritual in its own prep screen');
  const sh = await game(A, (sc) => ({ n: sc.run.players[1].rituals.length, t: sc.run.players[1].rituals[0]?.def.tier }));
  check(sh.n === 1, `the host received the joiner's ritual with its build (${J(sh)})`);
  const feed = (n) => game(A, (sc, k) => { const sh = sc.run.players[1], S = window.__SA.rituals; for (let i = 0; i < k; i++) S.ritualEvent(sh, { t: 'kill', elite: false, els: [] }); }, n);
  await feed(25);
  await game(A, (sc) => { sc.run.god = true; });
  await B.waitForTimeout(1600);
  const hud = await game(B, (sc) => sc.run.rituals.map((r) => r.prog[0]));
  check(hud[0] >= 25 && hud[0] < 40, `the joiner's HUD gets its progress from the host (${J(hud)})`);
  const hp0 = await game(A, (sc) => sc.run.players[1].player.maxHp);
  await game(A, (sc) => sc.run.endRound());
  await B.waitForSelector('#ui > .overlay', { timeout: 15000 });
  const mid = await game(B, (sc) => sc.run.rituals.map((r) => [r.state, r.roundsDone]));
  check(J(mid) === '[["active",1]]', `after round 1 the ritual is half way on the joiner (${J(mid)})`);
  await game(B, () => window.__SA.ui.clearLayers());
  await game(B, (sc) => { sc.run.pending.length = 0; sc.run.shopOpened = true; window.__SA.ui.clearLayers(); window.__SA.ui.showPrep(sc.run); });
  await B.click('[data-a=ready]'); await B.waitForTimeout(500);
  await game(A, (sc) => { window.__SA.ui.clearLayers(); sc.run.shopOpened = true; window.__SA.ui.showPrep(sc.run); });
  await A.click('[data-a=go]'); await A.waitForTimeout(1500);
  await feed(5);
  await game(A, (sc) => { sc.run.players[1].ritualRound.hurt = 0; sc.run.endRound(); });
  await B.waitForTimeout(1500);
  const end = await game(B, (sc) => ({ r: sc.run.rituals.map((r) => r.state), maxHp: sc.run.player.maxHp }));
  check(end.r[0] === 'fulfilled' && end.maxHp === hp0 + 15, `fulfilled in round 2: the reward reached the joiner (${J(end)} from ${hp0})`);
  // a doctored (free) ritual is refused when the joiner readies
  await game(B, (sc) => { const r = sc.run; r.rituals.push({ def: { id: 'x', name: 'cheat', icon: '?', tier: 1, rounds: 2, cost: 0, reward: 'power', objectives: [{ id: 'kills', scope: 'total', target: 0 }] }, startRound: 1, roundsDone: 0, prog: [0], state: 'active', why: '' }); });
  await game(B, (sc) => { window.__SA.ui.clearLayers(); sc.run.shopOpened = true; window.__SA.ui.showPrep(sc.run); });
  await game(B, (sc) => { sc.coop.setReady(true); }); await B.waitForTimeout(800);
  const ready = await game(A, (sc) => [...sc.coop.guests.values()].map((g) => g.ready));
  check(ready[0] === false, `the host refuses a too-easy ritual (${J(ready)})`);
  // elite chest
  await game(A, (sc) => { sc.run.god = true; const r = sc.run; const pr = r.players[0]; pr.pending.length = 0; pr.pushPending({ type: 'cache', chest: true }); });
  const kinds = await game(A, (sc) => { const R = window.__SA; return R.generateRewards(sc.run, 'chest').map((x) => R.RUNE_BY_ID[x.rune].kind); });
  check(kinds.length === 3 && ['core', 'form'].includes(kinds[0]) && ['trigger', 'behavior'].includes(kinds[1]), `an elite chest offers a form/core, a trigger/behavior and one more (${J(kinds)})`);
  check(s.errs.length === 0, `no page errors ${s.errs.slice(0, 2)}`);
  await s.close();
  done();
})();
