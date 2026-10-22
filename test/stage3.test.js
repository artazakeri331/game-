"use strict";
// Stage 3 tests: shared snapshots, room isolation, late join, exclusive claims. Real server process + real Socket.IO clients.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const zlib = require("node:zlib");
const path = require("node:path");
const { io } = require("socket.io-client");

const N = 1200 * 480;
let proc, URL;

function startServer(port, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(port), GRACE_MS: "1500", ...env } });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.stdout.on("data", (d) => { if (String(d).includes("listening")) resolve(p); });
    p.on("error", reject);
    setTimeout(() => reject(new Error("server did not start")), 15000);
  });
}
const clients = [];
function client(url = URL) {
  const s = io(url, { forceNew: true, reconnection: false });
  s.rooms = [];                                   // every room-update seen
  s.on("room-update", (r) => { s.last = r; s.rooms.push(r); });
  clients.push(s);
  return new Promise((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
}
const ask = (s, ev, data) => new Promise((res) => s.emit(ev, data || {}, res));
const until = async (fn, ms = 60000, what = "condition") => {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error("timeout waiting for " + what);
};
async function makeRoom(name) {
  const a = await client();
  const r = await ask(a, "create-room", { name });
  assert.ok(r.success);
  a.token = r.you.token; a.pid = r.you.id; a.code = r.room.code;
  return a;
}
async function joinRoom(code, name) {
  const b = await client();
  const r = await ask(b, "join-room", { code, name });
  assert.ok(r.success, r.message);
  b.token = r.you.token; b.pid = r.you.id; b.code = code; b.joinRoom = r.room;
  return b;
}
async function makeWorld(host) {
  const r = await ask(host, "create-world");
  assert.ok(r.success, r.message);
  await until(() => host.last && host.last.world.state === "ready", 90000, "world ready");
}
function decodeHeader(buf) {
  const u = zlib.inflateSync(buf), L = u.readUInt32LE(0);
  const meta = JSON.parse(u.subarray(4, 4 + L).toString("utf8"));
  return { u, meta, terr: u.subarray(4 + L, 4 + L + N), owner: u.subarray(4 + L + N, 4 + L + 2 * N) };
}
const me = (s) => s.last.players.find((p) => p.id === s.pid);

before(async () => { URL = "http://localhost:3231"; proc = await startServer(3231); });
after(() => { clients.forEach((c) => c.close()); proc && proc.kill(); });

let A, B, code1, snapA, claimedNation;

test("world is created only by the host; room shows building -> ready", async () => {
  A = await makeRoom("Alice"); B = await joinRoom(A.code, "Bob"); code1 = A.code;
  assert.equal((await until(() => A.last, 5000)).world.state, "none");
  const early = await ask(B, "claim-nation", { nation: 5 });
  assert.equal(early.success, false);
  assert.match(early.message, /not been created/);
  const nonHost = await ask(B, "create-world");
  assert.equal(nonHost.success, false);
  assert.match(nonHost.message, /Only the host/);
  assert.equal((await ask(B, "world-get")).success, false);
  const t = Date.now();
  const r = await ask(A, "create-world");
  assert.ok(r.success);
  await until(() => B.last && B.last.world.state === "building", 5000, "building broadcast");
  await until(() => A.last.world.state === "ready" && B.last.world.state === "ready", 90000, "ready broadcast");
  console.log(`      world generated in ${Date.now() - t} ms`);
  assert.equal((await ask(A, "create-world")).success, false);   // already exists
});

test("two players in one room receive the identical world snapshot", async () => {
  const [ra, rb] = await Promise.all([ask(A, "world-get"), ask(B, "world-get")]);
  assert.ok(ra.success && rb.success);
  assert.ok(Buffer.compare(Buffer.from(ra.snapshot), Buffer.from(rb.snapshot)) === 0, "snapshots differ");
  assert.equal(ra.seed, A.last.world.seed);
  const d = decodeHeader(Buffer.from(ra.snapshot));
  assert.equal(d.meta.seed, ra.seed);
  assert.equal(d.meta.G.nations.length, 48);
  assert.equal(d.meta.G.phase, "spawn");
  assert.ok(d.terr.some((v) => v > 0) && d.owner.some((v) => v > 0), "empty map arrays");
  snapA = Buffer.from(ra.snapshot);
});

test("exclusive claims: simultaneous claim of one nation -> exactly one winner", async () => {
  const race = await Promise.all([ask(A, "claim-nation", { nation: 7 }), ask(B, "claim-nation", { nation: 7 })]);
  assert.equal(race.filter((r) => r.success).length, 1, JSON.stringify(race));
  const loser = race.find((r) => !r.success);
  assert.match(loser.message, /already led by/);
  await until(() => A.last.players.filter((p) => p.nation === 7).length === 1 && B.last.players.filter((p) => p.nation === 7).length === 1, 3000, "single holder broadcast");
  const holder = A.last.players.find((p) => p.nation === 7);
  assert.deepEqual(A.last.players.map((p) => p.nation), B.last.players.map((p) => p.nation));
  assert.ok(holder.nationName && holder.nationName.length > 1);
  claimedNation = { id: 7, holder: holder.id, name: holder.nationName };
});

test("invalid claims are rejected with clear messages", async () => {
  for (const bad of [0, -1, 999, "abc", null, 2.5, undefined]) {
    const r = await ask(A, "claim-nation", { nation: bad });
    assert.equal(r.success, false, "accepted " + bad);
    assert.match(r.message, /cannot be led/);
  }
  const noRoom = await client();
  assert.match((await ask(noRoom, "claim-nation", { nation: 3 })).message, /Join a room first/);
  assert.match((await ask(noRoom, "create-world")).message, /Join a room first/);
});

test("late joiner gets the current snapshot and the existing claims", async () => {
  const C = await joinRoom(code1, "Carol");
  const seenClaim = C.joinRoom.players.find((p) => p.nation === claimedNation.id);
  assert.ok(seenClaim && seenClaim.id === claimedNation.holder, "late joiner did not see existing claim");
  assert.equal(C.joinRoom.world.state, "ready");
  const r = await ask(C, "world-get");
  assert.ok(r.success);
  assert.ok(Buffer.compare(Buffer.from(r.snapshot), snapA) === 0, "late snapshot differs from the room's world");
  const stolen = await ask(C, "claim-nation", { nation: claimedNation.id });
  assert.equal(stolen.success, false);
  assert.ok(stolen.message.includes(claimedNation.holder === A.pid ? "Alice" : "Bob"));
  const ok = await ask(C, "claim-nation", { nation: 9 });
  assert.ok(ok.success);
  C.close();
});

test("switching countries frees the old one; leaving the room frees the claim", async () => {
  await until(() => A.last.players.length === 2, 5000, "Carol gone");   // C disconnected: seat is held for the grace period
  const holder = claimedNation.holder === A.pid ? A : B, other = holder === A ? B : A;
  assert.ok((await ask(holder, "claim-nation", { nation: 11 })).success);
  assert.ok((await ask(other, "claim-nation", { nation: 7 })).success, "old nation was not freed on switch");
  assert.equal(me(other).nation === 7 || other.last.players.find((p) => p.id === other.pid).nation === 7, true);
  await ask(other, "leave-room");
  await until(() => holder.last.players.every((p) => p.nation !== 7), 3000, "claim released on leave");
  assert.ok((await ask(holder, "claim-nation", { nation: 7 })).success);
  await ask(holder, "claim-nation", { nation: 11 });
});

test("claim survives a reconnect within the grace period and is released after it expires", async () => {
  const D = await joinRoom(code1, "Dave");
  assert.ok((await ask(D, "claim-nation", { nation: 20 })).success);
  const watcher = [A, B].find((s) => s.connected);
  D.close();
  await until(() => watcher.last.players.some((p) => p.name === "Dave" && !p.connected), 3000, "offline flag");
  assert.equal(watcher.last.players.find((p) => p.name === "Dave").nation, 20, "claim lost on disconnect");
  const D2 = await client();
  const rj = await ask(D2, "rejoin-room", { code: code1, token: D.token });
  assert.ok(rj.success);
  assert.equal(rj.room.players.find((p) => p.name === "Dave").nation, 20, "claim lost on rejoin");
  D2.pid = rj.you.id; D2.token = rj.you.token;
  const D2done = new Promise((r) => D2.once("disconnect", r)); D2.close(); await D2done;
  await until(() => !watcher.last.players.some((p) => p.name === "Dave"), 6000, "seat expiry");
  assert.ok((await ask(watcher, "claim-nation", { nation: 20 })).success, "expired player's nation not released");
});

test("claim-random never hands out a taken nation (8 players, all distinct)", async () => {
  const E = await makeRoom("P0"); await makeWorld(E);
  const ps = [E]; for (let i = 1; i < 8; i++) ps.push(await joinRoom(E.code, "P" + i));
  const res = await Promise.all(ps.map((p) => ask(p, "claim-random")));
  assert.ok(res.every((r) => r.success));
  assert.equal(new Set(res.map((r) => r.nation)).size, 8);
  const ninth = await client();
  const full = await ask(ninth, "join-room", { code: E.code, name: "late" });
  assert.equal(full.success, false); assert.match(full.message, /full/);
});

test("rooms are isolated: separate worlds, independent claims, separate player lists", async () => {
  const X = await makeRoom("Xena");
  await makeWorld(X);
  const rx = await ask(X, "world-get");
  assert.notEqual(X.last.world.seed, A.last.world.seed, "two rooms got the same seed (1-in-9000 fluke? rerun)");
  assert.ok(Buffer.compare(Buffer.from(rx.snapshot), snapA) !== 0, "rooms share a world");
  const dx = decodeHeader(Buffer.from(rx.snapshot)), da = decodeHeader(snapA);
  assert.ok(Buffer.compare(dx.terr, da.terr) !== 0, "terrain identical across seeds");
  // The nation taken in room 1 is still free in room 2, and claiming there does not touch room 1.
  const before = JSON.stringify(A.last.players.map((p) => [p.id, p.nation]));
  assert.ok((await ask(X, "claim-nation", { nation: 7 })).success);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(JSON.stringify(A.last.players.map((p) => [p.id, p.nation])), before);
  assert.equal(X.last.players.length, 1);
  assert.ok(A.last.players.every((p) => p.name !== "Xena"));
  assert.notEqual(X.code, A.code);
  // Room 1's world is untouched by room 2's.
  const again = await ask(A, "world-get");
  assert.ok(Buffer.compare(Buffer.from(again.snapshot), snapA) === 0);
});

test("world cap protects the server (MAX_WORLDS=1)", async () => {
  const p2 = await startServer(3232, { MAX_WORLDS: "1" });
  try {
    const u = "http://localhost:3232";
    const h1 = await client(u), h2 = await client(u);
    await ask(h1, "create-room", { name: "a" }); await ask(h2, "create-room", { name: "b" });
    assert.ok((await ask(h1, "create-world")).success);
    const r = await ask(h2, "create-world");
    assert.equal(r.success, false); assert.match(r.message, /maximum of 1/);
  } finally { p2.kill(); }
});
