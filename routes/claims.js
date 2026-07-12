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
const { sendOrderUpdateEmail } = require('../utils/emailNotifications');
const { evaluateClaimDescription } = require('../utils/claimReview');

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
    const { status, resolution, newDeliveryStatus, cancellationReason, deliveryCode } = req.body;

    const claim = await Claim.findById(id).populate('delivery').session(session);
    if (!claim) {
      return res.status(404).json({ message: 'Reclamo no encontrado.' });
    }

    claim.status = status || 'resolved';
    claim.resolution = resolution || 'approved';
    await claim.save({ session });

    const delivery = await Delivery.findById(claim.delivery._id).session(session);
    if (delivery) {
      if (newDeliveryStatus) {
        delivery.status = newDeliveryStatus;
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
