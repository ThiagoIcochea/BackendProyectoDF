const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({


    name: String,

    lastname: String,

    email: {
        type: String,
        unique: true
    },

    password: String,

    phone: String,

    address: String,

    city: String,

    birthdate: Date,

    sex: String,

    profileImg: String,

    role: {
        type: String,
        default: "user"
    },

    twoFactorCode: String,
    twoFactorExpires: Date,
    twoFactorTempToken: String,
    twoFactorAttempts: {
        type: Number,
        default: 0
    },
    twoFactorBlockedUntil: Date,
    twoFactorLastSentAt: Date,
    twoFactorMethod: String,
    loginFailedAttempts: {
        type: Number,
        default: 0
    },
    loginBlockedUntil: Date,
    loginLastFailedAt: Date,
    loginLastIp: String,

    paymentmethod:{
        nombretarjeta: String,
        numerotarjeta: Number,
        cvv: Number,
        tipo: String
    },

    chatReportCount: {
        type: Number,
        default: 0
    },
    chatBlockedUntil: Date,
    chatBlockReason: String

}, {
    timestamps: true
});



module.exports = mongoose.model("User", UserSchema);
