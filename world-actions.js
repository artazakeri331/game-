"use strict";
// Server-side action validation. The nation id comes from the server (socket -> player -> claim), never from the client.
// Game rules are NOT re-implemented here: after shape checks we call the game's own launchAttack / tryBuild / upgradeBuilding,
// which enforce ownership, war status, borders, terrain, cost and troop minimums, and return '' on success or a message.

const fail = (message) => ({ success: false, message });
const ok = (message) => ({ success: true, message });
const tileOf = (v, N) => (Number.isInteger(v) && v >= 0 && v < N ? v : -1);
const fmt = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

function runAction(sim, nid, a) {
  const { sky } = sim;
  const { G, owner } = sim.state();
  const N = sky.MW * sky.MH;
  const n = Number.isInteger(nid) ? G.nations[nid] : null;

  if (!a || typeof a !== "object" || typeof a.type !== "string") return fail("Invalid request.");
  if (!n || nid < 1) return fail("You do not lead a country.");
  if (G.phase !== "play") return fail("The game has not started yet.");
  if (G.over) return fail("The game is over.");
  if (!n.alive) return fail("Your nation has fallen.");
  if (!n.human) return fail("You do not control this nation.");

  const tile = tileOf(a.tile, N);
  switch (a.type) {
    case "attack": {
      const ratio = Number(a.ratio);
      if (tile < 0) return fail("Invalid target.");
      if (!(ratio >= 1 && ratio <= 100)) return fail("Invalid troop amount.");
      const li = sky.fn.snapLand(tile, 4);                       // the game's own "click near coast" rule
      if (li < 0) return fail("That is water.");
      const def = owner[li];
      if (def === nid) return fail("That is your own land.");
      const before = n.troops;
      const msg = sky.fn.launchAttack(nid, def, (n.troops * ratio) / 100);   // troop count is computed from SERVER state
      if (msg) {
        if (msg.startsWith("You are not at war")) return fail(msg.split(".")[0] + ". Declaring war is not available in multiplayer yet.");
        if (msg.startsWith("Your land does not border")) return fail("Your land does not border that. Naval invasions are not available in multiplayer yet.");
        return fail(msg);
      }
      return ok(`Attack launched with ${fmt(before - n.troops)} troops.`);
    }
    case "build": {
      if (tile < 0) return fail("Invalid tile.");
      if (typeof a.building !== "string" || !Object.prototype.hasOwnProperty.call(sky.fn.BUILD, a.building)) return fail("Unknown building.");
      const msg = sky.fn.tryBuild(n, a.building, tile);
      return msg ? fail(msg) : ok(`${sky.fn.BUILD[a.building].name} built.`);
    }
    case "upgrade": {
      if (tile < 0) return fail("Invalid tile.");
      const msg = sky.fn.upgradeBuilding(n, tile);
      return msg ? fail(msg) : ok("Building upgraded.");
    }
    default:
      return fail("Unknown action.");
  }
}

module.exports = { runAction };
