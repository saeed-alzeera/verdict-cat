// Co-op responsiveness, correctness and payload under load, on a clean link and under SIMULATED impairment
// (loss / one-way delay / jitter are injected at the sender, on top of a real loopback WebRTC connection: not a real WAN).
//   npm run build && npx vite preview --port 4173 &
//   (cd ../../sync-worker && npx wrangler dev --local --port 8799) &
//   NODE_PATH=$(npm root -g) node tests/coop.perf.cjs
// Each scenario opens one room (the worker allows 12 room creations per 10 minutes per IP; restart it between runs).
const { session, ev, game, check, done, stats, install, read, latency, frameDeltas } = require('./_mp.cjs');
const J = JSON.stringify;
const SCEN = process.env.SCEN ? JSON.parse(process.env.SCEN) : [[0, 0, 0], [3, 50, 15]];

(async () => {
  for (const [loss, delay, jitter] of SCEN) {
    console.log(`\n=== loss ${loss}%, one-way delay ${delay}±${jitter} ms (simulated) ===`);
    const s = await session();
    const { A, B } = s;
    for (const P of [A, B]) await ev(P, (x) => { window.__netsim = x; }, { loss, delay, jitter });
    await install(A); await install(B);
    await game(A, (sc) => { sc.run.god = true; });
    await B.bringToFront();
    const latQuiet = await latency(B, 10); // before the swarm: the frame rate is not the bottleneck
    // a swarm of every enemy type, five different spells, and live combat (knockback gives the prediction something to correct)
    await game(A, (sc) => {
      const r = sc.run, S = window.__SA;
      r.dtime = 200;
      while (r.spells.length < 5) r.addSlot();
      const combos = [['f_orb', 'c_fire'], ['f_beam', 'c_ice'], ['f_nova', 'c_lightning'], ['f_aura', 'c_poison'], ['f_meteor', 'c_gravity']];
      r.spells.forEach((sp, i) => { sp.def.capacity = 40; const root = S.newNode(combos[i][0]); root.children.push(S.newNode(combos[i][1])); sp.def.root = root; sp.c = S.compileSpell(sp.def); r.recomputeMut(sp); sp.cd = 0; });
      const T = ['grunt', 'swarmer', 'archer', 'charger', 'armored', 'shaman'];
      window.__swarm = setInterval(() => { let n = 0; for (const e of r.enemies) if (!e.dead) n++; for (let i = n; i < 120; i++) { const a = Math.random() * 6.28; S.spawnEnemy(r, T[i % 6], r.player.x + Math.cos(a) * 330, r.player.y + Math.sin(a) * 330); } for (const p of r.players) p.player.hp = Math.max(p.player.hp, 40); }, 300);
    });
    await B.bringToFront();
    const lat = await latency(B);
    await A.bringToFront();
    const latHost = await latency(A);
    await B.bringToFront();
    const rep0 = await game(A, (sc) => ({ ...sc.coop.rep.stats, t: performance.now() }));
    await B.waitForTimeout(6000);
    const rep1 = await game(A, (sc) => ({ ...sc.coop.rep.stats, t: performance.now() }));
    const ni = await game(B, (sc) => sc.coop.netInfo());
    const sec = (rep1.t - rep0.t) / 1000;

    // do host and joiner see the same world?
    const host = await game(A, (sc) => sc.run.enemies.filter((e) => !e.dead).map((e) => [e.id & 0xffff, e.spr.texture.key]));
    const guest = await game(B, (sc) => [...sc.coop.replica.enemies.values()].map((o) => [o.id, o.spr.texture.key]));
    const hm = new Map(host); let both = 0, sameTex = 0;
    for (const [id, tex] of guest) if (hm.has(id)) { both++; if (hm.get(id) === tex) sameTex++; }
    const hs = await game(A, (sc) => { const o = {}; for (const e of sc.run.ents) { if (e.dead) continue; for (const im of [e.spr, e.spr2, ...e.deco]) if (im && im.visible && im.alpha >= 0.02) o[im.texture.key] = (o[im.texture.key] || 0) + 1; } return o; });
    const gs = await game(B, (sc) => { const o = {}; for (const i of sc.coop.replica.imgs.values()) if (i.key >> 19 === 0) o[i.img.texture.key] = (o[i.img.texture.key] || 0) + 1; return o; });

    const kbs = ((rep1.stBytes - rep0.stBytes) + (rep1.fxBytes - rep0.fxBytes)) / sec / 1024;
    console.log(` key -> own camera moves (ms), quiet:  joiner ${J(stats(latQuiet))}`);
    console.log(` key -> own camera moves (ms), swarm:  joiner ${J(stats(lat))}\n                                          host   ${J(stats(latHost))}`);
    console.log(` payload to joiner: ${kbs.toFixed(0)} KB/s total; largest state datagram ${ni.chan.st.maxMsg} B; snapshots/s ${((rep1.snaps - rep0.snaps) / sec).toFixed(1)}; effects/s ${((rep1.fxEvents - rep0.fxEvents) / sec).toFixed(0)}`);
    console.log(` host: ${host.length} enemies, ${Object.values(hs).reduce((a, b) => a + b, 0)} spell sprites | joiner: ${guest.length} enemies; ids on both ${both}, same sprite ${sameTex}`);
    console.log(` network: RTT ${ni.net.rtt.toFixed(0)} ms, interpolation buffer ${ni.net.delay.toFixed(0)} ms, snapshots complete ${ni.net.complete}, lost ${ni.net.lost}, partial ${ni.net.incomplete}`);
    console.log(` prediction: ${J(ni.pred)}`);
    console.log(` cost: host replication ${(rep1.cpuSum / rep1.snaps).toFixed(2)} ms/snapshot; joiner decode ${(ni.net.decodeMs / ni.net.datagrams).toFixed(3)} ms/datagram, draw ${(ni.net.renderMs / ni.net.renders).toFixed(2)} ms/frame`);
    console.log(` frame ms: host ${J(stats(frameDeltas((await read(A)).t)))}\n           joiner ${J(stats(frameDeltas((await read(B)).t)))}`);
    check(latQuiet.length >= 6 && stats(latQuiet).p50 < 50, `joiner's own movement shows within ~1-3 frames of the key press regardless of latency (p50 ${stats(latQuiet).p50} ms)`);
    // Under the swarm both machines are limited by the software renderer (frames of 100+ ms), so latency there is a few-sample,
    // heavy-tailed measure of frame time; it is reported, not asserted. The frame-time distributions are the fairer comparison.
    const fj = stats(frameDeltas((await read(B)).t)), fh = stats(frameDeltas((await read(A)).t));
    check(fj.mean <= fh.mean * 1.25, `the joiner's frame time is not worse than the host's (mean ${fj.mean} vs ${fh.mean} ms)`);
    check(both >= guest.length - 2 && sameTex === both && both > 60, `every enemy on the joiner is on the host with the same sprite (${sameTex}/${both})`);
    check(Object.entries(hs).every(([k, v]) => Math.abs((gs[k] || 0) - v) <= 3), `spell sprites match by texture (${J(hs)} vs ${J(gs)})`);
    check(ni.chan.st.maxMsg <= 1000, `no state datagram larger than 1000 B (largest ${ni.chan.st.maxMsg}), so nothing is fragmented`);
    check(ni.pred.snaps === 0, 'no prediction snap (corrections were all smoothed)');
    check(s.errs.length === 0, `no page errors ${s.errs.slice(0, 2)}`);
    await s.close();
  }
  done();
})();
