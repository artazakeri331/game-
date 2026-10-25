
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");
const { Worker } = require("worker_threads");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PUBLIC_DIR = path.join(__dirname, "public");
const GAME_FILE = path.join(__dirname, "Skyfront.html");

app.use(express.static(PUBLIC_DIR));

// Serve Skyfront when someone opens the main website URL.
app.get("/healthz", (req, res) => res.send("ok"));

app.get(["/", "/Skyfront.html"], (req, res) => {
  res.sendFile(GAME_FILE, (err) => {
    if (err) {
      console.error("Could not load Skyfront.html:", err.message);
      if (!res.headersSent) {
        res.status(err.statusCode || 500).send(
          "Skyfront.html could not be found. Check that it exists in the repository root."
        );
      }
    }
  });
});

// ---------------- Lobby / rooms (Stage 2) ----------------
const rooms = new Map();
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_ROOMS = 25;               // protects a small free Render instance
const MAX_WORLDS = Number(process.env.MAX_WORLDS) || 4;   // simulated worlds at once (each ~50 MB; free Render has 512 MB)
const MAX_RUNNING_GAMES = Number(process.env.MAX_RUNNING_GAMES) || 1;   // games ticking at once: one running sim costs ~170 ms CPU/s, more than a free Render instance (~0.1 vCPU) has; raise on paid plans
const ACTION_BURST = 10, ACTION_PER_SEC = 5;                              // per-player action rate limit
const GRACE_MS = Number(process.env.GRACE_MS) || 60 * 1000;        // seat is held this long after a disconnect
const WORLD_IDLE_MS = Number(process.env.WORLD_IDLE_MS) || 15 * 60 * 1000;   // an unstarted or finished world nobody touched for this long is discarded to free memory
const REAPER_MS = Number(process.env.REAPER_MS) || 60 * 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z2-9]{5}$/;

function makeRoomCode() {
  let s = "";
  for (const b of crypto.randomBytes(5)) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

function safeCallback(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

function cleanName(raw, room) {
  let base = String(raw || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16) || "Player";
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  let name = base, i = 2;
  while (taken.has(name.toLowerCase())) name = `${base} ${i++}`;
  return name;
}

function publicRoom(room) {
  return {
    code: room.code,
    max: MAX_PLAYERS_PER_ROOM,
    hostId: room.hostId,
    world: { state: room.world.state, seed: room.world.seed, rev: room.world.rev, started: room.world.started, over: room.world.over, error: room.world.error || null },
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId,
      nation: p.nation === null ? null : p.nation, nationName: p.nation === null ? null : (room.world.names[p.nation] || null)
    }))
  };
}

// Counters for the optional stats log. Rejections are counted (and rate-limit hits logged at most every 10 s per player), never logged with tokens or payloads.
const metrics = { actions: 0, rejected: 0, rateLimited: 0, duplicates: 0, errors: 0 };
const touch = (room) => { room.lastActive = Date.now(); };

function broadcast(room) {
  io.to(room.code).emit("room-update", publicRoom(room));
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = [...room.players.values()].find((p) => p.connected) || [...room.players.values()][0];
  if (next) room.hostId = next.id;
}

// ---------------- Shared world (Stage 3) ----------------
function newWorld() {
  return { state: "none", seed: 0, rev: 0, started: false, starting: false, over: false, paused: false, worker: null, ids: new Set(), names: [], error: null, pending: new Map(), seq: 0 };
}
function worldsInUse() {
  let n = 0;
  for (const r of rooms.values()) if (r.world.worker) n++;
  return n;
}
function disposeWorld(room) {
  const w = room.world;
  if (w.worker) { w.worker.removeAllListeners(); w.worker.terminate(); w.worker = null; }
  for (const p of w.pending.values()) p.reject(new Error("World closed"));
  w.pending.clear();
}
function worldCall(room, cmd, extra) {
  const w = room.world;
  return new Promise((resolve, reject) => {
    if (!w.worker) return reject(new Error("World not available"));
    const id = ++w.seq;
    w.pending.set(id, { resolve, reject });
    w.worker.postMessage({ id, cmd, ...extra });
  });
}
function startWorld(room) {
  const w = room.world;
  w.state = "building"; w.error = null; w.rev++;
  w.seed = 1000 + Math.floor(Math.random() * 9000);
  const worker = new Worker(path.join(__dirname, "sim-worker.js"));
  w.worker = worker;
  const fail = (msg) => {
    if (w.worker !== worker) return;
    console.error(`Room ${room.code} world failed:`, msg);
    const wasStarted = w.started;
    disposeWorld(room);
    w.state = "error"; w.ids = new Set();
    if (wasStarted) {                                           // a crashed running game cannot be recovered (state is in memory only): reset the room for a new one
      w.error = "The game server hit an error and this game was lost. The host can create a new world.";
      w.started = false; w.over = false; w.starting = false; w.paused = false;
      room.claims.clear();
      for (const p of room.players.values()) { p.nation = null; p.rids.clear(); }
    } else w.error = "World generation failed. Try again.";
    broadcast(room);
  };
  worker.on("message", (m) => {
    if (m.ev === "delta") {                                   // streamed by the sim; forwarded to this room only
      if (m.delta.tiles) m.delta.tiles = Buffer.from(m.delta.tiles);
      return io.to(room.code).emit("world-delta", m.delta);
    }
    if (m.ev === "over") { w.over = true; broadcast(room); return; }   // finished games stop ticking and no longer count as running
    const p = w.pending.get(m.id);
    if (!p) return;
    w.pending.delete(m.id);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error));
  });
  worker.on("error", (e) => fail(e && e.message ? e.message : "worker error"));
  worker.on("exit", () => fail("worker exited"));
  worldCall(room, "init", { seed: w.seed }).then((m) => {
    if (w.worker !== worker) return;
    w.ids = new Set(m.ids); w.names = m.names; w.state = "ready";
    touch(room);                                                // the idle clock starts when the world is ready, not when its (possibly slow) build began
    console.log(`Room ${room.code} world ready (seed ${w.seed})`);
    broadcast(room);
  }, (e) => fail(e.message));
}
function syncPause(room) {
  const w = room.world;
  if (!w.worker || !w.started) return;
  const anyone = [...room.players.values()].some((p) => p.connected);
  if (w.paused === !anyone) return;
  w.paused = !anyone;
  w.worker.postMessage({ cmd: "pause", paused: w.paused });
}
function releaseClaim(room, player) {
  if (player.nation !== null && room.claims.get(player.nation) === player.id) {
    room.claims.delete(player.nation);
    if (room.world.started && room.world.worker) room.world.worker.postMessage({ cmd: "setHuman", nation: player.nation, human: false });   // AI takes the country back
  }
  player.nation = null;
}
function ctxOf(socket) {
  const room = rooms.get(socket.data.roomCode);
  const player = room && room.players.get(socket.data.playerId);
  if (player) touch(room);                                     // any request from a room member counts as activity (idle-world reaper)
  return player ? { room, player } : null;
}
async function claimNation(room, player, id) {
  const holderId = room.claims.get(id);
  if (holderId === player.id) return { success: true, nation: id, name: room.world.names[id] };
  if (holderId) {
    const h = room.players.get(holderId);
    return { success: false, message: `${room.world.names[id]} is already led by ${h ? h.name : "another player"}.` };
  }
  if (room.world.started) {
    if (player.nation !== null) return { success: false, message: `You already lead ${room.world.names[player.nation]}. You cannot switch after the game has started.` };
    room.claims.set(id, player.id);                      // reserve synchronously so a simultaneous claim loses
    player.nation = id;
    try {
      const r = await worldCall(room, "setHuman", { nation: id, human: true });
      if (!r.success) throw new Error("gone");
    } catch (e) {
      if (room.claims.get(id) === player.id) { room.claims.delete(id); player.nation = null; }
      return { success: false, message: `${room.world.names[id]} is no longer available.` };
    }
    broadcast(room);
    return { success: true, nation: id, name: room.world.names[id] };
  }
  releaseClaim(room, player);           // before the game starts, switching countries frees the old one
  room.claims.set(id, player.id);
  player.nation = id;
  broadcast(room);
  return { success: true, nation: id, name: room.world.names[id] };
}

function removePlayer(room, player) {
  clearTimeout(player.timer);
  releaseClaim(room, player);
  room.players.delete(player.id);
  if (room.players.size === 0) {
    disposeWorld(room);
    rooms.delete(room.code);
    console.log(`Room ${room.code} deleted`);
    return;
  }
  ensureHost(room);
  broadcast(room);
  syncPause(room);
}

function attach(socket, room, player) {
  clearTimeout(player.timer);
  player.socketId = socket.id;
  player.connected = true;
  touch(room);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  syncPause(room);
}

function detach(socket) {
  const code = socket.data.roomCode;
  const pid = socket.data.playerId;
  delete socket.data.roomCode;
  delete socket.data.playerId;
  if (!code) return;
  socket.leave(code);
  const room = rooms.get(code);
  const player = room && room.players.get(pid);
  if (player && player.socketId === socket.id) removePlayer(room, player);
}

function joinOk(room, player) {
  return { success: true, room: publicRoom(room), you: { id: player.id, token: player.token } };
}

function addPlayer(socket, room, name) {
  const player = {
    id: String(room.nextId++), token: crypto.randomBytes(12).toString("hex"),
    name: cleanName(name, room), socketId: null, connected: false, timer: null, nation: null, rids: new Set(), tokens: ACTION_BURST, tokenAt: Date.now()
  };
  room.players.set(player.id, player);
  attach(socket, room, player);
  return player;
}

// Accept (callback) or (payload, callback)
function args(a, b) {
  return typeof a === "function" ? [{}, a] : [a && typeof a === "object" ? a : {}, b];
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("create-room", (a, b) => {
    const [data, cb] = args(a, b);
    if (rooms.size >= MAX_ROOMS) return safeCallback(cb, { success: false, message: "Server is busy. Try again in a few minutes." });
    detach(socket);
    let code;
    do { code = makeRoomCode(); } while (rooms.has(code));
    const room = { code, hostId: null, nextId: 1, players: new Map(), claims: new Map(), world: newWorld() };
    rooms.set(code, room);
    const player = addPlayer(socket, room, data.name);
    room.hostId = player.id;
    safeCallback(cb, joinOk(room, player));
    broadcast(room);
    console.log(`Room ${code} created`);
  });

  socket.on("join-room", (a, b) => {
    const [data, cb] = args(a, b);
    const code = String(data.code || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) return safeCallback(cb, { success: false, message: "Enter a valid 5-character room code." });
    const room = rooms.get(code);
    if (!room) return safeCallback(cb, { success: false, message: "Room not found. Check the code and try again." });
    if (socket.data.roomCode === code) {
      const me = room.players.get(socket.data.playerId);
      if (me) return safeCallback(cb, joinOk(room, me));
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return safeCallback(cb, { success: false, message: `This room is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM}).` });
    detach(socket);
    const player = addPlayer(socket, room, data.name);
    safeCallback(cb, joinOk(room, player));
    broadcast(room);
    console.log(`Player joined room ${code}`);
  });

  socket.on("rejoin-room", (a, b) => {
    const [data, cb] = args(a, b);
    const room = rooms.get(String(data.code || "").trim().toUpperCase());
    const player = room && [...room.players.values()].find((p) => p.token === data.token);
    if (!room || !player) return safeCallback(cb, { success: false, message: "Your seat has expired or the room no longer exists." });
    const old = player.socketId && io.sockets.sockets.get(player.socketId);
    if (old && old.id !== socket.id) {          // same player opened a second tab
      old.leave(room.code);
      delete old.data.roomCode; delete old.data.playerId;
      old.emit("kicked", "You joined this room from another tab.");
    }
    if (socket.data.roomCode && socket.data.roomCode !== room.code) detach(socket);
    attach(socket, room, player);
    ensureHost(room);
    safeCallback(cb, joinOk(room, player));
    broadcast(room);
    console.log(`Player rejoined room ${room.code}`);
  });

  socket.on("create-world", (a, b) => {
    const [, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    if (c.room.hostId !== c.player.id) return safeCallback(cb, { success: false, message: "Only the host can create the world." });
    if (c.room.world.state === "building" || c.room.world.state === "ready") return safeCallback(cb, { success: false, message: "The world already exists." });
    if (worldsInUse() >= MAX_WORLDS) return safeCallback(cb, { success: false, message: `The server is running its maximum of ${MAX_WORLDS} active games. Try again later.` });
    touch(c.room);
    startWorld(c.room);
    safeCallback(cb, { success: true });
    broadcast(c.room);
  });

  // After a game ends the host can reuse the room: the old world is discarded, claims are cleared, a fresh world is generated.
  socket.on("new-world", (a, b) => {
    const [, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    const { room } = c;
    if (room.hostId !== c.player.id) return safeCallback(cb, { success: false, message: "Only the host can start a new game." });
    if (!room.world.over) return safeCallback(cb, { success: false, message: "The current game is not over." });
    disposeWorld(room);
    const rev = room.world.rev;
    room.world = newWorld(); room.world.rev = rev;
    room.claims.clear();
    for (const p of room.players.values()) { p.nation = null; p.rids.clear(); }
    startWorld(room);
    safeCallback(cb, { success: true });
    broadcast(room);
  });

  socket.on("world-get", async (a, b) => {
    const [, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    if (c.room.world.state !== "ready") return safeCallback(cb, { success: false, message: "The world is not ready yet." });
    try {
      const m = await worldCall(c.room, "snapshot");   // always the room's current state
      safeCallback(cb, { success: true, rev: c.room.world.rev, seed: m.seed, seq: m.seq, started: m.started, snapshot: m.snapshot });
    } catch (e) {
      safeCallback(cb, { success: false, message: "Could not read the world. Try again." });
    }
  });

  socket.on("claim-nation", async (a, b) => {
    const [data, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    if (c.room.world.state !== "ready") return safeCallback(cb, { success: false, message: "The world has not been created yet." });
    const id = Number(data.nation);
    if (!Number.isInteger(id) || !c.room.world.ids.has(id)) return safeCallback(cb, { success: false, message: "That country cannot be led. Pick a coloured country." });
    safeCallback(cb, await claimNation(c.room, c.player, id));
  });

  socket.on("claim-random", async (a, b) => {
    const [, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    if (c.room.world.state !== "ready") return safeCallback(cb, { success: false, message: "The world has not been created yet." });
    const free = [...c.room.world.ids].filter((id) => !c.room.claims.has(id));
    if (!free.length) return safeCallback(cb, { success: false, message: "No free countries left." });
    safeCallback(cb, await claimNation(c.room, c.player, free[Math.floor(Math.random() * free.length)]));
  });

  socket.on("start-game", async (a, b) => {
    const [, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    const w = c.room.world;
    if (c.room.hostId !== c.player.id) return safeCallback(cb, { success: false, message: "Only the host can start the game." });
    if (w.state !== "ready") return safeCallback(cb, { success: false, message: "Create the world first." });
    if (w.started || w.starting) return safeCallback(cb, { success: false, message: "The game has already started." });
    if (!c.room.claims.size) return safeCallback(cb, { success: false, message: "At least one player must pick a country first." });
    if ([...rooms.values()].filter((r) => r.world.started && !r.world.over).length >= MAX_RUNNING_GAMES) return safeCallback(cb, { success: false, message: `The server is already running its maximum of ${MAX_RUNNING_GAMES} games. Try again later.` });
    w.starting = true;
    try {
      await worldCall(c.room, "start", { ids: [...c.room.claims.keys()] });
      w.started = true; w.paused = false;
      console.log(`Room ${c.room.code} game started with ${c.room.claims.size} players`);
      syncPause(c.room);
      broadcast(c.room);
      safeCallback(cb, { success: true });
    } catch (e) {
      safeCallback(cb, { success: false, message: "Could not start the game. Try again." });
    } finally { w.starting = false; }
  });

  // Gameplay actions. The nation is derived from the server-side claim, never from the client payload.
  socket.on("game-action", async (a, b) => {
    const [data, cb] = args(a, b);
    const c = ctxOf(socket);
    if (!c) return safeCallback(cb, { success: false, message: "Join a room first." });
    const { room, player } = c;
    if (!room.world.started) return safeCallback(cb, { success: false, message: "The game has not started yet." });
    if (player.nation === null) return safeCallback(cb, { success: false, message: "Pick a country first." });
    const rid = typeof data.rid === "string" && data.rid.length <= 40 ? data.rid : null;
    if (rid) {
      if (player.rids.has(rid)) { metrics.duplicates++; return safeCallback(cb, { success: false, duplicate: true, message: "Duplicate request ignored." }); }
      player.rids.add(rid);
      if (player.rids.size > 200) player.rids.delete(player.rids.values().next().value);
    }
    const t = Date.now();
    player.tokens = Math.min(ACTION_BURST, player.tokens + ((t - player.tokenAt) / 1000) * ACTION_PER_SEC);
    player.tokenAt = t;
    if (player.tokens < 1) {
      metrics.rateLimited++;
      if (t - (player.warnAt || 0) > 10000) { player.warnAt = t; console.warn(`Rate limit hit: room ${room.code} player ${player.id}`); }
      return safeCallback(cb, { success: false, message: "Too many actions. Slow down." });
    }
    metrics.actions++;
    player.tokens -= 1;
    touch(room);
    try {
      const r = await worldCall(room, "action", { nation: player.nation, action: data.action });
      if (!r.success) metrics.rejected++;
      safeCallback(cb, { success: !!r.success, message: r.message, code: r.code, target: r.target });
    } catch (e) {
      metrics.errors++; console.error(`Action failed in room ${room.code}:`, e && e.message ? e.message : e);
      safeCallback(cb, { success: false, message: "The server could not process that action." });
    }
  });

  if (process.env.SKYFRONT_TEST === "1") {                      // test-only hooks (never enabled in production): wipe a nation's land / crash a world worker
    socket.on("test-crash", (a, b) => {
      const [, cb] = args(a, b);
      const c = ctxOf(socket);
      if (c && c.room.world.worker) c.room.world.worker.postMessage({ cmd: "testCrash" });
      safeCallback(cb, { success: !!c });
    });
    socket.on("test-wipe", async (a, b) => {
      const [data, cb] = args(a, b);
      const c = ctxOf(socket);
      if (!c) return safeCallback(cb, { success: false });
      await worldCall(c.room, "testWipe", { nation: data.nation });
      safeCallback(cb, { success: true });
    });
  }

  socket.on("leave-room", (a, b) => {
    const [, cb] = args(a, b);
    detach(socket);
    safeCallback(cb, { success: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && room.players.get(socket.data.playerId);
    if (player && player.socketId === socket.id) {
      player.connected = false;
      ensureHost(room);
      broadcast(room);
      syncPause(room);
      player.timer = setTimeout(() => removePlayer(room, player), GRACE_MS);
    }
    console.log("Player disconnected:", socket.id);
  });
});

// Free memory held by worlds nobody is using: unstarted or finished worlds idle for WORLD_IDLE_MS. Running games are never reaped here
// (a room with no connected player is paused, and its seats expire after GRACE_MS).
setInterval(() => {
  const t = Date.now();
  for (const room of rooms.values()) {
    const w = room.world;
    if (!w.worker || w.state === "building" || (w.started && !w.over) || t - (room.lastActive || 0) < WORLD_IDLE_MS) continue;
    console.log(`Room ${room.code}: discarding idle ${w.over ? "finished" : "unstarted"} world`);
    disposeWorld(room);
    const rev = w.rev;
    room.world = newWorld(); room.world.rev = rev + 1;
    room.claims.clear();
    for (const p of room.players.values()) { p.nation = null; p.rids.clear(); }
    broadcast(room);
  }
}, REAPER_MS).unref();

// Optional measurement log (off by default): STATS_LOG_MS=30000 prints one line per interval with process memory and per-world worker stats.
const STATS_LOG_MS = Number(process.env.STATS_LOG_MS) || 0;
if (STATS_LOG_MS > 0) {
  setInterval(async () => {
    const out = [];
    for (const r of rooms.values()) {
      if (!r.world.worker) continue;
      try { out.push({ room: r.code, players: r.players.size, started: r.world.started, over: r.world.over, ...(await worldCall(r, "stats")), id: undefined, ok: undefined }); } catch (e) { /* world is going away */ }
    }
    const mu = process.memoryUsage();
    console.log("[stats] " + JSON.stringify({ metrics, rooms: rooms.size, rssMB: Math.round(mu.rss / 1e6), heapMB: Math.round(mu.heapUsed / 1e6), worlds: out }));
  }, STATS_LOG_MS).unref();
}

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Skyfront server listening on port ${PORT}`);
});

// Render sends SIGTERM on redeploy/restart: stop the worker threads and close connections instead of being killed mid-write.
function shutdown(sig) {
  console.log(`${sig} received: shutting down (rooms in memory are lost)`);
  for (const room of rooms.values()) disposeWorld(room);
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e && e.message ? e.message : e));
