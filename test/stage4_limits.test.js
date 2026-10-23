"use strict";
// Stage 4: connection-driven pause and resource limits (separate servers so grace/limit settings can differ).
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");
const { ask, sleep, until } = H;

const servers = [];
after(() => { H.closeAll(); servers.forEach((s) => s.kill()); });
async function boot(port, env) { const s = await H.startServer(port, env); servers.push(s); return `http://localhost:${port}`; }

test("the sim pauses while every player is disconnected and resumes on return; the world is never reset", async () => {
  const url = await boot(3281, { GRACE_MS: "30000" });
  const A = await H.makeRoom(url, "Alice"); await H.makeWorld(A);
  const s0 = await H.snapshotOf(A); const nb = H.findNeutralBorder(s0);
  assert.ok((await ask(A, "claim-nation", { nation: nb.nation })).success);
  assert.ok((await ask(A, "start-game")).success);
  await sleep(2200);
  const tBefore = A.deltas[A.deltas.length - 1].t; const rev = A.last.world.rev;
  assert.ok(tBefore > 1, "game did not advance while connected");
  const token = A.token, code = A.code; A.close();
  await sleep(3500);                                           // nobody connected: unpaused would advance ~3.5 game seconds
  const A2 = await H.connect(url);
  const rj = await ask(A2, "rejoin-room", { code, token }); assert.ok(rj.success, rj.message);
  Object.assign(A2, { pid: A.pid, token, code });
  const s1 = await H.snapshotOf(A2);
  assert.equal(rj.room.world.rev, rev); assert.equal(s1.seed, s0.seed);
  assert.ok(s1.G.t >= tBefore && s1.G.t - tBefore < 1.5, `sim advanced ${(s1.G.t - tBefore).toFixed(1)}s while nobody was connected`);
  await sleep(2200);
  const s2 = await H.snapshotOf(A2);
  assert.ok(s2.G.t - s1.G.t > 1.2, "sim did not resume after the player returned");
});

test("running-game cap: the DEFAULT is one running game; a second start is refused with a clear message", async () => {
  const url = await boot(3282, { MAX_RUNNING_GAMES: "" });          // empty = the code default
  const A = await H.makeRoom(url, "A"), B = await H.makeRoom(url, "B");
  await Promise.all([H.makeWorld(A), H.makeWorld(B)]);
  for (const c of [A, B]) assert.ok((await ask(c, "claim-random")).success);
  assert.ok((await ask(A, "start-game")).success);
  const r = await ask(B, "start-game");
  assert.equal(r.success, false); assert.match(r.message, /maximum of 1 games/);
});

test("existing limits are unchanged: default is still 4 worlds at once", async () => {
  const url = await boot(3283, { MAX_WORLDS: "", MAX_RUNNING_GAMES: "" });      // empty = fall back to the code defaults
  const hosts = []; for (let i = 0; i < 5; i++) hosts.push(await H.makeRoom(url, "H" + i));
  const res = []; for (const h of hosts) res.push(await ask(h, "create-world"));
  assert.equal(res.filter((r) => r.success).length, 4, JSON.stringify(res));
  assert.match(res.find((r) => !r.success).message, /maximum of 4/);
});
