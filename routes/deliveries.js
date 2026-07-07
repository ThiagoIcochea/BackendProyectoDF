const express = require("express");
const router = express.Router();

const Delivery = require("../models/Delivery");
const Payment = require("../models/Payment");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");

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

        // Validaciones condicionales según el tipo de entrega (shipping o pickup)
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

        // Patrón Upsert: busca entrega existente para evitar duplicidad de registros logísticos
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

        if (deliveryType === "shipping") {
            delivery.destinationAddress = destinationAddress;
            delivery.reference = reference;
            delivery.agency = agency;
        } else {
            // Limpieza de campos de envío para evitar datos residuales en retiro (pickup)
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
        const { destinationAddress, reference, agency, trackingCode, estimatedDate, status } = req.body;
        
        const delivery = await Delivery.findById(id);
        if (!delivery) {
            return res.status(404).json({ message: "Entrega no encontrada." });
        }
        
        // Validaciones condicionales al editar el despacho por ID
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
        
        // Asignación de campos según el tipo de entrega omnicanal
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
 * @desc    Actualizar el estado logístico de una entrega de forma rápida y exclusiva
 * @access  Solo Administradores
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
