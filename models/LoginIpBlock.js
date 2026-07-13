const mongoose = require("mongoose");

const LoginIpBlockSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  failedAttempts: {
    type: Number,
    default: 0
  },
  blockedUntil: Date,
  reason: String,
  emails: [{
    type: String
  }],
  lastAttemptAt: Date
}, {
  timestamps: true
});

module.exports = mongoose.model("LoginIpBlock", LoginIpBlockSchema);
