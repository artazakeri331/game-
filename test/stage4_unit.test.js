"use strict";
// Stage 4 unit tests: the real game simulation in-process (server mode). No sockets.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const host = require("../sim-host");
const { makeTracker, MAX_TILE_DELTA } = require("../world-sync");
const { runAction } = require("../world-actions");
const { decodeSnapshot, model, findNeutralBorder, MW, N } = require("./helpers");

let sim, tr, A, B, tileB, snap0, m, seq = 0;
const S = () => sim.state();
const feed = () => { const d = tr.diff(++seq); m.apply(d); return d; };
const run = (nid, a) => runAction(sim, nid, a);
function step(ticks) { for (let k = 0; k < ticks; k++) { sim.sky.step(0.1); if ((k + 1) % 5 === 0) feed(); } }

before(() => {
  sim = host.createSim(4242); sim.sky.server();
  const { owner, terr, G } = S();
  // two adjacent, claimable nations
  outer: for (let i = 0; i < N - 1; i++) {
    const a = owner[i], b = owner[i + 1];
    if (a < 1 || b < 1 || a === b || !terr[i] || !terr[i + 1]) continue;
    if (!host.eligible(sim, a) || !host.eligible(sim, b)) continue;
    A = a; B = b; tileB = i + 1; break outer;
  }
  assert.ok(A && B, "no adjacent nation pair");
  sim.sky.start([A, B]);
  snap0 = decodeSnapshot(host.snapshot(sim, 0));
  tr = makeTracker(sim); m = model(snap0); m.seq = 0;
});

test("server mode: a started multi-human game does not end because nation 0 is not alive", () => {
  step(100);
  assert.equal(S().G.over, null);
  assert.equal(S().G.phase, "play");
});

test("original rule is intact when server mode is NOT enabled (solo regression at sim level)", () => {
  const solo = host.createSim(1234);                // no sky.server(): same code path as the browser
  const { G } = solo.state();
  G.phase = "play"; G.paused = false;
  for (let k = 0; k < 15; k++) solo.sky.step(0.1);
  assert.ok(G.over, "solo rule 'Your nation fell' should still end a game with no player nation");
  assert.match(G.over.why, /Your nation fell/);
});

test("human nations are not driven by the AI; the rest still are", () => {
  const { G } = S();
  const ai = G.nations.find((n) => n.alive && !n.human && n.id > 0);
  const aiT = ai.aiT, aT = G.nations[A].aiT;
  step(50);
  assert.equal(G.nations[A].aiT, aT, "claimed nation was driven by the AI");
  assert.notEqual(ai.aiT, aiT, "unclaimed AI nation stopped thinking");
});

test("attack: neutral land is allowed, mapped to the server's own troop count, and reduces troops", () => {
  const { G } = S();
  const nb = findNeutralBorder({ owner: S().owner, terr: S().terr, G }, new Set([B]));
  const C = nb.nation;
  assert.ok(host.eligible(sim, C));
  sim.sky.setHuman(C, true);
  const before = G.nations[C].troops;
  const r = run(C, { type: "attack", tile: nb.target, ratio: 50, troops: 99999999 });   // extra client-sent troops field is ignored
  assert.equal(r.success, true, r.message);
  assert.ok(Math.abs(before - G.nations[C].troops - before * 0.5) < 1, "troops not computed from server state");
  assert.ok(G.attacks.some((x) => x.atk === C && x.def === -1));
  const tiles0 = G.nations[C].tiles;
  step(100);
  assert.ok(G.nations[C].tiles > tiles0, "attack did not take any land");
  sim.sky.setHuman(C, false);
});

test("attack: another nation requires war; after a war is declared with the game's own rules it works and land changes hands", () => {
  const { G } = S();
  const r1 = run(A, { type: "attack", tile: tileB, ratio: 50 });
  assert.equal(r1.success, false); assert.match(r1.message, /not at war/);
  assert.equal(sim.sky.fn.declareWar(A, B), "");
  const a0 = G.nations[A].tiles, b0 = G.nations[B].tiles;
  const r2 = run(A, { type: "attack", tile: tileB, ratio: 100 });
  assert.equal(r2.success, true, r2.message);
  step(300);
  assert.ok(G.nations[A].tiles > a0 && G.nations[B].tiles < b0, `no land changed hands (${a0}->${G.nations[A].tiles}, ${b0}->${G.nations[B].tiles})`);
});

test("attack: invalid requests are rejected with clear reasons", () => {
  const { G, owner, terr } = S();
  const own = owner.findIndex((o, i) => o === A && terr[i]);
  const bad = (a, re) => { const r = run(A, a); assert.equal(r.success, false, JSON.stringify(a)); assert.match(r.message, re, JSON.stringify(a)); };
  bad({ type: "attack", tile: own, ratio: 50 }, /your own land/);
  bad({ type: "attack", tile: -1, ratio: 50 }, /Invalid target/);
  bad({ type: "attack", tile: N, ratio: 50 }, /Invalid target/);
  bad({ type: "attack", tile: 1.5, ratio: 50 }, /Invalid target/);
  bad({ type: "attack", tile: "100", ratio: 50 }, /Invalid target/);
  bad({ type: "attack", tile: own + 1, ratio: 0 }, /Invalid troop/);
  bad({ type: "attack", tile: own + 1, ratio: 101 }, /Invalid troop/);
  bad({ type: "attack", tile: own + 1, ratio: "abc" }, /Invalid troop/);
  bad({ type: "attack", tile: own + 1 }, /Invalid troop/);
  bad({ type: "teleport", tile: own }, /Unknown action/);
  bad(null, /Invalid request/); bad("attack", /Invalid request/); bad({ type: 7 }, /Invalid request/);
  // deep water: no land within the game's own 4-tile snap radius
  let water = -1;
  for (let i = 0; i < N && water < 0; i += 37) { let any = false; const x = i % MW, y = (i / MW) | 0; for (let dy = -4; dy <= 4 && !any; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < MW && yy < 480 && terr[yy * MW + xx]) { any = true; break; } } if (!any && x > 5 && x < MW - 5 && y > 5 && y < 474) water = i; }
  assert.ok(water >= 0); bad({ type: "attack", tile: water, ratio: 50 }, /water/);
  // not enough troops
  const keep = G.nations[A].troops; G.nations[A].troops = 3;
  const nb = findNeutralBorder({ owner, terr, G }, new Set([B, A]));
  sim.sky.setHuman(nb.nation, true); const k2 = G.nations[nb.nation].troops; G.nations[nb.nation].troops = 3;
  bad2(nb.nation, { type: "attack", tile: nb.target, ratio: 50 }, /Not enough troops/);
  G.nations[A].troops = keep; G.nations[nb.nation].troops = k2; sim.sky.setHuman(nb.nation, false);
  function bad2(n, a, re) { const r = run(n, a); assert.equal(r.success, false); assert.match(r.message, re); }
  // no land border (A needs troops again: the war test above sent them all)
  G.nations[A].troops = 20000;
  // at war with a distant nation: no shared border (the game's own rule), so no attack
  const dist = (n) => Math.hypot(n.cx - G.nations[A].cx, n.cy - G.nations[A].cy);
  const D = G.nations.filter((n) => n.alive && n.id > 0 && n.id !== A && n.id !== B && n.tiles >= 100).sort((p, q) => dist(q) - dist(p))[0];
  assert.equal(sim.sky.fn.declareWar(A, D.id), "");
  const far = owner.findIndex((o, i) => o === D.id && terr[i]);
  bad({ type: "attack", tile: far, ratio: 50 }, /does not border|No land border/);
});

test("authorization: spectators, unstarted games, eliminated or released nations cannot act", () => {
  const { G, owner, terr } = S();
  const own = owner.findIndex((o, i) => o === A && terr[i] === 1 && !G.bat.has(i));
  assert.match(run(0, { type: "build", building: "city", tile: own }).message, /do not lead/);
  assert.match(run(undefined, { type: "build", building: "city", tile: own }).message, /do not lead/);
  assert.match(run(999, { type: "build", building: "city", tile: own }).message, /do not lead/);
  const free = G.nations.find((n) => n.alive && n.id > 0 && !n.human);
  assert.match(run(free.id, { type: "build", building: "city", tile: own }).message, /do not control/);
  G.nations[B].alive = false; assert.match(run(B, { type: "build", building: "city", tile: own }).message, /fallen/); G.nations[B].alive = true;
  G.phase = "spawn"; assert.match(run(A, { type: "build", building: "city", tile: own }).message, /not started/); G.phase = "play";
  G.over = { winner: 1, why: "x" }; assert.match(run(A, { type: "build", building: "city", tile: own }).message, /over/); G.over = null;
  sim.sky.setHuman(B, false);
  assert.match(run(B, { type: "build", building: "city", tile: own }).message, /do not control/);
  assert.equal(sim.sky.setHuman(B, true), true);
});

test("build: valid build deducts gold, updates counts and is emitted as a stable per-tile delta", () => {
  const { G, owner, terr } = S();
  const own = owner.findIndex((o, i) => o === A && terr[i] === 1 && !G.bat.has(i));
  const cost = sim.sky.fn.BUILD.city.cost * (1 + 0.18 * G.nations[A].cnt.city), g0 = G.nations[A].gold, c0 = G.nations[A].cnt.city;
  const r = run(A, { type: "build", building: "city", tile: own, owner: B, nation: B });   // spoofed owner/nation fields are ignored
  assert.equal(r.success, true, r.message);
  assert.equal(G.nations[A].cnt.city, c0 + 1);
  assert.ok(Math.abs(g0 - G.nations[A].gold - Math.round(cost)) < 2, "wrong gold deducted");
  assert.equal(G.bat.get(own).owner, A);
  const d = tr.diff(++seq); m.apply(d);
  const e = d.blds.find((x) => x[0] === own);
  assert.ok(e && e[1].type === "city" && e[1].owner === A && e[1].lv === 1, JSON.stringify(d.blds));
  global.__own = own;
});

test("build: invalid builds are rejected by the game's own rules", () => {
  const { G, owner, terr } = S();
  const own = global.__own;
  const bad = (n, a, re) => { const r = run(n, a); assert.equal(r.success, false, JSON.stringify(a)); assert.match(r.message, re, JSON.stringify(a)); };
  bad(A, { type: "build", building: "city", tile: own }, /already built/);
  bad(B, { type: "build", building: "city", tile: own }, /your own land/);                 // someone else's land
  bad(A, { type: "build", building: "nuke", tile: own + 1 }, /Unknown building/);
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", 5, null]) bad(A, { type: "build", building: k, tile: own + 1 }, /Unknown building/);
  bad(A, { type: "build", building: "city", tile: -5 }, /Invalid tile/);
  bad(A, { type: "build", building: "city", tile: "x" }, /Invalid tile/);
  const plains = owner.findIndex((o, i) => o === A && terr[i] === 1 && !G.bat.has(i));
  bad(A, { type: "build", building: "mine", tile: plains }, /mountain/);
  const inland = owner.findIndex((o, i) => o === A && terr[i] && !G.bat.has(i) && terr[i - 1] && terr[i + 1] && terr[i - MW] && terr[i + MW]);
  bad(A, { type: "build", building: "port", tile: inland }, /coast/);
  const sea = owner.findIndex((o, i) => o === A && !terr[i]);
  if (sea >= 0) bad(A, { type: "build", building: "city", tile: sea }, /your own land/);
  const g = G.nations[A].gold; G.nations[A].gold = 0;
  bad(A, { type: "build", building: "city", tile: plains }, /Not enough gold/);
  G.nations[A].gold = g;
});

test("upgrade: succeeds on own building, rejected on others' / missing buildings / max level", () => {
  const { G } = S();
  const own = global.__own;
  G.nations[A].gold = 1e6;
  assert.equal(run(A, { type: "upgrade", tile: own }).success, true);
  const d = tr.diff(++seq); m.apply(d);
  assert.equal(d.blds.find((x) => x[0] === own)[1].lv, 2);
  assert.equal(run(B, { type: "upgrade", tile: own }).success, false);
  assert.match(run(A, { type: "upgrade", tile: 5 }).message, /own buildings/);
  for (let k = 0; k < 5; k++) run(A, { type: "upgrade", tile: own });
  assert.match(run(A, { type: "upgrade", tile: own }).message, /max level/);
  assert.equal(run(A, { type: "upgrade", tile: "x" }).success, false);
});

test("deltas are lossless: snapshot + deltas equals the live authoritative state", () => {
  step(200);                                      // AI expansion, attacks, economy keep running
  const { G, owner, REL } = S();
  assert.deepEqual(Buffer.from(m.owner), Buffer.from(owner), "ownership diverged");
  assert.equal(m.blds.size, G.blds.length);
  for (const b of G.blds) { const x = m.blds.get(b.i); assert.ok(x && x.type === b.type && x.owner === b.owner && x.lv === b.lv, "building diverged at " + b.i); }
  for (const n of G.nations) { const x = m.nat[n.id]; assert.equal(x.tiles, n.tiles); assert.ok(Math.abs(x.troops - n.troops) < 20 && Math.abs(x.gold - n.gold) < 60, `nation ${n.id} economy diverged`); assert.equal(x.human, n.human); assert.equal(x.alive, n.alive); }
  assert.deepEqual(Array.from(m.rel.war), Array.from(REL.war));
  assert.deepEqual(Array.from(m.rel.treaty), Array.from(REL.treaty));
});

test("a change too large for a delta asks clients to resync instead of flooding them", () => {
  const { owner, terr } = S();
  let c = 0; for (let i = 0; i < N && c <= MAX_TILE_DELTA + 10; i++) if (terr[i] && owner[i] !== -1) { owner[i] = -1; c++; }
  const d = tr.diff(++seq);
  assert.equal(d.resync, true); assert.equal(d.tiles, undefined);
});
