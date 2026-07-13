const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { Resend } = require("resend");
const router = express.Router();

const Delivery = require("../models/Delivery");
const Payment = require("../models/Payment");
const Product = require("../models/Product");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { sendOrderUpdateEmail } = require("../utils/emailNotifications");
const User = require("../models/User");
const { ensureDeliveryCode } = require("../utils/deliveryCode");
const { syncStatusHistory } = require("../utils/deliveryStatusHistory");
const { isValidStatusTransition, getAllowedNextStatuses, getStatusLabel } = require("../utils/deliveryStatusFlow");
const { recordLog } = require("../utils/logger");

const OTP_EXPIRE_MS = 5 * 60 * 1000;
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));
const generateTempToken = () => crypto.randomBytes(24).toString("hex");

const sendActionMfaCode = async (user, code, method = "email") => {
    const selectedMethod = String(method || "email").toLowerCase();

    if (selectedMethod === "console" || !resendClient) {
        console.log(`[MFA cancelacion] Codigo para ${user.email}: ${code}`);
        return { sentBy: "console" };
    }

    const from = (process.env.RESEND_FROM_EMAIL || "Nendoshop <notificaciones@freecodingvibes.shop>").trim();
    await resendClient.emails.send({
        from,
        to: user.email,
        subject: "Codigo para cancelar tu pedido - Nendoshop",
        text: `Hola ${user.name || user.email}, tu codigo para cancelar el pedido es: ${code}. Expira en 5 minutos.`,
        html: `<p>Hola ${user.name || user.email},</p><p>Tu codigo para cancelar el pedido es:</p><h2>${code}</h2><p>Expira en 5 minutos. Si no solicitaste esta accion, ignora este mensaje.</p>`
    });
    return { sentBy: "email" };
};

const issueActionMfa = async (user, method = "email") => {
    const code = generateCode();
    const tempToken = generateTempToken();
    const now = new Date();
    const selectedMethod = String(method || "email").toLowerCase();
    await sendActionMfaCode(user, code, selectedMethod);

    user.twoFactorCode = code;
    user.twoFactorMethod = selectedMethod === "console" ? "console" : "email";
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
    const valid = user.twoFactorTempToken === tempToken &&
        Boolean(user.twoFactorCode) &&
        user.twoFactorCode === String(code || "").trim() &&
        user.twoFactorExpires &&
        user.twoFactorExpires >= now;

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

const restockPaymentProducts = async (paymentId, session = null) => {
    const paymentQuery = Payment.findById(paymentId);
    const payment = session ? await paymentQuery.session(session) : await paymentQuery;
    if (!payment?.productos?.length) return;

    for (const item of payment.productos) {
        const update = Product.findOneAndUpdate(
            { name: item.name },
            { $inc: { stock: Number(item.quantity || 0) } }
        );
        if (session) await update.session(session);
        else await update;
    }
};

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
                statusHistory: [{ status: "pending", timestamp: new Date(), note: "Pedido registrado" }],
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
            const validStatuses = ["pending", "ready_for_pickup", "shipped", "delivered", "cancelled", "returned"];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ message: "Estado de entrega inválido." });
            }
            const previousStatus = delivery.status;
            delivery.status = status;
            syncStatusHistory(delivery, status, {
                note: cancellationReason || `Estado actualizado por administracion: ${status}`
            });
            if (status === 'cancelled' && previousStatus !== 'cancelled' && delivery.paymentId) {
                await restockPaymentProducts(delivery.paymentId);
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
        const { status, deliveryCode, mfaCode, tempToken, method } = req.body;
        const allowedStatuses = ["pending", "ready_for_pickup", "shipped", "delivered", "cancelled", "returned"];

        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({
                message: `El estado proporcionado no es válido para este endpoint rápido. Los estados permitidos son: ${allowedStatuses.join(", ")}.`
            });
        }

        const delivery = await Delivery.findById(req.params.id);

        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }

        const payment = delivery.paymentId ? await Payment.findById(delivery.paymentId) : null;
        const deliveryType = delivery.deliveryType || payment?.deliveryType || "shipping";

        if (!isValidStatusTransition(delivery.status, status, deliveryType)) {
            return res.status(400).json({
                message: `No puedes avanzar desde '${getStatusLabel(delivery.status)}' hacia '${getStatusLabel(status)}'. Los cambios permitidos son: ${getAllowedNextStatuses(delivery.status, deliveryType).map(getStatusLabel).join(", ") || "ninguno"}.`
            });
        }

        if (status === "cancelled") {
            const adminUser = await User.findById(req.user.id);
            if (!adminUser) {
                return res.status(404).json({ message: "Administrador no encontrado." });
            }

            if (!mfaCode || !tempToken) {
                const newTempToken = await issueActionMfa(adminUser, method);
                return res.status(202).json({
                    twoFactorRequired: true,
                    tempToken: newTempToken,
                    message: "Te enviamos un codigo MFA para confirmar la cancelacion del pedido."
                });
            }

            const mfaOk = await verifyActionMfa(adminUser, tempToken, mfaCode);
            if (!mfaOk) {
                return res.status(401).json({ message: "Codigo MFA incorrecto o expirado." });
            }
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

        const previousStatus = delivery.status;
        delivery.status = status;
        syncStatusHistory(delivery, status, { note: `Estado logistico actualizado: ${status}` });
        if (deliveryCode !== undefined && status === "delivered") {
            delivery.deliveryCode = deliveryCode;
        }
        if (status === "cancelled" && previousStatus !== "cancelled" && delivery.paymentId) {
            await restockPaymentProducts(delivery.paymentId);
        }
        await delivery.save();
        await recordLog({
            req,
            usuario: req.user?.email || req.user?.name || "admin",
            descripcion: `Estado de pedido actualizado a ${status} para ${delivery._id}`,
            tipo: "PEDIDO",
            metodo: req.method,
            ruta: req.originalUrl
        });

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
            syncStatusHistory(delivery, "returned", { note: "Devolucion procesada" });
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

router.post("/my-orders/:id/cancel/request", verifyToken, async (req, res) => {
    try {
        const delivery = await Delivery.findById(req.params.id);
        if (!delivery || String(delivery.user) !== req.user.id) {
            return res.status(404).json({ message: "Pedido no encontrado." });
        }

        if (!["pending", "ready_for_pickup"].includes(delivery.status)) {
            return res.status(400).json({ message: "Solo puedes cancelar pedidos pendientes o listos para recojo. Si ya fue enviado, genera un reclamo." });
        }

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: "Usuario no encontrado." });
        }

        const selectedMethod = String(req.body?.method || "email").toLowerCase();
        const code = generateCode();
        const tempToken = generateTempToken();
        const now = new Date();
        await sendActionMfaCode(user, code, selectedMethod);

        user.twoFactorCode = code;
        user.twoFactorMethod = selectedMethod === "console" ? "console" : "email";
        user.twoFactorTempToken = tempToken;
        user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
        user.twoFactorLastSentAt = now;
        user.twoFactorAttempts = 0;
        user.twoFactorBlockedUntil = null;
        await user.save();

        await recordLog({
            req,
            usuario: req.user?.email || req.user?.name || "usuario",
            descripcion: `Solicitud de cancelación de pedido ${delivery._id}`,
            tipo: "PEDIDO",
            metodo: req.method,
            ruta: req.originalUrl
        });

        return res.json({
            twoFactorRequired: true,
            tempToken,
            message: "Te enviamos un codigo de verificacion para confirmar la cancelacion."
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
});

router.post("/my-orders/:id/cancel/confirm", verifyToken, async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const { code, tempToken, reason, method } = req.body;
        if (!code || !tempToken) {
            return res.status(400).json({ message: "Codigo MFA y token temporal son obligatorios." });
        }

        let responsePayload = null;
        await session.withTransaction(async () => {
            const user = await User.findById(req.user.id).session(session);
            if (!user) {
                const err = new Error("Usuario no encontrado.");
                err.status = 404;
                throw err;
            }

            const now = new Date();
            if (user.twoFactorTempToken !== tempToken || !user.twoFactorCode || user.twoFactorCode !== String(code).trim() || !user.twoFactorExpires || user.twoFactorExpires < now) {
                const err = new Error("Codigo MFA incorrecto o expirado.");
                err.status = 401;
                throw err;
            }

            const delivery = await Delivery.findById(req.params.id).session(session);
            if (!delivery || String(delivery.user) !== req.user.id) {
                const err = new Error("Pedido no encontrado.");
                err.status = 404;
                throw err;
            }

            if (!["pending", "ready_for_pickup"].includes(delivery.status)) {
                const err = new Error("Este pedido ya no puede cancelarse directamente. Genera un reclamo para que soporte lo revise.");
                err.status = 400;
                throw err;
            }

            delivery.status = "cancelled";
            delivery.cancellationReason = reason || "Cancelado por el cliente con MFA";
            syncStatusHistory(delivery, "cancelled", { note: delivery.cancellationReason });
            await delivery.save({ session });
            await restockPaymentProducts(delivery.paymentId, session);

            user.twoFactorCode = null;
            user.twoFactorExpires = null;
            user.twoFactorTempToken = null;
            user.twoFactorAttempts = 0;
            user.twoFactorBlockedUntil = null;
            user.twoFactorLastSentAt = null;
            user.twoFactorMethod = null;
            await user.save({ session });

            await recordLog({
                req,
                usuario: req.user?.email || req.user?.name || "usuario",
                descripcion: `Pedido ${delivery._id} cancelado correctamente`,
                tipo: "PEDIDO",
                metodo: req.method,
                ruta: req.originalUrl
            });

            responsePayload = { message: "Pedido cancelado correctamente.", delivery };
        });

        return res.json(responsePayload);
    } catch (error) {
        return res.status(error.status || 500).json({ message: error.message });
    } finally {
        session.endSession();
    }
});

module.exports = router;
