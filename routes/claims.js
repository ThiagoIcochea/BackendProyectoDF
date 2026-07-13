const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Claim = require('../models/Claim');
const Delivery = require('../models/Delivery');
const Payment = require('../models/Payment');
const User = require('../models/User');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { canCreateClaim } = require('../utils/orderFlow');
const { sendOrderUpdateEmail, sendVerificationCodeEmail } = require('../utils/emailNotifications');
const { evaluateClaimDescription } = require('../utils/claimReview');
const { syncStatusHistory } = require('../utils/deliveryStatusHistory');
const { recordLog } = require('../utils/logger');
const { isValidStatusTransition, getAllowedNextStatuses, getStatusLabel } = require('../utils/deliveryStatusFlow');

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));
const generateTempToken = () => require('crypto').randomBytes(24).toString('hex');

const OTP_EXPIRE_MS = 5 * 60 * 1000;
const resendClient = process.env.RESEND_API_KEY ? new (require('resend').Resend)(process.env.RESEND_API_KEY) : null;

const sendActionMfaCode = async (user, code, method = 'email') => {
  const selectedMethod = String(method || 'email').toLowerCase();
  if (selectedMethod === 'console') {
    console.log(`[MFA reclamo] Código para ${user.email}: ${code}`);
    return { sentBy: 'console' };
  }

  const result = await sendVerificationCodeEmail(user, code, {
    subject: 'Código para confirmar la cancelación del pedido - Nendoshop',
    title: 'Confirmación de cancelación',
    description: 'Tu código para confirmar la cancelación del pedido es:'
  });

  if (!result.sent) {
    return { sentBy: 'email', error: true, reason: result.reason, message: result.message };
  }

  return { sentBy: 'email' };
};

const issueActionMfa = async (user, method = 'email') => {
  const code = generateCode();
  const tempToken = generateTempToken();
  const now = new Date();
  const selectedMethod = String(method || 'email').toLowerCase();
  await sendActionMfaCode(user, code, selectedMethod);

  user.twoFactorCode = code;
  user.twoFactorMethod = selectedMethod === 'console' ? 'console' : 'email';
  user.twoFactorTempToken = tempToken;
  user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
  user.twoFactorLastSentAt = now;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  await user.save();

  return tempToken;
};

const verifyActionMfa = async (user, tempToken, code) => {
  const now = new Date();
  const valid = user.twoFactorTempToken === tempToken && Boolean(user.twoFactorCode) &&
    user.twoFactorCode === String(code || '').trim() && user.twoFactorExpires && user.twoFactorExpires >= now;

  if (!valid) return false;

  user.twoFactorCode = null;
  user.twoFactorExpires = null;
  user.twoFactorTempToken = null;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  user.twoFactorLastSentAt = null;
  user.twoFactorMethod = null;
  await user.save();
  return true;
};

router.get('/my-claims', verifyToken, async (req, res) => {
  try {
    const claims = await Claim.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', verifyToken, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { deliveryId, category, description, resolution } = req.body;

    if (!deliveryId || !category || !description) {
      return res.status(400).json({ message: 'deliveryId, category y description son obligatorios.' });
    }

    const delivery = await Delivery.findById(deliveryId).session(session);
    if (!delivery) {
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }

    if (String(delivery.user) !== req.user.id) {
      return res.status(403).json({ message: 'No autorizado.' });
    }

    const payment = await Payment.findById(delivery.paymentId).session(session);
    const existingClaims = await Claim.find({ delivery: delivery._id, status: 'pending' }).session(session);
    const decision = canCreateClaim({
      category,
      currentStatus: delivery.status,
      deadlineDate: delivery.estimatedDate || payment?.fecha,
      existingClaims
    }, new Date());

    if (!decision.allowed) {
      return res.status(400).json({ message: decision.reason });
    }

    const review = await evaluateClaimDescription(description, category);
    if (!review.validClaim) {
      return res.status(400).json({ message: review.reason });
    }

    const claim = new Claim({
      delivery: delivery._id,
      payment: payment?._id,
      user: req.user.id,
      category,
      description,
      resolution: resolution || 'pending',
      status: 'pending'
    });

    await claim.save({ session });
    await recordLog({ req, usuario: req.user?.email || req.user?.name || 'usuario', descripcion: `Reclamo ${claim._id} registrado para pedido ${delivery._id}`, tipo: 'RECLAMO', metodo: req.method, ruta: req.originalUrl });

    const userDoc = await User.findById(req.user.id).session(session);
    await sendOrderUpdateEmail(userDoc, 'Reclamo registrado en Nendoshop', `Hemos recibido tu reclamo por ${category}.\nPronto revisaremos tu solicitud y te notificaremos.`);

    res.status(201).json({ message: 'Reclamo registrado correctamente.', claim });
  } catch (error) {
    res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
});

router.get('/', verifyToken, isAdmin, async (req, res) => {
  try {
    const claims = await Claim.find().populate('delivery').populate('payment').sort({ createdAt: -1 });
    res.json(claims);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.patch('/:id/resolve', verifyToken, isAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { status, resolution, newDeliveryStatus, cancellationReason, deliveryCode, mfaCode, tempToken, method } = req.body;

    const claim = await Claim.findById(id).populate('delivery').session(session);
    if (!claim) {
      return res.status(404).json({ message: 'Reclamo no encontrado.' });
    }

    claim.status = status || 'resolved';
    claim.resolution = resolution || 'approved';
    await claim.save({ session });

    const delivery = await Delivery.findById(claim.delivery._id).session(session);
    if (delivery) {
      const payment = delivery.paymentId ? await Payment.findById(delivery.paymentId).session(session) : null;
      const deliveryType = delivery.deliveryType || payment?.deliveryType || 'shipping';

      if (newDeliveryStatus === 'pending') {
        delivery.status = 'pending';
        syncStatusHistory(delivery, 'pending', { note: resolution || `Reclamo ${claim.status}` });
      } else if (newDeliveryStatus === 'cancelled') {
        const adminUser = await User.findById(req.user.id).session(session);
        if (!adminUser) {
          return res.status(404).json({ message: 'Administrador no encontrado.' });
        }

        if (!mfaCode || !tempToken) {
          const normalizedMethod = String(method || 'email').toLowerCase();
          const safeMethod = ['email', 'sms', 'call', 'whatsapp', 'console'].includes(normalizedMethod) ? normalizedMethod : 'email';
          const newTempToken = await issueActionMfa(adminUser, safeMethod);
          return res.status(202).json({
            twoFactorRequired: true,
            tempToken: newTempToken,
            method: safeMethod,
            message: 'Te enviamos un código MFA para confirmar la cancelación del pedido desde el reclamo.'
          });
        }

        const mfaOk = await verifyActionMfa(adminUser, tempToken, mfaCode);
        if (!mfaOk) {
          return res.status(401).json({ message: 'Código MFA incorrecto o expirado.' });
        }
      }

      if (newDeliveryStatus) {
        const currentStatus = delivery.status;
        const allowed = ['pending','shipped','ready_for_pickup','delivered','cancelled','returned'];
        if (!allowed.includes(newDeliveryStatus)) {
          return res.status(400).json({ message: 'Estado de entrega inválido.' });
        }
        const isAllowedTransition = newDeliveryStatus === currentStatus || newDeliveryStatus === 'pending' || (newDeliveryStatus === 'cancelled' && ['pending','shipped','ready_for_pickup','delivered'].includes(currentStatus)) || (newDeliveryStatus === 'returned' && ['delivered'].includes(currentStatus)) || isValidStatusTransition(currentStatus, newDeliveryStatus, deliveryType);
        if (!isAllowedTransition) {
          return res.status(400).json({ message: 'El reclamo solo puede mover el pedido a un estado válido y permitido por la logística.' });
        }
        delivery.status = newDeliveryStatus;
        syncStatusHistory(delivery, newDeliveryStatus, { note: resolution || `Reclamo ${claim.status}` });
      }
      if (cancellationReason) {
        delivery.cancellationReason = cancellationReason;
      }
      if (deliveryCode) {
        delivery.deliveryCode = deliveryCode;
      }
      await delivery.save({ session });

      if ((newDeliveryStatus === 'cancelled' || newDeliveryStatus === 'returned') && delivery.paymentId) {
        const payment = await Payment.findById(delivery.paymentId).session(session);
        if (payment?.productos?.length) {
          for (const item of payment.productos) {
            await mongoose.model('Product').findOneAndUpdate(
              { name: item.name },
              { $inc: { stock: Number(item.quantity || 0) } },
              { session }
            );
          }
        }

        if (newDeliveryStatus === 'returned' && payment) {
          payment.estado = 'Refunded';
          await payment.save({ session });
        }
      }

      const statusLabel = {
        pending: 'pendiente',
        ready_for_pickup: 'listo para recojo',
        shipped: 'enviado',
        delivered: 'entregado',
        cancelled: 'cancelado',
        returned: 'devuelto'
      }[delivery.status] || delivery.status;

      const userDoc = await User.findById(claim.user).session(session);
      await sendOrderUpdateEmail(userDoc, 'Actualización de tu reclamo', `Tu reclamo ha sido ${claim.status === 'resolved' ? 'resuelto' : 'actualizado'}.\n${resolution || 'Revisa la información en tu pedido.'}\nEstado del pedido: ${statusLabel}.`);
    }

    res.json({ message: 'Reclamo actualizado correctamente.', claim, delivery });
  } catch (error) {
    res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
