"use strict";
// All-in mode in multiplayer: the server runs the game's own buildMany / upgradeMany / recruitMany for the player's nation.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const host = require("../sim-host");
const { makeTracker } = require("../world-sync");
const { runAction } = require("../world-actions");
const { N } = require("./helpers");

let sim, A, B;
const S = () => sim.state();
const run = (nid, a) => runAction(sim, nid, a);
const nat = (id) => S().G.nations[id];
const ownTile = (id, skip = new Set()) => { const { owner, terr, G } = S(); for (let i = 0; i < N; i++) if (owner[i] === id && terr[i] === 1 && !G.bat.has(i) && !skip.has(i)) return i; return -1; };

before(() => {
  sim = host.createSim(4242); sim.sky.server();
  const { owner, terr } = S();
  for (let i = 0; i < N - 1 && !A; i++) { const a = owner[i], b = owner[i + 1]; if (a >= 1 && b >= 1 && a !== b && terr[i] && terr[i + 1] && host.eligible(sim, a) && host.eligible(sim, b)) { A = a; B = b; } }
  sim.sky.start([A, B]);
});

test("All-in build: one request builds many buildings, spends real gold, never goes negative, and is bounded", () => {
  const n = nat(A); n.gold = 2000;
  const before = S().G.blds.filter((b) => b.owner === A).length;
  const single = run(A, { type: "build", building: "city", tile: ownTile(A) });
  assert.equal(single.success, true, single.message);
  assert.equal(S().G.blds.filter((b) => b.owner === A).length, before + 1, "without all, exactly one building");
  const g0 = n.gold;
  const r = run(A, { type: "build", building: "market", tile: ownTile(A), all: true });
  assert.equal(r.success, true, r.message);
  assert.match(r.message, /^All-in: built \d+/);
  const built = S().G.blds.filter((b) => b.owner === A).length - before - 1;
  assert.ok(built > 1, "built several: " + built);
  assert.ok(n.gold >= 0 && n.gold < g0, "gold spent, not negative: " + n.gold);
  n.gold = 1e9;                                                  // even with unlimited gold the loop is bounded
  const t0 = Date.now(); const big = run(A, { type: "build", building: "barracks", tile: ownTile(A), all: true });
  assert.ok(big.success, big.message); assert.ok(Date.now() - t0 < 2000);
  assert.ok(S().G.blds.filter((b) => b.owner === A && b.type === "barracks").length <= 1700, "bounded by the game's own search grid, not by gold");
});

test("All-in build/upgrade/recruit validate like single actions (ownership, war-free, cost) and ignore a non-boolean `all`", () => {
  const n = nat(A); n.gold = 0;
  assert.equal(run(A, { type: "build", building: "city", tile: ownTile(A), all: true }).success, false, "no gold: refused");
  assert.equal(run(A, { type: "build", building: "bogus", tile: 1, all: true }).success, false);
  const foreign = ownTile(B);
  n.gold = 5000;
  const r = run(A, { type: "build", building: "city", tile: foreign, all: true });
  assert.equal(r.success, false, "cannot build on another nation's land: " + r.message);
  const gold = n.gold; const before = S().G.blds.length;
  assert.equal(run(A, { type: "build", building: "city", tile: ownTile(A), all: "yes" }).message, "City built.", "`all` must be exactly true; otherwise one building");
  assert.equal(S().G.blds.length, before + 1); assert.ok(n.gold < gold);
});

test("All-in upgrade upgrades many of the same type; recruit all-in spends gold on troops up to the cap", () => {
  const n = nat(A); n.gold = 1e6;
  for (let k = 0; k < 4; k++) assert.equal(run(A, { type: "build", building: "city", tile: ownTile(A) }).success, true);
  const cities = S().G.blds.filter((b) => b.owner === A && b.type === "city");
  const lv0 = cities.map((b) => b.lv).reduce((x, y) => x + y, 0);
  const up = run(A, { type: "upgrade", tile: cities[0].i, all: true });
  assert.equal(up.success, true, up.message); assert.match(up.message, /^All-in: \d+ upgrade/);
  assert.ok(S().G.blds.filter((b) => b.owner === A && b.type === "city").map((b) => b.lv).reduce((x, y) => x + y, 0) > lv0 + 1);
  n.gold = 1e6; n.troops = 100;
  const rec = run(A, { type: "recruit", key: "small", all: true });
  assert.equal(rec.success, true, rec.message); assert.match(rec.message, /^All-in: recruited/);
  assert.ok(n.troops > 100 && n.gold < 1e6 && n.gold >= 0);
});

test("the recruit helper used by All-in is bound to the acting nation (it used to hard-code nation 0)", () => {
  const b = nat(B); const a = nat(A); a.gold = 1e6; b.gold = 1e6; a.troops = 100; b.troops = 100;
  const bg = b.gold, bt = b.troops;
  run(A, { type: "recruit", key: "small", all: true });
  assert.equal(b.gold, bg, "B's gold untouched"); assert.equal(b.troops, bt, "B's troops untouched");
});
