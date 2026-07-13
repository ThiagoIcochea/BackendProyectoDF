const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

const User = require("../models/User");
const LoginIpBlock = require("../models/LoginIpBlock");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { recordLog } = require("../utils/logger");
const { validateAdminClientField } = require("../utils/validation");

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
    const { blocked, reason } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

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
