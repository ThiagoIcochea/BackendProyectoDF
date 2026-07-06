const mongoose = require("mongoose");

// ANÁLISIS CRÍTICO DEL DISEÑO ANTERIOR:
// 1. El modelo original forzaba 'destinationAddress' como requerido sin importar el tipo de entrega.
//    Esto impedía la creación de despachos para 'pickup' (retiro en tienda), obligando a guardar datos ficticios.
// 2. Se utilizaba 'deliveryStatus' y 'shippingAgency'. Para adaptarnos a la especificación y estandarizar 
//    el diseño de la API, se renombran a 'status' y 'agency', respectivamente.
//    Nota: Si hay datos existentes en producción, renombrar estos campos requerirá un script de migración.

const DeliverySchema = new mongoose.Schema({
    // CÓMO: Relación estricta con el esquema Payment usando ObjectId.
    // POR QUÉ: Garantiza la integridad referencial y permite poblar (populate) la información del pago/orden.
    paymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment",
        required: [true, "La referencia al pago (paymentId) es obligatoria."]
    },

    // CÓMO: Definimos 'deliveryType' con un enum limitado a ['shipping', 'pickup'].
    // POR QUÉ: Controla el flujo lógico y activa dinámicamente las validaciones condicionales de dirección y agencia.
    deliveryType: {
        type: String,
        enum: {
            values: ["shipping", "pickup"],
            message: "{VALUE} no es un tipo de entrega válido (debe ser shipping o pickup)."
        },
        required: [true, "El tipo de entrega (deliveryType) es obligatorio."]
    },

    // CÓMO: Cambiamos 'deliveryStatus' a 'status' con enums específicos.
    // POR QUÉ: Refleja los estados de la logística omnicanal solicitados por el negocio.
    status: {
        type: String,
        enum: {
            values: ["pending", "ready_for_pickup", "shipped", "delivered"],
            message: "{VALUE} no es un estado de entrega válido."
        },
        default: "pending"
    },

    // CÓMO: Se usa una función tradicional (NO una función flecha) para el validador 'required'.
    // POR QUÉ: Las funciones flecha en Javascript no enlazan su propio 'this', por lo que no podrían acceder 
    // al documento de Mongoose para evaluar 'this.deliveryType'.
    destinationAddress: {
        type: String,
        required: function() {
            return this.deliveryType === "shipping";
        }
    },

    // CÓMO: Hacemos que la referencia sea requerida solo si es de tipo 'shipping'.
    reference: {
        type: String,
        required: function() {
            return this.deliveryType === "shipping";
        }
    },

    // CÓMO: Renombramos 'shippingAgency' a 'agency' y lo hacemos condicionalmente requerido.
    agency: {
        type: String,
        required: function() {
            return this.deliveryType === "shipping";
        }
    },

    trackingCode: {
        type: String,
        default: ""
    },

    estimatedDate: {
        type: Date
    }
}, {
    timestamps: true, 
    versionKey: false 
});

module.exports = mongoose.model("Delivery", DeliverySchema);
