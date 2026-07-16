const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

const User = require("../models/User");
const LoginIpBlock = require("../models/LoginIpBlock");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { recordLog } = require("../utils/logger");
const { validateAdminClientField } = require("../utils/validation");
const { issueActionMfa, verifyActionMfa } = require("../utils/twoFactor");

router.get("/", verifyToken, isAdmin, async (req, res) => {
 const users = await User.find();
  res.json(users);
});

router.patch("/:id/email", verifyToken, isAdmin, async (req, res) => {
  try {
    const email = req.body.email;
    const validationError = validateAdminClientField("email", email);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const exists = await User.findOne({
      email,
      _id: { $ne: req.params.id }
    });

    if (exists) {
      return res.status(409).json({ message: "Email ya registrado" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { email },
      { new: true }
    );

    await recordLog({ req, usuario: req.user?.email || "admin", descripcion: `Administrador actualizó el email de ${user?.email || req.params.id}`, tipo: "SISTEMA", metodo: req.method, ruta: req.originalUrl });

    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Error servidor" });
  }
});

router.patch("/:id/phone", verifyToken, isAdmin, async (req, res) => {
  const validationError = validateAdminClientField("phone", req.body.phone);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { phone: req.body.phone },
    { new: true }
  );

  res.json(user);
});

router.patch("/:id/name", verifyToken, isAdmin, async (req, res) => {
  const validationError = validateAdminClientField("name", req.body.name);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { name: req.body.name },
    { new: true }
  );

  res.json(user);
});

router.patch("/:id/city", verifyToken, isAdmin, async (req, res) => {
  const validationError = validateAdminClientField("city", req.body.city);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { city: req.body.city },
    { new: true }
  );

  res.json(user);
});

router.patch("/:id/password", verifyToken, isAdmin, async (req, res) => {
  const validationError = validateAdminClientField("password", req.body.password);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  const hashed = await bcrypt.hash(req.body.password, 10);

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { password: hashed },
    { new: true }
  );

  await recordLog({ req, usuario: req.user?.email || "admin", descripcion: `Administrador restableció la contraseña de ${user?.email || req.params.id}`, tipo: "SISTEMA", metodo: req.method, ruta: req.originalUrl });

  res.json({ message: "Password updated" });
});

router.patch("/:id/block", verifyToken, isAdmin, async (req, res) => {
  try {
    const { blocked, reason, mfaCode, tempToken, method } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const adminUser = await User.findById(req.user.id);
    if (!adminUser) return res.status(404).json({ message: "Administrador no encontrado." });

    if (!mfaCode || !tempToken) {
      const normalizedMethod = String(method || "email").toLowerCase();
      const safeMethod = ["email", "sms", "call", "whatsapp", "console"].includes(normalizedMethod) ? normalizedMethod : "email";
      const mfaResult = await issueActionMfa(adminUser, safeMethod);
      if (mfaResult?.error) {
        return res.status(502).json({ message: mfaResult.message || "No se pudo enviar el código MFA." });
      }

      return res.status(202).json({
        twoFactorRequired: true,
        tempToken: mfaResult.tempToken,
        method: safeMethod,
        message: blocked ? "Te enviamos un código MFA para confirmar el bloqueo." : "Te enviamos un código MFA para confirmar el desbloqueo."
      });
    }

    const mfaOk = await verifyActionMfa(adminUser, tempToken, mfaCode);
    if (!mfaOk) {
      return res.status(401).json({ message: "Código MFA incorrecto o expirado." });
    }

    user.chatBlockedUntil = blocked ? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) : null;
    user.chatBlockReason = blocked ? reason || "Reporte acumulado" : "";
    user.chatReportCount = blocked ? Math.max(user.chatReportCount || 0, 10) : Math.max(0, (user.chatReportCount || 0) - 1);
    if (!blocked) {
      user.loginFailedAttempts = 0;
      user.loginBlockedUntil = null;
      user.twoFactorAttempts = 0;
      user.twoFactorBlockedUntil = null;
    }
    await user.save();

    await recordLog({ req, usuario: req.user?.email || "admin", descripcion: blocked ? `Bloqueó al usuario ${user.email}` : `Desbloqueó al usuario ${user.email}`, tipo: "SISTEMA", metodo: req.method, ruta: req.originalUrl });

    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error al actualizar el estado del usuario" });
  }
});

router.get("/security/ip-blocks", verifyToken, isAdmin, async (req, res) => {
  try {
    const blocks = await LoginIpBlock.find().sort({ updatedAt: -1 }).lean();
    res.json(blocks);
  } catch (error) {
    res.status(500).json({ message: "Error al cargar IPs bloqueadas" });
  }
});

router.post("/security/ip-blocks/block", verifyToken, isAdmin, async (req, res) => {
  try {
    const { ip, reason, durationMinutes = 30, mfaCode, tempToken, method } = req.body;
    if (!ip) {
      return res.status(400).json({ message: "La IP es obligatoria" });
    }

    const adminUser = await User.findById(req.user.id);
    if (!adminUser) {
      return res.status(404).json({ message: "Administrador no encontrado." });
    }

    if (!mfaCode || !tempToken) {
      const normalizedMethod = String(method || "email").toLowerCase();
      const safeMethod = ["email", "sms", "call", "whatsapp", "console"].includes(normalizedMethod) ? normalizedMethod : "email";
      const mfaResult = await issueActionMfa(adminUser, safeMethod);
      if (mfaResult?.error) {
        return res.status(502).json({ message: mfaResult.message || "No se pudo enviar el código MFA." });
      }

      return res.status(202).json({
        twoFactorRequired: true,
        tempToken: mfaResult.tempToken,
        method: safeMethod,
        message: "Te enviamos un código MFA para confirmar el bloqueo de IP."
      });
    }

    const mfaOk = await verifyActionMfa(adminUser, tempToken, mfaCode);
    if (!mfaOk) {
      return res.status(401).json({ message: "Código MFA incorrecto o expirado." });
    }

    const blockedUntil = new Date(Date.now() + Math.max(1, Number(durationMinutes) || 30) * 60 * 1000);
    const block = await LoginIpBlock.findOneAndUpdate(
      { ip },
      {
        $set: {
          blockedUntil,
          reason: reason || "Bloqueo manual por administrador",
          lastAttemptAt: new Date()
        }
      },
      { new: true, upsert: true }
    );

    await recordLog({
      req,
      usuario: req.user?.email || "admin",
      descripcion: `Bloqueó la IP ${ip}`,
      tipo: "SISTEMA",
      metodo: req.method,
      ruta: req.originalUrl
    });

    return res.json({ block });
  } catch (error) {
    return res.status(500).json({ message: "Error al bloquear IP" });
  }
});

router.patch("/security/ip-blocks/:id/unblock", verifyToken, isAdmin, async (req, res) => {
  try {
    const block = await LoginIpBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ message: "IP no encontrada" });

    block.failedAttempts = 0;
    block.blockedUntil = null;
    block.reason = "";
    await block.save();

    await recordLog({ req, usuario: req.user?.email || "admin", descripcion: `Desbloqueo la IP ${block.ip}`, tipo: "SISTEMA", metodo: req.method, ruta: req.originalUrl });
    res.json({ block });
  } catch (error) {
    res.status(500).json({ message: "Error al desbloquear IP" });
  }
});

module.exports = router;
