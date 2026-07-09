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
const verifyToken = require("../middlewares/verifyToken");
const { recordLog } = require("../utils/logger");
const { validateRegistrationPayload, validateProfilePayload } = require("../utils/validation");

const OTP_EXPIRE_MS = 5 * 60 * 1000;
const RESEND_WAIT_MS = 30 * 1000;
const BLOCK_DURATION_MS = 2 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 3;
const isProduction = process.env.NODE_ENV === "production";
// En localhost/desarrollo, permitir sameSite: "none" con secure: false para cross-origin
// En producción, requerir secure: true para sameSite: "none"
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "none",
  maxAge: 7 * 24 * 60 * 60 * 1000
};
const pendingRegistrations = new Map();
const pendingPasswordChanges = new Map();
const pendingProfileUpdates = new Map();

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));
const generateTempToken = () => crypto.randomBytes(24).toString("hex");
const normalizeEmail = (value) => (value || "").trim().toLowerCase();
const getResendFromAddress = () => {
  const raw = (process.env.RESEND_FROM_EMAIL || "Nendoshop <notificaciones@freecodingvibes.shop>").trim();
  if (!raw || !raw.includes("@")) return "Nendoshop <notificaciones@freecodingvibes.shop>";
  return raw;
};

const generateEmailHtml = (name, code) => {
  const brand = "#9333EA";
  return `
  <div style="font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; color:#111;"> 
    <div style="max-width:600px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:8px;">
      <div style="text-align:center;margin-bottom:18px;">
        <div style="display:inline-block;padding:12px 18px;background:${brand};color:#fff;border-radius:8px;font-weight:600;">Nendoshop</div>
      </div>
      <h2 style="color:${brand};font-size:20px;margin:8px 0;">Verificación de seguridad</h2>
      <p style="margin:8px 0 18px;">Hola ${name || ''},</p>
      <p style="margin:8px 0;color:#333;">Hemos recibido una solicitud para iniciar sesión en tu cuenta. Usa el siguiente código de verificación para continuar. Este código expira en 5 minutos.</p>
      <div style="text-align:center;margin:20px 0;">
        <div style="display:inline-block;padding:16px 22px;border-radius:8px;background:#f7f7fb;border:2px dashed ${brand};font-size:22px;letter-spacing:4px;color:${brand};font-weight:700;">${code}</div>
      </div>
      <p style="margin:8px 0;color:#666;font-size:13px;">Si no solicitaste este código, ignora este email o cambia tu contraseña si sospechas actividad no autorizada.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
      <p style="font-size:12px;color:#999;margin:0;">Nendoshop · Soporte al cliente</p>
    </div>
  </div>
  `;
};

const sendTwoFactorCode = async (user, method, code) => {
  const sendMethod = method || "email";

  if (sendMethod === "email") {
    const html = generateEmailHtml(user.name || user.email, code);
    const from = getResendFromAddress();
    const to = user.email;
    const replyTo = from || "noreply@localhost";
    const text = `Hola ${user.name || user.email},\n\nTu código de verificación es: ${code}.\n\nSi no solicitaste este código, ignora este mensaje.`;

    if (!resendClient) {
      console.error('[2FA] RESEND_API_KEY no configurada; no se pudo enviar el correo');
      return { sentBy: 'email', error: true, reason: 'missing_api_key', message: 'No se pudo enviar el correo porque la clave de Resend no está configurada.' };
    }

    if (!from) {
      console.error('[2FA] No hay remitente verificado en Resend para enviar correos');
      return {
        sentBy: 'email',
        error: true,
        reason: 'unverified_sender',
        message: 'No se pudo enviar el correo porque el remitente no está verificado en Resend. Configura RESEND_FROM_EMAIL con un dominio verificado, por ejemplo: no-reply@tu-dominio.com.'
      };
    }

    try {
      const { data } = await resendClient.emails.send({
        from,
        to,
        replyTo, 
        subject: 'Código de verificación - Nendoshop',
        text,
        html,
      });

      console.log('[2FA] Email enviado:', data);
      return { sentBy: 'email', data };
    } catch (err) {
      const errorMessage = err?.message || "Error desconocido al enviar el correo";
      console.error('[2FA] Error al enviar email con Resend', errorMessage);
      console.log(`[2FA] fallback código: ${code}`);
      return {
        sentBy: 'email',
        error: true,
        reason: 'resend_error',
        message: errorMessage.includes('domain') || errorMessage.includes('testing')
          ? 'Resend rechazó el envío por restricciones del remitente o del dominio. Verifica el remitente en Resend.'
          : 'No se pudo enviar el correo de verificación.'
      };
    }
  }

  if (!user.phone) {
    console.log(`[2FA] Sin teléfono para ${sendMethod}; enviando por correo: ${code}`);
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
        res.on("data", () => {});
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

router.post("/login", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      await recordLog({ req, usuario: normalizedEmail, descripcion: "Intento de login con correo no registrado", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    if (user.role === "admin" && req.body.loginContext !== "admin") {
      await recordLog({ req, usuario: user.email, descripcion: "Intento de login de administrador desde el login general", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "El acceso administrativo solo está permitido desde el panel dedicado.",
        requiresAdminAccess: true
      });
    }

    if (user.role !== "admin" && req.body.loginContext === "admin") {
      await recordLog({ req, usuario: user.email, descripcion: "Intento de acceso de usuario al panel administrativo", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({ message: "No tienes permisos de administrador" });
    }

    const validPassword = await bcrypt.compare(req.body.password, user.password);

    if (!validPassword) {
      await recordLog({ req, usuario: user.email, descripcion: "Intento de login con contraseña incorrecta", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(401).json({ message: "Password incorrecta" });
    }

    if (isBlocked(user)) {
      return res.status(403).json({
        message: "La cuenta está bloqueada temporalmente por demasiados intentos fallidos. Intenta de nuevo en unos minutos."
      });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    const emailResult = await sendTwoFactorCode(user, "email", code);
    if (emailResult?.error) {
      return res.status(502).json({ message: emailResult.message || "No se pudo enviar el código por correo." });
    }

    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;

    await user.save();

    await recordLog({ req, usuario: user.email, descripcion: "Inicio de sesión solicitado con verificación en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      twoFactorRequired: true,
      tempToken,
      method: "email",
      message: "Se ha enviado el código por correo"
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
        return res.status(502).json({ message: emailResult.message || "No se pudo reenviar el código por correo." });
      }

      return res.json({
        message: "Código reenviado",
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
          message: `Espera ${waitSeconds} segundos antes de reenviar el código.`
        });
      }

      const newCode = generateCode();
      const sendMethod = method || "email";
      const emailResult = await sendTwoFactorCode(user, sendMethod, newCode);
      if (emailResult?.error) {
        return res.status(502).json({ message: emailResult.message || "No se pudo reenviar el código por correo." });
      }

      user.twoFactorCode = newCode;
      user.twoFactorMethod = sendMethod;
      user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
      user.twoFactorLastSentAt = now;
      user.twoFactorAttempts = 0;
      await user.save();

      return res.json({
        message: "Código reenviado",
        method: sendMethod,
        waitSeconds: 30
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (user.twoFactorTempToken !== tempToken) {
      return res.status(401).json({ message: "Token de verificación inválido" });
    }

    if (isBlocked(user)) {
      return res.status(403).json({
        message: "La cuenta está bloqueada temporalmente por muchos intentos fallidos. Intenta de nuevo en unos minutos."
      });
    }

    const now = new Date();
    if (user.twoFactorLastSentAt && now - user.twoFactorLastSentAt < RESEND_WAIT_MS) {
      const waitSeconds = Math.ceil((RESEND_WAIT_MS - (now - user.twoFactorLastSentAt)) / 1000);
      return res.status(429).json({
        message: `Espera ${waitSeconds} segundos antes de reenviar el código.`
      });
    }

    const newCode = generateCode();
    const sendMethod = method || "email";

    const emailResult = await sendTwoFactorCode(user, sendMethod, newCode);
    if (emailResult?.error) {
      return res.status(502).json({ message: emailResult.message || "No se pudo reenviar el código por correo." });
    }

    user.twoFactorCode = newCode;
    user.twoFactorMethod = sendMethod;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;

    await user.save();

    return res.json({
      message: "Código reenviado",
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
      return res.status(400).json({ message: "Email, token y código son requeridos" });
    }

    const pendingEntry = pendingRegistrations.get(tempToken) || pendingRegistration;
    const pendingChangeEntry = pendingPasswordChanges.get(tempToken) || pendingPasswordChange;
    const pendingProfileEntry = pendingProfileUpdates.get(tempToken) || pendingProfileUpdate;

    if (pendingEntry) {
      const now = new Date();
      if (!pendingEntry.code || !pendingEntry.expiresAt || pendingEntry.expiresAt < now || pendingEntry.code !== code) {
        return res.status(401).json({ message: "Código incorrecto o expirado" });
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
      await recordLog({ req, usuario: user.email, descripcion: "Registro completado tras verificación en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.cookie("token", token, cookieOptions);

      return res.json({
        message: "Verificación correcta",
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          profileImg: user.profileImg
        }
      });
    }

    if (pendingChangeEntry) {
      const user = await User.findOne({ email: normalizeEmail(pendingChangeEntry.email || normalizedEmail) });
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      if (user.twoFactorTempToken !== tempToken) {
        return res.status(401).json({ message: "Token de verificación inválido" });
      }

      const now = new Date();
      if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
        return res.status(401).json({ message: "Código incorrecto o expirado" });
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

      await recordLog({ req, usuario: user.email, descripcion: "Contraseña actualizada tras verificación en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      return res.json({ message: "Contraseña actualizada correctamente" });
    }

    if (pendingProfileEntry) {
      const user = await User.findOne({ email: normalizeEmail(pendingProfileEntry.email || normalizedEmail) });
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      if (user.twoFactorTempToken !== tempToken) {
        return res.status(401).json({ message: "Token de verificación inválido" });
      }

      const now = new Date();
      if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
        return res.status(401).json({ message: "Código incorrecto o expirado" });
      }

      const payload = pendingProfileEntry.payload || pendingProfileEntry;
      const { isValid, errors } = validateProfilePayload(payload);
      if (!isValid) {
        return res.status(400).json({ message: errors.join(" ") });
      }

      if (payload.email && normalizeEmail(payload.email) !== normalizeEmail(user.email)) {
        const existingUser = await User.findOne({ email: normalizeEmail(payload.email) });
        if (existingUser) {
          return res.status(409).json({ message: "El correo ya está registrado por otro usuario." });
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

      await recordLog({ req, usuario: user.email, descripcion: "Perfil actualizado tras verificación en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      return res.json({ message: "Perfil actualizado correctamente", user: { id: user._id, name: user.name, email: user.email, role: user.role, profileImg: user.profileImg } });
    }

    if (forgotPassword) {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(404).json({ message: "Usuario no encontrado" });
      }

      if (user.twoFactorTempToken !== tempToken) {
        return res.status(401).json({ message: "Token de verificación inválido" });
      }

      const now = new Date();
      if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < now || user.twoFactorCode !== code) {
        return res.status(401).json({ message: "Código incorrecto o expirado" });
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

      await recordLog({ req, usuario: user.email, descripcion: "Contraseña actualizada tras verificación en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.cookie("token", token, cookieOptions);

      return res.json({
        message: "Contraseña actualizada correctamente",
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
      return res.status(401).json({ message: "Token de verificación inválido" });
    }

    if (isBlocked(user)) {
      await recordLog({ req, usuario: user.email, descripcion: "Verificación 2FA bloqueada por exceso de intentos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "La cuenta está bloqueada temporalmente por demasiados intentos fallidos. Intenta de nuevo en unos minutos."
      });
    }

    if (user.chatBlockedUntil && new Date(user.chatBlockedUntil) > new Date()) {
      await recordLog({ req, usuario: user.email, descripcion: "Intento de verificación bloqueado por estado de seguridad", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });
      return res.status(403).json({
        message: "Tu cuenta está bloqueada por reportes acumulados. Contacta al administrador."
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
      return res.status(401).json({ message: "Código incorrecto o expirado" });
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
      message: "Verificación correcta",
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
      return res.status(400).json({ message: "Datos de perfil inválidos" });
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
        return res.status(409).json({ message: "El correo ya está registrado por otro usuario." });
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

    await sendTwoFactorCode(user, "email", code);
    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    await recordLog({ req, usuario: user.email, descripcion: "Solicitud de actualización de perfil iniciada", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

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
      return res.status(400).json({ message: "Contraseña actual y nueva son requeridas" });
    }

    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(String(newPassword))) {
      return res.status(400).json({ message: "La nueva contraseña debe tener al menos 8 caracteres, una letra, un número y un símbolo." });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ message: "La contraseña actual es incorrecta" });
    }

    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();

    pendingPasswordChanges.set(tempToken, {
      email: user.email,
      newPassword,
      kind: "change"
    });

    await sendTwoFactorCode(user, "email", code);
    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    await recordLog({ req, usuario: user.email, descripcion: "Solicitud de cambio de contraseña iniciada", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

    return res.json({
      message: "Verifica tu correo para confirmar el cambio de contraseña",
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
      return res.status(400).json({ message: "Correo y nueva contraseña requeridos" });
    }

    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(String(newPassword))) {
      return res.status(400).json({ message: "La nueva contraseña debe tener al menos 8 caracteres, una letra, un número y un símbolo." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
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
      return res.status(502).json({ message: emailResult.message || "No se pudo enviar el código por correo." });
    }

    user.twoFactorCode = code;
    user.twoFactorMethod = "email";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();

    await sendTwoFactorCode(user, "email", code);

    return res.json({
      message: "Verifica tu correo para confirmar el cambio de contraseña",
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

        await sendTwoFactorCode({ email: normalizedEmail, name: req.body.name }, "email", code);
        await recordLog({ req, usuario: normalizedEmail, descripcion: "Registro iniciado con verificación en dos pasos", tipo: "AUTH", metodo: req.method, ruta: req.originalUrl });

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
