const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/verifyToken");
const { createSupportSession, getSupportBotReply, normalizeCustomerName } = require("../utils/supportBot");

const sessions = new Map();

router.post("/message", verifyToken, async (req, res) => {
  try {
    const { sessionId, message, customerName } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "Falta sessionId" });
    }

    let session = sessions.get(sessionId);
    if (!session) {
      session = createSupportSession(normalizeCustomerName(customerName || req.user?.name || "cliente"));
      sessions.set(sessionId, session);
    }

    if (req.user?.id || req.user?._id) {
      session.userId = String(req.user.id || req.user._id);
    }

    const reply = await getSupportBotReply(message, session);

    res.json({ reply, step: session.step });
  } catch (error) {
    console.error("Error en chatbot:", error);
    res.status(500).json({ message: "Error interno del asistente" });
  }
});

router.post("/reset", (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

module.exports = router;
