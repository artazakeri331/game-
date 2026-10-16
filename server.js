const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));

const rooms = new Map();
const MAX_PLAYERS_PER_ROOM = 8;

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function safeCallback(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("create-room", (callback) => {
    let code;
    do {
      code = makeRoomCode();
    } while (rooms.has(code));

    rooms.set(code, { players: new Set([socket.id]) });
    socket.join(code);
    socket.data.roomCode = code;

    safeCallback(callback, { success: true, roomCode: code, playerCount: 1 });
    io.to(code).emit("player-count", 1);
    console.log(`Room ${code} created`);
  });

  socket.on("join-room", (rawCode, callback) => {
    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return safeCallback(callback, { success: false, message: "Room not found." });
    }

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      return safeCallback(callback, { success: false, message: "This room is full." });
    }

    // Remove this socket from any room it previously joined.
    const previousCode = socket.data.roomCode;
    if (previousCode && previousCode !== code) {
      const previousRoom = rooms.get(previousCode);
      if (previousRoom) {
        previousRoom.players.delete(socket.id);
        io.to(previousCode).emit("player-count", previousRoom.players.size);
        if (previousRoom.players.size === 0) rooms.delete(previousCode);
      }
      socket.leave(previousCode);
    }

    room.players.add(socket.id);
    socket.join(code);
    socket.data.roomCode = code;

    safeCallback(callback, {
      success: true,
      roomCode: code,
      playerCount: room.players.size
    });
    io.to(code).emit("player-count", room.players.size);
    console.log(`Player joined room ${code}`);
  });

  socket.on("leave-room", (callback) => {
    const code = socket.data.roomCode;
    if (!code) return safeCallback(callback, { success: true });

    const room = rooms.get(code);
    if (room) {
      room.players.delete(socket.id);
      io.to(code).emit("player-count", room.players.size);
      if (room.players.size === 0) rooms.delete(code);
    }

    socket.leave(code);
    delete socket.data.roomCode;
    safeCallback(callback, { success: true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);
    io.to(code).emit("player-count", room.players.size);
    if (room.players.size === 0) {
      rooms.delete(code);
      console.log(`Room ${code} deleted`);
    }
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Skyfront server running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop the server.");
});
