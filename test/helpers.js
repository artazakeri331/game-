"use strict";
// Shared helpers for Stage 4 tests: server process, socket clients, snapshot decoding, delta applier.
const { spawn } = require("node:child_process");
const path = require("node:path");
const zlib = require("node:zlib");
const { io } = require("socket.io-client");

const MW = 1200, MH = 480, N = MW * MH;
const ROOT = path.join(__dirname, "..");

function startServer(port, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), GRACE_MS: "1500", SKYFRONT_TEST: "1", MAX_WORLDS: "8", MAX_RUNNING_GAMES: "4", ...env } });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.stdout.on("data", (d) => { if (String(d).includes("listening")) resolve(p); });
    p.on("error", reject);
    setTimeout(() => reject(new Error("server did not start")), 15000);
  });
}

const open = [];
function connect(url) {
  const s = io(url, { forceNew: true, reconnection: false });
  s.last = null; s.deltas = [];
  s.on("room-update", (r) => { s.last = r; });
  s.on("world-delta", (d) => s.deltas.push(d));
  open.push(s);
  return new Promise((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
}
const closeAll = () => open.forEach((c) => c.close());
const ask = (s, ev, data) => new Promise((res) => s.emit(ev, data === undefined ? {} : data, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error("timeout waiting for " + what);
}

async function makeRoom(url, name) {
  const a = await connect(url);
  const r = await ask(a, "create-room", { name });
  if (!r.success) throw new Error(r.message);
  Object.assign(a, { token: r.you.token, pid: r.you.id, code: r.room.code, url });
  return a;
}
async function joinRoom(url, code, name) {
  const b = await connect(url);
  const r = await ask(b, "join-room", { code, name });
  if (!r.success) throw new Error(r.message);
  Object.assign(b, { token: r.you.token, pid: r.you.id, code, url, joinRoom: r.room });
  return b;
}
async function makeWorld(host) {
  const r = await ask(host, "create-world");
  if (!r.success) throw new Error(r.message);
  await until(() => host.last && host.last.world.state === "ready", 120000, "world ready");
}

// ---- snapshot decoding (mirror of what the browser does) ----
function dec(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(dec);
  if (v.$n !== undefined) return Number(v.$n);
  if (v.$t) { const b = Buffer.from(v.b, "base64"); const u = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); return new globalThis[v.$t](u.buffer); }
  if (v.$m) return new Map(v.$m.map(([k, x]) => [dec(k), dec(x)]));
  const o = {}; for (const k in v) o[k] = dec(v[k]); return o;
}
function decodeSnapshot(buf) {
  const u = zlib.inflateSync(Buffer.from(buf)), L = u.readUInt32LE(0);
  const meta = JSON.parse(u.subarray(4, 4 + L).toString("utf8"));
  let o = 4 + L;
  const take = (T) => { const a = new T(u.buffer.slice(u.byteOffset + o, u.byteOffset + o + N)); o += N; return a; };
  const terr = take(Uint8Array), owner = take(Int8Array), scorch = take(Uint8Array), orig = take(Int8Array);
  return { seed: meta.seed, seq: meta.seq, ev: meta.ev, G: dec(meta.G), REL: dec(meta.REL), terr, owner, scorch, orig };
}
async function snapshotOf(s) {
  const r = await ask(s, "world-get");
  if (!r.success) throw new Error(r.message);
  return { ...decodeSnapshot(r.snapshot), reply: r };
}

// A minimal client model that applies deltas exactly like the browser hook does (used to prove deltas are lossless).
function model(snap) {
  const m = { seq: snap.seq, owner: Int8Array.from(snap.owner), blds: new Map(snap.G.blds.map((b) => [b.i, { type: b.type, owner: b.owner, lv: b.lv }])),
    nat: snap.G.nations.map((n) => ({ troops: n.troops, gold: n.gold, tiles: n.tiles, human: n.human, alive: n.alive })), t: snap.G.t, phase: snap.G.phase, rel: { war: snap.REL.war.slice(), treaty: snap.REL.treaty.slice(), truce: snap.REL.truce.slice(), pact: snap.REL.pact.slice(), riv: snap.REL.riv.slice(), op: Int16Array.from(snap.REL.op, Math.round) },
    offers: JSON.parse(JSON.stringify(snap.G.offers || [])), lastEv: snap.ev | 0, events: [], over: null,
    proj: { m: new Map(snap.G.missiles.map((o) => [o._id, o])), b: new Map(snap.G.bombers.map((o) => [o._id, o])), s: new Map(snap.G.boats.map((o) => [o._id, o])) } };
  m.apply = (d) => {
    if (d.seq !== m.seq + 1) throw new Error(`delta gap: have ${m.seq}, got ${d.seq}`);
    m.seq = d.seq; m.t = d.t; m.phase = d.phase;
    if (d.tiles) { const u = Buffer.from(d.tiles); for (let o = 0; o + 5 <= u.length; o += 5) m.owner[u.readUInt32LE(o)] = u.readInt8(o + 4); }
    for (const v of d.nat) Object.assign(m.nat[v[0]], { troops: v[1], gold: v[2], tiles: v[3] });
    for (const k in d.cold) Object.assign(m.nat[k], d.cold[k]);
    for (const [i, b] of d.blds) b ? m.blds.set(i, { type: b.type, owner: b.owner, lv: b.lv }) : m.blds.delete(i);
    if (d.rel) for (const f in d.rel) for (const [k, v] of d.rel[f]) m.rel[f][k] = v;
    if (d.offers) m.offers = d.offers;
    if (d.pr) for (const k in d.pr) { const e = d.pr[k]; for (const id of e.del || []) m.proj[k].delete(id); for (const o of e.up || []) m.proj[k].set(o._id, o); }
    if (d.ev) for (const [id, t, text, cls] of d.ev) { if (id <= m.lastEv) continue; m.lastEv = id; m.events.push({ id, text, cls }); }
    if (d.over) m.over = d.over;
  };
  return m;
}

// Find a nation (claimable) that has a tile bordering unclaimed land, plus that neutral tile.
function findNeutralBorder(snap, skip = new Set()) {
  const { owner, terr, G } = snap;
  for (const n of G.nations) {
    if (n.id < 1 || !n.alive || n.tiles < 100 || skip.has(n.id)) continue;
    for (let i = 0; i < N; i++) {
      if (owner[i] !== n.id || !terr[i]) continue;
      const x = i % MW;
      for (const j of [x > 0 ? i - 1 : -1, x < MW - 1 ? i + 1 : -1, i - MW, i + MW]) if (j >= 0 && j < N && owner[j] === -1 && terr[j]) return { nation: n.id, from: i, target: j };
    }
  }
  throw new Error("no neutral border found");
}
const firstTile = (snap, nid, pred = () => true) => { for (let i = 0; i < N; i++) if (snap.owner[i] === nid && snap.terr[i] && pred(i)) return i; return -1; };

module.exports = { startServer, connect, closeAll, ask, sleep, until, makeRoom, joinRoom, makeWorld, decodeSnapshot, snapshotOf, model, findNeutralBorder, firstTile, MW, MH, N };
