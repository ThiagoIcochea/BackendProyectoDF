const express = require("express");
const router = express.Router();

const Delivery = require("../models/Delivery");
const Payment = require("../models/Payment");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");

/** 
 * @route   POST /api/deliveries
 * @desc    Registrar o actualizar (Upsert) una orden de entrega asociada a un pago
 * @access  Autenticado (Cualquier usuario logueado)
 *  
 * ANÁLISIS CRÍTICO DEL DISEÑO ANTERIOR:
 * En el diseño original, no se verificaba si ya existía un registro de despacho para el 'paymentId'. 
 * Esto permitía duplicados no deseados en la base de datos (relación lógica 1-a-1 rota). 
 * Se refactoriza para implementar un patrón de "upsert" (creación o actualización) seguro.
 * Además, las validaciones de campos requeridos dependían de una estructura estática. Ahora
 * validamos de manera estricta y dinámica según el 'deliveryType' del pago.
 * 
 * CONTRATO API:
 * - Recibe:
 *   {
 *     "paymentId": "string (Mongoose ObjectId) - Obligatorio",
 *     "destinationAddress": "string - Requerido si deliveryType === 'shipping'",
 *     "reference": "string - Requerido si deliveryType === 'shipping'",
 *     "agency": "string - Requerido si deliveryType === 'shipping'",
 *     "estimatedDate": "string (ISO Date) - Opcional"
 *   }
 * - Retorna:
 *   - 201 Created: { "message": "Entrega creada con éxito", "delivery": { ... } }
 *   - 200 OK: { "message": "Entrega actualizada con éxito", "delivery": { ... } }
 *   - 400 Bad Request: { "message": "Faltan datos obligatorios o formato inválido" }
 *   - 404 Not Found: { "message": "No se encontró el registro de pago" }
 *   - 500 Internal Server Error: { "message": "Error del servidor" }
 */
router.post("/", verifyToken, async (req, res) => {
    try {
        const { paymentId, destinationAddress, reference, agency, estimatedDate } = req.body;

        // CÓMO: Validación inicial de la referencia de pago indispensable.
        if (!paymentId) {
            return res.status(400).json({
                message: "El campo paymentId es estrictamente obligatorio para registrar una entrega."
            });
        }

        // CÓMO: Buscar el pago correspondiente y validar su existencia y su estado 'Pagado'.
        // POR QUÉ: Evitamos despachar productos de transacciones fallidas o pendientes.
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

        // CÓMO: Recuperamos el 'deliveryType' directamente del modelo de pago.
        const deliveryType = payment.deliveryType || "shipping";

        // CÓMO: Validación estricta según el tipo de entrega omnicanal.
        // POR QUÉ: Si es 'pickup', no se deben enviar ni almacenar datos de dirección ni agencia. 
        // Si es 'shipping', se requiere obligatoriamente toda la información del destino.
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

        // CÓMO: Buscamos si ya existe una entrega registrada para este pago.
        // POR QUÉ: Implementamos el Upsert para actualizar la entrega existente si el cliente o sistema re-envía la orden.
        let delivery = await Delivery.findOne({ paymentId });
        let isNew = false;

        if (!delivery) {
            isNew = true;
            delivery = new Delivery({
                paymentId,
                deliveryType,
                status: "pending"
            });
        }

        // CÓMO: Asignamos valores solo si corresponden al flujo logístico.
        if (deliveryType === "shipping") {
            delivery.destinationAddress = destinationAddress;
            delivery.reference = reference;
            delivery.agency = agency;
        } else {
            // Limpiamos campos de envío para evitar persistencia de datos basura en pickup
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
        console.error("Error al registrar/actualizar despacho:", error);
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/deliveries
 * @desc    Obtener todas las entregas (ordenadas de forma descendente)
 * @access  Solo Administradores (verifyToken + isAdmin)
 * 
 * CÓMO: Añadimos '.populate("paymentId")' para obtener los datos de la orden/pago embebidos.
 * POR QUÉ: El frontend requiere mostrar detalles del pago (deliveryType, cliente, total) sin hacer 
 * múltiples consultas a la base de datos, optimizando el rendimiento y red.
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
 * @route   GET /api/deliveries/:paymentId
 * @desc    Obtener la entrega asociada a un pago en específico
 * @access  Autenticado (Usuario dueño o administrador)
 * 
 * CÓMO: Añadimos '.populate("paymentId")' para retornar los datos del pago asociados al despacho.
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
 * @access  Solo Administradores (verifyToken + isAdmin)
 */
router.put("/:id", verifyToken, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { destinationAddress, reference, agency, trackingCode, estimatedDate, status } = req.body;
        
        const delivery = await Delivery.findById(id);
        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }
        
        // CÓMO: Validaciones condicionales al editar el despacho por ID.
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
        
        // CÓMO: Asignación segura de campos editables.
        if (delivery.deliveryType === "shipping") {
            if (destinationAddress !== undefined) delivery.destinationAddress = destinationAddress;
            if (reference !== undefined) delivery.reference = reference;
            if (agency !== undefined) delivery.agency = agency;
        }

        if (trackingCode !== undefined) delivery.trackingCode = trackingCode;
        if (estimatedDate !== undefined) delivery.estimatedDate = estimatedDate ? new Date(estimatedDate) : undefined;
        
        if (status !== undefined) {
            const validStatuses = ["pending", "ready_for_pickup", "shipped", "delivered"];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ message: "Estado de entrega inválido." });
            }
            delivery.status = status;
        }
        
        await delivery.save();
        return res.json({ message: "Entrega actualizada con éxito.", delivery });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route   PATCH /api/deliveries/:id/status
 * @desc    Endpoint rápido y exclusivo para actualizar el estado logístico
 * @access  Solo Administradores (verifyToken + isAdmin)
 * 
 * CÓMO: Filtramos estrictamente el cambio de estado a 'ready_for_pickup', 'shipped' y 'delivered'.
 * POR QUÉ: Permite a los operadores de almacén o repartidores actualizar de forma directa, ágil y segura 
 * el estado logístico, impidiendo modificaciones accidentales sobre otras propiedades de la entrega.
 */
router.patch("/:id/status", verifyToken, isAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        const allowedStatuses = ["ready_for_pickup", "shipped", "delivered"];

        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({
                message: `El estado proporcionado no es válido para este endpoint rápido. Los estados permitidos son: ${allowedStatuses.join(", ")}.`
            });
        }

        const delivery = await Delivery.findById(req.params.id);
        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }

        // CÓMO: Actualizamos únicamente el estado logístico.
        delivery.status = status;
        await delivery.save();

        return res.json({
            message: `Estado de entrega actualizado a '${status}' con éxito.`,
            delivery
        });

    } catch (error) {
        console.error("Error al actualizar estado de despacho:", error);
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;
