require("dotenv").config();

const express = require("express");
const router = express.Router();

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const https = require("https");
const crypto = require("crypto");
const { Resend } = require("resend");

const resendApiKey = process.env.RESEND_API_KEY;
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

const User = require("../models/User");
const LoginIpBlock = require("../models/LoginIpBlock");
const verifyToken = require("../middlewares/verifyToken");
const { recordLog } = require("../utils/logger");
const { normalizeIp } = require("../utils/logger");
const { validateRegistrationPayload, validateProfilePayload } = require("../utils/validation");
const { sendVerificationCodeEmail } = require("../utils/emailNotifications");

const OTP_EXPIRE_MS = 5 * 60 * 1000;
const RESEND_WAIT_MS = 30 * 1000;
const BLOCK_DURATION_MS = 2 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 3;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_IP_LOGIN_ATTEMPTS = 12;
const LOGIN_BLOCK_DURATION_MS = 10 * 60 * 1000;
const IP_BLOCK_DURATION_MS = 30 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "none",
  maxAge: 7 * 24 * 60 * 60 * 1000
};

const pendingRegistrations = new Map();
const pendingPasswordChanges = new Map();
const pendingProfileUpdates = new Map();

const { issueActionMfa, verifyActionMfa, generateCode, generateTempToken, normalizeMfaMethod } = require("../utils/twoFactor");
const normalizeEmail = (value) => (value || "").trim().toLowerCase();
const getResendFromAddress = () => {
  const raw = (process.env.RESEND_FROM_EMAIL || "").trim();
  if (raw && raw.includes("@")) return raw;
  return "onboarding@resend.dev";
};

const generateEmailHtml = (name, code) => {
  const brand = "#9333EA";
  return `
  <div style="font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; color:#111;"> 
    <div style="max-width:600px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:8px;">
      <div style="text-align:center;margin-bottom:18px;">
        <div style="display:inline-block;padding:12px 18px;background:${brand};color:#fff;border-radius:8px;font-weight:600;">Nendoshop</div>
      </div>
      <h2 style="color:${brand};font-size:20px;margin:8px 0;">Verificaci?n de seguridad</h2>
      <p style="margin:8px 0 18px;">Hola ${name || ''},</p>
      <p style="margin:8px 0;color:#333;">Hemos recibido una solicitud para iniciar sesi?n en tu cuenta. Usa el siguiente c?digo de verificaci?n para continuar. Este c?digo expira en 5 minutos.</p>
      <div style="text-align:center;margin:20px 0;">
        <div style="display:inline-block;padding:16px 22px;border-radius:8px;background:#f7f7fb;border:2px dashed ${brand};font-size:22px;letter-spacing:4px;color:${brand};font-weight:700;">${code}</div>
      </div>
      <p style="margin:8px 0;color:#666;font-size:13px;">Si no solicitaste este c?digo, ignora este email o cambia tu contrase?a si sospechas actividad no autorizada.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
      <p style="font-size:12px;color:#999;margin:0;">Nendoshop ? Soporte al cliente</p>
    </div>
  </div>
  `;
};

const sendTwoFactorCode = async (user, method, code) => {
  const sendMethod = normalizeMfaMethod(method || "email");

  if (sendMethod === "email") {
    const result = await sendVerificationCodeEmail(user, code, {
      subject: 'C?digo de verificaci?n - Nendoshop',
      title: 'Verificaci?n de seguridad',
      description: 'Usa el siguiente c?digo de verificaci?n para continuar.'
    });

    if (!result.sent) {
      return { sentBy: 'email', error: true, reason: result.reason || 'resend_error', message: result.message || 'No se pudo enviar el correo de verificaci?n.' };
    }

    return { sentBy: 'email', data: result };
  }

  if (!user.phone) {
    console.log(`[2FA] Sin tel?fono para ${sendMethod}; enviando por correo: ${code}`);
    return Promise.resolve({ sentBy: "email" });
  }

  const macroMethod =
    sendMethod === "whatsapp"
      ? "wtsp"
      : sendMethod === "call"
        ? "call"
        : sendMethod === "sms"
          ? "sms"
          : "email";

  const nombre = encodeURIComponent(user.name || user.email);
  const numero = encodeURIComponent(String(user.phone));
  const url = `https://trigger.macrodroid.com/543902b9-9627-4797-833f-8ab08ee4a3ec/otp?nombre=${nombre}&numero=${numero}&metodo=${macroMethod}&codigo=${code}`;

  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        console.log(`[2FA] trigger ${macroMethod} status ${res.statusCode}`);
        res.on("data", () => { });
        res.on("end", () => resolve({ sentBy: sendMethod }));
      })
      .on("error", (err) => {
        console.error("[2FA] Error al llamar trigger", err);
        resolve({ sentBy: sendMethod, error: true });
      });
  });
};

const isBlocked = (user) => {
  return user.twoFactorBlockedUntil && user.twoFactorBlockedUntil > new Date();
};

const isLoginBlocked = (user) => {
  return user.loginBlockedUntil && user.loginBlockedUntil > new Date();
};

const isIpBlocked = (entry) => {
  return entry?.blockedUntil && entry.blockedUntil > new Date();
};

const registerIpFailure = async (req, email, reason = "Intento fallido") => {
  const ip = normalizeIp(req);
  const normalizedEmail = normalizeEmail(email);
  const update = {
    $set: { lastAttemptAt: new Date(), reason },
    $inc: { failedAttempts: 1 }
  };
  if (normalizedEmail) {
    update.$addToSet = { emails: normalizedEmail };
  }
  const entry = await LoginIpBlock.findOneAndUpdate(
    { ip },
    update,
    { new: true, upsert: true }
  );

  if ((entry.failedAttempts || 0) >= MAX_IP_LOGIN_ATTEMPTS) {
    entry.blockedUntil = new Date(Date.now() + IP_BLOCK_DURATION_MS);
    entry.reason = "Demasiados intentos de login fallidos desde esta IP";
    await entry.save();
  }

  return entry;
};

const registerUserLoginFailure = async (user, req, reason = "Login fallido") => {
  user.loginFailedAttempts = (user.loginFailedAttempts || 0) + 1;
  user.loginLastFailedAt = new Date();
  user.loginLastIp = normalizeIp(req);

  if (user.loginFailedAttempts >= MAX_LOGIN_ATTEMPTS) {
    user.loginBlockedUntil = new Date(Date.now() + LOGIN_BLOCK_DURATION_MS);
    user.loginFailedAttempts = 0;
  }

  await user.save();
  await registerIpFailure(req, user.email, reason);
};

const clearLoginFailures = async (user, req) => {
  if (!user) return;
  user.loginFailedAttempts = 0;
  user.loginBlockedUntil = null;
  user.loginLastIp = normalizeIp(req);
  await user.save();

  const ip = normalizeIp(req);
  await LoginIpBlock.updateOne(
    { ip },
    { $set: { failedAttempts: 0, blockedUntil: null, reason: "" } }
  ).catch(() => { });
};

router.post("/login", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    const ip = normalizeIp(req);
    const ipEntry = await LoginIpBlock.findOne({ ip });

    if (isIpBlocked(ipEntry)) {
      await recordLog({ req, usuario: normalizedEmail || "Anonimo", descripcion: "Login bloqueado por IP en lista negra temporal", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "Esta IP esta bloqueada temporalmente por demasiados intentos fallidos. Contacta al administrador si fue un error.",
        ipBlocked: true
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      await registerIpFailure(req, normalizedEmail, "Correo no registrado");
      await recordLog({ req, usuario: normalizedEmail, descripcion: "Intento de login con correo no registrado", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    if (isLoginBlocked(user)) {
      await recordLog({ req, usuario: user.email, descripcion: "Login bloqueado por exceso de intentos de password", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "La cuenta esta bloqueada temporalmente por demasiados intentos de login. Un administrador puede desbloquearla.",
        userBlocked: true
      });
    }

    if (user.role === "admin" && req.body.loginContext !== "admin") {
      await registerUserLoginFailure(user, req, "Administrador intento entrar desde login general");
      await recordLog({ req, usuario: user.email, descripcion: "Intento de login de administrador desde el login general", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "El acceso administrativo solo est? permitido desde el panel dedicado.",
        requiresAdminAccess: true
      });
    }

    if (user.role !== "admin" && req.body.loginContext === "admin") {
      await registerUserLoginFailure(user, req, "Usuario intento entrar al panel admin");
      await recordLog({ req, usuario: user.email, descripcion: "Intento de acceso de usuario al panel administrativo", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({ message: "No tienes permisos de administrador" });
    }

    const validPassword = await bcrypt.compare(req.body.password, user.password);

    if (!validPassword) {
      await registerUserLoginFailure(user, req, "Password incorrecta");
      await recordLog({ req, usuario: user.email, descripcion: "Intento de login con contrase?a incorrecta", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(401).json({ message: "Password incorrecta" });
    }

    if (isBlocked(user)) {
      return res.status(403).json({
        message: "La cuenta est? bloqueada temporalmente por demasiados intentos fallidos. Intenta de nuevo en unos minutos."
      });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    const emailResult = await sendTwoFactorCode(user, "email", code);
    if (emailResult?.error) {
      return res.status(502).json({ message: emailResult.message || "No se pudo enviar el c?digo por correo." });
    }

    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    user.loginFailedAttempts = 0;
    user.loginBlockedUntil = null;
    user.loginLastIp = ip;

    await user.save();
    await clearLoginFailures(user, req);

    await recordLog({ req, usuario: user.email, descripcion: "Inicio de sesi?n solicitado con verificaci?n en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      twoFactorRequired: true,
      tempToken,
      method: "email",
      message: "Se ha enviado el c?digo por correo"
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/resend-2fa", async (req, res) => {
  try {
    const {
      email,
      tempToken,
      method,
      pendingRegistration,
      pendingPasswordChange,
      pendingProfileUpdate,
      forgotPassword,
      newPassword,
    } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !tempToken) {
      return res.status(400).json({ message: "Email y token temporario son requeridos" });
    }

    const pendingEntry = pendingRegistrations.get(tempToken) || pendingRegistration;
    const pendingChangeEntry = pendingPasswordChanges.get(tempToken) || pendingPasswordChange;
    const pendingProfileEntry = pendingProfileUpdates.get(tempToken) || pendingProfileUpdate;

    if (pendingEntry) {
      const now = new Date();
      const newCode = generateCode();
      const sendMethod = method || "email";
      const entry = {
        ...(pendingEntry || {}),
        email: normalizeEmail(pendingEntry?.email || normalizedEmail),
        code: newCode,
        expiresAt: new Date(now.getTime() + OTP_EXPIRE_MS)
      };

      pendingRegistrations.set(tempToken, entry);
      const emailResult = await sendTwoFactorCode({ email: entry.email, name: entry.name }, sendMethod, newCode);
      if (emailResult?.error) {
        return res.status(502).json({ message: emailResult.message || "No se pudo reenviar el c?digo por correo." });
      }

      return res.json({
        message: "C?digo reenviado",
        method: sendMethod,
        waitSeconds: 30
      });
    }

    if (pendingChangeEntry || pendingProfileEntry || forgotPassword) {
      const targetEmail = normalizeEmail((pendingChangeEntry && pendingChangeEntry.email) || (pendingProfileEntry && pendingProfileEntry.email) || normalizedEmail);
      const user = await User.findOne({ email: targetEmail });

      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      const now = new Date();
      if (user.twoFactorLastSentAt && now - user.twoFactorLastSentAt < RESEND_WAIT_MS) {
        const waitSeconds = Math.ceil((RESEND_WAIT_MS - (now - user.twoFactorLastSentAt)) / 1000);
        return res.status(429).json({
          message: `Espera ${waitSeconds} segundos antes de reenviar el c?digo.`
        });
      }

      const newCode = generateCode();
      const sendMethod = method || "email";
      const emailResult = await sendTwoFactorCode(user, sendMethod, newCode);
      if (emailResult?.error) {
        return res.status(502).json({ message: emailResult.message || "No se pudo reenviar el c?digo por correo." });
      }

      user.twoFactorCode = newCode;
      user.twoFactorMethod = sendMethod;
      user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
      user.twoFactorLastSentAt = now;
      user.twoFactorAttempts = 0;
      await user.save();

      return res.json({
        message: "C?digo reenviado",
        method: sendMethod,
        waitSeconds: 30
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (user.twoFactorTempToken !== tempToken) {
      return res.status(401).json({ message: "Token de verificaci?n inv?lido" });
    }

    if (isBlocked(user)) {
      return res.status(403).json({
        message: "La cuenta est? bloqueada temporalmente por muchos intentos fallidos. Intenta de nuevo en unos minutos."
      });
    }

    const now = new Date();
    if (user.twoFactorLastSentAt && now - user.twoFactorLastSentAt < RESEND_WAIT_MS) {
      const waitSeconds = Math.ceil((RESEND_WAIT_MS - (now - user.twoFactorLastSentAt)) / 1000);
      return res.status(429).json({
        message: `Espera ${waitSeconds} segundos antes de reenviar el c?digo.`
      });
    }

    const newCode = generateCode();
    const sendMethod = method || "email";

    const emailResult = await sendTwoFactorCode(user, sendMethod, newCode);
    if (emailResult?.error) {
      return res.status(502).json({ message: emailResult.message || "No se pudo reenviar el c?digo por correo." });
    }

    user.twoFactorCode = newCode;
    user.twoFactorMethod = sendMethod;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;

    await user.save();

    return res.json({
      message: "C?digo reenviado",
      method: sendMethod,
      waitSeconds: 30
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/verify-2fa", async (req, res) => {
  try {
    const { email, tempToken, code, pendingRegistration, forgotPassword, newPassword, pendingPasswordChange, pendingProfileUpdate } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !tempToken || !code) {
      return res.status(400).json({ message: "Email, token y c?digo son requeridos" });
    }

    const pendingEntry = pendingRegistrations.get(tempToken) || pendingRegistration;
    const pendingChangeEntry = pendingPasswordChanges.get(tempToken) || pendingPasswordChange;
    const pendingProfileEntry = pendingProfileUpdates.get(tempToken) || pendingProfileUpdate;

    if (pendingEntry) {
      const now = new Date();
      if (!pendingEntry.code || !pendingEntry.expiresAt || pendingEntry.expiresAt < now || pendingEntry.code !== code) {
        return res.status(401).json({ message: "C?digo incorrecto o expirado" });
      }

      const existingUser = await User.findOne({ email: normalizedEmail });
      if (existingUser) {
        return res.status(400).json({ message: "El email ya existe" });
      }

      const user = new User({
        name: pendingEntry.name,
        lastname: pendingEntry.lastname,
        email: pendingEntry.email,
        password: pendingEntry.password,
        phone: pendingEntry.phone,
        address: pendingEntry.address,
        city: pendingEntry.city,
        birthdate: pendingEntry.birthdate,
        sex: pendingEntry.sex,
        role: "user"
      });

      await user.save();
      pendingRegistrations.delete(tempToken);
      await recordLog({ req, usuario: user.email, descripcion: "Registro completado tras verificaci?n en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.cookie("token", token, cookieOptions);

      return res.json({
        message: "Verificaci?n correcta",
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          profileImg: user.profileImg
        }
      });
    }

    if (pendingChangeEntry && !forgotPassword) {
      const user = await User.findOne({ email: normalizeEmail(pendingChangeEntry.email || normalizedEmail) });
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      if (user.twoFactorTempToken !== tempToken) {
        return res.status(401).json({ message: "Token de verificaci?n inv?lido" });
      }

      const now = new Date();
      if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
        return res.status(401).json({ message: "C?digo incorrecto o expirado" });
      }

      user.password = await bcrypt.hash(pendingChangeEntry.newPassword, 10);
      user.twoFactorCode = null;
      user.twoFactorExpires = null;
      user.twoFactorTempToken = null;
      user.twoFactorAttempts = 0;
      user.twoFactorBlockedUntil = null;
      user.twoFactorLastSentAt = null;
      user.twoFactorMethod = null;
      await user.save();
      pendingPasswordChanges.delete(tempToken);

      await recordLog({ req, usuario: user.email, descripcion: "Contrase?a actualizada tras verificaci?n en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      return res.json({ message: "Contrase?a actualizada correctamente" });
    }

    if (pendingProfileEntry) {
      const user = await User.findOne({ email: normalizeEmail(pendingProfileEntry.email || normalizedEmail) });
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      if (user.twoFactorTempToken !== tempToken) {
        return res.status(401).json({ message: "Token de verificaci?n inv?lido" });
      }

      const now = new Date();
      if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
        return res.status(401).json({ message: "C?digo incorrecto o expirado" });
      }

      const payload = pendingProfileEntry.payload || pendingProfileEntry;
      const { isValid, errors } = validateProfilePayload(payload);
      if (!isValid) {
        return res.status(400).json({ message: errors.join(" ") });
      }

      if (payload.email && normalizeEmail(payload.email) !== normalizeEmail(user.email)) {
        const existingUser = await User.findOne({ email: normalizeEmail(payload.email) });
        if (existingUser) {
          return res.status(409).json({ message: "El correo ya est? registrado por otro usuario." });
        }
      }

      user.email = payload.email || user.email;
      user.name = payload.name || user.name;
      user.lastname = payload.lastname || user.lastname;
      user.phone = payload.phone || user.phone;
      user.address = payload.address || user.address;
      user.city = payload.city || user.city;
      user.birthdate = payload.birthdate || user.birthdate;
      user.sex = payload.sex || user.sex;
      user.profileImg = payload.profileImg || user.profileImg;
      user.paymentmethod = payload.paymentmethod || user.paymentmethod;
      user.twoFactorCode = null;
      user.twoFactorExpires = null;
      user.twoFactorTempToken = null;
      user.twoFactorAttempts = 0;
      user.twoFactorBlockedUntil = null;
      user.twoFactorLastSentAt = null;
      user.twoFactorMethod = null;
      await user.save();
      pendingProfileUpdates.delete(tempToken);

      await recordLog({ req, usuario: user.email, descripcion: "Perfil actualizado tras verificaci?n en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      return res.json({ message: "Perfil actualizado correctamente", user: { id: user._id, name: user.name, email: user.email, role: user.role, profileImg: user.profileImg } });
    }

    if (forgotPassword) {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      if (user.twoFactorTempToken !== tempToken) {
        return res.status(401).json({ message: "Token de verificaci?n inv?lido" });
      }

      const now = new Date();
      if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
        return res.status(401).json({ message: "C?digo incorrecto o expirado" });
      }

      user.password = await bcrypt.hash(newPassword, 10);
      user.twoFactorCode = null;
      user.twoFactorExpires = null;
      user.twoFactorTempToken = null;
      user.twoFactorAttempts = 0;
      user.twoFactorBlockedUntil = null;
      user.twoFactorLastSentAt = null;
      user.twoFactorMethod = null;
      await user.save();
      pendingPasswordChanges.delete(tempToken);

      await recordLog({ req, usuario: user.email, descripcion: "Contrase?a actualizada tras verificaci?n en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.cookie("token", token, cookieOptions);

      return res.json({
        message: "Contrase?a actualizada correctamente",
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          profileImg: user.profileImg
        }
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (user.twoFactorTempToken !== tempToken) {
      return res.status(401).json({ message: "Token de verificaci?n inv?lido" });
    }

    if (isBlocked(user)) {
      await recordLog({ req, usuario: user.email, descripcion: "Verificaci?n 2FA bloqueada por exceso de intentos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "La cuenta est? bloqueada temporalmente por demasiados intentos fallidos. Intenta de nuevo en unos minutos."
      });
    }

    if (user.chatBlockedUntil && new Date(user.chatBlockedUntil) > new Date()) {
      await recordLog({ req, usuario: user.email, descripcion: "Intento de verificaci?n bloqueado por estado de seguridad", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "Tu cuenta est? bloqueada por reportes acumulados. Contacta al administrador."
      });
    }

    const now = new Date();
    if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
      user.twoFactorAttempts = (user.twoFactorAttempts || 0) + 1;
      if (user.twoFactorAttempts >= MAX_VERIFY_ATTEMPTS) {
        user.twoFactorBlockedUntil = new Date(now.getTime() + BLOCK_DURATION_MS);
        user.twoFactorAttempts = 0;
        await user.save();
        return res.status(403).json({ message: "Demasiados intentos fallidos. Vuelve a intentar en 2 minutos." });
      }
      await user.save();
      return res.status(401).json({ message: "C?digo incorrecto o expirado" });
    }

    user.twoFactorCode = null;
    user.twoFactorExpires = null;
    user.twoFactorTempToken = null;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    user.twoFactorLastSentAt = null;
    user.twoFactorMethod = null;

    await user.save();

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.cookie("token", token, cookieOptions);

    return res.json({
      message: "Verificaci?n correcta",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImg: user.profileImg
      }
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/profile-update-request", verifyToken, async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ message: "Datos de perfil inv?lidos" });
    }

    const { isValid, errors } = validateProfilePayload(payload);
    if (!isValid) {
      return res.status(400).json({ message: errors.join(" ") });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (payload.email && normalizeEmail(payload.email) !== normalizeEmail(user.email)) {
      const existingUser = await User.findOne({ email: normalizeEmail(payload.email) });
      if (existingUser) {
        return res.status(409).json({ message: "El correo ya est? registrado por otro usuario." });
      }
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    pendingProfileUpdates.set(tempToken, {
      email: user.email,
      payload,
      kind: "profile"
    });

    // Fix Bug 1: capturar resultado del env?o en profile-update-request.
    // REVERT: reemplazar por: await sendTwoFactorCode(user, "email", code);
    const profileEmailResult = await sendTwoFactorCode(user, "email", code);
    if (profileEmailResult?.error) {
      pendingProfileUpdates.delete(tempToken);
      return res.status(502).json({ message: profileEmailResult.message || "No se pudo enviar el c?digo de verificaci?n por correo. Intenta de nuevo." });
    }
    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    await recordLog({ req, usuario: user.email, descripcion: "Solicitud de actualizaci?n de perfil iniciada", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      message: "Verifica tu correo para confirmar los cambios del perfil",
      tempToken,
      twoFactorRequired: true
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/change-password-request", verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Contrase?a actual y nueva son requeridas" });
    }

    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(String(newPassword))) {
      return res.status(400).json({ message: "La nueva contrase?a debe tener al menos 8 caracteres, una letra, un n?mero y un s?mbolo." });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ message: "La contrase?a actual es incorrecta" });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    pendingPasswordChanges.set(tempToken, {
      email: user.email,
      newPassword,
      kind: "change"
    });

    // Fix Bug 1: capturar resultado del env?o en change-password-request.
    // REVERT: reemplazar por: await sendTwoFactorCode(user, "email", code);
    const changePassEmailResult = await sendTwoFactorCode(user, "email", code);
    if (changePassEmailResult?.error) {
      pendingPasswordChanges.delete(tempToken);
      return res.status(502).json({ message: changePassEmailResult.message || "No se pudo enviar el c?digo de verificaci?n por correo. Intenta de nuevo." });
    }
    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    await recordLog({ req, usuario: user.email, descripcion: "Solicitud de cambio de contrase?a iniciada", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      message: "Verifica tu correo para confirmar el cambio de contrase?a",
      tempToken,
      twoFactorRequired: true
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !newPassword) {
      return res.status(400).json({ message: "Correo y nueva contrase?a requeridos" });
    }

    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(String(newPassword))) {
      return res.status(400).json({ message: "La nueva contrase?a debe tener al menos 8 caracteres, una letra, un n?mero y un s?mbolo." });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (user.role === "admin") {
      await recordLog({ req, usuario: user.email, descripcion: "Recuperacion admin bloqueada desde login general", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({ message: "La contrasena de administrador solo se recupera desde access-panel-admin." });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    pendingPasswordChanges.set(tempToken, {
      email: normalizedEmail,
      newPassword,
      kind: "forgot"
    });

    const emailResult = await sendTwoFactorCode(user, "email", code);
    if (emailResult?.error) {
      pendingPasswordChanges.delete(tempToken);
      return res.status(502).json({ message: emailResult.message || "No se pudo enviar el c?digo por correo." });
    }

    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    return res.json({
      message: "Verifica tu correo para confirmar el cambio de contrase?a",
      tempToken,
      twoFactorRequired: true
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/admin/forgot-password", async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !newPassword) {
      return res.status(400).json({ message: "Correo y nueva contrasena requeridos" });
    }

    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(String(newPassword))) {
      return res.status(400).json({ message: "La nueva contrasena debe tener al menos 8 caracteres, una letra, un numero y un simbolo." });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user || user.role !== "admin") {
      return res.status(404).json({ message: "Administrador no encontrado" });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    pendingPasswordChanges.set(tempToken, {
      email: normalizedEmail,
      newPassword,
      kind: "admin-forgot"
    });

    const emailResult = await sendTwoFactorCode(user, "email", code);
    if (emailResult?.error) {
      pendingPasswordChanges.delete(tempToken);
      return res.status(502).json({ message: emailResult.message || "No se pudo enviar el codigo por correo." });
    }

    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    await recordLog({ req, usuario: user.email, descripcion: "Recuperacion de contrasena admin iniciada", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      message: "Verifica tu correo para confirmar el cambio de contrasena de administrador",
      tempToken,
      twoFactorRequired: true
    });
  } catch (error) {
    res.status(500).json(error);
  }
});

router.post("/register", async (req, res) => {

  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    const { isValid, errors } = validateRegistrationPayload(req.body);

    if (!isValid) {
      return res.status(400).json({
        message: errors.join(". ")
      });
    }

    const exists = await User.findOne({
      email: normalizedEmail
    });

    if (exists) {
      return res.status(400).json({
        message: "El email ya existe"
      });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();
    const hashedPassword = await bcrypt.hash(req.body.password, 10);

    pendingRegistrations.set(tempToken, {
      email: normalizedEmail,
      password: hashedPassword,
      name: req.body.name,
      lastname: req.body.lastname,
      phone: req.body.phone,
      address: req.body.address,
      city: req.body.city,
      birthdate: req.body.birthdate,
      sex: req.body.sex,
      code,
      expiresAt: new Date(now.getTime() + OTP_EXPIRE_MS)
    });

    // Fix Bug 1: el env?o se verificaba solo en /login pero no en /register.
    // Si el correo falla, el usuario quedaba varado en la pantalla de c?digo sin recibirlo.
    // REVERT: reemplazar el bloque completo por: await sendTwoFactorCode({ email: normalizedEmail, name: req.body.name }, "email", code);
    const registerEmailResult = await sendTwoFactorCode({ email: normalizedEmail, name: req.body.name }, "email", code);
    if (registerEmailResult?.error) {
      pendingRegistrations.delete(tempToken);
      return res.status(502).json({ message: registerEmailResult.message || "No se pudo enviar el c?digo de verificaci?n por correo. Intenta de nuevo." });
    }

    await recordLog({ req, usuario: normalizedEmail, descripcion: "Registro iniciado con verificaci?n en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      message: "Verifica tu correo para completar el registro",
      tempToken,
      twoFactorRequired: true
    });

  } catch (error) {
    res.status(500).json(error);
  }

});

module.exports = router;
