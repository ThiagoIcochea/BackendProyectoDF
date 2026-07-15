const express = require("express");
const router = express.Router();
const ChatMessage = require("../models/ChatMessage");
const ChatRoom = require("../models/ChatRoom");
const verifyToken = require("../middlewares/verifyToken");

// Middleware que aplica verifyToken solo para salas de soporte
const verifySupportRoomToken = async (req, res, next) => {
  if (req.params.roomKey && req.params.roomKey.startsWith("support")) {
    return verifyToken(req, res, next);
  }
  next();
};

router.get("/rooms", async (req, res) => {
  try {
    const rooms = await ChatRoom.find().sort({ key: 1 });
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener las salas de chat" });
  }
});

router.get("/rooms/:roomKey/messages", verifySupportRoomToken, async (req, res) => {
  try {
    let { roomKey } = req.params;

    if (roomKey.startsWith("support")) {
      const expectedRoomKey = `support_${req.user.id}`;
      if (roomKey === "support") {
        roomKey = expectedRoomKey;
      }
      if (roomKey !== expectedRoomKey) {
        return res.status(403).json({ message: "No autorizado a ver este chat de soporte." });
      }
    }

    const limit = Math.min(Number(req.query.limit) || 100, 200);

    const messages = await ChatMessage.find({ roomKey })
      .sort({ createdAt: 1 })
      .limit(limit);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener los mensajes del chat" });
  }
});

module.exports = router;

