const { Resend } = require("resend");

const resendApiKey = process.env.RESEND_API_KEY;
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

const getFromAddress = () => {
  const raw = (process.env.RESEND_FROM_EMAIL || "").trim();
  if (raw && raw.includes("@")) return raw;
  return "onboarding@resend.dev";
};

const getFallbackFromAddress = () => {
  const raw = (process.env.RESEND_FALLBACK_FROM_EMAIL || "").trim();
  if (raw && raw.includes("@")) return raw;
  return "onboarding@resend.dev";
};

const buildSendPayload = ({ from, to, subject, text, html }) => ({
  from,
  to: [to],
  subject,
  text,
  html
});

const sendEmail = async ({ to, subject, text, html }) => {
  if (!to) return { sent: false, reason: "missing_email" };

  if (!resendClient) {
    console.log(`[email][fallback] ${subject} -> ${to}: ${text}`);
    return {
      sent: true,
      fallback: true,
      reason: "missing_resend",
      message: "Se registró el mensaje en consola porque Resend no está configurado."
    };
  }

  try {
    const from = getFromAddress();
    const { data, error } = await resendClient.emails.send(
      buildSendPayload({ from, to, subject, text, html })
    );

    if (error) {
      console.error("[email] resend error", error);
      console.log(`[email][fallback] ${subject} -> ${to}: ${text}`);

      const fallbackFrom = getFallbackFromAddress();
      if (fallbackFrom !== from) {
        const retry = await resendClient.emails.send(
          buildSendPayload({ from: fallbackFrom, to, subject, text, html })
        );

        if (!retry?.error) {
          return {
            sent: true,
            fallback: true,
            reason: "sender_fallback",
            id: retry?.data?.id,
            from: fallbackFrom
          };
        }
      }

      return {
        sent: false,
        fallback: true,
        reason: "resend_error",
        message:
          "Resend rechazó el envío. Revisa que el dominio o remitente estén verificados en tu cuenta."
      };
    }

    return { sent: true, id: data?.id, fallback: false };
  } catch (error) {
    console.error("[email] send failure", error);
    console.log(`[email][fallback] ${subject} -> ${to}: ${text}`);
    return {
      sent: false,
      fallback: true,
      reason: "exception",
      message:
        error?.message || "No se pudo enviar el correo. Se registró en consola para continuar el flujo."
    };
  }
};

const sendOrderUpdateEmail = async (user, subject, message) => {
  if (!user?.email) return { sent: false, reason: "missing_email" };
  return sendEmail({
    to: user.email,
    subject,
    text: message,
    html: `<p>${message.replace(/\n/g, "<br />")}</p>`
  });
};

const sendVerificationCodeEmail = async (
  user,
  code,
  {
    subject = "Código de verificación - Nendoshop",
    title = "Verificación de seguridad",
    description = "Tu código de verificación es:"
  } = {}
) => {
  if (!user?.email) return { sent: false, reason: "missing_email" };

  const html = `
    <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
      <div style="max-width:560px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
        <h2 style="color:#9333EA;margin-bottom:8px;">${title}</h2>
        <p>Hola ${user.name || user.email},</p>
        <p>${description}</p>
        <div style="text-align:center;padding:20px 0;">
          <div style="display:inline-block;padding:16px 24px;border-radius:8px;background:#f7f7fb;border:2px dashed #9333EA;font-size:22px;letter-spacing:4px;font-weight:700;color:#9333EA;">${code}</div>
        </div>
        <p style="font-size:13px;color:#666;">Este código expira en 5 minutos. Si no solicitaste esta acción, ignora este mensaje.</p>
      </div>
    </div>
  `;

  return sendEmail({
    to: user.email,
    subject,
    text: `Hola ${user.name || user.email},\n\n${description}\n${code}\n\nEste código expira en 5 minutos.`,
    html
  });
};

module.exports = {
  getFromAddress,
  sendOrderUpdateEmail,
  sendVerificationCodeEmail,
  sendEmail
};
