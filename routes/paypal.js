const express = require("express");
const router = express.Router();

const Payment = require("../models/Payment");
const Delivery = require("../models/Delivery");
const Log = require("../models/Log");
const Product = require("../models/Product");
const verifyToken = require("../middlewares/verifyToken");
const wsBroadcast = require("../utils/wsBroadcast");
const { createPayPalOrder, capturePayPalOrder } = require("../utils/paypalHelper");
const { calculateDeliveryDeadline } = require("../utils/orderFlow");
const { syncStatusHistory } = require("../utils/deliveryStatusHistory");

/**
 * @route   POST /api/paypal/create-order
 * @desc    Crea una orden en PayPal para iniciar el flujo de pago desde el frontend
 * @access  Autenticado
 */
router.post("/create-order", verifyToken, async (req, res) => {
    try {
        const { total } = req.body;

        if (!total || isNaN(total) || total <= 0) {
            return res.status(400).json({ message: "El monto total de la compra debe ser un n?mero mayor a cero" });
        }

        const payPalOrder = await createPayPalOrder(total);
        
        return res.status(201).json({
            message: "Orden de PayPal creada exitosamente",
            orderId: payPalOrder.id,
            links: payPalOrder.links
        });
    } catch (error) {
        console.error("Error al crear orden en PayPal:", error);
        return res.status(500).json({ message: "Error interno al crear orden en PayPal", error: error.message });
    }
});

/**
 * @route   POST /api/paypal/capture-order
 * @desc    Captura una orden aprobada en PayPal, registra el pago en la base de datos y crea la orden de entrega correspondiente
 * @access  Autenticado
 */
router.post("/capture-order", verifyToken, async (req, res) => {
    try {
        const { orderId, paymentData } = req.body;

        if (!orderId) {
            return res.status(400).json({ message: "El campo orderId es obligatorio para capturar el pago" });
        }

        if (!paymentData || typeof paymentData !== "object") {
            return res.status(400).json({ message: "Faltan los datos del pago (paymentData) para guardar en base de datos" });
        }

        const captureResult = await capturePayPalOrder(orderId);

        if (captureResult.status !== "COMPLETED") {
            return res.status(400).json({
                message: "No se pudo capturar el pago. El estado de la transacci?n no es COMPLETED",
                status: captureResult.status
            });
        }

        const payment = new Payment({
            ...paymentData,
            estado: "Pagado"
        });

        await payment.save();

        for (const item of payment.productos || []) {
            const quantity = Number(item?.quantity || 0);
            if (quantity <= 0) continue;
            const productDoc = await Product.findOne({ name: item.name });
            if (!productDoc) {
                throw new Error(`Producto no encontrado en el cat?logo: ${item.name}`);
            }
            if ((productDoc.stock || 0) < quantity) {
                throw new Error(`Stock insuficiente para ${item.name}`);
            }
            await Product.findOneAndUpdate(
                { name: item.name },
                { $inc: { stock: -quantity } },
                { new: true }
            );
        }

        // Creaci?n reactiva de la orden log?stica en Delivery asociada al pago
        const reactiveDelivery = new Delivery({
            paymentId: payment._id,
            user: req.user.id,
            deliveryType: payment.deliveryType || "shipping",
            status: "pending",
            statusHistory: [{ status: "pending", timestamp: new Date(), note: "Pedido registrado" }],
            destinationAddress: payment.deliveryType === "shipping" 
                ? (payment.direccion_entrega || "Pendiente de registro") 
                : undefined,
            reference: payment.deliveryType === "shipping" 
                ? (payment.referencia || "Pendiente de registro") 
                : undefined,
            agency: payment.deliveryType === "shipping" 
                ? "Pendiente de registro" 
                : undefined,
            estimatedDate: calculateDeliveryDeadline(payment.fecha, payment.productos || []),
            trackingCode: `TRK-${payment._id.toString().slice(-6).toUpperCase()}`
        });

        await reactiveDelivery.save();

        // Emisi?n de alertas por WebSockets para productos con descuento
        const discountProducts = (payment.productos || []).filter((item) => {
            const quantity = Number(item.quantity || 0);
            return quantity > 0;
        });

        if (discountProducts.length) {
            const discountedCandidates = [];
            for (const item of discountProducts) {
                const itemName = String(item?.name || "").trim();
                let productDoc = null;

                if (itemName) {
                    const escapedName = itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    productDoc = await Product.findOne({
                        $or: [
                            { name: itemName },
                            { name: { $regex: new RegExp(`^${escapedName}$`, "i") } },
                            { name: { $regex: new RegExp(escapedName, "i") } }
                        ]
                    }).catch(() => null);
                }

                const discountValue = Number(productDoc?.discount ?? item?.discount ?? 0);
                if (!discountValue || discountValue <= 0) continue;

                const basePrice = Number(productDoc?.price ?? item?.price ?? 0);
                const discountPrice = discountValue > 1
                    ? Math.max(0, basePrice - discountValue)
                    : Math.max(0, basePrice * (1 - discountValue));

                discountedCandidates.push({
                    name: itemName || productDoc?.name || "Producto con descuento",
                    price: discountPrice,
                    originalPrice: basePrice,
                    discountPercent: discountValue > 1 ? null : discountValue * 100,
                    discountAmount: discountValue > 1 ? discountValue : null,
                    productId: productDoc?._id?.toString?.() || item?.productId || null,
                    productDoc
                });
            }

            if (discountedCandidates.length) {
                discountedCandidates.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
                const selected = discountedCandidates[0];
                wsBroadcast.broadcastPurchaseAlert({
                    id: `${payment._id || Date.now()}-${selected.name}`,
                    customer: payment.cliente || "Un cliente",
                    product: selected.name,
                    productId: selected.productId,
                    price: selected.price,
                    originalPrice: selected.originalPrice,
                    discountPercent: selected.discountPercent,
                    discountAmount: selected.discountAmount,
                    priceLabel: `S/. ${selected.price}`,
                    message: `Aprovecha esta oferta y lleva ${selected.name} con descuento.`
                });
            }
        }

        // Registro del log de auditor?a
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "IP Desconocida";
        const userAgent = req.headers['user-agent'] || "Dispositivo Desconocido";
        
        const auditLog = new Log({
            ip: clientIp,
            usuario: payment.cliente || "An?nimo",
            descripcion: `Compra registrada por PayPal - OrderID: ${orderId} | PagoID: ${payment._id} | Total: $ ${payment.total}`,
            tipo: "TRANSACCION",
            metodo: req.method,
            ruta: req.originalUrl,
            userAgent: userAgent
        });

        await auditLog.save();

        return res.status(200).json({
            message: "Pago de PayPal capturado y registrado con ?xito",
            payment
        });

    } catch (error) {
        console.error("Error al capturar orden de PayPal:", error);

        try {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "IP Desconocida";
            await new Log({
                ip: clientIp,
                usuario: "Sistema",
                descripcion: `Fallo al capturar/guardar pago PayPal: ${error.message}`,
                tipo: "ERROR",
                metodo: req.method,
                ruta: req.originalUrl,
                userAgent: req.headers['user-agent']
            }).save();
        } catch (logError) {
            console.error("Error cr?tico: No se pudo registrar el log del fallo", logError);
        }

        return res.status(500).json({ message: "Error interno al capturar el pago", error: error.message });
    }
});

module.exports = router;
