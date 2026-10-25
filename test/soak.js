"use strict";
// Configurable multiplayer soak / measurement run against a LOCAL server process (never point this at production).
//   node test/soak.js                       # 60 s, 3 clients, 1 room
//   SOAK_SECONDS=300 SOAK_CLIENTS=4 SOAK_ROOMS=1 node test/soak.js
//   SOAK_ENV="SIM_STEP_MS=200" node test/soak.js        # extra server env, e.g. tick-rate experiments
// Each client claims a country and, within the 5 actions/s limit, keeps issuing a mix of real actions (build, recruit, tax, war, peace
// offers, attacks, missiles, bombers). Samples server CPU (all threads, from /proc), RSS, delta count/bytes, worker tick stats.
// Server defaults (MAX_RUNNING_GAMES=1 etc.) are left untouched unless SOAK_ENV overrides them. SOAK_ROOMS>1 needs SOAK_ENV="MAX_RUNNING_GAMES=2".
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const H = require("./helpers");
const { ask, until, sleep, N } = H;

const SECONDS = Number(process.env.SOAK_SECONDS) || 60, CLIENTS = Math.max(2, Number(process.env.SOAK_CLIENTS) || 3), ROOMS = Math.max(1, Number(process.env.SOAK_ROOMS) || 1);
const BATTLE = process.env.SOAK_BATTLE === "1";
const PORT = Number(process.env.SOAK_PORT) || 3377, URL = `http://localhost:${PORT}`;
const extra = Object.fromEntries((process.env.SOAK_ENV || "").split(/\s+/).filter(Boolean).map((kv) => kv.split("=")));
if (!/^(localhost|127\.)/.test(URL.replace("http://", ""))) throw new Error("soak.js only runs against localhost");

const cpuOf = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / 100; };   // utime+stime, seconds
const rssOf = (pid) => Number((fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/) || [0, 0])[1]) / 1024;
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; };

async function main() {
  const srv = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(PORT), STATS_LOG_MS: "10000", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let statLines = [], errs = [];
  srv.stdout.on("data", (d) => String(d).split("\n").forEach((l) => l.startsWith("[stats]") && statLines.push(JSON.parse(l.slice(8)))));
  srv.stderr.on("data", (d) => errs.push(String(d).trim()));
  await until(() => statLines.length || true, 1000).catch(() => {}); await sleep(1200);
  const stats = { actions: 0, ok: 0, rejected: 0, rateLimited: 0, deltas: 0, bytes: 0, resyncs: 0, projectilesSeen: 0, maxDeltaBytes: 0 };
  const rooms = [];
  try {
    for (let r = 0; r < ROOMS; r++) {
      const host = await H.makeRoom(URL, `H${r}`); const players = [host];
      for (let i = 1; i < CLIENTS; i++) players.push(await H.joinRoom(URL, host.code, `P${r}_${i}`));
      await H.makeWorld(host);
      const s0 = await H.snapshotOf(host);
      const elig = s0.G.nations.filter((n) => n.id >= 1 && n.alive && n.tiles >= 100);
      // choose CLIENTS nations, starting from one nation and taking its nearest neighbours so that ground wars are possible
      const first = elig[0]; const d = (n) => Math.hypot(n.cx - first.cx, n.cy - first.cy);
      const picks = [...elig].sort((a, b) => d(a) - d(b)).slice(0, CLIENTS);
      for (let i = 0; i < CLIENTS; i++) { const res = await ask(players[i], "claim-nation", { nation: picks[i].id }); if (!res.success) throw new Error("claim failed " + res.message); players[i].nat = picks[i].id; }
      players.forEach((p) => p.on("world-delta", (dl) => { stats.deltas++; stats.bytes += (dl.tiles ? dl.tiles.length : 0) + JSON.stringify({ ...dl, tiles: undefined }).length; if (dl.resync) stats.resyncs++; if (dl.pr) for (const k of Object.keys(dl.pr)) stats.projectilesSeen += ((dl.pr[k] && dl.pr[k].up) || []).length; const sz = (dl.tiles ? dl.tiles.length : 0) + JSON.stringify({ ...dl, tiles: undefined }).length; if (sz > stats.maxDeltaBytes) stats.maxDeltaBytes = sz; }));
      const start = await ask(host, "start-game"); if (!start.success) throw new Error(start.message);
      rooms.push({ host, players, s0 });
    }
    const t0 = Date.now(), cpu0 = cpuOf(srv.pid); const samples = []; let cpuPrev = cpu0, tPrev = t0;
    const rng = (n) => Math.floor(Math.random() * n);
    const worker = async (room, p, idx) => {
      const { s0 } = room;
      const mine = []; for (let i = 0; i < N && mine.length < 400; i += 3) if (s0.owner[i] === p.nat && s0.terr[i] === 1) mine.push(i);
      const enemyTiles = (id) => { const t = []; for (let i = 0; i < N && t.length < 200; i += 5) if (s0.owner[i] === id && s0.terr[i] === 1) t.push(i); return t; };
      const others = room.players.filter((q) => q !== p).map((q) => q.nat);
      const foes = others.map((id) => ({ id, tiles: enemyTiles(id) }));
      while (Date.now() - t0 < SECONDS * 1000) {
        await sleep(230);
        const f = foes[rng(foes.length)];
        const early = (Date.now() - t0) < SECONDS * 1000 * 0.25;
        const pick = BATTLE ? (early ? [4, 4, 4, 2, 7, 0][rng(6)] : [5, 5, 5, 5, 6, 6, 7, 8, 8, 0][rng(10)]) : rng(10);   // battle mode: build up first, then fire as much as the economy allows
        const action = pick === 0 ? { type: "diplo", kind: "war", target: f.id }
          : pick === 1 ? { type: "diplo", kind: "peace", target: f.id }
          : pick === 2 ? { type: "recruit", key: "small" }
          : pick === 3 ? { type: "tax", value: 10 + rng(40) }
          : pick === 4 ? { type: "build", building: ["city", "silo", "air", "barracks", "market"][rng(5)], tile: mine[rng(mine.length)] }
          : pick === 5 ? { type: "missile", key: "cruise", tile: f.tiles[rng(f.tiles.length)] }
          : pick === 6 ? { type: "bomber", tile: f.tiles[rng(f.tiles.length)] }
          : pick === 7 ? { type: "jet", kind: "bomber" }
          : { type: "attack", tile: f.tiles[rng(f.tiles.length)], ratio: 30 + rng(60) };
        const res = await ask(p, "game-action", { rid: Math.random().toString(36).slice(2, 12), action });
        stats.actions++; if (res && res.success) stats.ok++; else { stats.rejected++; if (res && /Too many/.test(res.message || "")) stats.rateLimited++; }
      }
    };
    const sampler = (async () => {
      while (Date.now() - t0 < SECONDS * 1000) {
        await sleep(5000);
        const c = cpuOf(srv.pid), t = Date.now();
        samples.push({ cpuPerSec: (c - cpuPrev) / ((t - tPrev) / 1000), rss: rssOf(srv.pid) }); cpuPrev = c; tPrev = t;
      }
    })();
    await Promise.all([sampler, ...rooms.flatMap((r) => r.players.map((p, i) => worker(r, p, i)))]);
    const wall = (Date.now() - t0) / 1000, cpuTotal = cpuOf(srv.pid) - cpu0;
    await sleep(10500);
    const last = statLines[statLines.length - 1] || { worlds: [] };
    const gameT = last.worlds.map((w) => w.t);
    const out = {
      config: { battle: BATTLE, seconds: SECONDS, clients: CLIENTS, rooms: ROOMS, serverEnv: extra, node: process.version, cpus: require("os").cpus().length },
      wallSeconds: Math.round(wall), cpuSecondsPerWallSecond: +(cpuTotal / wall).toFixed(3),
      cpuSample: { median: +pct(samples.map((s) => s.cpuPerSec), .5).toFixed(3), p95: +pct(samples.map((s) => s.cpuPerSec), .95).toFixed(3) },
      rssMB: { start: Math.round(samples[0] ? samples[0].rss : 0), end: Math.round(samples.length ? samples[samples.length - 1].rss : 0), max: Math.round(Math.max(0, ...samples.map((s) => s.rss))) },
      actions: stats, actionsPerSec: +(stats.actions / wall).toFixed(1),
      deltasPerClientPerSec: +(stats.deltas / (CLIENTS * ROOMS) / wall).toFixed(2), deltaBytesAvg: stats.deltas ? Math.round(stats.bytes / stats.deltas) : 0,
      downstreamKBperClientPerSec: +(stats.bytes / (CLIENTS * ROOMS) / wall / 1024).toFixed(2),
      gameSecondsReached: gameT, realtimeRatio: gameT.length ? +(Math.max(...gameT) / wall).toFixed(2) : null,
      workers: last.worlds.map((w) => ({ tickMs: w.tickMs, tickMax: w.tickMax, elu: w.elu, heapMB: w.heapMB, extMB: w.extMB })),
      serverErrors: errs.slice(0, 5)
    };
    console.log(JSON.stringify(out, null, 2));
    return out;
  } finally { H.closeAll(); srv.kill(); }
}
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error("SOAK FAILED:", e.message); process.exit(1); });
module.exports = { main };
