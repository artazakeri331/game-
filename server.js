
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

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
const GRACE_MS = Number(process.env.GRACE_MS) || 60 * 1000;        // seat is held this long after a disconnect
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
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId
    }))
  };
}

function broadcast(room) {
  io.to(room.code).emit("room-update", publicRoom(room));
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = [...room.players.values()].find((p) => p.connected) || [...room.players.values()][0];
  if (next) room.hostId = next.id;
}

function removePlayer(room, player) {
  clearTimeout(player.timer);
  room.players.delete(player.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    console.log(`Room ${room.code} deleted`);
    return;
  }
  ensureHost(room);
  broadcast(room);
}

function attach(socket, room, player) {
  clearTimeout(player.timer);
  player.socketId = socket.id;
  player.connected = true;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
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
    name: cleanName(name, room), socketId: null, connected: false, timer: null
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
    const room = { code, hostId: null, nextId: 1, players: new Map() };
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

  socket.on("leave-room", (a) => {
    detach(socket);
    safeCallback(typeof a === "function" ? a : undefined, { success: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && room.players.get(socket.data.playerId);
    if (player && player.socketId === socket.id) {
      player.connected = false;
      ensureHost(room);
      broadcast(room);
      player.timer = setTimeout(() => removePlayer(room, player), GRACE_MS);
    }
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Skyfront server listening on port ${PORT}`);
});
