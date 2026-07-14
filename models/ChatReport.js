const mongoose = require("mongoose");

const ChatReportSchema = new mongoose.Schema(
  {
    reporterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    reportedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    reason: {
      type: String,
      required: true
    },
    messagesEvaluated: [
      {
        text: String,
        createdAt: Date
      }
    ],
    groqAnalysis: {
      allowed: {
        type: Boolean,
        default: true
      },
      block: {
        type: Boolean,
        default: false
      },
      category: {
        type: String,
        default: "apropiado"
      },
      reason: {
        type: String,
        default: ""
      }
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("ChatReport", ChatReportSchema);
