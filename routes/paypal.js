const express = require("express");
const router = express.Router();

const Payment = require("../models/Payment");
const Delivery = require("../models/Delivery");
const Log = require("../models/Log");
const Product = require("../models/Product");
const verifyToken = require("../middlewares/verifyToken");
const wsBroadcast = require("../utils/wsBroadcast");
const { createPayPalOrder, capturePayPalOrder } = require("../utils/paypalHelper");

/**
 * El frontend requiere el ID de la orden de PayPal para inicializar los botones de pago 
 * y permitir que el usuario apruebe la transacción en la interfaz segura de PayPal.
 */
router.post("/create-order", verifyToken, async (req, res) => {
    try {
        const { total } = req.body;

        if (!total || isNaN(total) || total <= 0) {
            return res.status(400).json({ message: "El monto total de la compra debe ser un número mayor a cero" });
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
 * @desc    Captura una orden aprobada por el usuario en PayPal y registra el pago en MongoDB
 * @access  Autenticado
 * 
 * ¿CÓMO funciona?
 * 1. Invoca el helper 'capturePayPalOrder' para confirmar y transferir los fondos de PayPal.
 * 2. Valida que el estado retornado por PayPal sea 'COMPLETED'.
 * 3. Guarda el pago en la base de datos (MongoDB) usando el modelo común 'Payment' con estado 'Pagado'.
 * 4. Dispara las alertas por websockets si hay productos con descuento elegibles.
 * 5. Genera el registro de auditoría (Log).
 * 
 * ¿POR QUÉ esta estructura?
 * Garantiza que solo guardemos el pago en base de datos si la pasarela de PayPal certifica 
 * que los fondos fueron cobrados de forma exitosa. Mantiene paridad con la lógica de auditoría
 * y notificaciones web del router manual original.
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

        // Llama a PayPal para capturar oficialmente el dinero
        const captureResult = await capturePayPalOrder(orderId);

        // Verificamos si la orden fue capturada exitosamente
        if (captureResult.status !== "COMPLETED") {
            return res.status(400).json({
                message: "No se pudo capturar el pago. El estado de la transacción no es COMPLETED",
                status: captureResult.status
            });
        }

        // Mapeamos los datos de pago al esquema Payment de MongoDB
        // Establecemos explícitamente el estado a "Pagado" ya que PayPal completó el cobro
        const payment = new Payment({
            ...paymentData,
            estado: "Pagado"
        });

        await payment.save();

        // ANÁLISIS CRÍTICO DEL DISEÑO ANTERIOR:
        // Los pagos exitosos se guardaban pero no generaban su respectiva orden logística en Delivery de forma reactiva.
        // Esto causaba que el panel de administración de despachos quedara a ciegas.
        // 
        // CÓMO: Instanciamos y guardamos un nuevo documento 'Delivery' asociado al pago.
        // POR QUÉ: Asegura la integridad lógica y la aparición inmediata de la orden en el dashboard logístico.
        // Si es de tipo 'shipping', asignamos valores por defecto a los campos obligatorios para no violar 
        // las restricciones del esquema en base de datos.
        const reactiveDelivery = new Delivery({
            paymentId: payment._id,
            deliveryType: payment.deliveryType || "shipping",
            status: "pending",
            destinationAddress: payment.deliveryType === "shipping" 
                ? (payment.direccion_entrega || "Pendiente de registro") 
                : undefined,
            reference: payment.deliveryType === "shipping" 
                ? (payment.referencia || "Pendiente de registro") 
                : undefined,
            agency: payment.deliveryType === "shipping" 
                ? "Pendiente de registro" 
                : undefined
        });

        await reactiveDelivery.save();

        // Lógica de Alertas de Compra para WebSockets (Mismo comportamiento que el router manual)
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

        // Registro de Auditoría (Logs)
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "IP Desconocida";
        const userAgent = req.headers['user-agent'] || "Dispositivo Desconocido";
        
        const auditLog = new Log({
            ip: clientIp,
            usuario: payment.cliente || "Anónimo",
            descripcion: `Compra registrada por PayPal - OrderID: ${orderId} | PagoID: ${payment._id} | Total: $ ${payment.total}`,
            tipo: "TRANSACCION",
            metodo: req.method,
            ruta: req.originalUrl,
            userAgent: userAgent
        });

        await auditLog.save();

        return res.status(200).json({
            message: "Pago de PayPal capturado y registrado con éxito",
            payment
        });

    } catch (error) {
        console.error("Error al capturar orden de PayPal:", error);

        // Registro de log de error
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
            console.error("Error crítico: No se pudo registrar el log del fallo", logError);
        }

        return res.status(500).json({ message: "Error interno al capturar el pago", error: error.message });
    }
});

module.exports = router;
