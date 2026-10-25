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
  const f = sky.fn;
  const done = (msg, okMsg) => (msg ? fail(msg) : ok(okMsg));
  const ratioOf = () => { const r = Number(a.ratio); return r >= 1 && r <= 100 ? r : NaN; };
  const news = (t) => f.pushNews(t);
  const sig = (x, y) => {           // fingerprint of everything a diplomatic action can change between two nations
    const { REL } = sim.state(), k1 = x * sky.NCOUNT + y, k2 = y * sky.NCOUNT + x;
    return [REL.war[k1], REL.treaty[k1], REL.pact[k1], REL.riv[k1], REL.riv[k2], (G.offers || []).length, Math.round(G.nations[x].gold), Math.round(G.nations[y].gold)].join("|");
  };
  const targetName = (i) => { const o = owner[i]; return o >= 0 && o !== nid ? G.nations[o].name : null; };
  switch (a.type) {
    case "attack": {
      const ratio = ratioOf();
      if (tile < 0) return fail("Invalid target.");
      if (!(ratio >= 1)) return fail("Invalid troop amount.");
      const li = f.snapLand(tile, 4);                            // the game's own "click near coast" rule
      if (li < 0) return fail("That is water.");
      const def = owner[li];
      if (def === nid) return fail("That is your own land.");
      const before = n.troops;
      let msg = f.launchAttack(nid, def, (n.troops * ratio) / 100);   // troop count is computed from SERVER state
      if (msg && msg.startsWith("Your land does not border")) {     // same fallback as the original click handler
        msg = n.cnt.port > 0 ? f.launchNaval(nid, li, (n.troops * ratio) / 100) : "No land border there. Build a Port (Build tab), then click their coast to invade by sea.";
        if (!msg) { if (def >= 0) news(`${n.name} sends a fleet against ${G.nations[def].name}.`); return ok("Fleet launched."); }
      }
      if (msg) {
        if (msg.startsWith("You are not at war") && def > 0) return { success: false, message: msg, code: "nowar", target: def };
        return fail(msg);
      }
      return ok(`Attack launched with ${fmt(before - n.troops)} troops.`);
    }
    case "build": {
      if (tile < 0) return fail("Invalid tile.");
      if (typeof a.building !== "string" || !Object.prototype.hasOwnProperty.call(f.BUILD, a.building)) return fail("Unknown building.");
      if (a.all === true) { const msg = f.buildMany(n, a.building, tile); return /^All-in: built/.test(msg) ? ok(msg) : fail(msg); }   // the game's own All-in loop (bounded: <120 builds)
      return done(f.tryBuild(n, a.building, tile), `${f.BUILD[a.building].name} built.`);
    }
    case "upgrade": {
      if (tile < 0) return fail("Invalid tile.");
      if (a.all === true) { const msg = f.upgradeMany(n, tile); return msg === "" ? ok("Building upgraded.") : /^All-in:/.test(msg) ? ok(msg) : fail(msg); }
      return done(f.upgradeBuilding(n, tile), "Building upgraded.");
    }
    case "naval": {                                               // sail troops to a coast (Navy tab)
      const ratio = ratioOf();
      if (tile < 0 || !(ratio >= 1)) return fail("Invalid target.");
      const def = owner[f.snapLand(tile, 4)];
      const msg = f.launchNaval(nid, tile, (n.troops * ratio) / 100);
      if (!msg && def >= 0 && def !== nid) news(`${n.name} sends a fleet against ${G.nations[def].name}.`);
      return msg && msg.startsWith("You are not at war") && def > 0 ? { success: false, message: msg, code: "nowar", target: def } : done(msg, "Fleet launched.");
    }
    case "sink": {
      if (tile < 0) return fail("Invalid target.");
      return done(f.sinkShip(nid, (tile % sky.MW) + 0.5, Math.floor(tile / sky.MW) + 0.5), "Ship sunk.");
    }
    case "missile": {
      if (tile < 0) return fail("Invalid target.");
      if (typeof a.key !== "string" || !Object.prototype.hasOwnProperty.call(f.MISSILES, a.key)) return fail("Unknown missile.");
      const who = targetName(tile);
      const msg = f.launchMissile(nid, a.key, tile % sky.MW, Math.floor(tile / sky.MW));
      if (msg && /^(You are not at war|Declare war on)/.test(msg) && owner[tile] > 0) return { success: false, message: msg, code: "nowar", target: owner[tile] };
      if (!msg && who) news(`${n.name} launched a ${f.MISSILES[a.key].name} at ${who}.`);
      return done(msg, `${f.MISSILES[a.key].name} launched.`);
    }
    case "bomber": {
      if (tile < 0) return fail("Invalid target.");
      const who = targetName(tile);
      const msg = f.sortie(nid, tile % sky.MW, Math.floor(tile / sky.MW));
      if (msg && /^(You are not at war|Declare war on)/.test(msg) && owner[tile] > 0) return { success: false, message: msg, code: "nowar", target: owner[tile] };
      if (!msg && who) news(`${n.name} bombers are heading for ${who}.`);
      return done(msg, "Bomber sortie launched.");
    }
    case "recruit": {
      if (typeof a.key !== "string" || !Object.prototype.hasOwnProperty.call(f.RECRUIT, a.key)) return fail("Unknown recruit order.");
      if (a.all === true) { const msg = f.recruitMany(n, a.key); return /^All-in:/.test(msg) ? ok(msg) : fail(msg); }
      const t0 = n.troops;
      const msg = f.recruit(nid, a.key);
      return done(msg, `Recruited ${fmt(n.troops - t0)} troops.`);
    }
    case "drive": return done(f.startDrive(nid), "Conscription drive started.");
    case "jet": {
      if (a.kind !== "bomber" && a.kind !== "fighter") return fail("Unknown aircraft.");
      return done(f.buyJet(nid, a.kind), `${a.kind === "bomber" ? "Bomber" : "Fighter"} bought.`);
    }
    case "sat": {
      const s0 = n.sats, msg = f.buySat(n);
      return n.sats > s0 ? ok(msg) : fail(msg);
    }
    case "stock": {
      if (typeof a.key !== "string" || !Object.prototype.hasOwnProperty.call(f.MISSILES, a.key)) return fail("Unknown missile.");
      const msg = f.stockBuy(nid, a.key);
      return /stored in your silos/.test(msg) ? ok(msg) : fail(msg);
    }
    case "bonds": {
      if (a.op !== "issue" && a.op !== "repay") return fail("Invalid request.");
      if (a.op === "issue") { const g0 = n.gold, msg = f.issueBonds(nid); return msg ? fail(msg) : ok(`Bonds sold: +${fmt(n.gold - g0)} gold. You owe ${fmt(n.debt)}.`); }
      const msg = f.repayBonds(nid);
      return msg.startsWith("Repaid") ? ok(msg) : fail(msg);
    }
    case "retreat": {
      const mine = G.attacks.filter((x) => x.atk === nid);
      mine.forEach((x) => f.endAttack(x));
      return mine.length ? ok("Attacks recalled.") : fail("No attacks underway.");
    }
    case "tax": {
      const v = a.value;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > Math.round(f.TAX_MAX * 100)) return fail("Invalid tax rate.");
      n.tax = v / 100;
      return ok(`Tax rate set to ${v}%.`);
    }
    case "diplo": {
      if (!Number.isInteger(a.target) || a.target < 0 || a.target >= G.nations.length) return fail("Invalid nation.");
      const before = sig(nid, a.target);
      const msg = f.dip(nid, String(a.kind), a.target);
      return { success: sig(nid, a.target) !== before, message: msg };       // success = the world really changed
    }
    case "respond": {
      if (!Number.isInteger(a.offer) || typeof a.accept !== "boolean") return fail("Invalid response.");
      const o = (G.offers || []).find((x) => x.id === a.offer);
      const before = o ? sig(o.from, o.to) : "";
      const msg = f.respond(nid, a.offer, a.accept);
      const changed = o ? sig(o.from, o.to).split("|").slice(0, 4).join("|") !== before.split("|").slice(0, 4).join("|") : false;
      return { success: !!o && o.to === nid && (a.accept ? changed : /declined/.test(msg)), message: msg };
    }
    default:
      return fail("Unknown action.");
  }
}

module.exports = { runAction };
