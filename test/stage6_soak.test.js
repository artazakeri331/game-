"use strict";
// Short soak as part of `npm test` (default 25 s, 3 clients). The long, configurable run is `node test/soak.js` (see README).
process.env.SOAK_SECONDS = process.env.SOAK_SECONDS || "25";
process.env.SOAK_CLIENTS = process.env.SOAK_CLIENTS || "3";
process.env.SOAK_PORT = process.env.SOAK_PORT || "3412";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { main } = require("./soak");

test(`soak: ${process.env.SOAK_CLIENTS} clients, ${process.env.SOAK_SECONDS}s of mixed real actions, no errors, no resyncs, bounded memory`, async () => {
  const r = await main();
  assert.equal(r.serverErrors.length, 0, JSON.stringify(r.serverErrors));
  assert.ok(r.actions.ok > 20, "actions were really accepted");
  assert.equal(r.actions.resyncs, 0);
  assert.ok(r.deltasPerClientPerSec > 1 && r.deltasPerClientPerSec < 4, "broadcast frequency stays bounded (about 2/s)");
  assert.ok(r.rssMB.max < 400, "memory stays under the 512 MB free-tier limit with headroom");
  assert.ok(r.realtimeRatio > 0.8, "simulation keeps real time locally");
});
