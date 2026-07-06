const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema({
    cliente: String,

    tipo_comprobante: { type: String, enum: ['boleta', 'factura'], default: 'boleta' },
    documento: String,
    razon_social: String,

    metodo_envio: { type: String, enum: ['delivery', 'recojo', 'presencial'], default: 'delivery' },
    
    // ANÁLISIS CRÍTICO: Se observa una mezcla de idiomas (Spanglish) en el esquema original:
    // campos como 'cliente', 'tipo_comprobante', 'direccion_entrega' (español) conviven con 'total', 
    // 'timestamps' y ahora 'deliveryType' (inglés). Lo ideal en entornos profesionales es estandarizar todo 
    // en inglés para mantener consistencia. Mantenemos la estructura actual para evitar romper integraciones.
    // 
    // CÓMO: Definimos 'deliveryType' como un String con enum limitado a 'shipping' y 'pickup'.
    // POR QUÉ: Permite mapear de forma inequívoca el canal logístico elegido por el usuario en el checkout 
    // y propagarlo directamente hacia el módulo de despachos durante la confirmación/captura del pago.
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