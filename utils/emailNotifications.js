const { Resend } = require('resend');

const resendApiKey = process.env.RESEND_API_KEY;
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

const getFromAddress = () => {
  return (process.env.RESEND_FROM_EMAIL || 'Nendoshop <notificaciones@freecodingvibes.shop>').trim();
};

const sendOrderUpdateEmail = async (user, subject, message) => {
  if (!user?.email) return { sent: false, reason: 'missing_email' };

  if (!resendClient) {
    console.log(`[email] ${subject} -> ${user.email}: ${message}`);
    return { sent: false, reason: 'missing_resend' };
  }

  try {
    const { data, error } = await resendClient.emails.send({
      from: getFromAddress(),
      to: [user.email],
      subject,
      html: `<p>${message.replace(/\n/g, '<br />')}</p>`
    });

    if (error) {
      console.error('[email] resend error', error);
      return { sent: false, reason: 'resend_error' };
    }

    return { sent: true, id: data?.id };
  } catch (error) {
    console.error('[email] send failure', error);
    return { sent: false, reason: 'exception' };
  }
};

module.exports = { sendOrderUpdateEmail };
