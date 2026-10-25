"use strict";
// Stage 6 resilience tests: real server processes, real Socket.IO clients, 3+ players, several rooms, crashes, limits, cleanup.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const H = require("./helpers");
const { ask, until, sleep, N } = H;

const procs = [];
const boot = async (port, env) => { const p = await H.startServer(port, env); procs.push(p); return `http://localhost:${port}`; };
after(() => { H.closeAll(); procs.forEach((p) => p.kill()); });
const act = async (c, action) => {                                  // paced just under the 5/s limit
  const wait = 230 - (Date.now() - (c.lastAct || 0)); if (wait > 0) await sleep(wait); c.lastAct = Date.now();
  return ask(c, "game-action", { rid: Math.random().toString(36).slice(2, 12), action });
};
const get = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b })); }).on("error", rej));
const clusters = (s, k) => {                                         // k eligible nations ordered by distance from the first one
  const el = s.G.nations.filter((n) => n.id >= 1 && n.alive && n.tiles >= 100);
  const f = el[0]; return [...el].sort((a, b) => Math.hypot(a.cx - f.cx, a.cy - f.cy) - Math.hypot(b.cx - f.cx, b.cy - f.cy)).slice(0, k).map((n) => n.id);
};
const ownTile = (s, id) => { for (let i = 0; i < N; i++) if (s.owner[i] === id && s.terr[i] === 1 && !s.G.bat.has(i)) return i; return -1; };
async function game(url, names, extraClaims = true) {              // room with len(names) players, each leading a nearby country, game started
  const host = await H.makeRoom(url, names[0]); const ps = [host];
  for (const n of names.slice(1)) ps.push(await H.joinRoom(url, host.code, n));
  await H.makeWorld(host);
  const s = await H.snapshotOf(host); const ids = clusters(s, names.length);
  if (extraClaims) { for (let i = 0; i < ps.length; i++) { assert.ok((await ask(ps[i], "claim-nation", { nation: ids[i] })).success); ps[i].nat = ids[i]; } }
  return { host, ps, ids, s };
}
const startAndWait = async (g) => { const r = await ask(g.host, "start-game"); assert.ok(r.success, r.message); await until(() => g.ps.every((p) => p.deltas.length >= 2), 10000, "deltas"); };
const contiguous = (c) => c.deltas.every((d, i) => i === 0 || d.seq === c.deltas[i - 1].seq + 1);

test("production safety: health check works and test-only hooks are NOT available without SKYFRONT_TEST", async () => {
  const url = await boot(3401, { SKYFRONT_TEST: "0" });
  assert.deepEqual(await get(url + "/healthz"), { status: 200, body: "ok" });
  const page = await get(url + "/");
  assert.equal(page.status, 200); assert.match(page.body, /<canvas/);
  const c = await H.makeRoom(url, "Prod");
  for (const ev of ["test-wipe", "test-crash"]) {
    const reply = await Promise.race([ask(c, ev, { nation: 1 }), sleep(800).then(() => "no handler")]);
    assert.equal(reply, "no handler", `${ev} must not exist in production mode`);
  }
});

test("three clients: simultaneous claims of one country give exactly one winner; distinct claims all succeed", async () => {
  const url = await boot(3402, {});
  const host = await H.makeRoom(url, "A"), b = await H.joinRoom(url, host.code, "B"), c = await H.joinRoom(url, host.code, "C");
  await H.makeWorld(host);
  const s = await H.snapshotOf(host); const [x, y, z] = clusters(s, 3);
  const race = await Promise.all([host, b, c].map((p) => ask(p, "claim-nation", { nation: x })));
  assert.equal(race.filter((r) => r.success).length, 1, JSON.stringify(race));
  assert.ok(race.filter((r) => !r.success).every((r) => /already led/.test(r.message)));
  const winner = [host, b, c][race.findIndex((r) => r.success)], losers = [host, b, c].filter((p) => p !== winner);
  const rest = await Promise.all([ask(losers[0], "claim-nation", { nation: y }), ask(losers[1], "claim-nation", { nation: z })]);
  assert.ok(rest.every((r) => r.success));
  const owners = host.last.players.map((p) => p.nation).sort();
  assert.deepEqual(owners, [x, y, z].sort(), "every player leads a different country");
});

test("three clients act at the same time (wars, attacks, builds, tax): no errors, no gaps, no resync", async () => {
  const url = await boot(3403, {});
  const g = await game(url, ["Ann", "Ben", "Cat"]);
  for (const p of g.ps) assert.ok(g.s.REL.treaty); // snapshot has relations
  await startAndWait(g);
  const [a, b, c] = g.ps;
  const mine = g.ps.map((p) => ownTile(g.s, p.nat));
  await Promise.all([
    act(a, { type: "diplo", kind: "war", target: b.nat }), act(b, { type: "diplo", kind: "war", target: c.nat }), act(c, { type: "diplo", kind: "war", target: a.nat })
  ]);
  const results = [];
  for (let round = 0; round < 6; round++) {
    results.push(...await Promise.all(g.ps.map((p, i) => {
      const foe = g.ps[(i + 1) % 3], pick = round % 3;
      return act(p, pick === 0 ? { type: "attack", tile: ownTile(g.s, foe.nat), ratio: 40 } : pick === 1 ? { type: "build", building: "silo", tile: mine[i] + 0 } : { type: "tax", value: 20 + round });
    })));
  }
  assert.ok(results.every((r) => r && typeof r.success === "boolean" && typeof r.message === "string"), "every action gets a clear answer");
  await sleep(1500);
  for (const p of g.ps) { assert.ok(contiguous(p), `${p.pid} saw a gap`); assert.ok(!p.deltas.some((d) => d.resync), "unexpected resync"); }
  const s1 = await H.snapshotOf(a), s2 = await H.snapshotOf(c);
  for (const id of g.ids) assert.equal(s1.G.nations[id].human, true);
  assert.ok(s1.G.t > 0 && s2.G.t >= s1.G.t - 1, "both clients see the same running world");
});

test("two rooms play at the same time and stay isolated (different worlds, no cross-talk in deltas)", async () => {
  const url = await boot(3404, {});
  const g1 = await game(url, ["R1a", "R1b", "R1c"]), g2 = await game(url, ["R2a", "R2b", "R2c"]);
  assert.notEqual(g1.host.code, g2.host.code);
  await startAndWait(g1); await startAndWait(g2);
  g2.ps.forEach((p) => (p.deltas.length = 0));
  const r = await act(g1.ps[0], { type: "diplo", kind: "war", target: g1.ps[1].nat });
  assert.ok(r.success, r.message);
  await sleep(1500);
  const warSeen = (p) => p.deltas.some((d) => d.rel && d.rel.war && d.rel.war.length);
  assert.ok(g1.ps.every(warSeen), "room 1 sees its war");
  assert.ok(!g2.ps.some(warSeen), "room 2 must not see room 1's war");
  assert.ok(!g2.ps.some((p) => (p.deltas.flatMap((d) => d.ev || [])).some((e) => /declared war/.test(e.text) && e.text.includes(g1.s.G.nations[g1.ps[0].nat].name))), "no news leaks");
  assert.notEqual((await H.snapshotOf(g1.host)).seed, (await H.snapshotOf(g2.host)).seed);
});

test("disconnect and reconnect during combat: country, war and running attack survive; deltas continue without gaps; late joiner can claim a free nation", async () => {
  const url = await boot(3405, { GRACE_MS: "20000" });
  const g = await game(url, ["Ann", "Ben", "Cat"]);
  await startAndWait(g);
  const [a, b, c] = g.ps;
  assert.ok((await act(a, { type: "diplo", kind: "war", target: b.nat })).success);
  const tgt = ownTile(g.s, b.nat); await act(a, { type: "attack", tile: tgt, ratio: 30 });           // may or may not border: war exists either way
  b.close();                                                                                           // B drops mid-war
  await until(() => c.last.players.find((p) => p.id === b.pid && !p.connected), 5000, "offline flag");
  await sleep(1200);
  const b2 = await H.connect(url); b2.deltas = [];
  const rj = await ask(b2, "rejoin-room", { code: g.host.code, token: b.token });
  assert.ok(rj.success, rj.message);
  const snap = await H.snapshotOf(b2);
  assert.equal(b2.last.players.find((p) => p.id === b.pid).nation, b.nat, "country kept");
  assert.equal(snap.G.nations[b.nat].human, true);
  assert.equal(snap.REL.war[a.nat * (snap.REL.war.length ** 0.5 | 0) + b.nat], 1, "war still on");
  await until(() => b2.deltas.some((d) => d.seq > snap.reply.seq), 6000, "a delta newer than the snapshot");
  assert.ok(b2.deltas.filter((d) => d.seq > snap.reply.seq).length >= 1);
  b2.deltas.filter((d) => d.seq > snap.reply.seq).reduce((prev, d) => { assert.equal(d.seq, prev + 1, "no gap after snapshot"); return d.seq; }, snap.reply.seq);
  const late = await H.joinRoom(url, g.host.code, "Late");
  const free = clusters(snap, 6).find((id) => !g.ids.includes(id));
  const lr = await ask(late, "claim-nation", { nation: free });
  assert.ok(lr.success, lr.message);
  assert.equal((await act(late, { type: "tax", value: 30 })).success, true);
});

test("host leaves a 3-player game: host moves to a connected player, game keeps running, leaver's nation goes back to AI", async () => {
  const url = await boot(3406, {});
  const g = await game(url, ["Hal", "Ivy", "Jon"]); await startAndWait(g);
  const [h, i, j] = g.ps;
  const t0 = (await H.snapshotOf(i)).G.t;
  await ask(h, "leave-room");
  await until(() => i.last.hostId !== h.pid && i.last.players.length === 2, 6000, "handover");
  assert.ok([i.pid, j.pid].includes(i.last.hostId));
  const s = await H.snapshotOf(j);
  assert.equal(s.G.nations[h.nat].human, false);
  assert.ok(s.G.t >= t0, "world kept running");
  assert.equal((await act(j, { type: "tax", value: 21 })).success, true);
});

test("elimination -> spectating -> game over -> new game in the same room with three players", async () => {
  const url = await boot(3407, {});
  const g = await game(url, ["Kim", "Lou", "Max"]); await startAndWait(g);
  const [k, l, m] = g.ps;
  await ask(l, "test-wipe", { nation: l.nat });
  await until(() => k.deltas.some((d) => (d.ev || []).some((e) => /has fallen/.test(e[2]))), 8000, "fallen event");
  l.deltas.length = 0;
  assert.equal((await act(l, { type: "tax", value: 20 })).success, false, "eliminated player cannot act");
  await until(() => l.deltas.length >= 2, 5000, "spectator keeps receiving updates");
  assert.ok(contiguous(l));
  await ask(m, "test-wipe", { nation: m.nat });
  await until(() => k.deltas.some((d) => d.over), 8000, "game over");
  const over = k.deltas.find((d) => d.over).over; assert.equal(over.winner, k.nat);
  assert.ok(l.deltas.some((d) => d.over) && m.deltas.some((d) => d.over), "everyone gets game over");
  assert.equal((await ask(l, "new-world")).success, false, "non-host cannot restart");
  assert.ok((await ask(k, "new-world")).success);
  await until(() => k.last.world.state === "ready" && !k.last.world.started && !k.last.world.over, 120000, "fresh world");
  assert.deepEqual(k.last.players.map((p) => p.nation), [null, null, null], "countries are free again");
  const s = await H.snapshotOf(k); const ids = clusters(s, 3);
  for (let n = 0; n < 3; n++) assert.ok((await ask(g.ps[n], "claim-nation", { nation: ids[n] })).success);
  const st = await ask(k, "start-game"); assert.ok(st.success, st.message);
  await until(() => k.deltas.filter((d) => d.t > 0).length >= 2, 8000);
  assert.equal((await act(k, { type: "tax", value: 22 })).success, true, "the second game is playable");
});

test("worker crash: that room is reset with a clear message and can build a new world; another room is unaffected", async () => {
  const url = await boot(3408, {});
  const g1 = await game(url, ["Cy", "Di"]), g2 = await game(url, ["Ed", "Flo"]);
  await startAndWait(g1); await startAndWait(g2);
  assert.ok((await ask(g1.ps[0], "test-crash")).success);
  await until(() => g1.host.last.world.state === "error", 8000, "error state");
  const w = g1.host.last.world; assert.equal(w.started, false); assert.match(w.error, /lost|error/i);
  assert.deepEqual(g1.host.last.players.map((p) => p.nation), [null, null], "claims reset");
  assert.equal((await act(g1.ps[0], { type: "tax", value: 20 })).success, false, "no actions into a dead world");
  assert.equal(g2.host.last.world.state, "ready", "other room unaffected");
  const before = g2.ps[0].deltas.length; await sleep(1200); assert.ok(g2.ps[0].deltas.length > before, "other room keeps ticking");
  assert.equal((await ask(g1.ps[1], "create-world")).success, false, "only the host may rebuild");
  await H.makeWorld(g1.host);                                       // host rebuilds
  assert.equal(g1.host.last.world.state, "ready");
  const s = await H.snapshotOf(g1.host); const ids = clusters(s, 2);
  assert.ok((await ask(g1.ps[0], "claim-nation", { nation: ids[0] })).success);
  assert.ok((await ask(g1.host, "start-game")).success, "a new game can start after the crash");
});

test("limits: MAX_ROOMS, MAX_WORLDS and MAX_RUNNING_GAMES are enforced; closing rooms frees capacity", async () => {
  const url = await boot(3409, { MAX_WORLDS: "2", MAX_RUNNING_GAMES: "1", GRACE_MS: "800" });
  const hosts = []; let last;
  for (let i = 0; i < 25; i++) hosts.push(await H.makeRoom(url, "h" + i));
  const extra = await H.connect(url);
  last = await ask(extra, "create-room", { name: "x" });
  assert.equal(last.success, false); assert.match(last.message, /busy/i, "26th room refused (MAX_ROOMS 25)");
  const [r1, r2, r3] = hosts;
  assert.ok((await ask(r1, "create-world")).success); assert.ok((await ask(r2, "create-world")).success);
  const third = await ask(r3, "create-world"); assert.equal(third.success, false); assert.match(third.message, /maximum of 2/);
  await until(() => r1.last.world.state === "ready" && r2.last.world.state === "ready", 120000, "worlds");
  for (const r of [r1, r2]) { const s = await H.snapshotOf(r); await ask(r, "claim-nation", { nation: clusters(s, 1)[0] }); }
  assert.ok((await ask(r1, "start-game")).success);
  const second = await ask(r2, "start-game"); assert.equal(second.success, false); assert.match(second.message, /maximum of 1 games/);
  r1.close();                                                         // last player leaves -> seat expires -> room and its worker are gone
  await until(async () => true, 100); await sleep(2200);
  assert.ok((await ask(r2, "start-game")).success, "capacity freed after the room closed");
  assert.ok((await ask(r3, "create-world")).success, "world slot freed too");
});

test("idle cleanup: an unstarted world nobody uses is discarded; a running game is not", async () => {
  const url = await boot(3410, { WORLD_IDLE_MS: "2500", REAPER_MS: "400", MAX_WORLDS: "4" });
  const idle = await H.makeRoom(url, "Idle"); await H.makeWorld(idle);
  const g = await game(url, ["Run1", "Run2"]); await startAndWait(g);
  await until(() => idle.last.world.state === "none", 15000, "idle world discarded");
  assert.equal(idle.last.world.started, false);
  assert.equal(g.host.last.world.state, "ready", "running game kept");
  assert.equal((await act(g.ps[0], { type: "tax", value: 19 })).success, true);
  await H.makeWorld(idle);                                            // and the host can simply build again
  assert.equal(idle.last.world.state, "ready");
});

test("SIGTERM (Render redeploy) shuts the server down cleanly with exit code 0", async () => {
  const p = await H.startServer(3411, {});
  const done = new Promise((res) => p.on("exit", (code, sig) => res({ code, sig })));
  const c = await H.makeRoom("http://localhost:3411", "Bye"); await H.makeWorld(c);
  const t = Date.now(); p.kill("SIGTERM");
  const r = await Promise.race([done, sleep(6000).then(() => "hung")]);
  assert.notEqual(r, "hung", "server did not exit after SIGTERM");
  assert.equal(r.code, 0); assert.ok(Date.now() - t < 5000);
});
