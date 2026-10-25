"use strict";
// One worker thread per room world: owns the authoritative simulation, ticks it at a bounded rate, validates actions,
// and streams deltas. Generating or ticking a world therefore never blocks the lobby for other rooms.
const { parentPort } = require("worker_threads");
const host = require("./sim-host");
const { makeTracker } = require("./world-sync");
const { runAction } = require("./world-actions");

// SIM_STEP_MS: wall-clock length of one simulation step AND the game time it advances (speed stays 1x). 100 ms is the original game's own step.
// Larger values (up to 250) cost less CPU but make the simulation coarser: this is NOT equivalent to the original experience.
const TICK_MS = Math.min(250, Math.max(100, Number(process.env.SIM_STEP_MS) || 100));
// A delta goes out every BROADCAST_TICKS steps (default 5 at 100 ms = 500 ms). With a coarser step the default keeps ~500 ms spacing.
const BROADCAST_TICKS = Math.max(1, Number(process.env.BROADCAST_TICKS) || Math.round(500 / TICK_MS));
const MAX_CATCHUP = 3;                                                    // if the CPU is starved the game slows down instead of spiralling

let sim = null, tracker = null, seq = 0, timer = null;
let started = false, paused = false, finished = false;
let last = 0, acc = 0, ticks = 0, tickMs = 0, tickMax = 0;
let deltas = 0, deltaBytes = 0, eluMark = performance.eventLoopUtilization();

const now = () => performance.now();
function emitDelta() {
  const d = tracker.diff(++seq);
  if (d.tiles) d.tiles = new Uint8Array(d.tiles);
  deltas++;                                                               // measurement only: counts and approximate payload size
  deltaBytes += (d.tiles ? d.tiles.length : 0) + JSON.stringify({ ...d, tiles: undefined }).length;
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
    const dur = now() - t0;
    tickMs = tickMs ? tickMs * 0.95 + dur * 0.05 : dur; if (dur > tickMax) tickMax = dur;
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
    } else if (cmd === "testCrash" && process.env.SKYFRONT_TEST === "1") {   // test-only: kill this worker with an uncaught error
      setImmediate(() => { throw new Error("test crash"); });
    } else if (cmd === "testWipe" && process.env.SKYFRONT_TEST === "1") {   // test-only: remove a nation's land so elimination/game-over can be exercised quickly
      const { owner } = sim.state();
      for (let i = 0; i < owner.length; i++) if (owner[i] === m.nation) owner[i] = -1;
    } else if (cmd === "pause") {
      paused = !!m.paused; last = now();
    } else if (cmd === "stats") {
      const mu = process.memoryUsage(), e = performance.eventLoopUtilization(eluMark);   // elu = share of wall time this worker was busy since the last stats call
      eluMark = performance.eventLoopUtilization();
      r = { tickMs: Math.round(tickMs * 100) / 100, tickMax: Math.round(tickMax * 100) / 100, ticks, seq, t: Math.round(sim.state().G.t), started, paused, finished, deltas, deltaBytes,
        elu: Math.round(e.utilization * 1000) / 1000, heapMB: Math.round(mu.heapUsed / 1e6), extMB: Math.round((mu.external + mu.arrayBuffers) / 1e6) };
      tickMax = 0;
    } else {
      throw new Error("Unknown command");
    }
    if (id !== undefined) parentPort.postMessage({ id, ok: true, ...r });
  } catch (e) {
    if (id !== undefined) parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
});
