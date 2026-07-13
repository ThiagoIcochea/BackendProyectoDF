const crypto = require("crypto");
const https = require("https");
const { sendVerificationCodeEmail } = require("./emailNotifications");

const OTP_EXPIRE_MS = 5 * 60 * 1000;

const normalizeMfaMethod = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "email";
  if (["correo", "email", "mail"].includes(raw)) return "email";
  if (["sms", "mensaje", "texto"].includes(raw)) return "sms";
  if (["whatsapp", "wa"].includes(raw)) return "whatsapp";
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

const sendTwoFactorCode = async (user, method, code) => {
  const safeMethod = normalizeMfaMethod(method || "email");

  if (safeMethod === "email") {
    const result = await sendVerificationCodeEmail(user, code, {
      subject: "Código de verificación - Nendoshop",
      title: "Verificación de seguridad",
      description: "Usa el siguiente código de verificación para continuar."
    });

    if (!result.sent) {
      return { sentBy: "email", error: true, reason: result.reason || "resend_error", message: result.message || "No se pudo enviar el código por correo." };
    }

    return { sentBy: "email", data: result };
  }

  if (safeMethod === "console") {
    return { sentBy: "console" };
  }

  if (!user?.phone) {
    return { sentBy: safeMethod, error: true, message: "No hay teléfono configurado para este método." };
  }

  const macroMethod = safeMethod === "whatsapp" ? "wtsp" : safeMethod === "call" ? "call" : safeMethod === "sms" ? "sms" : "email";
  const nombre = encodeURIComponent(user.name || user.email || "Cliente");
  const numero = encodeURIComponent(String(user.phone));
  const url = `https://trigger.macrodroid.com/543902b9-9627-4797-833f-8ab08ee4a3ec/otp?nombre=${nombre}&numero=${numero}&metodo=${macroMethod}&codigo=${code}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ sentBy: safeMethod }));
    }).on("error", (err) => {
      resolve({ sentBy: safeMethod, error: true, message: err?.message || "No se pudo enviar el código por el canal seleccionado." });
    });
  });
};

const issueActionMfa = async (user, method = "email", options = {}) => {
  if (!user) return { tempToken: null, error: true, message: "Usuario no encontrado." };

  const safeMethod = normalizeMfaMethod(method);
  const code = options.code || generateCode();
  const tempToken = options.tempToken || generateTempToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (options.expiresInMs || OTP_EXPIRE_MS));

  const deliveryResult = await sendTwoFactorCode(user, safeMethod, code);
  if (deliveryResult?.error) {
    return { tempToken, sentBy: safeMethod, error: true, message: deliveryResult.message || "No se pudo enviar el código de verificación." };
  }

  user.twoFactorCode = code;
  user.twoFactorMethod = safeMethod;
  user.twoFactorTempToken = tempToken;
  user.twoFactorExpires = expiresAt;
  user.twoFactorLastSentAt = now;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  await user.save();

  return { tempToken, sentBy: safeMethod };
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
