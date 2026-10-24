"use strict";
// One worker thread per room world: owns the authoritative simulation, ticks it at a bounded rate, validates actions,
// and streams deltas. Generating or ticking a world therefore never blocks the lobby for other rooms.
const { parentPort } = require("worker_threads");
const host = require("./sim-host");
const { makeTracker } = require("./world-sync");
const { runAction } = require("./world-actions");

const TICK_MS = 100;                                                      // the game's native 0.1 s step; speed is fixed at 1x
const BROADCAST_TICKS = Math.max(1, Number(process.env.BROADCAST_TICKS) || 5);   // delta every 500 ms
const MAX_CATCHUP = 3;                                                    // if the CPU is starved the game slows down instead of spiralling

let sim = null, tracker = null, seq = 0, timer = null;
let started = false, paused = false, finished = false;
let last = 0, acc = 0, ticks = 0, tickMs = 0;

const now = () => performance.now();
function emitDelta() {
  const d = tracker.diff(++seq);
  if (d.tiles) d.tiles = new Uint8Array(d.tiles);
  parentPort.postMessage({ ev: "delta", delta: d });
}
function loop() {
  const t = now();
  if (!started || paused || finished) { last = t; acc = 0; return; }
  acc += Math.min(t - last, 250); last = t;
  let steps = 0;
  while (acc >= TICK_MS && steps < MAX_CATCHUP) {
    const t0 = now();
    sim.sky.step(TICK_MS / 1000);
    tickMs = tickMs ? tickMs * 0.95 + (now() - t0) * 0.05 : now() - t0;
    acc -= TICK_MS; steps++; ticks++;
    const over = !!sim.state().G.over;
    if (over || ticks % BROADCAST_TICKS === 0) emitDelta();
    if (over) { finished = true; parentPort.postMessage({ ev: "over" }); break; }
  }
  if (acc > TICK_MS * MAX_CATCHUP) acc = 0;                               // drop backlog
}

parentPort.on("message", (m) => {
  const { id, cmd } = m;
  let r = {};
  try {
    if (cmd === "init") {
      sim = host.createSim(m.seed);
      sim.sky.server();
      tracker = makeTracker(sim);
      timer = setInterval(loop, 50);
      r = { snapshot: host.snapshot(sim, seq, tracker.lastEv()), ids: host.eligibleIds(sim), names: host.names(sim), seed: sim.state().seed, seq };
    } else if (!sim) {
      throw new Error("World not initialised");
    } else if (cmd === "snapshot") {
      if (started && !finished) emitDelta();                              // flush so the snapshot sits exactly at `seq`
      r = { snapshot: host.snapshot(sim, seq, tracker.lastEv()), seed: sim.state().seed, seq, started, over: finished };
    } else if (cmd === "start") {
      if (started) throw new Error("Already started");
      sim.sky.start(m.ids);
      started = true; last = now(); acc = 0;
      emitDelta();
    } else if (cmd === "setHuman") {
      r = { success: sim.sky.setHuman(m.nation, m.human) };
    } else if (cmd === "action") {
      r = runAction(sim, m.nation, m.action);
    } else if (cmd === "testWipe" && process.env.SKYFRONT_TEST === "1") {   // test-only: remove a nation's land so elimination/game-over can be exercised quickly
      const { owner } = sim.state();
      for (let i = 0; i < owner.length; i++) if (owner[i] === m.nation) owner[i] = -1;
    } else if (cmd === "pause") {
      paused = !!m.paused; last = now();
    } else if (cmd === "stats") {
      r = { tickMs, ticks, seq, t: sim.state().G.t, started, paused, finished };
    } else {
      throw new Error("Unknown command");
    }
    if (id !== undefined) parentPort.postMessage({ id, ok: true, ...r });
  } catch (e) {
    if (id !== undefined) parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
});
