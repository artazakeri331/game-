"use strict";
// Stage 5 unit tests: diplomacy, military, economy, events, victory on the real game simulation (server mode, in-process).
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const host = require("../sim-host");
const { makeTracker } = require("../world-sync");
const { runAction } = require("../world-actions");
const { decodeSnapshot, model, N } = require("./helpers");

let sim, tr, A, B, C, tileA, tileB, m, seq = 0, NC;
const S = () => sim.state();
const feed = () => { const d = tr.diff(++seq); m.apply(d); return d; };
const run = (nid, a) => runAction(sim, nid, a);
const dip = (nid, kind, target) => run(nid, { type: "diplo", kind, target });
const pk = (a, b) => a * NC + b;
const nat = (id) => S().G.nations[id];
const rich = (...ids) => ids.forEach((i) => { nat(i).gold = 1e6; });
function step(ticks) { for (let k = 0; k < ticks; k++) { sim.sky.step(0.1); if ((k + 1) % 5 === 0) feed(); } }
function pickPair(sim, skipIds = []) {
  const { owner, terr } = sim.state();
  for (let i = 0; i < N - 1; i++) {
    const a = owner[i], b = owner[i + 1];
    if (a < 1 || b < 1 || a === b || !terr[i] || !terr[i + 1] || skipIds.includes(a) || skipIds.includes(b)) continue;
    if (host.eligible(sim, a) && host.eligible(sim, b)) return { A: a, B: b, tileA: i, tileB: i + 1 };
  }
  throw new Error("no adjacent pair");
}
function fresh(seed, humans) {
  const s = host.createSim(seed); s.sky.server();
  const p = pickPair(s);
  const c = s.state().G.nations.find((n) => n.id >= 1 && n.alive && n.tiles >= 100 && n.id !== p.A && n.id !== p.B).id;
  s.sky.start(humans === 3 ? [p.A, p.B, c] : [p.A, p.B]);
  return { s, ...p, c };
}

before(() => {
  sim = host.createSim(4242); sim.sky.server();
  NC = sim.sky.NCOUNT;
  ({ A, B, tileA, tileB } = pickPair(sim));
  C = S().G.nations.find((n) => n.id >= 1 && n.alive && n.tiles >= 100 && n.id !== A && n.id !== B).id;
  sim.sky.start([A, B, C]);
  const { REL } = S(); REL.treaty.fill(0); REL.riv.fill(0); REL.pact.fill(0);       // start from clean relations (the game presets some real-world alliances)
  tr = makeTracker(sim);
  m = model(decodeSnapshot(host.snapshot(sim, 0, tr.lastEv()))); m.seq = 0;
  rich(A, B, C);
});

// ---------------- diplomacy: validation ----------------
test("diplomacy: invalid and impossible requests are rejected and change nothing", () => {
  const w0 = S().REL.war.slice();
  for (const [who, a] of [
    [A, { type: "diplo", kind: "war", target: A }],            // self
    [A, { type: "diplo", kind: "war", target: 9999 }],         // out of range
    [A, { type: "diplo", kind: "war", target: -1 }],
    [A, { type: "diplo", kind: "war", target: "1" }],          // wrong type
    [A, { type: "diplo", kind: "war", target: 1.5 }],
    [A, { type: "diplo", kind: "conquer", target: B }],        // unknown kind
    [A, { type: "diplo", kind: "peace", target: B }],          // not at war
    [A, { type: "diplo", kind: "alliance", target: B }],       // needs a trade deal first
    [A, { type: "diplo", kind: "end", target: B }],            // nothing to end
    [A, { type: "diplo", kind: "endpact", target: B }],
    [A, { type: "diplo", kind: "mend", target: B }],           // no dispute
    [A, { type: "respond", offer: 1, accept: true }],          // no such offer
    [A, { type: "respond", offer: "x", accept: true }],
    [A, { type: "respond", offer: 1, accept: "yes" }],
    [0, { type: "diplo", kind: "war", target: B }],            // nation 0 does not lead anyone
    [S().G.nations.find((n) => n.alive && !n.human && n.id > 0).id, { type: "diplo", kind: "war", target: B }],   // an AI nation is not controllable
    [A, null], [A, { type: 5 }], [A, { type: "launchEverything" }],
  ]) {
    const r = run(who, a);
    assert.equal(r.success, false, JSON.stringify(a) + " -> " + r.message);
    assert.ok(r.message);
  }
  assert.deepEqual([...S().REL.war], [...w0]);
});

test("diplomacy: war declaration between two humans uses the game's declareWar and syncs", () => {
  const r = dip(A, "war", B);
  assert.equal(r.success, true, r.message);
  assert.equal(S().REL.war[pk(A, B)], 1);
  assert.equal(S().REL.war[pk(B, A)], 1);
  const d = feed();
  assert.ok(d.rel.war.length >= 2);
  assert.equal(m.rel.war[pk(A, B)], 1);
  assert.ok(m.events.some((e) => /declared war/.test(e.text) && e.text.includes(nat(A).name)), "news event missing");
  assert.equal(dip(A, "war", B).success, false, "duplicate war declaration must be rejected");
  assert.equal(dip(B, "war", A).success, false, "already at war from the other side too");
});

test("attack: players at war can fight; the server computes troops; unrelated nations cannot be attacked", () => {
  const before = nat(A).troops;
  const r = run(A, { type: "attack", tile: tileB, ratio: 60, troops: 1e9 });
  assert.equal(r.success, true, r.message);
  assert.ok(Math.abs(before - nat(A).troops - before * 0.6) < 1);
  const t0 = nat(A).tiles, b0 = nat(B).tiles;
  step(150);
  assert.ok(nat(A).tiles > t0 || nat(B).tiles < b0, "war attack changed nothing");
  // C is not at war with A: attacking C's land is refused with a 'nowar' code the UI turns into the war prompt
  const { owner, terr } = S();
  let tileC = -1; for (let i = 0; i < N; i++) if (owner[i] === C && terr[i]) { tileC = i; break; }
  const rc = run(A, { type: "attack", tile: tileC, ratio: 30 });
  assert.equal(rc.success, false);
  assert.equal(rc.code === "nowar" || /border|not at war/i.test(rc.message), true, rc.message);
});

// ---------------- peace / treaties / gifts ----------------
test("peace: offer -> pending offer synced -> wrong player cannot answer -> acceptance ends the war with a ceasefire", () => {
  const r = dip(B, "peace", A);
  assert.equal(r.success, true, r.message);
  assert.equal(S().G.offers.length, 1);
  feed(); assert.equal(m.offers.length, 1);
  const id = S().G.offers[0].id;
  assert.equal(dip(B, "peace", A).success, false, "duplicate offer");
  assert.equal(run(B, { type: "respond", offer: id, accept: true }).success, false, "proposer cannot accept their own offer");
  assert.equal(run(C, { type: "respond", offer: id, accept: true }).success, false, "a third player cannot answer");
  assert.equal(S().REL.war[pk(A, B)], 1, "war must still be on");
  const ok = run(A, { type: "respond", offer: id, accept: true });
  assert.equal(ok.success, true, ok.message);
  assert.equal(S().REL.war[pk(A, B)], 0);
  assert.ok(S().REL.truce[pk(A, B)] > S().G.t, "ceasefire expected");
  assert.equal(S().G.offers.length, 0);
  feed(); assert.equal(m.offers.length, 0); assert.equal(m.rel.war[pk(A, B)], 0);
  assert.equal(run(A, { type: "respond", offer: id, accept: true }).success, false, "offer cannot be reused");
  assert.equal(run(A, { type: "attack", tile: tileB, ratio: 30 }).success, false, "no attacks during peace");
  assert.match(dip(A, "war", B).message, /ceasefire/i, "cannot declare war during a ceasefire");
});

test("peace: declining works and throttles immediate repeats; offers expire; stale offers are dropped", () => {
  S().REL.truce[pk(A, B)] = 0; S().REL.truce[pk(B, A)] = 0;
  assert.equal(dip(A, "war", B).success, true);
  assert.equal(dip(A, "peace", B).success, true);
  const id = S().G.offers[0].id;
  const r = run(B, { type: "respond", offer: id, accept: false });
  assert.equal(r.success, true, r.message);
  assert.equal(S().REL.war[pk(A, B)], 1, "declined: still at war");
  assert.match(dip(A, "peace", B).message, /will not discuss/);
  S().G.cd.clear();
  assert.equal(dip(A, "peace", B).success, true);
  step(10 * 62 + 5);                                             // > 60 s of game time
  assert.equal(S().G.offers.length, 0, "offer should have expired");
  assert.equal(dip(A, "peace", B).success, true);
  S().REL.war[pk(A, B)] = 0; S().REL.war[pk(B, A)] = 0;          // war ends some other way
  step(15);
  assert.equal(S().G.offers.length, 0, "peace offer with no war must be dropped");
});

test("mutual offers become an agreement; trade then alliance rules are enforced", () => {
  S().REL.truce.fill(0); S().G.cd.clear();
  assert.equal(dip(A, "trade", C).success, true);
  assert.equal(dip(C, "trade", A).success, true, "A's pending offer accepts C's identical offer");
  assert.equal(S().REL.treaty[pk(A, C)], 1);
  assert.equal(S().G.offers.length, 0);
  assert.equal(dip(A, "trade", C).success, false, "already have a deal");
  assert.match(dip(A, "alliance", C).message, /Too soon/);
  S().REL.tsince[pk(A, C)] = S().REL.tsince[pk(C, A)] = S().G.t - 200;
  assert.equal(dip(A, "alliance", C).success, true);
  const id = S().G.offers[0].id;
  assert.equal(run(C, { type: "respond", offer: id, accept: true }).success, true);
  assert.equal(S().REL.treaty[pk(A, C)], 2);
  assert.equal(S().REL.treaty[pk(C, A)], 2);
  feed(); assert.equal(m.rel.treaty[pk(A, C)], 2);
  assert.ok(m.events.some((e) => /alliance/.test(e.text)));
  assert.equal(dip(A, "war", C).success, true, "declaring war on an ally is allowed but costs reputation");
  assert.equal(S().REL.treaty[pk(A, C)], 0, "alliance broken by the game's own declareWar");
  assert.ok(nat(A).infamy >= 30);
  dip(A, "peace", C); run(C, { type: "respond", offer: S().G.offers[0].id, accept: true });
});

test("nuclear deal and ending a deal", () => {
  S().REL.truce.fill(0); S().G.cd.clear();
  assert.equal(dip(A, "nukepact", B).success, true);
  assert.equal(run(B, { type: "respond", offer: S().G.offers[0].id, accept: true }).success, true);
  assert.equal(S().REL.pact[pk(A, B)], 1);
  feed(); assert.equal(m.rel.pact[pk(B, A)], 1);
  assert.equal(dip(A, "endpact", B).success, true);
  assert.equal(S().REL.pact[pk(A, B)], 0);
});

test("gifts move real gold server-side, are validated, cooled down, and refused during war", () => {
  S().REL.war.fill(0); S().REL.truce.fill(0); S().G.cd.clear();
  nat(A).gold = 5000; nat(B).gold = 100;
  const r = dip(A, "gift", B);
  assert.equal(r.success, true, r.message);
  const sent = 5000 - nat(A).gold;
  assert.ok(sent >= 50);
  assert.equal(Math.round(nat(B).gold - 100), Math.round(sent), "recipient did not receive exactly what was sent");
  assert.match(dip(A, "gift", B).message, /Wait/);
  S().G.cd.clear(); nat(A).gold = 10;
  assert.equal(dip(A, "gift", B).success, false, "not enough gold");
  assert.ok(nat(A).gold >= 0);
  S().G.cd.clear(); nat(A).gold = 5000;
  dip(A, "war", B);
  assert.match(dip(A, "gift", B).message, /at war/);
  S().REL.war.fill(0); S().REL.truce.fill(0);
});

// ---------------- military ----------------
test("recruit / conscription: cost, cap and ownership are enforced by the game's own functions", () => {
  const n = nat(A);
  n.gold = 100000; n.troops = 100;
  const r = run(A, { type: "recruit", key: "small" });
  assert.equal(r.success, true, r.message);
  assert.ok(n.troops > 100 && n.gold < 100000);
  assert.equal(run(A, { type: "recruit", key: "__proto__" }).success, false);
  assert.equal(run(A, { type: "recruit", key: "huge" }).success, false);
  n.gold = 1;
  const g = n.gold;
  assert.equal(run(A, { type: "recruit", key: "big" }).success, false);
  assert.equal(n.gold, g, "failed recruit must not spend gold");
  n.gold = 100000;
  assert.equal(run(A, { type: "drive" }).success, true);
  assert.ok(n.drive > S().G.t);
  assert.equal(run(A, { type: "drive" }).success, false, "second drive while one is running");
  feed(); assert.ok(m.nat[A].drive > 0);
});

test("economy: tax is validated server-side and syncs; bonds; negative resources are impossible", () => {
  assert.equal(run(A, { type: "tax", value: 40 }).success, true);
  assert.equal(nat(A).tax, 0.4);
  for (const v of [-1, 61, 1.5, "abc", null, NaN, Infinity]) assert.equal(run(A, { type: "tax", value: v }).success, false, String(v));
  assert.equal(nat(A).tax, 0.4);
  feed(); assert.equal(m.nat[A].tax, 0.4);
  const n = nat(A); n.debt = 0;
  assert.equal(run(A, { type: "bonds", op: "issue" }).success, true);
  assert.ok(n.debt > 0);
  assert.equal(run(A, { type: "bonds", op: "issue" }).success, false, "must repay first");
  n.gold = 50; const d0 = n.debt;
  assert.equal(run(A, { type: "bonds", op: "repay" }).success, true);
  assert.ok(n.gold >= 0 && n.debt < d0);
  assert.equal(run(A, { type: "bonds", op: "steal" }).success, false);
  nat(A).tax = 0.25;
  // a player cannot change another nation's tax: the nation comes only from the server-side claim
  const bt = nat(B).tax;
  run(A, { type: "tax", value: 10, nation: B, target: B });
  assert.equal(nat(B).tax, bt);
});

test("missiles: silo, cost, war requirement; projectile syncs to clients and its removal arrives too", () => {
  const { owner, terr, G } = S();
  rich(A, B);
  const own = (id) => { for (let i = 0; i < N; i++) if (owner[i] === id && terr[i] && !G.bat.has(i)) return i; return -1; };
  const tB = own(B), sA = own(A);
  assert.ok(tB >= 0);
  assert.equal(run(A, { type: "missile", key: "cruise", tile: tB }).success, false, "no silo yet");
  assert.equal(run(A, { type: "missile", key: "bogus", tile: tB }).success, false);
  assert.equal(run(A, { type: "build", building: "silo", tile: sA }).success, true);
  const r0 = run(A, { type: "missile", key: "cruise", tile: tB });
  assert.equal(r0.success, false);
  assert.equal(r0.code, "nowar", r0.message);                       // not at war -> the UI offers to declare war first
  assert.equal(dip(A, "war", B).success, true);
  const gold0 = nat(A).gold;
  const r = run(A, { type: "missile", key: "cruise", tile: tB });
  assert.equal(r.success, true, r.message);
  assert.ok(nat(A).gold < gold0, "missile cost not charged");
  assert.equal(G.missiles.length >= 1, true);
  const d = feed();
  assert.ok(d.pr && d.pr.m && d.pr.m.up.length >= 1, "projectile not in delta");
  const id = d.pr.m.up[0]._id;
  assert.ok(m.proj.m.has(id));
  assert.match(run(A, { type: "missile", key: "cruise", tile: tB }).message, /reload/i, "silo cooldown must be enforced");
  assert.ok(m.events.some((e) => /launched a Cruise/.test(e.text)));
  step(100);
  assert.equal(m.proj.m.has(id), false, "missile removal not synced");
  assert.deepEqual([...m.proj.m.keys()].sort(), Array.from(S().G.missiles, (x) => x._id).sort());
});

test("air power: jets need an airfield and hangar space, sorties need a target at war; satellites; stored missiles", () => {
  const { owner, terr, G } = S();
  rich(A);
  assert.equal(run(A, { type: "jet", kind: "bomber" }).success, false, "no airfield");
  assert.equal(run(A, { type: "jet", kind: "drone" }).success, false);
  let tile = -1; for (let i = 0; i < N; i++) if (owner[i] === A && terr[i] && !G.bat.has(i)) { tile = i; break; }
  assert.equal(run(A, { type: "build", building: "air", tile }).success, true);
  assert.equal(run(A, { type: "jet", kind: "bomber" }).success, true);
  assert.equal(nat(A).bombers >= 1, true);
  const fighters = nat(A).fighters;
  assert.equal(run(A, { type: "jet", kind: "fighter" }).success, true);
  assert.equal(nat(A).fighters, fighters + 1);
  feed(); assert.equal(m.nat[A].bombers, nat(A).bombers);
  const g0 = nat(A).gold;
  let tB2 = -1; for (let i = 0; i < N; i++) if (owner[i] === B && terr[i]) { tB2 = i; break; }
  const r = run(A, { type: "bomber", tile: tB2 });
  assert.equal(r.success, true, r.message);                          // at war with B from the previous test
  assert.equal(G.bombers.length, 1);
  const d = feed();
  assert.ok(d.pr && d.pr.b, "bomber not synced");
  assert.equal(run(A, { type: "sat" }).success, true);
  assert.equal(nat(A).sats, 1);
  nat(A).gold = 5;
  assert.equal(run(A, { type: "sat" }).success, false);
  assert.equal(nat(A).sats, 1);
  nat(A).gold = 1e6;
  assert.equal(run(A, { type: "stock", key: "cruise" }).success, true);
  assert.equal(nat(A).stock.cruise, 1);
  assert.equal(run(A, { type: "stock", key: "nope" }).success, false);
  step(150);
  assert.ok(g0 >= 0);
});

test("navy: sea invasion and anti-ship actions validate on the server", () => {
  const { owner, terr } = S();
  let tile = -1; for (let i = 0; i < N; i++) if (owner[i] === B && terr[i]) { tile = i; break; }
  assert.equal(nat(A).cnt.port, 0);
  assert.match(run(A, { type: "naval", tile, ratio: 50 }).message, /Port|not at war/i);
  assert.equal(run(A, { type: "naval", tile, ratio: 500 }).success, false);
  assert.equal(run(A, { type: "naval", tile: -5, ratio: 50 }).success, false);
  assert.equal(run(A, { type: "sink", tile }).success, false, "no ship there");
  assert.equal(run(A, { type: "retreat" }).success === true || /No attacks/.test(run(A, { type: "retreat" }).message), true);
});

test("a nation cannot be controlled by a player who does not lead it, and released nations lose control", () => {
  sim.sky.setHuman(C, false);
  assert.equal(run(C, { type: "tax", value: 10 }).success, false);
  assert.equal(run(C, { type: "diplo", kind: "war", target: A }).success, false);
  assert.ok(!S().G.mpIds.includes(C));
  assert.equal(S().G.offers.some((o) => o.from === C || o.to === C), false);
  sim.sky.setHuman(C, true);
  assert.ok(S().G.mpIds.includes(C));
});

// ---------------- events ----------------
test("events: ids strictly increase, nothing repeats, and a snapshot carries the id it is aligned to", () => {
  const ids = m.events.map((e) => e.id);
  assert.ok(ids.length > 3);
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b));
  const snap = decodeSnapshot(host.snapshot(sim, seq, tr.lastEv()));
  assert.equal(snap.ev, tr.lastEv());
  // a late client: snapshot first, then a replay of an old delta's events is ignored
  const late = model(snap); late.seq = seq;
  late.apply({ seq: seq + 1, t: 0, phase: "play", nat: [], cold: {}, blds: [], ev: m.events.slice(0, 3).map((e) => [e.id, 0, e.text, e.cls, 0]) });
  assert.equal(late.events.length, 0, "events older than the snapshot must not be re-added");
});

test("sync: snapshot + deltas equals a fresh authoritative snapshot (relations, offers, projectiles, tiles)", () => {
  dip(A, "gift", B);                                          // just to make the state busy
  step(40);
  const snap = decodeSnapshot(host.snapshot(sim, seq, tr.lastEv()));
  for (const f of ["war", "treaty", "pact", "riv"]) assert.deepEqual([...m.rel[f]], [...snap.REL[f]], f);
  assert.deepEqual(m.offers, snap.G.offers);
  assert.equal(Buffer.compare(Buffer.from(m.owner), Buffer.from(snap.owner)), 0);
  for (const k of ["m", "b", "s"]) assert.deepEqual([...m.proj[k].keys()].sort(), snap.G[{ m: "missiles", b: "bombers", s: "boats" }[k]].map((o) => o._id).sort(), k);
  // opinions involving humans are within rounding of the server
  for (const h of [A, B]) for (let o = 1; o < NC; o++) assert.ok(Math.abs(m.rel.op[pk(h, o)] - S().REL.op[pk(h, o)]) <= 1.01, "op drift");
});

// ---------------- victory / defeat ----------------
test("elimination: a human nation that loses all land is eliminated; the last surviving player wins; game-over syncs", () => {
  const f = fresh(777, 2);
  const { G, owner, terr } = f.s.state();
  const mm = model(decodeSnapshot(host.snapshot(f.s, 0, 0))); mm.seq = 0;
  const t2 = makeTracker(f.s);
  let sq = 0; const go = (n) => { for (let k = 0; k < n; k++) { f.s.sky.step(0.1); if ((k + 1) % 5 === 0) mm.apply(t2.diff(++sq)); } };
  go(20);
  assert.equal(G.over, null);
  for (let i = 0; i < N; i++) if (owner[i] === f.B) owner[i] = -1;       // B loses everything
  go(30);
  assert.equal(G.nations[f.B].alive, false);
  assert.ok(mm.events.some((e) => e.text.includes(G.nations[f.B].name) && /fallen/.test(e.text)), "defeat event missing");
  assert.ok(G.over, "game should be over");
  assert.equal(G.over.winner, f.A);
  assert.match(G.over.why, /Last surviving player/);
  assert.deepEqual(mm.over, { winner: f.A, why: G.over.why });
  assert.equal(runAction(f.s, f.A, { type: "tax", value: 20 }).success, false, "no actions after game over");
  assert.equal(runAction(f.s, f.B, { type: "tax", value: 20 }).success, false);
});

test("elimination of the only player ends the game; AIs keep playing otherwise", () => {
  const s = host.createSim(778); s.sky.server();
  const p = pickPair(s);
  s.sky.start([p.A]);
  const { G, owner } = s.state();
  for (let k = 0; k < 30; k++) s.sky.step(0.1);
  assert.equal(G.over, null, "a lone player with AI opponents must not end the game by itself");
  for (let i = 0; i < N; i++) if (owner[i] === p.A) owner[i] = -1;
  for (let k = 0; k < 30; k++) s.sky.step(0.1);
  assert.ok(G.over);
  assert.match(G.over.why, /fallen/);
  assert.notEqual(G.over.winner, p.A);
});

test("victory by land share uses the original rule and names the winner", () => {
  const f = fresh(779, 2);
  const { G } = f.s.state();
  G.nations[f.A].tiles = Math.ceil(G.land * 0.6);
  for (let k = 0; k < 30; k++) f.s.sky.step(0.1);
  assert.ok(G.over);
  assert.equal(G.over.winner, f.A);
  assert.match(G.over.why, new RegExp(G.nations[f.A].name));
  assert.doesNotMatch(G.over.why, /^You hold/);
});

test("victory by alliance bloc works for any human nation", () => {
  const f = fresh(780, 3);
  const { G, REL } = f.s.state();
  const NCt = f.s.sky.NCOUNT;
  REL.treaty[f.A * NCt + f.c] = REL.treaty[f.c * NCt + f.A] = 2;
  G.nations[f.A].tiles = Math.ceil(G.land * 0.3); G.nations[f.c].tiles = Math.ceil(G.land * 0.4);
  G.nations[f.B].tiles = Math.min(G.nations[f.B].tiles, 100);
  let k = 0;
  for (; k < 600 && !G.over; k++) f.s.sky.step(0.1);
  assert.ok(G.over, "bloc victory never triggered");
  assert.equal(G.over.winner, f.A);
  assert.match(G.over.why, /alliance bloc/);
  assert.ok(k >= 440, "bloc must hold for ~45 s, took " + k / 10);
});

test("a released (disconnected-for-good) player's nation goes back to AI and no longer counts as a player", () => {
  const f = fresh(781, 2);
  f.s.sky.setHuman(f.B, false);
  for (let k = 0; k < 30; k++) f.s.sky.step(0.1);
  assert.equal(f.s.state().G.over, null, "one human left among AIs: game continues");
  assert.equal(f.s.state().G.nations[f.B].human, false);
});

test("naval invasion: port + sea route + war; the fleet is a synced projectile that lands and then disappears", () => {
  const s = host.createSim(4242); s.sky.server();
  const { owner, terr, G } = s.state();
  const ids = host.eligibleIds(s), P1 = ids[0];
  s.sky.start([P1]);
  const n = G.nations[P1]; n.gold = 1e6; n.troops = 5000;
  const t2 = makeTracker(s); const mm = model(decodeSnapshot(host.snapshot(s, 0, 0))); mm.seq = 0; let sq = 0;
  const go = (k) => { for (let j = 0; j < k; j++) { s.sky.step(0.1); if ((j + 1) % 5 === 0) mm.apply(t2.diff(++sq)); } };
  assert.match(runAction(s, P1, { type: "naval", tile: 5, ratio: 30 }).message, /Port|coast|Pick/);
  for (let i = 0; i < N && !n.cnt.port; i++) if (owner[i] === P1 && terr[i]) runAction(s, P1, { type: "build", building: "port", tile: i });
  assert.ok(n.cnt.port >= 1);
  let launched = null;
  for (const D of ids.slice(1, 15)) {
    s.sky.fn.declareWar(P1, D);
    for (let i = 0, tried = 0; i < N && tried < 30 && !launched; i += 997) {
      if (owner[i] !== D || !terr[i]) continue; tried++;
      const troops0 = n.troops;
      const r = runAction(s, P1, { type: "naval", tile: i, ratio: 30 });
      if (r.success) { launched = { D, troops0 }; }
    }
    if (launched) break;
  }
  assert.ok(launched, "no sea route found for any enemy");
  assert.ok(n.troops < launched.troops0, "troops were not taken for the fleet");
  assert.equal(G.boats.length, 1);
  go(5);
  const id = G.boats.find((b) => b.owner === P1)._id;
  assert.ok(mm.proj.s.has(id), "boat not synced");
  const d0 = mm.proj.s.get(id).d;
  go(20);
  assert.ok(!mm.proj.s.has(id) || mm.proj.s.get(id).d > d0, "boat progress not synced");
  go(2500);
  assert.equal(G.boats.some((b) => b.owner === P1), false, "fleet never landed");
  assert.equal(mm.proj.s.has(id), false, "boat removal not synced");
  assert.deepEqual([...mm.proj.s.keys()].sort(), Array.from(G.boats, (b) => b._id).sort());
});
