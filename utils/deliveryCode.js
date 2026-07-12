function createDeliveryCode(prefix = "CONF") {
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${randomPart}`;
}

function ensureDeliveryCode(delivery) {
  if (!delivery) return delivery;

  const currentCode = String(delivery.deliveryCode || "").trim();
  if (currentCode) {
    return delivery;
  }

  delivery.deliveryCode = createDeliveryCode();
  return delivery;
}

module.exports = {
  createDeliveryCode,
  ensureDeliveryCode
};
