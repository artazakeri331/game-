"use strict";
// One worker thread per room world, so generating or ticking a world never blocks the lobby for other rooms.
const { parentPort } = require("worker_threads");
const host = require("./sim-host");
let sim = null;
parentPort.on("message", ({ id, cmd, seed }) => {
  try {
    if (cmd === "init") sim = host.createSim(seed);
    if (!sim) throw new Error("World not initialised");
    // Stage 3: the world is static (spawn phase), so every reply carries the current snapshot + claimable nations.
    parentPort.postMessage({ id, ok: true, snapshot: host.snapshot(sim), ids: host.eligibleIds(sim), names: host.names(sim), seed: sim.state().seed });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
});
