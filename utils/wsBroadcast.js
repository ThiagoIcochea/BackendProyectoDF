const ChatMessage = require("../models/ChatMessage");
const ChatRoom = require("../models/ChatRoom");
const User = require("../models/User");
const ChatReport = require("../models/ChatReport");
const { buildSupportBotReply, createSupportSession, moderateCommunityMessage, checkTextSafety, analyzeReportWithGroq } = require("./supportBot");
const { recordLog } = require("../utils/logger");

let wss = null;
const roomUsers = new Map();

const setWss = (instance) => {
  wss = instance;
};

const getRoomMembers = (roomKey) => {
  if (!roomKey) return [];
  const existing = roomUsers.get(roomKey) || [];
  return existing.filter(Boolean);
};

const broadcastToRoom = (roomKey, payload, excludeSocket = null) => {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client.roomKey === roomKey && client !== excludeSocket) {
      client.send(JSON.stringify(payload));
    }
  });
};

const broadcastRoomUsers = (roomKey) => {
  const users = getRoomMembers(roomKey).map((user) => ({
    id: user.id,
    username: user.username,
    profileImg: user.profileImg || "",
    online: true
  }));
  broadcastToRoom(roomKey, { type: "room-users", users });
};

const addUserToRoom = (socket, roomKey) => {
  if (!roomKey) return;
  const current = getRoomMembers(roomKey);
  const next = current.filter((user) => user.id !== socket.userId);
  next.push({
    id: socket.userId || socket.id,
    username: socket.username || "Usuario",
    profileImg: socket.profileImg || ""
  });
  roomUsers.set(roomKey, next);
  broadcastRoomUsers(roomKey);
};

const removeUserFromRoom = (socket) => {
  if (!socket?.roomKey) return;
  const current = getRoomMembers(socket.roomKey);
  const next = current.filter((user) => user.id !== (socket.userId || socket.id));
  if (next.length) {
    roomUsers.set(socket.roomKey, next);
  } else {
    roomUsers.delete(socket.roomKey);
  }
  broadcastRoomUsers(socket.roomKey);
};

const ensureChatRoom = async (roomKey, fallbackName = "Chat") => {
  if (!roomKey) return null;
  let room = await ChatRoom.findOne({ key: roomKey });
  if (!room) {
    room = await ChatRoom.create({
      key: roomKey,
      name: fallbackName,
      description: "Sala de chat persistida",
      type: roomKey.startsWith("support") ? "support" : "community"
    });
  }
  return room;
};

const persistMessage = async ({ roomKey, userId, username, text, profileImg, role = "user", meta = {} }) => {
  await ensureChatRoom(roomKey, roomKey?.startsWith("support") ? "Soporte" : "Comunidad");
  const message = await ChatMessage.create({
    roomKey,
    userId,
    username,
    text,
    profileImg,
    role,
    meta
  });
  return message.toObject();
};

const handleClientMessage = async (socket, message) => {
  if (!message || typeof message !== "object") return;
  if (!socket?.authenticated) {
    socket?.send(JSON.stringify({ type: "error", message: "Debes iniciar sesión para usar el chat." }));
    return;
  }

  const { type, roomKey, text, username, userId, profileImg } = message;

  if (type === "join") {
    socket.roomKey = roomKey || socket.roomKey;
    socket.username = socket.username || username || "Usuario";
    socket.userId = socket.userId || userId || socket.id;
    socket.profileImg = socket.profileImg || profileImg || "";

    if (socket.roomKey) {
      addUserToRoom(socket, socket.roomKey);
      socket.send(JSON.stringify({ type: "joined", roomKey: socket.roomKey }));
    }
    return;
  }

  if (type === "typing" && socket.roomKey) {
    broadcastToRoom(socket.roomKey, { type: "typing", username: socket.username || "Usuario" }, socket);
    return;
  }

  if (type === "report-user") {
    const targetUser = await User.findById(message.targetUserId);
    if (!targetUser) {
      socket.send(JSON.stringify({ type: "error", message: "Usuario no encontrado" }));
      return;
    }

    // Calcular el inicio del día actual (00:00:00) para control de duplicados e historial
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const mongoose = require("mongoose");
    const reporterId = mongoose.Types.ObjectId.isValid(socket.userId) ? socket.userId : null;

    if (reporterId) {
      // Verificar si el reportero actual ya reportó al mismo usuario el día de hoy
      const existingReport = await ChatReport.findOne({
        reporterId,
        reportedUserId: targetUser._id,
        createdAt: { $gte: startOfDay }
      });

      if (existingReport) {
        socket.send(JSON.stringify({ type: "error", message: "Ya has reportado a este usuario el día de hoy." }));
        return;
      }
    }

    // Obtener todos los mensajes de chat enviados por el usuario reportado el día de hoy
    const userMessages = await ChatMessage.find({
      userId: targetUser._id,
      createdAt: { $gte: startOfDay }
    }).sort({ createdAt: 1 });

    // Analizar el historial de mensajes con el prompt especializado en Groq
    const analysis = await analyzeReportWithGroq(message.reason || "Sin motivo", userMessages);

    // Crear y persistir el reporte si el reportero es un ID de usuario válido
    if (reporterId) {
      await ChatReport.create({
        reporterId,
        reportedUserId: targetUser._id,
        reason: message.reason || "Sin motivo",
        messagesEvaluated: userMessages.map((m) => ({ text: m.text, createdAt: m.createdAt })),
        groqAnalysis: {
          allowed: analysis.allowed,
          block: analysis.block,
          category: analysis.category,
          reason: analysis.reason
        }
      });
    }

    // Incrementar el contador de reportes y aplicar el bloqueo automático si supera el límite de 10
    targetUser.chatReportCount = (targetUser.chatReportCount || 0) + 1;
    if (targetUser.chatReportCount >= 10) {
      targetUser.chatBlockedUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      targetUser.chatBlockReason = message.reason || "reporte";
    }
    await targetUser.save();

    await recordLog({
      usuario: socket.username || "Anónimo",
      descripcion: `Reportó al usuario ${targetUser.email || targetUser.name || message.targetUsername} por: ${message.reason || "sin motivo"}. Análisis IA: Categoría: ${analysis.category}, Bloqueo sugerido: ${analysis.block}. Total de reportes: ${targetUser.chatReportCount}`,
      tipo: "SISTEMA",
      metodo: "WS",
      ruta: "/chat/report"
    });

    socket.send(JSON.stringify({
      type: "report-received",
      message: targetUser.chatReportCount >= 10
        ? "El usuario ha sido bloqueado por superar el límite de reportes."
        : "Reporte enviado. El comportamiento del usuario en el chat será analizado por nuestro sistema inteligente."
    }));
    return;
  }

  if (type === "message" && roomKey) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return;

    let messageMeta = {};

    if (roomKey === "community") {
      const moderation = await moderateCommunityMessage(normalizedText);

      if (!moderation.allowed) {
        socket.send(JSON.stringify({
          type: "error",
          message: moderation.reason || "Mensaje no permitido."
        }));
        return;
      }

      messageMeta = {
        moderation
      };
    }

    const savedMessage = await persistMessage({
      roomKey,
      userId: socket.userId || userId || null,
      username: socket.username || username || "Usuario",
      text: normalizedText,
      profileImg: socket.profileImg || profileImg || "",
      role: "user",
      meta: messageMeta
    });
    broadcastToRoom(roomKey, { type: "room-message", message: savedMessage });

    if (roomKey.startsWith("support")) {
      const session = socket.supportSession || createSupportSession(socket.username || "cliente");
      session.userId = socket.userId || userId || session.userId || null;
      if (Array.isArray(message.cartItems)) {
        session.cartItems = message.cartItems.map((item) => ({
          id: item.id || item._id || item.name,
          name: item.name || "Producto",
          price: Number(item.price || 0),
          quantity: Number(item.quantity || 1),
          image: item.image || ""
        }));
      }
      socket.supportSession = session;

      const replyText = await buildSupportBotReply(normalizedText, session);
      const botMeta = session.lastBotMeta || null;
      session.lastBotMeta = null;
      const assistantMessage = await persistMessage({
        roomKey,
        username: "NendoBot",
        text: String(replyText || "").trim() || "Gracias por tu mensaje. Estoy aquí para ayudarte.",
        profileImg: "",
        role: "assistant",
        meta: botMeta ? { action: botMeta } : {}
      });
      broadcastToRoom(roomKey, { type: "room-message", message: assistantMessage });
    }
  }
};

const handleClientDisconnect = (socket) => {
  removeUserFromRoom(socket);
};

const broadcastPurchaseAlert = (payload) => {
  if (!wss) return;
  wss.clients.forEach((client) => {
    client.send(JSON.stringify({ type: "purchase-alert", payload }));
  });
};

const broadcastCommentUpdate = (productId, comments) => {
  if (!wss) return;
  wss.clients.forEach((client) => {
    client.send(JSON.stringify({ type: "comment-update", productId, comments }));
  });
};

module.exports = {
  setWss,
  handleClientMessage,
  handleClientDisconnect,
  broadcastPurchaseAlert,
  broadcastCommentUpdate,
  moderateCommunityMessage,
  checkTextSafety
};
