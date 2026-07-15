const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const router = express.Router();

const verifyToken = require("../middlewares/verifyToken");
const { createSupportSession, getSupportBotReply, normalizeCustomerName } = require("../utils/supportBot");
const ChatMessage = require("../models/ChatMessage");
const ChatRoom = require("../models/ChatRoom");
const { normalizeSpanishText } = require("../utils/textEncoding");

const sessions = new Map();

const resolveChatbotSessionKey = (sessionId, reqUser = {}) => {
  const incoming = String(sessionId || "").trim();
  if (incoming) return incoming;

  const userId = reqUser?.id || reqUser?._id;
  if (userId) return `user:${String(userId)}`;

  return `anon:${crypto.randomUUID()}`;
};

const resolveSupportRoomKey = (sessionId, reqUser = {}) => {
  const userId = reqUser?.id || reqUser?._id;
  if (userId) return `support_${String(userId)}`;

  const incoming = String(sessionId || "").trim();
  return incoming ? `support_${incoming}` : `support_${crypto.randomUUID()}`;
};

const ensureSupportRoom = async (roomKey, customerName = "cliente") => {
  let room = await ChatRoom.findOne({ key: roomKey });
  if (!room) {
    room = await ChatRoom.create({
      key: roomKey,
      name: `Soporte - ${String(customerName || "cliente").trim() || "cliente"}`,
      description: "Conversación de soporte con el asistente",
      type: "support"
    });
  }
  return room;
};

const hydrateSessionFromDb = async (session, roomKey) => {
  if (!session || !roomKey || session.history?.length) return;

  const persistedMessages = await ChatMessage.find({ roomKey })
    .sort({ createdAt: 1 })
    .limit(12)
    .lean();

  if (!persistedMessages.length) return;

  session.history = persistedMessages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
    text: message.text
  }));
};

const persistSupportBotMessage = async ({ roomKey, userId, username, text, role = "user", meta = {} }) => {
  if (!roomKey || !text) return null;

  const payload = {
    roomKey,
    username: normalizeSpanishText(String(username || "cliente").trim() || "cliente"),
    text: normalizeSpanishText(String(text || "").trim()),
    role,
    meta
  };

  if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    payload.userId = String(userId);
  }

  return ChatMessage.create(payload);
};

router.post("/message", verifyToken, async (req, res) => {
  try {
    const { sessionId, message, customerName } = req.body;
    const activeSessionKey = resolveChatbotSessionKey(sessionId, req.user || {});
    const roomKey = resolveSupportRoomKey(activeSessionKey, req.user || {});

    let session = sessions.get(activeSessionKey);
    if (!session) {
      session = createSupportSession(normalizeCustomerName(customerName || req.user?.name || "cliente"));
      sessions.set(activeSessionKey, session);
    }

    if (req.user?.id || req.user?._id) {
      session.userId = String(req.user.id || req.user._id);
    }

    await ensureSupportRoom(roomKey, session.customerName);
    await hydrateSessionFromDb(session, roomKey);

    const username = normalizeCustomerName(customerName || req.user?.name || session.customerName || "cliente");
    await persistSupportBotMessage({
      roomKey,
      userId: req.user?.id || req.user?._id,
      username,
      text: message,
      role: "user",
      meta: { sessionId: activeSessionKey }
    });

    const reply = normalizeSpanishText(await getSupportBotReply(message, session));

    await persistSupportBotMessage({
      roomKey,
      userId: req.user?.id || req.user?._id,
      username: "NendoBot",
      text: reply,
      role: "assistant",
      meta: { sessionId: activeSessionKey, step: session.step }
    });

    res.json({ reply, step: session.step, sessionId: activeSessionKey, roomKey });
  } catch (error) {
    console.error("Error en chatbot:", error);
    res.status(500).json({ message: "Error interno del asistente" });
  }
});

router.post("/reset", (req, res) => {
  const { sessionId } = req.body;
  const sessionKey = resolveChatbotSessionKey(sessionId, req.user || {});
  if (sessionKey) sessions.delete(sessionKey);
  res.json({ ok: true });
});

module.exports = {
  router,
  resolveChatbotSessionKey,
  resolveSupportRoomKey,
  ensureSupportRoom,
  hydrateSessionFromDb,
  persistSupportBotMessage
};
