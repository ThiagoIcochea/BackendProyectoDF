const crypto = require("crypto");
const { sendVerificationCodeEmail } = require("./emailNotifications");

const OTP_EXPIRE_MS = 5 * 60 * 1000;

const normalizeMfaMethod = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "email";
  if (["correo", "email", "mail"].includes(raw)) return "email";
  if (["sms", "mensaje", "texto", "whatsapp", "wa"].includes(raw)) return "whatsapp";
  if (["llamada", "call", "telefono"].includes(raw)) return "call";
  if (["console", "consola"].includes(raw)) return "console";
  return raw;
};

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));
const generateTempToken = () => crypto.randomBytes(24).toString("hex");

const clearActionMfa = async (user) => {
  if (!user) return;
  user.twoFactorCode = null;
  user.twoFactorExpires = null;
  user.twoFactorTempToken = null;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  user.twoFactorLastSentAt = null;
  user.twoFactorMethod = null;
  await user.save();
};

const getPendingMfaState = (user) => ({
  code: user?.twoFactorCode,
  tempToken: user?.twoFactorTempToken,
  expiresAt: user?.twoFactorExpires,
  method: user?.twoFactorMethod
});

const issueActionMfa = async (user, method = "email", options = {}) => {
  if (!user) return { tempToken: null, error: true, message: "Usuario no encontrado." };

  const safeMethod = normalizeMfaMethod(method);
  const code = options.code || generateCode();
  const tempToken = options.tempToken || generateTempToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (options.expiresInMs || OTP_EXPIRE_MS));

  if (safeMethod === "console") {
    user.twoFactorCode = code;
    user.twoFactorMethod = "console";
    user.twoFactorTempToken = tempToken;
    user.twoFactorExpires = expiresAt;
    user.twoFactorLastSentAt = now;
    user.twoFactorAttempts = 0;
    user.twoFactorBlockedUntil = null;
    await user.save();
    return { tempToken, sentBy: "console" };
  }

  const emailResult = await sendVerificationCodeEmail(user, code, {
    subject: options.subject || "Código de verificación - Nendoshop",
    title: options.title || "Verificación de seguridad",
    description: options.description || "Tu código de verificación es:"
  });

  if (!emailResult.sent) {
    return { tempToken, sentBy: "email", error: true, message: emailResult.message || "No se pudo enviar el código por correo." };
  }

  user.twoFactorCode = code;
  user.twoFactorMethod = safeMethod;
  user.twoFactorTempToken = tempToken;
  user.twoFactorExpires = expiresAt;
  user.twoFactorLastSentAt = now;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  await user.save();

  return { tempToken, sentBy: "email" };
};

const verifyActionMfa = async (user, tempToken, code) => {
  if (!user) return false;

  const now = new Date();
  const valid = user.twoFactorTempToken === tempToken &&
    Boolean(user.twoFactorCode) &&
    user.twoFactorCode === String(code || "").trim() &&
    user.twoFactorExpires &&
    user.twoFactorExpires >= now;

  if (!valid) return false;

  await clearActionMfa(user);
  return true;
};

module.exports = {
  OTP_EXPIRE_MS,
  normalizeMfaMethod,
  generateCode,
  generateTempToken,
  clearActionMfa,
  getPendingMfaState,
  issueActionMfa,
  verifyActionMfa
};
