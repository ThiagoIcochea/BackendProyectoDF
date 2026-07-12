const mongoose = require('mongoose');

const ClaimSchema = new mongoose.Schema({
  delivery: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Delivery',
    required: true
  },
  payment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment'
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['delay', 'incomplete', 'damaged', 'cancellation']
  },
  description: {
    type: String,
    required: true
  },
  status: {
    type: String,
    default: 'pending',
    enum: ['pending', 'resolved', 'rejected']
  },
  resolution: {
    type: String,
    default: 'pending'
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model('Claim', ClaimSchema);
