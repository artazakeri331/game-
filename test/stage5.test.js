"use strict";
// Stage 5 socket tests: real server process (worker-thread sims), real Socket.IO clients, two+ players per room.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");
const { ask, until, sleep, N } = H;

const URL1 = "http://localhost:3281";
let srv, A, B, D, na, nb, tileA, tileB, NC;
const act = async (c, action, extra = {}) => {                      // paced just under the 5/s limit
  const wait = 230 - (Date.now() - (c.lastAct || 0)); if (wait > 0) await sleep(wait); c.lastAct = Date.now();
  return ask(c, "game-action", { rid: Math.random().toString(36).slice(2, 12), action, ...extra });
};
const diplo = (c, kind, target) => act(c, { type: "diplo", kind, target });
const events = (c) => c.deltas.flatMap((d) => d.ev || []);
const relChanges = (c, field) => c.deltas.flatMap((d) => (d.rel && d.rel[field]) || []);
const pk = (a, b) => a * NC + b;
const snap = async (c) => H.snapshotOf(c);
const latestOffers = (c) => { for (let i = c.deltas.length - 1; i >= 0; i--) if (c.deltas[i].offers) return c.deltas[i].offers; return null; };

before(async () => { srv = await H.startServer(3281); });
after(() => { H.closeAll(); srv && srv.kill(); });

function pickPair(s) {
  const { owner, terr, G } = s;
  for (let i = 0; i < N - 1; i++) {
    const a = owner[i], b = owner[i + 1];
    if (a < 1 || b < 1 || a === b || !terr[i] || !terr[i + 1]) continue;
    const ga = G.nations[a], gb = G.nations[b];
    if (ga.alive && gb.alive && ga.tiles >= 100 && gb.tiles >= 100) return { a, b, ta: i, tb: i + 1 };
  }
  throw new Error("no pair");
}

test("setup: two players in one room claim adjacent countries and start the game", async () => {
  A = await H.makeRoom(URL1, "Alice"); B = await H.joinRoom(URL1, A.code, "Bob");
  await H.makeWorld(A);
  const s0 = await snap(A);
  NC = s0.G.nations.length;
  ({ a: na, b: nb, ta: tileA, tb: tileB } = pickPair(s0));
  assert.ok((await ask(A, "claim-nation", { nation: na })).success);
  assert.ok((await ask(B, "claim-nation", { nation: nb })).success);
  const r = await ask(A, "start-game"); assert.ok(r.success, r.message);
  await until(() => A.deltas.length && B.deltas.length, 8000, "deltas");
  const s = await snap(A);
  NC = s.REL.war.length ** 0.5 | 0;
  // the game presets some real-world alliances; make the pair neutral for the tests (this itself uses the real 'end deal' action)
  if (s.REL.treaty[pk(na, nb)]) assert.equal((await diplo(A, "end", nb)).success, true);
});

test("war between two humans: server-authorized, synced to both clients, news event on both, duplicates rejected", async () => {
  const r = await diplo(A, "war", nb);
  assert.equal(r.success, true, r.message);
  await until(() => relChanges(A, "war").length && relChanges(B, "war").length, 5000, "war delta");
  for (const c of [A, B]) assert.ok(relChanges(c, "war").some(([k, v]) => k === pk(na, nb) && v === 1));
  await until(() => events(A).some((e) => /declared war/.test(e[2])) && events(B).some((e) => /declared war/.test(e[2])), 5000, "war event");
  const s = await snap(B);
  assert.equal(s.REL.war[pk(na, nb)], 1); assert.equal(s.REL.war[pk(nb, na)], 1);
  assert.equal((await diplo(A, "war", nb)).success, false, "duplicate");
  assert.equal((await diplo(B, "war", na)).success, false, "already at war");
});

test("invalid / unauthorized diplomacy: self, bad ids, no claim, not in a room, identity forging", async () => {
  assert.equal((await diplo(A, "war", na)).success, false);
  assert.match((await diplo(A, "war", na)).message, /yourself/);
  for (const t of [-1, 999, "2", 1.5, null, undefined]) assert.equal((await diplo(A, "war", t)).success, false, String(t));
  assert.equal((await diplo(A, "bogus", nb)).success, false);
  // a spectator with no country
  const S1 = await H.joinRoom(URL1, A.code, "Spec");
  assert.match((await ask(S1, "game-action", { rid: "s1", action: { type: "diplo", kind: "war", target: na } })).message, /Pick a country/);
  // a socket outside any room
  const lone = await H.connect(URL1);
  assert.match((await ask(lone, "game-action", { rid: "l1", action: { type: "tax", value: 5 } })).message, /Join a room/);
  // forging: B sends an action that names A as the actor; the server uses B's own claim
  const before = (await snap(A)).G.nations[na].tax;
  const r = await act(B, { type: "tax", value: 11, nation: na, nid: na, from: na, actor: na });
  assert.equal(r.success, true);
  await sleep(700);
  const s = await snap(A);
  assert.equal(s.G.nations[na].tax, before, "B changed A's tax");
  assert.equal(s.G.nations[nb].tax, 0.11);
  const r2 = await act(B, { type: "diplo", kind: "peace", target: nb, from: na });   // forged 'from'; target is B itself
  assert.equal(r2.success, false);
  S1.close();
  await act(B, { type: "tax", value: 25 });
});

test("attacks: players at war fight with the server's troop count; a non-war target gets a war-prompt code; no ground attack on peaceful humans", async () => {
  const s0 = await snap(A);
  const t0 = s0.G.nations[na].troops;
  const r = await act(A, { type: "attack", tile: tileB, ratio: 50, troops: 1e9 });
  assert.equal(r.success, true, r.message);
  await until(() => {
    const d = A.deltas.slice(-3).map((x) => x.atk).filter(Boolean).pop();
    return d && d.some(([atk, def]) => atk === na && def === nb);
  }, 6000, "attack in delta");
  const s1 = await snap(A);
  assert.ok(s1.G.nations[na].troops < t0 * 0.75, "troops not spent");
  // B has no war with a third nation: attack on that nation's land -> nowar code
  const third = s1.G.nations.find((n) => n.id >= 1 && n.alive && n.id !== na && n.id !== nb && n.tiles >= 100 && s1.REL.war[pk(nb, n.id)] === 0 && !s1.G.nations[nb].human === false);
  let tile = -1; for (let i = 0; i < N; i++) if (s1.owner[i] === third.id && s1.terr[i]) { tile = i; break; }
  const rr = await act(B, { type: "attack", tile, ratio: 20 });
  assert.equal(rr.success, false);
  assert.ok(rr.code === "nowar" || /border/i.test(rr.message), rr.message);
  assert.ok(await act(A, { type: "retreat" }));
});

test("peace: offer shows up for both players, a third client cannot answer, acceptance syncs a ceasefire and blocks attacks", async () => {
  const r = await diplo(B, "peace", na);
  assert.equal(r.success, true, r.message);
  await until(() => (latestOffers(A) || []).length && (latestOffers(B) || []).length, 5000, "offer delta");
  const offer = latestOffers(A)[0];
  assert.deepEqual([offer.from, offer.to, offer.kind], [nb, na, "peace"]);
  assert.equal((await diplo(B, "peace", na)).success, false, "duplicate offer");
  assert.equal((await act(B, { type: "respond", offer: offer.id, accept: true })).success, false, "proposer cannot accept");
  const C1 = await H.joinRoom(URL1, A.code, "Carol");
  assert.equal((await ask(C1, "game-action", { rid: "c1", action: { type: "respond", offer: offer.id, accept: true } })).success, false);
  C1.close();
  const acc = await act(A, { type: "respond", offer: offer.id, accept: true });
  assert.equal(acc.success, true, acc.message);
  await until(() => (latestOffers(A) || [1]).length === 0 && (latestOffers(B) || [1]).length === 0, 5000, "offer cleared");
  await until(() => relChanges(B, "war").some(([k, v]) => k === pk(na, nb) && v === 0), 5000, "war off");
  const s = await snap(B);
  assert.equal(s.REL.war[pk(na, nb)], 0);
  assert.ok(s.REL.truce[pk(na, nb)] > s.G.t);
  assert.equal((await act(A, { type: "attack", tile: tileB, ratio: 30 })).success, false);
  assert.match((await diplo(A, "war", nb)).message, /ceasefire/i);
});

test("trade / alliance offers and gifts between humans", async () => {
  const s0 = await snap(A);
  assert.equal((await diplo(A, "alliance", nb)).success, false, "alliance needs a trade deal");
  if (!s0.REL.treaty[pk(na, nb)]) {
    assert.equal((await diplo(A, "trade", nb)).success, true);
    await until(() => (latestOffers(B) || []).some((x) => x.kind === "trade"), 5000, "trade offer at B");
    const o = latestOffers(B).find((x) => x.kind === "trade");
    assert.equal((await act(B, { type: "respond", offer: o.id, accept: true })).success, true);
    await until(() => relChanges(A, "treaty").some(([k, v]) => k === pk(na, nb) && v === 1), 5000, "trade deal delta");
  }
  const g0 = (await snap(A)).G.nations;
  const r = await diplo(A, "gift", nb);
  assert.equal(r.success, true, r.message);
  const g1 = (await snap(A)).G.nations;
  const sent = g0[na].gold - g1[na].gold, got = g1[nb].gold - g0[nb].gold;
  assert.ok(sent > 40, "gift not charged");
  assert.ok(got >= sent * 0.6, "recipient did not receive the gift");        // income accrues between snapshots, so compare loosely
  assert.match((await diplo(A, "gift", nb)).message, /Wait/);
});

test("economy and military actions run on the server and sync to the other client", async () => {
  assert.equal((await act(A, { type: "tax", value: 42 })).success, true);
  await until(() => B.deltas.some((d) => d.cold && d.cold[na] && d.cold[na].tax === 0.42), 5000, "tax synced to B");
  for (const v of [-5, 61, 2.5, "x"]) assert.equal((await act(A, { type: "tax", value: v })).success, false);
  const cap = (await act(A, { type: "recruit", key: "small" }));
  assert.equal(typeof cap.success, "boolean");
  assert.ok(cap.success ? /Recruited/.test(cap.message) : cap.message.length > 0, cap.message);
  assert.equal((await act(A, { type: "recruit", key: "nope" })).success, false);
  const drive = await act(A, { type: "drive" });                    // needs gold, which differs between random worlds: either it ran, or the server said it was short
  assert.ok(drive.success || /gold/i.test(drive.message), drive.message);
  if (drive.success) await until(() => B.deltas.some((d) => d.cold && d.cold[na] && d.cold[na].drive > 0), 5000, "drive synced");
  assert.equal((await act(A, { type: "drive" })).success, false, "a second drive is refused (already running, or no gold)");
  assert.equal((await act(A, { type: "missile", key: "cruise", tile: tileB })).success, false, "no silo");
  assert.equal((await act(A, { type: "jet", kind: "bomber" })).success, false, "no airfield");
  assert.match((await act(A, { type: "naval", tile: tileB, ratio: 30 })).message, /Port|Not at war|not at war/);
});

test("events: both clients see the same ids, no duplicates, strictly increasing", async () => {
  const ea = events(A).map((e) => e[0]), eb = events(B).map((e) => e[0]);
  assert.ok(ea.length >= 3, "expected several events, got " + ea.length);
  for (const ids of [ea, eb]) assert.deepEqual(ids, [...new Set(ids)].sort((x, y) => x - y));
  const common = ea.filter((i) => eb.includes(i));
  assert.ok(common.length >= 3);
  for (const i of common) assert.equal(events(A).find((e) => e[0] === i)[2], events(B).find((e) => e[0] === i)[2]);
});

test("late joiner: snapshot already contains diplomacy, events and projectiles; claims a free nation after start", async () => {
  D = await H.joinRoom(URL1, A.code, "Dave");
  const s = await snap(D);
  assert.equal(s.REL.treaty[pk(na, nb)] > 0 || s.REL.truce[pk(na, nb)] > 0, true, "diplomatic state missing from the snapshot");
  assert.ok(s.ev > 0, "snapshot has no event id");
  assert.ok(s.G.news.length > 0 && s.G.log.length >= 0);
  // the news list is a 12-entry ring buffer: in a busy world AI news can legitimately push the war line out, so only require it while the ring is not full
  assert.ok(s.G.news.some((n) => /declared war/.test(n.text)) || s.G.news.length >= 12, "earlier war news not in the late snapshot");
  const free = s.G.nations.find((n) => n.id >= 1 && n.alive && n.tiles >= 100 && n.id !== na && n.id !== nb && !n.human);
  const r = await ask(D, "claim-nation", { nation: free.id });
  assert.equal(r.success, true, r.message);
  D.nat = free.id;
  // deltas after the snapshot never repeat events the snapshot already contained
  await until(() => D.deltas.filter((d) => d.seq > s.seq).length >= 2, 6000, "deltas for D");
  for (const d of D.deltas.filter((x) => x.seq > s.seq)) for (const e of d.ev || []) assert.ok(e[0] > s.ev, "event repeated after snapshot");
  assert.equal((await act(D, { type: "tax", value: 30 })).success, true);
  await sleep(700);
  assert.equal((await snap(A)).G.nations[D.nat].tax, 0.3);
});

test("reconnect within grace keeps the country, offers and state; events after the new snapshot are not repeated", async () => {
  assert.equal((await diplo(A, "nukepact", nb)).success, true);
  await until(() => (latestOffers(A) || []).some((o) => o.kind === "nukepact"), 5000, "offer");
  const { token, code, pid } = A;
  A.close();
  await sleep(300);
  const A2 = await H.connect(URL1);
  const rj = await ask(A2, "rejoin-room", { code, token });
  assert.equal(rj.success, true, rj.message);
  assert.equal(rj.room.players.find((p) => p.id === pid).nation, na);
  Object.assign(A2, { token, pid, code, url: URL1 });
  const s = await snap(A2);
  assert.ok(s.G.offers.some((o) => o.kind === "nukepact" && o.from === na), "pending offer lost across reconnect");
  assert.equal(s.G.nations[na].human, true, "nation must still be human (no AI takeover within grace)");
  await until(() => A2.deltas.filter((d) => d.seq > s.seq).length >= 2, 6000, "deltas after reconnect");
  for (const d of A2.deltas.filter((x) => x.seq > s.seq)) for (const e of d.ev || []) assert.ok(e[0] > s.ev);
  A = Object.assign(A2, { lastAct: 0 });
  const o = latestOffers(B).find((x) => x.kind === "nukepact") || (await snap(B)).G.offers.find((x) => x.kind === "nukepact");
  assert.equal((await act(B, { type: "respond", offer: o.id, accept: false })).success, true);
});

test("rate limit and duplicate protection apply to the new actions", async () => {
  const rid = "dup-" + Date.now();
  const r1 = await ask(B, "game-action", { rid, action: { type: "tax", value: 20 } });
  const r2 = await ask(B, "game-action", { rid, action: { type: "tax", value: 20 } });
  assert.equal(r1.success, true); assert.equal(r2.duplicate, true);
  await sleep(2200);
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => ask(B, "game-action", { rid: "burst" + i + Date.now(), action: { type: "diplo", kind: "war", target: 9999 } })));
  assert.ok(rs.some((r) => /Too many actions/.test(r.message)), "no rate limiting");
  assert.ok(rs.filter((r) => /Too many actions/.test(r.message)).length >= 15);
  await sleep(2200);
});

test("room isolation: another room's players cannot see or change this game", async () => {
  const X = await H.makeRoom(URL1, "Xena"), Y = await H.joinRoom(URL1, X.code, "Yuri");
  await H.makeWorld(X);
  const sx = await snap(X);
  const p = pickPair(sx);
  await ask(X, "claim-nation", { nation: p.a }); await ask(Y, "claim-nation", { nation: p.b });
  assert.ok((await ask(X, "start-game")).success);
  await until(() => X.deltas.length && Y.deltas.length, 8000);
  const mainWar = (await snap(B)).REL.war.slice();
  const evBefore = events(B).length, mainDeltas = B.deltas.length;
  const r = await act(X, { type: "diplo", kind: "war", target: p.b });
  assert.equal(r.success, true, r.message);
  await sleep(1500);
  assert.deepEqual([...(await snap(B)).REL.war], [...mainWar], "another room changed this world");
  assert.equal(events(B).filter((e) => e[2].includes("Xena")).length, 0);
  assert.ok(Y.deltas.some((d) => d.rel && d.rel.war), "room mate did not get the war");
  for (const d of B.deltas.slice(mainDeltas)) assert.ok(!(d.ev || []).some((e) => /Xena|Yuri/.test(e[2])));
  assert.ok(evBefore >= 0);
  X.close(); Y.close();
});

test("elimination, spectating, victory and game-over sync; non-host cannot restart; host can start a new game", async () => {
  // D (late joiner) leaves so exactly A and B remain as players
  assert.ok((await ask(D, "leave-room")).success);
  await sleep(500);
  const s0 = await snap(B);
  assert.equal(s0.G.nations[D.nat].human, false, "released nation must go back to AI");
  assert.ok((await ask(B, "test-wipe", { nation: nb })).success);
  await until(() => B.deltas.some((d) => d.over), 15000, "game over delta");
  const over = B.deltas.find((d) => d.over).over;
  assert.equal(over.winner, na);
  assert.match(over.why, /Last surviving player/);
  await until(() => A.deltas.some((d) => d.over), 5000, "A sees game over");
  assert.ok(events(A).some((e) => /fallen/.test(e[2]) && e[2].includes(s0.G.nations[nb].name)), "defeat notification missing");
  const sOver = await snap(A);
  assert.equal(sOver.G.nations[nb].alive, false);
  assert.ok(sOver.G.over && sOver.G.over.winner === na, "game-over state missing from a fresh snapshot");
  assert.match((await act(B, { type: "tax", value: 10 })).message, /over|fallen/i);
  assert.match((await act(A, { type: "tax", value: 10 })).message, /over/i);
  await until(() => A.last.world.over, 5000, "over flag in room state");
  const hostC = A.last.hostId === A.pid ? A : B, otherC = hostC === A ? B : A;      // the host moved when Alice dropped earlier
  assert.match((await ask(otherC, "new-world")).message, /Only the host/);
  const r = await ask(hostC, "new-world");
  assert.equal(r.success, true, r.message);
  await until(() => A.last.world.state === "ready" && !A.last.world.over, 120000, "new world");
  assert.equal(A.last.players.every((p) => p.nation === null), true, "claims must be cleared for the new game");
  const s2 = await snap(A);
  assert.notEqual(s2.seed, sOver.seed);
  assert.equal(s2.G.over, null);
  assert.ok((await ask(hostC, "claim-nation", { nation: pickPair(s2).a })).success);
  assert.ok((await ask(hostC, "start-game")).success);
});

test("host disconnect: after the grace period the host role moves on and the running game is untouched", async () => {
  const H1 = await H.makeRoom(URL1, "Hank"), O1 = await H.joinRoom(URL1, H1.code, "Olga");
  await H.makeWorld(H1);
  const s = await snap(H1);
  const p = pickPair(s);
  await ask(H1, "claim-nation", { nation: p.a }); await ask(O1, "claim-nation", { nation: p.b });
  assert.ok((await ask(H1, "start-game")).success);
  await until(() => O1.deltas.length >= 2, 8000);
  const before = await snap(O1);
  H1.close();
  await until(() => O1.last.hostId === O1.pid && O1.last.players.length === 1, 8000, "host handover and seat expiry");
  const after1 = await snap(O1);
  assert.equal(after1.seed, before.seed, "world must not be reset when the host leaves");
  assert.ok(after1.seq >= before.seq);
  assert.equal(after1.G.nations[p.a].human, false, "the departed host's nation reverts to AI");
  assert.equal(after1.G.nations[p.b].human, true);
  assert.equal((await act(O1, { type: "tax", value: 33 })).success, true, "remaining player keeps playing");
  O1.close();
});
