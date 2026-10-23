"use strict";
// Delta tracker: compares the authoritative sim against what clients were last told and emits only the difference.
// Stable identifiers: nations by id, tiles by index, buildings by tile index (one building per tile), relations by pair index.
// All values are absolute (not increments), so applying a delta over a slightly newer snapshot is still correct.

const HOT = ["troops", "gold", "tiles", "cx", "cy", "approval", "unrest", "debt"];      // change every tick -> compact vector
// Everything else the client UI reads. Whitelist (not "all scalars"): AI timers change every tick and would bloat deltas.
const COLD = ["alive", "spawned", "human", "cnt", "lsum", "tax", "sats", "infamy", "home", "fighters", "bombers", "stock", "drive", "debtRate", "bonds", "noPort", "cc", "country"];
const MAX_TILE_DELTA = 40000;          // beyond this (nuke-scale change) tell clients to refetch a snapshot instead
const REL_FIELDS = ["war", "treaty", "truce"];
const r1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

function coldOf(n) {
  const o = {};
  for (const k of COLD) if (n[k] !== undefined) o[k] = n[k];
  return JSON.stringify(o);
}
const bsig = (b) => `${b.type}|${b.owner}|${b.lv}|${Math.round(b.ready || 0)}`;

function makeTracker(sim) {
  const s0 = sim.state();
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

    if (G.over) d.over = { winner: G.over.winner, why: G.over.why };
    return d;
  }
  return { diff };
}

module.exports = { makeTracker, HOT, COLD, MAX_TILE_DELTA };
