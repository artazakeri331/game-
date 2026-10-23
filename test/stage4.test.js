"use strict";
// Stage 4 socket tests: real server process (worker-thread sims), real Socket.IO clients.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");
const { ask, until, sleep, MW, N } = H;

const URL1 = "http://localhost:3271";
let srv, A, B, nbA, nbB, base, ownA, ownB, tileOfA;
// Paced just under the server's 5 actions/s limit, like a human clicking. The rate-limit test below uses raw `ask` to burst.
const act = async (c, action, extra = {}) => {
  const wait = 230 - (Date.now() - (c.lastAct || 0)); if (wait > 0) await sleep(wait); c.lastAct = Date.now();
  return ask(c, "game-action", { rid: Math.random().toString(36).slice(2, 12), action, ...extra });
};
const lastSeq = (c) => (c.deltas.length ? c.deltas[c.deltas.length - 1].seq : -1);
const natOf = (c, id) => { for (let i = c.deltas.length - 1; i >= 0; i--) { const v = c.deltas[i].nat.find((x) => x[0] === id); if (v) return { troops: v[1], gold: v[2], tiles: v[3] }; } };

before(async () => { srv = await H.startServer(3271); });
after(() => { H.closeAll(); srv && srv.kill(); });

test("same room, same world: players receive an identical world before the game starts", async () => {
  A = await H.makeRoom(URL1, "Alice"); B = await H.joinRoom(URL1, A.code, "Bob");
  await H.makeWorld(A);
  const [sa, sb] = await Promise.all([H.snapshotOf(A), H.snapshotOf(B)]);
  assert.equal(sa.seed, sb.seed); assert.equal(sa.seq, sb.seq);
  assert.ok(Buffer.compare(Buffer.from(sa.reply.snapshot), Buffer.from(sb.reply.snapshot)) === 0, "snapshots differ");
  base = sa;
  const nb = H.findNeutralBorder(sa);
  nbA = nb.nation; tileOfA = nb.target;
  nbB = sa.G.nations.find((n) => n.id >= 1 && n.id !== nbA && n.alive && n.tiles >= 100).id;
  ownA = H.firstTile(sa, nbA, (i) => sa.terr[i] === 1);
  ownB = H.firstTile(sa, nbB, (i) => sa.terr[i] === 1);
});

test("starting: needs the host, a claim and a ready world; actions are refused until then", async () => {
  assert.match((await act(A, { type: "build", building: "city", tile: ownA })).message, /not started/);
  assert.match((await ask(B, "start-game")).message, /Only the host/);
  assert.match((await ask(A, "start-game")).message, /At least one player must pick/);
  assert.ok((await ask(A, "claim-nation", { nation: nbA })).success);
  assert.ok((await ask(B, "claim-nation", { nation: nbB })).success);
  const noRoom = await H.connect(URL1);
  assert.match((await ask(noRoom, "start-game")).message, /Join a room first/);
});

test("ownership: claims map to real nation ids on the server and are visible to every client", async () => {
  const r = await ask(A, "start-game");
  assert.ok(r.success, r.message);
  assert.match((await ask(A, "start-game")).message, /already started/);
  assert.match((await ask(A, "create-world")).message, /already exists/);
  await until(() => A.last.world.started && B.last.world.started, 5000, "started broadcast");
  const sa = await H.snapshotOf(A);
  assert.equal(sa.G.phase, "play");
  const humans = sa.G.nations.filter((n) => n.human && n.id > 0).map((n) => n.id).sort((x, y) => x - y);
  assert.deepEqual(humans, [nbA, nbB].sort((x, y) => x - y), "human flags do not match the claims");
  for (const c of [A, B]) {
    assert.equal(c.last.players.find((p) => p.id === A.pid).nation, nbA);
    assert.equal(c.last.players.find((p) => p.id === B.pid).nation, nbB);
  }
  assert.deepEqual(A.last.players.map((p) => p.nation), B.last.players.map((p) => p.nation));
});

test("both clients converge on the same live world (snapshot + deltas)", async () => {
  const [sa, sb] = [await H.snapshotOf(A), await H.snapshotOf(B)];
  const ma = H.model(sa), mb = H.model(sb);
  await sleep(2000);
  const target = Math.min(lastSeq(A), lastSeq(B));
  for (const d of A.deltas.filter((d) => d.seq > sa.seq && d.seq <= target)) ma.apply(d);
  for (const d of B.deltas.filter((d) => d.seq > sb.seq && d.seq <= target)) mb.apply(d);
  assert.equal(ma.seq, target); assert.equal(mb.seq, target);
  assert.deepEqual(Buffer.from(ma.owner), Buffer.from(mb.owner), "ownership differs between clients");
  assert.deepEqual([...ma.blds], [...mb.blds]);
  assert.deepEqual(ma.nat.map((n) => [n.tiles, n.human, n.alive, n.troops]), mb.nat.map((n) => [n.tiles, n.human, n.alive, n.troops]));
});

test("update rate and size are bounded; every client sees a gap-free sequence", async () => {
  const from = lastSeq(A); const t0 = Date.now();
  await sleep(5000);
  const mine = A.deltas.filter((d) => d.seq > from);
  const rate = mine.length / ((Date.now() - t0) / 1000);
  assert.ok(rate >= 1.2 && rate <= 3, `delta rate ${rate.toFixed(2)}/s outside 1.2-3`);
  const wire = (d) => JSON.stringify({ ...d, tiles: undefined }).length + (d.tiles ? Buffer.from(d.tiles).length : 0);
  const sizes = mine.map(wire);
  assert.ok(Math.max(...sizes) < 100000, "a delta exceeded 100 KB: " + Math.max(...sizes));
  console.log(`      delta rate ${rate.toFixed(2)}/s, avg ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} B, max ${Math.max(...sizes)} B`);
  for (const c of [A, B]) for (let i = 1; i < c.deltas.length; i++) assert.equal(c.deltas[i].seq, c.deltas[i - 1].seq + 1, "gap in delta sequence");
});

test("attack: a valid attack on unclaimed land runs on the server and every client sees it", async () => {
  const before = natOf(A, nbA);
  const r = await act(A, { type: "attack", tile: tileOfA, ratio: 50 });
  assert.equal(r.success, true, r.message); assert.match(r.message, /Attack launched/);
  const start = lastSeq(A);
  await sleep(3500);
  for (const c of [A, B]) {
    const ds = c.deltas.filter((d) => d.seq > start - 1);
    assert.ok(ds.some((d) => d.atk && d.atk.some((x) => x[0] === nbA && x[1] === -1)), "attack not visible to a client");
    let flipped = 0; for (const d of ds) if (d.tiles) { const u = Buffer.from(d.tiles); for (let o = 0; o < u.length; o += 5) if (u.readInt8(o + 4) === nbA) flipped++; }
    assert.ok(flipped > 0, "no tile changed owner for a client");
  }
  assert.ok(natOf(A, nbA).tiles > before.tiles, "attacker did not gain land");
});

test("attack: invalid and unauthorized attacks are rejected with clear messages", async () => {
  const bad = async (c, a, re, extra) => { const r = await act(c, a, extra); assert.equal(r.success, false, JSON.stringify(a)); assert.match(r.message, re, JSON.stringify(a)); };
  const own = H.firstTile(base, nbA);
  await bad(A, { type: "attack", tile: own, ratio: 50 }, /your own land/);
  await bad(A, { type: "attack", tile: H.firstTile(base, nbB), ratio: 50 }, /not at war/);
  await bad(A, { type: "attack", tile: -1, ratio: 50 }, /Invalid target/);
  await bad(A, { type: "attack", tile: N + 5, ratio: 50 }, /Invalid target/);
  await bad(A, { type: "attack", tile: "5", ratio: 50 }, /Invalid target/);
  await bad(A, { type: "attack", tile: tileOfA, ratio: 500 }, /Invalid troop/);
  await bad(A, { type: "attack", tile: tileOfA, ratio: 0 }, /Invalid troop/);
  await bad(A, { type: "attack", tile: tileOfA }, /Invalid troop/);
  await bad(A, { type: "fly", tile: 1 }, /Unknown action/);
  await bad(A, null, /Invalid request/);
  await bad(A, "attack", /Invalid request/);
  const ghost = await H.joinRoom(URL1, A.code, "Spectator");
  await bad(ghost, { type: "attack", tile: tileOfA, ratio: 50 }, /Pick a country first/);
  const outsider = await H.connect(URL1);
  await bad(outsider, { type: "attack", tile: tileOfA, ratio: 50 }, /Join a room first/);
  ghost.close();
});

test("security: the nation always comes from the server-side claim, never from the request", async () => {
  const goldB = natOf(B, nbB).gold;
  // A names B's nation everywhere in the payload and targets B's land: still evaluated as A, so it is rejected
  await act(A, { type: "build", building: "city", tile: ownB, nation: nbB, owner: nbB }, { nation: nbB, owner: nbB });
  assert.equal((await act(A, { type: "build", building: "city", tile: ownB, nation: nbB }, { nation: nbB })).success, false);
  // and an ordinary build with a spoofed owner is attributed to A
  const r = await act(A, { type: "build", building: "city", tile: ownA, nation: nbB, owner: nbB }, { nation: nbB, owner: nbB });
  assert.equal(r.success, true, r.message);
  await until(() => B.deltas.some((d) => d.blds.some((x) => x[0] === ownA && x[1] && x[1].owner === nbA)), 5000, "building attributed to A");
  assert.ok(!B.deltas.some((d) => d.blds.some((x) => x[0] === ownB && x[1])), "a building appeared on B's land");
  await sleep(600);
  assert.ok(natOf(B, nbB).gold >= goldB - 1, "B's gold was spent by A's request");
});

test("building: valid builds sync to every client; invalid ones are rejected", async () => {
  const seen = (c, tile, owner, type) => c.deltas.some((d) => d.blds.some((x) => x[0] === tile && x[1] && x[1].owner === owner && x[1].type === type));
  assert.ok(seen(A, ownA, nbA, "city") && seen(B, ownA, nbA, "city"), "A's city did not reach both clients");
  const ownB2 = H.firstTile(base, nbB, (i) => base.terr[i] === 1 && i !== ownB);
  const r = await act(B, { type: "build", building: "barracks", tile: ownB2 });
  assert.equal(r.success, true, r.message);
  await until(() => seen(A, ownB2, nbB, "barracks") && seen(B, ownB2, nbB, "barracks"), 5000, "barracks sync");
  const bad = async (c, a, re) => { const x = await act(c, a); assert.equal(x.success, false, JSON.stringify(a)); assert.match(x.message, re, JSON.stringify(a)); };
  await bad(A, { type: "build", building: "city", tile: ownA }, /already built/);
  await bad(B, { type: "build", building: "city", tile: ownA }, /your own land/);
  await bad(A, { type: "build", building: "reactor", tile: ownA + 1 }, /Unknown building/);
  await bad(A, { type: "build", building: "__proto__", tile: ownA + 1 }, /Unknown building/);
  await bad(A, { type: "build", building: "mine", tile: H.firstTile(base, nbA, (i) => base.terr[i] === 1 && i !== ownA) }, /mountain/);
  await bad(A, { type: "build", building: "city", tile: "x" }, /Invalid tile/);
  const inland = H.firstTile(base, nbA, (i) => base.terr[i - 1] && base.terr[i + 1] && base.terr[i - MW] && base.terr[i + MW]);
  await bad(A, { type: "build", building: "port", tile: inland }, /coast/);
  // upgrade syncs; upgrading someone else's building is refused
  const up = await act(A, { type: "upgrade", tile: ownA });
  assert.equal(up.success, true, up.message);
  await until(() => A.deltas.some((d) => d.blds.some((x) => x[0] === ownA && x[1] && x[1].lv === 2)) && B.deltas.some((d) => d.blds.some((x) => x[0] === ownA && x[1] && x[1].lv === 2)), 5000, "upgrade sync");
  await bad(B, { type: "upgrade", tile: ownA }, /own buildings/);
});

test("deltas are lossless against the authoritative server state", async () => {
  const sx = await H.snapshotOf(A); const m = H.model(sx);
  await sleep(3000);
  const sy = await H.snapshotOf(A);                           // flushes a delta first, so sy.seq is the newest delta
  await until(() => lastSeq(A) >= sy.seq, 3000, "newest delta delivered");
  for (const d of A.deltas.filter((d) => d.seq > sx.seq && d.seq <= sy.seq)) m.apply(d);
  assert.equal(m.seq, sy.seq);
  assert.deepEqual(Buffer.from(m.owner), Buffer.from(sy.owner), "ownership diverged from the server");
  assert.deepEqual([...m.blds].sort((x, y) => x[0] - y[0]), sy.G.blds.map((b) => [b.i, { type: b.type, owner: b.owner, lv: b.lv }]).sort((x, y) => x[0] - y[0]));
  for (const n of sy.G.nations) { assert.equal(m.nat[n.id].tiles, n.tiles); assert.equal(m.nat[n.id].human, n.human); assert.ok(Math.abs(m.nat[n.id].troops - n.troops) < 0.11 + 1e-6 || Math.abs(m.nat[n.id].troops - n.troops) < 1, `troops nation ${n.id}`); }
  assert.deepEqual(Array.from(m.rel.war), Array.from(sy.REL.war));
  assert.deepEqual(Array.from(m.rel.treaty), Array.from(sy.REL.treaty));
});

let C, D, freeNation;
test("competing claims after the game started: exactly one winner, no switching, held nations protected", async () => {
  C = await H.joinRoom(URL1, A.code, "Carol"); D = await H.joinRoom(URL1, A.code, "Dave");
  const s = await H.snapshotOf(C);
  freeNation = s.G.nations.find((n) => n.id >= 1 && n.alive && n.tiles >= 100 && !n.human).id;
  const race = await Promise.all([ask(C, "claim-nation", { nation: freeNation }), ask(D, "claim-nation", { nation: freeNation })]);
  assert.equal(race.filter((r) => r.success).length, 1, JSON.stringify(race));
  const winner = race[0].success ? C : D, loser = winner === C ? D : C;
  assert.match(race.find((r) => !r.success).message, /already led by/);
  await until(() => A.deltas.some((d) => d.cold[freeNation] && d.cold[freeNation].human === true), 5000, "late claim becomes human-controlled for everyone");
  assert.equal(A.last.players.filter((p) => p.nation === freeNation).length, 1);
  const another = s.G.nations.find((n) => n.id >= 1 && n.alive && n.tiles >= 100 && !n.human && n.id !== freeNation).id;
  const sw = await ask(winner, "claim-nation", { nation: another });
  assert.equal(sw.success, false); assert.match(sw.message, /cannot switch/);
  assert.match((await ask(loser, "claim-nation", { nation: nbA })).message, /already led by Alice/);
  assert.match((await ask(loser, "claim-nation", { nation: 0 })).message, /cannot be led/);
  const ok = await ask(loser, "claim-random");
  assert.ok(ok.success, ok.message); assert.notEqual(ok.nation, freeNation);
  C.winner = winner === C; 
});

test("late joiner gets the CURRENT state (buildings, human nations, phase) and a gap-free stream after it", async () => {
  const E = await H.joinRoom(URL1, A.code, "Erin");
  assert.equal(E.joinRoom.world.started, true);
  const snap = await H.snapshotOf(E);
  assert.equal(snap.G.phase, "play"); assert.ok(snap.G.t > 5, "late joiner got a fresh/reset world");
  assert.ok(snap.G.blds.some((b) => b.i === ownA && b.owner === nbA && b.lv === 2), "A's upgraded city missing for late joiner");
  assert.ok(snap.G.blds.some((b) => b.i === ownA + 0 && b.type === "city"));
  assert.ok(snap.G.nations[nbA].human && snap.G.nations[nbB].human && snap.G.nations[freeNation].human);
  assert.equal(snap.seed, base.seed);
  await sleep(1500);
  const after = E.deltas.filter((d) => d.seq > snap.seq);
  assert.ok(after.length >= 1 && after[0].seq === snap.seq + 1, `first delta after snapshot is ${after[0] && after[0].seq}, expected ${snap.seq + 1}`);
  for (let i = 1; i < after.length; i++) assert.equal(after[i].seq, after[i - 1].seq + 1);
  // leaving frees the claim and AI takes the nation back
  const claim = await ask(E, "claim-random"); assert.ok(claim.success);
  await ask(E, "leave-room");
  await until(() => A.last.players.every((p) => p.nation !== claim.nation) && A.deltas.some((d) => d.cold[claim.nation] && d.cold[claim.nation].human === false), 5000, "claim released and AI resumes");
});

test("disconnect and reconnect: seat, country and the running world are preserved (never reset)", async () => {
  const preT = natOf(A, nbA), tBefore = A.deltas[A.deltas.length - 1].t, snapBefore = await H.snapshotOf(B);
  const revBefore = B.last.world.rev;
  const oldTok = A.token; A.close();
  await until(() => B.last.players.find((p) => p.id === A.pid && !p.connected), 4000, "offline flag");
  assert.equal(B.last.players.find((p) => p.id === A.pid).nation, nbA, "claim lost on disconnect");
  await sleep(700);
  const A2 = await H.connect(URL1);
  const rj = await ask(A2, "rejoin-room", { code: B.code, token: oldTok });
  assert.ok(rj.success, rj.message);
  assert.equal(rj.room.players.find((p) => p.id === A.pid).nation, nbA, "claim lost on rejoin");
  assert.equal(rj.room.world.rev, revBefore); assert.equal(rj.room.world.started, true);
  Object.assign(A2, { pid: A.pid, token: oldTok, code: B.code });
  const snap = await H.snapshotOf(A2);
  assert.equal(snap.seed, snapBefore.seed, "world was replaced on reconnect");
  assert.ok(snap.G.t > tBefore, "world time went backwards/reset");
  assert.ok(snap.G.blds.some((b) => b.i === ownA && b.owner === nbA), "buildings lost on reconnect");
  assert.ok(snap.G.nations[nbA].human);
  const r = await act(A2, { type: "build", building: "market", tile: H.firstTile(base, nbA, (i) => base.terr[i] === 1 && i !== ownA && !snap.G.blds.some((b) => b.i === i)) });
  assert.equal(r.success, true, r.message);
  A = A2;
});

test("a player who stays away loses the seat after the grace period and the AI takes the country back", async () => {
  const Fz = await H.joinRoom(URL1, B.code, "Fay");
  const mine = (await ask(Fz, "claim-random")).nation;
  Fz.close();
  await until(() => B.last.players.some((p) => p.name === "Fay" && !p.connected), 4000, "offline flag");
  await until(() => !B.last.players.some((p) => p.name === "Fay"), 8000, "seat expiry");
  await until(() => B.deltas.some((d) => d.cold[mine] && d.cold[mine].human === false), 5000, "AI resumes control");
  const G2 = await H.joinRoom(URL1, B.code, "Gus");
  assert.ok((await ask(G2, "claim-nation", { nation: mine })).success, "released nation was not claimable");
});

test("rate limit and duplicate protection", async () => {
  const rid = "dup-" + Date.now();
  const tile = H.firstTile(base, nbA, (i) => base.terr[i] === 1 && i % 7 === 0);
  const [r1, r2] = await Promise.all([ask(A, "game-action", { rid, action: { type: "build", building: "mine", tile } }), ask(A, "game-action", { rid, action: { type: "build", building: "mine", tile } })]);
  assert.equal([r1, r2].filter((r) => r.duplicate).length, 1, "duplicate request was not detected");
  await sleep(2200);                                          // let the bucket refill fully
  const burst = await Promise.all(Array.from({ length: 40 }, () => ask(A, "game-action", { action: { type: "build", building: "city", tile: -1 } })));
  const limited = burst.filter((r) => /Too many actions/.test(r.message)).length;
  assert.ok(limited >= 20 && limited <= 35, `rate limiter let ${40 - limited} of 40 through`);
});

test("rooms are isolated: another running game never leaks into this one", async () => {
  const Y = await H.makeRoom(URL1, "Yara"); await H.makeWorld(Y);
  const sy = await H.snapshotOf(Y);
  assert.notEqual(sy.seed, base.seed);
  const ny = H.findNeutralBorder(sy);
  assert.ok((await ask(Y, "claim-nation", { nation: ny.nation })).success);
  assert.ok((await ask(Y, "start-game")).success);
  const aBefore = A.deltas.length;
  const own = H.firstTile(sy, ny.nation, (i) => sy.terr[i] === 1);
  assert.ok((await act(Y, { type: "build", building: "city", tile: own })).success);
  await sleep(2500);
  for (const c of [A, B]) for (let i = 1; i < c.deltas.length; i++) assert.equal(c.deltas[i].seq, c.deltas[i - 1].seq + 1, "foreign delta leaked into the room's stream");
  assert.ok(A.deltas.length > aBefore);
  assert.ok(!A.deltas.some((d) => d.blds.some((x) => x[0] === own && x[1] && x[1].owner === ny.nation && own !== ownA)), "room Y's building appeared in room A");
  assert.ok(Y.deltas.some((d) => d.blds.some((x) => x[0] === own && x[1])), "room Y did not receive its own building");
  assert.ok(!Y.deltas.some((d) => d.blds.some((x) => x[0] === ownA && x[1] && x[1].owner === nbA && x[1].type === "city" && x[1].lv === 2)), "room A's building appeared in room Y");
  assert.ok(Y.last.players.every((p) => p.name === "Yara"));
});
