const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const Delivery = require("../models/Delivery");
const Payment = require("../models/Payment");
const Product = require("../models/Product");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { sendOrderUpdateEmail } = require("../utils/emailNotifications");
const User = require("../models/User");
const { ensureDeliveryCode } = require("../utils/deliveryCode");

/** 
 * @route   POST /api/deliveries
 * @desc    Registrar o actualizar (Upsert) una orden de entrega asociada a un pago verificado
 * @access  Autenticado
 */
router.post("/", verifyToken, async (req, res) => {
    try {
        const { paymentId, destinationAddress, reference, agency, estimatedDate } = req.body;

        if (!paymentId) {
            return res.status(400).json({
                message: "El campo paymentId es estrictamente obligatorio para registrar una entrega."
            });
        }

        const payment = await Payment.findById(paymentId);
        if (!payment) {
            return res.status(404).json({
                message: `No se encontró ningún registro de pago asociado al ID: ${paymentId}`
            });
        }

        if (payment.estado !== "Pagado") {
            return res.status(400).json({
                message: `El pago referenciado no está liquidado. Estado actual: '${payment.estado}'. No se puede registrar la entrega.`
            });
        }

        const deliveryType = payment.deliveryType || "shipping";

        if (deliveryType === "pickup") {
            if (destinationAddress || reference || agency) {
                return res.status(400).json({
                    message: "No se permiten enviar datos de dirección, referencia ni agencia para un retiro en tienda (pickup)."
                });
            }
        } else if (deliveryType === "shipping") {
            if (!destinationAddress || !reference || !agency) {
                return res.status(400).json({
                    message: "Los campos destinationAddress, reference y agency son obligatorios para envíos a domicilio/agencia (shipping)."
                });
            }
        }

        let delivery = await Delivery.findOne({ paymentId });
        let isNew = false;

        if (!delivery) {
            isNew = true;
            delivery = new Delivery({
                paymentId,
                deliveryType,
                status: "pending",
                user: req.user.id
            });
        } else {
            if (!delivery.user) {
                delivery.user = req.user.id;
            }
        }

        if (deliveryType === "shipping") {
            delivery.destinationAddress = destinationAddress;
            delivery.reference = reference;
            delivery.agency = agency;
        } else {
            delivery.destinationAddress = undefined;
            delivery.reference = undefined;
            delivery.agency = undefined;
        }

        if (estimatedDate) {
            delivery.estimatedDate = new Date(estimatedDate);
        }

        await delivery.save();

        return res.status(isNew ? 201 : 200).json({
            message: isNew ? "Entrega creada con éxito" : "Entrega actualizada con éxito",
            delivery
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/deliveries
 * @desc    Obtener todas las entregas ordenadas de forma descendente poblando la relación con Payment
 * @access  Solo Administradores
 */
router.get("/", verifyToken, isAdmin, async (req, res) => {
    try {
        const deliveries = await Delivery.find()
            .populate("paymentId")
            .sort({ createdAt: -1 });
        return res.json(deliveries);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/deliveries/my-orders
 * @desc    Obtener el historial de compras/entregas del usuario logueado
 * @access  Autenticado
 */
router.get("/my-orders", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const orders = await Delivery.find({ user: userId })
            .populate("paymentId")
            .sort({ createdAt: -1 });

        return res.json(orders);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/deliveries/:paymentId
 * @desc    Obtener la entrega asociada a un pago en específico poblando la relación con Payment
 * @access  Autenticado
 */
router.get("/:paymentId", verifyToken, async (req, res) => {
    try {
        const { paymentId } = req.params;

        const delivery = await Delivery.findOne({ paymentId }).populate("paymentId");

        if (!delivery) {
            return res.status(404).json({
                message: `No se encontró ninguna orden de entrega asociada al pago: ${paymentId}`
            });
        }

        return res.json(delivery);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   PUT /api/deliveries/:id
 * @desc    Actualizar detalles generales de una entrega por su ID
 * @access  Solo Administradores
 */
router.put("/:id", verifyToken, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { destinationAddress, reference, agency, trackingCode, estimatedDate, status, deliveryCode, cancellationReason } = req.body;

        const delivery = await Delivery.findById(id);
        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }

        if (delivery.deliveryType === "pickup") {
            if (destinationAddress || reference || agency) {
                return res.status(400).json({
                    message: "No se permiten datos de dirección, referencia ni agencia para despachos de tipo pickup."
                });
            }
        } else if (delivery.deliveryType === "shipping") {
            if (destinationAddress !== undefined && !destinationAddress) {
                return res.status(400).json({ message: "La dirección es obligatoria para envíos a domicilio/agencia." });
            }
            if (reference !== undefined && !reference) {
                return res.status(400).json({ message: "La referencia es obligatoria para envíos a domicilio/agencia." });
            }
            if (agency !== undefined && !agency) {
                return res.status(400).json({ message: "La agencia es obligatoria para envíos a domicilio/agencia." });
            }
        }

        if (delivery.deliveryType === "shipping") {
            if (destinationAddress !== undefined) delivery.destinationAddress = destinationAddress;
            if (reference !== undefined) delivery.reference = reference;
            if (agency !== undefined) delivery.agency = agency;
        }

        if (trackingCode !== undefined) delivery.trackingCode = trackingCode;
        if (estimatedDate !== undefined) delivery.estimatedDate = estimatedDate ? new Date(estimatedDate) : undefined;
        if (deliveryCode !== undefined) delivery.deliveryCode = deliveryCode;
        if (cancellationReason !== undefined) delivery.cancellationReason = cancellationReason;

        if (status !== undefined) {
            const validStatuses = ["pending", "ready_for_pickup", "shipped", "delivered", "cancelled"];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ message: "Estado de entrega inválido." });
            }
            delivery.status = status;
            if (status === 'cancelled' && delivery.paymentId) {
                const payment = await Payment.findById(delivery.paymentId);
                if (payment?.productos?.length) {
                    for (const item of payment.productos) {
                        await Product.findOneAndUpdate(
                            { name: item.name },
                            { $inc: { stock: Number(item.quantity || 0) } }
                        );
                    }
                }
            }
        }

        await delivery.save();

        const userDoc = await User.findById(delivery.user);
        if (userDoc) {
            await sendOrderUpdateEmail(userDoc, 'Actualización de tu pedido', `Tu pedido ha cambiado al estado: ${delivery.status}.\n${delivery.deliveryCode ? `Código de entrega: ${delivery.deliveryCode}` : ''}`);
        }

        return res.json({ message: "Entrega actualizada con éxito.", delivery });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   PATCH /api/deliveries/:id/status
 * @desc    Actualizar el estado logístico de una entrega de forma rápida y exclusiva
 * @access  Solo Administradores
 */
router.patch("/:id/status", verifyToken, isAdmin, async (req, res) => {
    try {
        const { status, deliveryCode } = req.body;
        const allowedStatuses = ["ready_for_pickup", "shipped", "delivered", "cancelled"];

        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({
                message: `El estado proporcionado no es válido para este endpoint rápido. Los estados permitidos son: ${allowedStatuses.join(", ")}.`
            });
        }

        const delivery = await Delivery.findById(req.params.id);

        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }

        if (status === "ready_for_pickup") {
            if (!delivery.deliveryCode) {
                ensureDeliveryCode(delivery);
            }
        }

        if (status === "delivered") {
            if (!deliveryCode) {
                return res.status(400).json({ message: "Para confirmar la entrega debes ingresar el código de validación." });
            }
            if (String(delivery.deliveryCode || '').trim() && String(delivery.deliveryCode).trim() !== String(deliveryCode).trim()) {
                return res.status(400).json({ message: "El código de validación no coincide." });
            }
            if (!delivery.deliveryCode) {
                delivery.deliveryCode = deliveryCode;
            }
        }

        delivery.status = status;
        if (deliveryCode !== undefined && status === "delivered") {
            delivery.deliveryCode = deliveryCode;
        }
        await delivery.save();

        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }

        const userDoc = await User.findById(delivery.user);
        if (userDoc) {
            await sendOrderUpdateEmail(userDoc, 'Estado de tu pedido actualizado', `Tu pedido cambió a ${status}.\n${delivery.deliveryCode ? `Código de confirmación: ${delivery.deliveryCode}` : ''}`);
        }

        return res.json({
            message: `Estado de entrega actualizado a '${status}' con éxito.`,
            delivery
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   PUT /api/deliveries/my-orders/:id/return
 * @desc    Procesar la devolución de un pedido (entrega, pago y stock) de forma atómica
 * @access  Autenticado
 */
router.put("/my-orders/:id/return", verifyToken, async (req, res) => {
    const session = await mongoose.startSession();
    try {
        let responsePayload = null;

        await session.withTransaction(async () => {
            const { id } = req.params;
            const returnCost = Number(req.body?.returnCost) || 0;

            if (returnCost < 0) {
                const err = new Error("El costo de devolución no puede ser un número negativo.");
                err.status = 400;
                throw err;
            }

            const delivery = await Delivery.findById(id).session(session);

            if (!delivery || !delivery.user || delivery.user.toString() !== req.user.id) {
                const err = new Error("Pedido no encontrado o no autorizado");
                err.status = 403;
                throw err;
            }

            if (delivery.status !== "delivered") {
                const err = new Error(`No se puede procesar la devolución. El estado actual de la entrega es '${delivery.status}' (debe ser 'delivered').`);
                err.status = 400;
                throw err;
            }

            delivery.status = "returned";
            delivery.returnCost = returnCost;
            await delivery.save({ session });

            const payment = await Payment.findById(delivery.paymentId).session(session);

            if (!payment) {
                const err = new Error("Pago asociado no encontrado o no autorizado");
                err.status = 404;
                throw err;
            }

            const previousPaymentStatus = payment.estado;
            payment.estado = "Refunded";
            await payment.save({ session });

            if (payment.productos && payment.productos.length > 0) {
                for (const productItem of payment.productos) {
                    const productDoc = await Product.findOne({ name: productItem.name }).session(session);
                    if (!productDoc) {
                        const err = new Error(`Producto no encontrado en el catálogo: ${productItem.name}`);
                        err.status = 404;
                        throw err;
                    }
                }

                const bulkOps = payment.productos.map(productItem => {
                    return {
                        updateOne: {
                            filter: { name: productItem.name },
                            update: { $inc: { stock: productItem.quantity } }
                        }
                    };
                });

                await Product.bulkWrite(bulkOps, { session });
            }

            responsePayload = {
                success: true,
                message: "La orden de devolución ha sido procesada con éxito y el stock ha sido repuesto.",
                claim: {
                    deliveryId: delivery._id,
                    paymentId: payment._id,
                    status: delivery.status,
                    returnCost: delivery.returnCost,
                    returnedAt: delivery.updatedAt
                },
                paymentDetails: {
                    previousStatus: previousPaymentStatus,
                    newStatus: payment.estado,
                    totalRefunded: payment.total
                },
                restoredProducts: payment.productos.map(productItem => ({
                    name: productItem.name,
                    quantityRestored: productItem.quantity
                }))
            };
        });

        return res.status(200).json(responsePayload);

    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            error: error.message
        });
    } finally {
        session.endSession();
    }
});

module.exports = router;
