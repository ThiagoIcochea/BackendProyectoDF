const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema({
    cliente: String,

    tipo_comprobante: { type: String, enum: ['boleta', 'factura'], default: 'boleta' },
    documento: String,
    razon_social: String,

    metodo_envio: { type: String, enum: ['delivery', 'recojo', 'presencial'], default: 'delivery' },
    
    deliveryType: { 
        type: String, 
        enum: ['shipping', 'pickup'],
        default: 'shipping'
    },
    
    direccion_entrega: String, 
    referencia: String,
    envio: Number,

    productos: [
        {
            name: String,
            quantity: Number,
            price: Number
        }
    ],

    total: Number,

    estado: {
        type: String,
        default: "Pagado"
    },

    fecha: {
        type: Date,
        default: Date.now
    }

}, {
    timestamps: true
});

module.exports = mongoose.model("Payment", PaymentSchema);