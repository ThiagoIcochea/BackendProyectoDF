const ChatMessage = require("../models/ChatMessage");
const ChatRoom = require("../models/ChatRoom");
const User = require("../models/User");
const { buildSupportBotReply, createSupportSession, moderateCommunityMessage, checkTextSafety } = require("./supportBot");
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

  const { type, roomKey, text, username, userId, profileImg } = message;

  if (type === "join") {
    socket.roomKey = roomKey || socket.roomKey;
    socket.username = username || socket.username || "Usuario";
    socket.userId = userId || socket.userId || socket.id;
    socket.profileImg = profileImg || socket.profileImg || "";

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

    targetUser.chatReportCount = (targetUser.chatReportCount || 0) + 1;
    if (targetUser.chatReportCount >= 10) {
      targetUser.chatBlockedUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      targetUser.chatBlockReason = message.reasonType || "reporte";
    }
    await targetUser.save();

    await recordLog({
      usuario: socket.username || "Anónimo",
      descripcion: `Reportó al usuario ${targetUser.email || targetUser.name || message.targetUsername} por: ${message.reason || "sin motivo"}`,
      tipo: "SISTEMA",
      metodo: "WS",
      ruta: "/chat/report"
    });

    socket.send(JSON.stringify({
      type: "report-received",
      message: targetUser.chatReportCount >= 10
        ? "El usuario ha sido bloqueado por superar el límite de reportes."
        : `Reporte recibido. Total actual: ${targetUser.chatReportCount}`
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
      userId: userId || socket.userId || null,
      username: username || socket.username || "Usuario",
      text: normalizedText,
      profileImg: profileImg || socket.profileImg || "",
      role: "user",
      meta: messageMeta
    });
    broadcastToRoom(roomKey, { type: "room-message", message: savedMessage });

    if (roomKey.startsWith("support")) {
      const session = socket.supportSession || createSupportSession(socket.username || "cliente");
      session.userId = userId || socket.userId || session.userId || null;
      socket.supportSession = session;
      
      const replyText = await buildSupportBotReply(normalizedText, session);
      const botMeta = session.lastBotMeta || null;
      session.lastBotMeta = null;
      const assistantMessage = await persistMessage({
        roomKey,
        username: "NendoBot",
        text: replyText,
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
