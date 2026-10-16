
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
app.get("/", (req, res) => {
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

const rooms = new Map();
const MAX_PLAYERS_PER_ROOM = 8;

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function safeCallback(callback, payload) {
  if (typeof callback === "function") {
    callback(payload);
  }
}

function removePlayerFromRoom(socket, code) {
  const room = rooms.get(code);
  if (!room) return;

  room.players.delete(socket.id);
  io.to(code).emit("player-count", room.players.size);

  if (room.players.size === 0) {
    rooms.delete(code);
    console.log(`Room ${code} deleted`);
  }
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("create-room", (callback) => {
    // Avoid leaving an old room behind if this socket creates another.
    const previousCode = socket.data.roomCode;
    if (previousCode) {
      removePlayerFromRoom(socket, previousCode);
      socket.leave(previousCode);
      delete socket.data.roomCode;
    }

    let code;
    do {
      code = makeRoomCode();
    } while (rooms.has(code));

    rooms.set(code, { players: new Set([socket.id]) });
    socket.join(code);
    socket.data.roomCode = code;

    safeCallback(callback, {
      success: true,
      roomCode: code,
      playerCount: 1
    });

    io.to(code).emit("player-count", 1);
    console.log(`Room ${code} created`);
  });

  socket.on("join-room", (rawCode, callback) => {
    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return safeCallback(callback, {
        success: false,
        message: "Room not found."
      });
    }

    const previousCode = socket.data.roomCode;

    if (previousCode === code) {
      return safeCallback(callback, {
        success: true,
        roomCode: code,
        playerCount: room.players.size
      });
    }

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      return safeCallback(callback, {
        success: false,
        message: "This room is full."
      });
    }

    if (previousCode) {
      removePlayerFromRoom(socket, previousCode);
      socket.leave(previousCode);
      delete socket.data.roomCode;
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

    if (!code) {
      return safeCallback(callback, { success: true });
    }

    removePlayerFromRoom(socket, code);
    socket.leave(code);
    delete socket.data.roomCode;

    safeCallback(callback, { success: true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;

    if (code) {
      removePlayerFromRoom(socket, code);
    }

    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Skyfront server listening on port ${PORT}`);
});
