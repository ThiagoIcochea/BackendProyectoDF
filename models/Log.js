const mongoose = require("mongoose");

const LogSchema = new mongoose.Schema({
    ip: { 
        type: String, 
        required: true 
    },
    usuario: { 
        type: String, 
        default: "Anónimo" 
    },
    descripcion: { 
        type: String, 
        required: true 
    },
    tipo: { 
        type: String, 
        enum: ["TRANSACCION", "ERROR", "SISTEMA", "AUTH", "PEDIDO", "RECLAMO", "CARRITO", "PRODUCTO", "WEBSOCKET"], 
        required: true 
    },
    metodo: {
        type: String,
        required: true
    },
    ruta: {
        type: String,
        required: true
    },
    userAgent: {
        type: String
    }
}, {
    timestamps: true 
});

module.exports = mongoose.model("Log", LogSchema);
