"use strict";
// Runs the unmodified Skyfront simulation headlessly (one isolated vm context per room).
// The game script is read from Skyfront.html at startup, so there is no second copy to keep in sync.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const GAME_FILE = path.join(__dirname, "Skyfront.html");
let SOURCE = null;

function gameSource() {
  if (SOURCE) return SOURCE;
  const html = fs.readFileSync(GAME_FILE, "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  SOURCE = blocks.find((s) => s.includes("const MW=1200"));
  if (!SOURCE) throw new Error("Game script not found in Skyfront.html");
  return SOURCE;
}

// ---- minimal DOM stand-in: every element/property is a harmless no-op ----
function stub() {
  const store = Object.create(null);
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return () => [][Symbol.iterator]();
      if (k === "then" || typeof k === "symbol") return undefined;
      return k in store ? store[k] : p;
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return p; },
    construct() { return p; }
  });
  return p;
}
function ctx2d() {
  const base = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}
  };
  const s = stub();
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : s), set: () => true });
}
function canvasStub() {
  const s = stub(), c = ctx2d();
  return new Proxy({ getContext: () => c }, { get: (t, k) => (k in t ? t[k] : s), set: () => true });
}

function createSim(seed) {
  const el = stub();
  const win = {
    __SKY_SEED: seed, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    requestAnimationFrame() {}, matchMedia: () => ({ matches: false }), ResizeObserver: function () { return { observe() {} }; },
    addEventListener() {}, performance, setTimeout, clearTimeout, console
  };
  win.window = win;
  win.document = {
    getElementById: () => el, createElement: (t) => (t === "canvas" ? canvasStub() : stub()),
    addEventListener() {}, activeElement: null
  };
  const context = vm.createContext(win);
  vm.runInContext(gameSource(), context, { filename: "Skyfront-game.js", timeout: 30000 });
  const sky = win.__SKY;
  if (!sky) throw new Error("Game hook (__SKY) missing");
  return { sky, state: () => sky.state() };
}

// ---- snapshot codec (server side; the client mirrors decode in Skyfront.html) ----
function enc(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : { $n: String(v) };
  if (typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return { $t: v.constructor.name, b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Object.prototype.toString.call(v) === "[object Map]") return { $m: [...v].map(([k, x]) => [enc(k), enc(x)]) };
  if (Array.isArray(v)) return v.map(enc);
  const o = {};
  for (const k of Object.keys(v)) if (k !== "rows") o[k] = enc(v[k]); // G.rows = client DOM refs
  return o;
}

function snapshot(sim, seq = 0, ev = 0) {
  const s = sim.state();
  const meta = Buffer.from(JSON.stringify({ seed: s.seed, seq, ev, G: enc(s.G), REL: enc(s.REL) }), "utf8");
  const head = Buffer.alloc(4); head.writeUInt32LE(meta.length);
  const arr = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  return zlib.deflateSync(Buffer.concat([head, meta, arr(s.terr), arr(s.owner), arr(s.scorch), arr(s.orig)]), { level: 6 });
}

// Nations a player may lead (same rule as the game's own random pick).
function eligible(sim, id) {
  const n = sim.state().G.nations[id];
  return !!(Number.isInteger(id) && id >= 1 && n && n.alive && n.tiles >= 100);
}
function eligibleIds(sim) {
  return sim.state().G.nations.filter((n) => n.id >= 1 && n.alive && n.tiles >= 100).map((n) => n.id);
}

function names(sim) {
  return sim.state().G.nations.map((n) => n.name);
}

module.exports = { createSim, snapshot, eligible, eligibleIds, names };
