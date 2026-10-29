// Co-op session flow on the real WebRTC stack: a dropped connection reconnects by itself, the host's pause reaches the joiner, a
// joiner leaving and the host ending the game are handled, and a mismatched game version is refused with a clear message.
//   NODE_PATH=$(npm root -g) node tests/coop.flow.cjs        (see coop.perf.cjs for the servers it needs; uses 4 rooms)
const { session, game, check, done } = require('./_mp.cjs');
const J = JSON.stringify;

(async () => {
  // ---- 1. hard connection drop (no goodbye) -> automatic reconnect, state flows again, prediction agrees with the host
  {
    console.log('1. connection drop and reconnect');
    const s = await session({ viewport: { width: 480, height: 270 } });
    const { A, B } = s;
    await game(A, (sc) => { sc.run.god = true; });
    await A.waitForTimeout(1500);
    const before = await game(B, (sc) => sc.coop.replica.stats.stPackets);
    // keep the old link's close handler: a real network failure delivers it late, after the replacement is already up
    await game(A, (sc) => { const l = sc.coop.net.links.get('1'); window.__lateClose = l.ctl.onclose; });
    await game(B, (sc) => { sc.coop.net.pc.close(); });
    await A.waitForTimeout(1200);
    const mid = await game(A, (sc) => sc.run.players.map((p) => ({ pid: p.pid, down: p.down })));
    check(mid[1].down === true, `host stands the dropped player down while waiting (${J(mid)})`);
    check(await B.evaluate(() => document.body.innerText.includes('Reconnecting')), 'joiner shows a reconnecting banner');
    await A.waitForTimeout(9000);
    const after = await game(B, (sc) => sc.coop.replica.stats.stPackets);
    const hostSees = await game(A, (sc) => sc.run.players.map((p) => ({ pid: p.pid, down: p.down })));
    check(hostSees.length === 2 && hostSees[1].down === false, `the player is back on their feet on the host (${J(hostSees)})`);
    check(after > before + 20, 'joiner receives world state again');
    await game(A, () => { window.__lateClose(); }); await A.waitForTimeout(800);
    check(await game(A, (sc) => sc.coop.net.ids().includes('1')), 'a late close event from the replaced link does not tear down the new connection');
    check(!(await B.evaluate(() => document.body.innerText.includes('Reconnecting'))), 'banner is gone');
    await B.bringToFront(); await B.keyboard.down('d'); await B.waitForTimeout(900); await B.keyboard.up('d'); await B.waitForTimeout(600);
    const px = await game(B, (sc) => Math.round(sc.coop.pred.s.x)), hx = await game(A, (sc) => Math.round(sc.run.players[1].player.x));
    check(Math.abs(px - hx) < 12, `after reconnecting the joiner moves and the host agrees (predicted ${px}, host ${hx})`);
    check(s.errs.length === 0, `no page errors ${s.errs.slice(0, 2)}`);
    await s.close();
  }
  // ---- 2. pause / resume on the joiner, joiner leaves
  {
    console.log('2. host pause, resume, joiner leaves');
    const s = await session({ viewport: { width: 480, height: 270 } });
    const { A, B } = s;
    await game(A, (sc) => { sc.run.god = true; });
    await A.waitForTimeout(1200);
    await A.bringToFront(); await A.keyboard.press('Escape'); await B.waitForTimeout(1500);
    check(await B.evaluate(() => document.body.innerText.includes('paused the game')), 'joiner sees the pause screen when the host pauses');
    const t0 = await game(B, (sc) => sc.run.roundElapsed); await B.waitForTimeout(1200);
    const t1 = await game(B, (sc) => sc.run.roundElapsed);
    check(Math.abs(t1 - t0) < 0.05, `the round clock is frozen while paused (${t0.toFixed(2)} -> ${t1.toFixed(2)})`);
    await A.keyboard.press('Escape'); await B.waitForTimeout(1500);
    check(!(await B.evaluate(() => document.body.innerText.includes('paused the game'))), 'pause screen goes away on resume');
    check((await game(B, (sc) => sc.run.roundElapsed)) > t1 + 0.5, 'and the clock runs again');
    await game(B, () => window.__SA.ui.quitToMenu()); await A.waitForTimeout(2500);
    const left = await game(A, (sc) => ({ players: sc.run.players.length, phase: sc.run.phase }));
    check(left.players === 1 && left.phase === 'fight', `host carries on alone after the joiner leaves (${J(left)})`);
    check(s.errs.length === 0, `no page errors ${s.errs.slice(0, 2)}`);
    await s.close();
  }
  // ---- 3. host ends the game
  {
    console.log('3. host ends the game');
    const s = await session({ viewport: { width: 480, height: 270 } });
    const { A, B } = s;
    await A.waitForTimeout(1200);
    await game(A, () => window.__SA.ui.quitToMenu()); await B.waitForTimeout(3500);
    check(await B.evaluate(() => /host ended the game/i.test(document.body.innerText)), 'joiner is told the host ended the game');
    await B.click('[data-a=ok]').catch(() => {}); await B.waitForTimeout(800);
    check(await B.evaluate(() => !!document.querySelector('.menu')), 'and lands back on the menu');
    check(s.errs.length === 0, `no page errors ${s.errs.slice(0, 2)}`);
    await s.close();
  }
  // ---- 4. a stale (mismatched) build is refused up front, with advice, instead of showing wrong sprites
  {
    console.log('4. version mismatch');
    const s = await session({ mismatch: true });
    check(/version does not match/i.test(s.refused) && /refresh/i.test(s.refused), `the joiner is told why: "${s.refused}"`);
    await s.A.waitForTimeout(1500);
    check(!/Bob/.test(await s.A.textContent('.lobbyp').catch(() => '')), 'and never appears in the host\'s lobby');
    await s.close();
  }
  done();
})();
