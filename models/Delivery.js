const mongoose = require("mongoose");

const DeliverySchema = new mongoose.Schema({
    paymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment",
        required: [true, "La referencia al pago (paymentId) es obligatoria."]
    },
    deliveryType: {
        type: String,
        enum: {
            values: ["shipping", "pickup"],
            message: "{VALUE} no es un tipo de entrega válido (debe ser shipping o pickup)."
        },
        required: [true, "El tipo de entrega (deliveryType) es obligatorio."]
    },
    status: {
        type: String,
        enum: {
            values: ["pending", "ready_for_pickup", "shipped", "delivered"],
            message: "{VALUE} no es un estado de entrega válido."
        },
        default: "pending"
    },
    // Se utiliza una función tradicional para enlazar el contexto de 'this' en la evaluación dinámica del tipo de entrega
    destinationAddress: {
        type: String,
        required: function() {
            return this.deliveryType === "shipping";
        }
    },
    reference: {
        type: String,
        required: function() {
            return this.deliveryType === "shipping";
        }
    },
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
