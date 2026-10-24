"use strict";
// Delta tracker: compares the authoritative sim against what clients were last told and emits only the difference.
// Stable identifiers: nations by id, tiles by index, buildings by tile index (one building per tile), relations by pair index.
// All values are absolute (not increments), so applying a delta over a slightly newer snapshot is still correct.

const HOT = ["troops", "gold", "tiles", "cx", "cy", "approval", "unrest", "debt"];      // change every tick -> compact vector
// Everything else the client UI reads. Whitelist (not "all scalars"): AI timers change every tick and would bloat deltas.
const COLD = ["alive", "spawned", "human", "cnt", "lsum", "tax", "sats", "infamy", "home", "fighters", "bombers", "stock", "drive", "debtRate", "bonds", "noPort", "cc", "country"];
const MAX_TILE_DELTA = 40000;          // beyond this (nuke-scale change) tell clients to refetch a snapshot instead
const REL_FIELDS = ["war", "treaty", "truce", "pact", "riv"];
const r1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

function coldOf(n) {
  const o = {};
  for (const k of COLD) if (n[k] !== undefined) o[k] = n[k];
  return JSON.stringify(o);
}
const bsig = (b) => `${b.type}|${b.owner}|${b.lv}|${Math.round(b.ready || 0)}`;

// Projectile lists. Each object gets a stable `_id` the first time it is seen (it is also part of snapshots, so a client
// that loads a snapshot and then applies deltas refers to the same objects). `sig` changes -> object is re-sent in full.
const PROJ = { m: ["missiles", () => "1"], b: ["bombers", (o) => o.phase + "|" + o.t0], s: ["boats", () => "1"] };
const MAX_EVENTS = 40;

function makeTracker(sim) {
  const s0 = sim.state();
  let nextId = 0, evId = 0;
  const seen = new WeakSet([...s0.G.log, ...s0.G.news]);
  const prevProj = { m: new Map(), b: new Map(), s: new Map() };
  for (const k in PROJ) for (const o of s0.G[PROJ[k][0]]) { o._id = o._id || ++nextId; prevProj[k].set(o._id, PROJ[k][1](o)); }
  let prevOffers = JSON.stringify(s0.G.offers || []);
  const N = sim.sky.NCOUNT;
  let prevOp = Int16Array.from(s0.REL.op, Math.round);
  let prevOwner = Int8Array.from(s0.owner);
  let prevBlds = new Map(s0.G.blds.map((b) => [b.i, bsig(b)]));
  let prevCold = s0.G.nations.map(coldOf);
  let prevAlive = new Set(s0.G.nations.filter((n) => n.alive).map((n) => n.id));
  let prevRel = {};
  for (const f of REL_FIELDS) prevRel[f] = s0.REL[f].slice();
  let prevAtk = "[]";

  function diff(seq) {
    const { G, owner, REL } = sim.state();
    const d = { seq, t: r1(G.t), phase: G.phase, paused: !!G.paused, nat: [], cold: {}, blds: [] };

    // tiles: compare 4 bytes at a time, only inspect bytes of words that differ
    const a = new Int32Array(owner.buffer, owner.byteOffset, owner.length >> 2);
    const b = new Int32Array(prevOwner.buffer, 0, prevOwner.length >> 2);
    const idx = [];
    let count = 0;
    for (let w = 0; w < a.length; w++) {
      if (a[w] === b[w]) continue;
      for (let k = w * 4; k < w * 4 + 4; k++) if (owner[k] !== prevOwner[k]) { count++; if (count <= MAX_TILE_DELTA) idx.push(k); }
    }
    if (count > MAX_TILE_DELTA) d.resync = true;
    else if (count) {
      const buf = Buffer.alloc(idx.length * 5);
      idx.forEach((i, j) => { buf.writeUInt32LE(i, j * 5); buf.writeInt8(owner[i], j * 5 + 4); });
      d.tiles = buf;
    }
    prevOwner.set(owner);

    // nations: hot vector for living nations (plus any that just died), cold object only when changed
    const ids = new Set(prevAlive);
    const alive = new Set();
    for (const n of G.nations) { if (n.alive) { alive.add(n.id); ids.add(n.id); } }
    for (const id of ids) {
      const n = G.nations[id];
      d.nat.push([id, r1(n.troops), r1(n.gold), n.tiles, r1(n.cx), r1(n.cy), r1(n.approval), r1(n.unrest), r1(n.debt)]);
    }
    prevAlive = alive;
    for (const n of G.nations) {
      const c = coldOf(n);
      if (c !== prevCold[n.id]) { d.cold[n.id] = JSON.parse(c); prevCold[n.id] = c; }
    }

    // buildings keyed by tile index
    const cur = new Map();
    for (const bl of G.blds) cur.set(bl.i, bl);
    for (const [i, bl] of cur) {
      const sg = bsig(bl);
      if (prevBlds.get(i) !== sg) d.blds.push([i, { type: bl.type, owner: bl.owner, lv: bl.lv, ready: Math.round(bl.ready || 0) }]);
    }
    for (const i of prevBlds.keys()) if (!cur.has(i)) d.blds.push([i, null]);
    prevBlds = new Map([...cur].map(([i, bl]) => [i, bsig(bl)]));

    // relations (war / treaty / truce) as changed-pair lists
    for (const f of REL_FIELDS) {
      const now = REL[f], was = prevRel[f], ch = [];
      for (let k = 0; k < now.length; k++) if (now[k] !== was[k]) { ch.push([k, now[k]]); was[k] = now[k]; }
      if (ch.length) (d.rel || (d.rel = {}))[f] = ch;
    }

    // active attacks (small list; only when it changed)
    const atk = JSON.stringify(G.attacks.map((x) => [x.atk, x.def, Math.round(x.troops)]));
    if (atk !== prevAtk) { d.atk = JSON.parse(atk); prevAtk = atk; }

    // offers between human players (small list; sent only when it changed)
    const of = JSON.stringify(G.offers || []);
    if (of !== prevOffers) { d.offers = JSON.parse(of); prevOffers = of; }

    // opinions of/toward human nations (rounded, so slow drift costs almost nothing)
    const op = [];
    for (const h of G.nations) {
      if (!h.human || !h.alive || h.id < 1) continue;
      for (let o = 0; o < N; o++) {
        for (const k of [h.id * N + o, o * N + h.id]) {
          const v = Math.round(REL.op[k]);
          if (v !== prevOp[k]) { prevOp[k] = v; op.push([k, v]); }
        }
      }
    }
    if (op.length) (d.rel || (d.rel = {})).op = op;

    // projectiles: new/changed objects in full, removed ids, boat progress
    const pr = {};
    for (const key in PROJ) {
      const [list, sg] = PROJ[key], prev = prevProj[key], cur = new Map(), up = [];
      for (const o of G[list]) {
        if (!o._id) o._id = ++nextId;
        const g = sg(o);
        cur.set(o._id, g);
        if (prev.get(o._id) !== g) up.push(o);
      }
      const del = [];
      for (const id of prev.keys()) if (!cur.has(id)) del.push(id);
      prevProj[key] = cur;
      const e = {};
      if (up.length) e.up = up;
      if (del.length) e.del = del;
      if (key === "s" && G.boats.length) e.d = G.boats.map((b) => [b._id, r1(b.d)]);
      if (Object.keys(e).length) pr[key] = e;
    }
    if (Object.keys(pr).length) d.pr = pr;

    // events: new game news / log lines, each with a stable increasing id (clients drop ids they already have)
    const ev = [];
    for (let i = G.news.length - 1; i >= 0; i--) { const x = G.news[i]; if (!seen.has(x)) { seen.add(x); ev.push([++evId, r1(x.t), x.text, "news", 1]); } }
    for (let i = G.log.length - 1; i >= 0; i--) { const x = G.log[i]; if (!seen.has(x)) { seen.add(x); ev.push([++evId, r1(G.t), x.text, x.cls || "", 0]); } }
    if (ev.length) d.ev = ev.slice(-MAX_EVENTS);

    if (G.over) d.over = { winner: G.over.winner, why: G.over.why };
    return d;
  }
  return { diff, lastEv: () => evId };
}

module.exports = { makeTracker, HOT, COLD, MAX_TILE_DELTA };
