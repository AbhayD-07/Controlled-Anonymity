const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

// 1. DEPLOYMENT CONFIG: Use dynamic port
const PORT = process.env.PORT || 3001;

const io = new Server(server, {
  cors: {
    // 2. SECURITY: Allow connection from anywhere (for easiest deployment)
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// --- STATE ---
let waitingQueue = [];
const userUsage = {}; // The Ledger: { "dev_123": { count: 2, date: "2/3/2026" } }
const DAILY_LIMIT = 10;

// --- HELPER: Cleanly leave a room ---
function leaveRoom(socket) {
  // find the room ID (it starts with 'room_')
  const roomID = Array.from(socket.rooms).find((r) => r.startsWith("room_"));

  if (roomID) {
    // Notify the partner
    socket.to(roomID).emit("receive_message", {
      sender: "System",
      message: "The stranger has left the chat. 🚪",
    });
    socket.to(roomID).emit("partner_left"); // Tell frontend partner is gone

    // Leave the room
    socket.leave(roomID);
  }
}

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 1. User joins the Queue
  socket.on("join_queue", (userData) => {
    const { nickname, gender, genderFilter, deviceId } = userData;

    // Check if they are already in a room and remove them first (Next Match Logic)
    leaveRoom(socket);

    // --- FAIRNESS CHECK 🛑 ---
    if (genderFilter !== "Any") {
      const today = new Date().toLocaleDateString();
      // Initialize if new user or new day
      if (!userUsage[deviceId] || userUsage[deviceId].date !== today) {
        userUsage[deviceId] = { count: 0, date: today };
      }
      // Check Limit
      if (userUsage[deviceId].count >= DAILY_LIMIT) {
        socket.emit("receive_message", {
          sender: "System",
          message:
            "🚫 Daily Limit Reached! You can only use specific gender filters 10 times per day. Try 'Random Match'.",
        });
        return; // Stop here.
      }
      // Increment Count
      userUsage[deviceId].count++;
      console.log(
        `Device ${deviceId} usage: ${userUsage[deviceId].count}/${DAILY_LIMIT}`,
      );
    }
    // ---------------------------

    console.log(`${nickname} (${gender}) joined. Looking for: ${genderFilter}`);

    // LOGIC: Find a match
    const matchIndex = waitingQueue.findIndex((user) => {
      const isNotMe = user.id !== socket.id;
      const matchesMyFilter =
        genderFilter === "Any" || user.gender === genderFilter;
      const matchesTheirFilter =
        user.genderFilter === "Any" || user.genderFilter === gender;
      return isNotMe && matchesMyFilter && matchesTheirFilter;
    });

    if (matchIndex !== -1) {
      // MATCH FOUND! 🎉
      const partnerSocket = waitingQueue[matchIndex].socket;
      waitingQueue.splice(matchIndex, 1); // Remove partner from queue

      const roomID = `room_${socket.id}_${partnerSocket.id}`;

      socket.join(roomID);
      partnerSocket.join(roomID);

      io.to(roomID).emit("match_found", { roomID });
      console.log(`Match Created: ${roomID}`);
    } else {
      // NO MATCH. Add to queue.
      waitingQueue.push({
        id: socket.id,
        socket: socket,
        nickname,
        gender,
        genderFilter,
      });
    }
  });

  // 2. Report User
  socket.on("report_user", () => {
    console.log(`User ${socket.id} reported their partner.`);
    leaveRoom(socket); // Immediately disconnect
  });

  // 3. Relay Messages
  socket.on("send_message", (data) => {
    const { roomID, message, sender } = data;
    socket.to(roomID).emit("receive_message", { message, sender });
  });

  // 4. Disconnect
  socket.on("disconnect", () => {
    console.log("User Disconnected", socket.id);
    leaveRoom(socket);
    waitingQueue = waitingQueue.filter((u) => u.id !== socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`SERVER RUNNING on port ${PORT}`);
});
