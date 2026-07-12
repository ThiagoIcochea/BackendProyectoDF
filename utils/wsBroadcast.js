const ChatMessage = require("../models/ChatMessage");
const User = require("../models/User");
const { buildSupportBotReply, createSupportSession, moderateCommunityMessage, checkTextSafety } = require("./supportBot");
const { recordLog } = require("../utils/logger");
const { getGroqApiKey, callGroq, parseGroqJson } = require("../utils/groqClient");

let wss = null;
const roomUsers = new Map();
const reportCooldowns = new Map();

const setWss = (instance) => {
  wss = instance;
};

const getReporterIdentity = (socket, message) => {
  const reporterId = message?.reporterUserId || message?.userId || socket?.userId;
  return reporterId ? String(reporterId) : null;
};

const isDuplicateReport = (reporterId, targetUserId, messageId) => {
  const now = Date.now();
  const key = `${reporterId}:${targetUserId}:${messageId || "no-message"}`;
  const lastReportAt = reportCooldowns.get(key);

  if (lastReportAt && now - lastReportAt < 5 * 60 * 1000) {
    return true;
  }

  reportCooldowns.set(key, now);
  return false;
};

const REPORT_MODERATION_PROMPT = (reason, messageText) => `Eres un clasificador de reportes de chat público. Responde ÚNICAMENTE con un JSON válido con las llaves: allowed, block, category, reason.
- Si el reporte tiene un motivo claro, evidencia concreta y parece legítimo, califícalo como allowed=true, block=false.
- Si el reporte parece spam, vacío, sin evidencia, o un intento de abuso, califícalo como allowed=false, block=true.
- Usa únicamente las categorías "legitimo" o "inapropiado".
- El campo reason debe ser una explicación corta y directa.
Motivo: "${reason}"
Mensaje: "${messageText}"`;

const moderateReportWithGroq = async (reason, messageText) => {
  const apiKey = await getGroqApiKey();
  if (!apiKey) return null;

  const text = await callGroq({
    apiKey,
    input: REPORT_MODERATION_PROMPT(reason, messageText),
    temperature: 0,
    maxOutputTokens: 300,
    onFallback: () => JSON.stringify({
      allowed: true,
      block: false,
      category: "legitimo",
      reason: "Moderación fallida; tratado como legítimo"
    })
  });

  const parsed = parseGroqJson(text);
  if (!parsed) {
    throw new Error("Respuesta de moderación de reporte inválida");
  }

  return parsed;
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

const persistMessage = async ({ roomKey, userId, username, text, profileImg, role = "user", meta = {} }) => {
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
  const effectiveUserId = String(userId || socket.userId || "").trim();

  if (effectiveUserId) {
    const blockedUser = await User.findById(effectiveUserId);
    if (blockedUser?.chatBlockedUntil && new Date(blockedUser.chatBlockedUntil) > new Date()) {
      socket.send(JSON.stringify({ type: "error", message: "Tu cuenta está bloqueada por reportes acumulados." }));
      return;
    }
  }

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
    const reporterId = getReporterIdentity(socket, message);
    const targetUserId = message?.targetUserId;
    const normalizedReason = String(message?.reason || "").trim();
    const normalizedReasonType = String(message?.reasonType || normalizedReason || "reporte").trim();

    if (!reporterId) {
      socket.send(JSON.stringify({ type: "error", message: "No se pudo identificar al usuario que reporta." }));
      return;
    }

    if (!targetUserId) {
      socket.send(JSON.stringify({ type: "error", message: "Falta el usuario que se quiere reportar." }));
      return;
    }

    if (String(targetUserId) === String(reporterId)) {
      socket.send(JSON.stringify({ type: "error", message: "No puedes reportarte a ti mismo." }));
      return;
    }

    if (!normalizedReason) {
      socket.send(JSON.stringify({ type: "error", message: "Debes indicar un motivo para el reporte." }));
      return;
    }

    if (!message?.messageId) {
      socket.send(JSON.stringify({ type: "error", message: "El reporte debe incluir el mensaje que se está reportando." }));
      return;
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      socket.send(JSON.stringify({ type: "error", message: "Usuario no encontrado" }));
      return;
    }

    if (targetUser.role === "admin") {
      socket.send(JSON.stringify({ type: "error", message: "No se pueden reportar usuarios administrativos." }));
      return;
    }

    if (targetUser.chatBlockedUntil && new Date(targetUser.chatBlockedUntil) > new Date()) {
      socket.send(JSON.stringify({ type: "error", message: "Este usuario ya está bloqueado por reportes acumulados." }));
      return;
    }

    const reportedMessage = await ChatMessage.findById(message.messageId);
    if (!reportedMessage) {
      socket.send(JSON.stringify({ type: "error", message: "El mensaje reportado no existe." }));
      return;
    }

    if (!reportedMessage.userId || String(reportedMessage.userId) !== String(targetUser._id)) {
      socket.send(JSON.stringify({ type: "error", message: "El mensaje no pertenece al usuario reportado." }));
      return;
    }

    if (isDuplicateReport(reporterId, String(targetUserId), String(message.messageId))) {
      socket.send(JSON.stringify({ type: "error", message: "Este reporte ya fue enviado recientemente." }));
      return;
    }

    let moderation = {
      allowed: true,
      block: false,
      category: "legitimo",
      reason: "Aprobado por validación local"
    };

    try {
      const groqKey = await getGroqApiKey();
      if (groqKey) {
        moderation = await moderateReportWithGroq(normalizedReason, reportedMessage.text || "");
      } else {
        console.warn("[REPORTS] no hay clave de Groq, usando validación local");
      }
    } catch (error) {
      console.error("Report moderation error:", error);
      moderation = {
        allowed: true,
        block: false,
        category: "legitimo",
        reason: "Moderación fallida; tratado como legítimo"
      };
    }

    if (!moderation.allowed || moderation.block) {
      socket.send(JSON.stringify({
        type: "error",
        message: moderation.reason || "Reporte no válido"
      }));
      return;
    }

    targetUser.chatReportCount = (targetUser.chatReportCount || 0) + 1;
    if (targetUser.chatReportCount >= 10) {
      targetUser.chatBlockedUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      targetUser.chatBlockReason = normalizedReasonType || "reporte";
    }
    await targetUser.save();

    await recordLog({
      usuario: socket.username || "Anónimo",
      descripcion: `Reportó al usuario ${targetUser.email || targetUser.name || message.targetUsername} por: ${normalizedReason}`,
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
      socket.supportSession = session;
      
      const replyText = await buildSupportBotReply(normalizedText, session);
      const assistantMessage = await persistMessage({
        roomKey,
        username: "NendoBot",
        text: replyText,
        profileImg: "",
        role: "assistant"
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
