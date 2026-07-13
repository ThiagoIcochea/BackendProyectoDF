const STATUS_ORDER = ["pending", "shipped", "ready_for_pickup", "delivered", "cancelled", "returned"];

const STATUS_TRANSITIONS = {
  pending: {
    shipping: ["shipped", "cancelled"],
    pickup: ["ready_for_pickup", "cancelled"]
  },
  shipped: {
    shipping: ["delivered", "cancelled"],
    pickup: []
  },
  ready_for_pickup: {
    pickup: ["delivered", "cancelled"],
    shipping: []
  },
  delivered: {
    shipping: ["returned"],
    pickup: ["returned"]
  },
  cancelled: {},
  returned: {}
};

const normalizeStatus = (status) => String(status || "").trim().toLowerCase();
const normalizeDeliveryType = (deliveryType) => {
  const normalized = normalizeStatus(deliveryType);
  if (normalized === "pickup" || normalized === "presencial") return "pickup";
  return "shipping";
};

const getAllowedNextStatuses = (currentStatus, deliveryType = "shipping") => {
  const normalized = normalizeStatus(currentStatus);
  const mode = normalizeDeliveryType(deliveryType);
  return STATUS_TRANSITIONS[normalized]?.[mode] || [];
};

const isValidStatusTransition = (currentStatus, nextStatus, deliveryType = "shipping") => {
  if (!currentStatus || !nextStatus) return false;

  const normalizedCurrent = normalizeStatus(currentStatus);
  const normalizedNext = normalizeStatus(nextStatus);

  if (!STATUS_ORDER.includes(normalizedCurrent) || !STATUS_ORDER.includes(normalizedNext)) {
    return false;
  }

  if (normalizedCurrent === normalizedNext) {
    return true;
  }

  return getAllowedNextStatuses(normalizedCurrent, deliveryType).includes(normalizedNext);
};

const getStatusLabel = (status) => {
  const normalized = normalizeStatus(status);
  const labels = {
    pending: "pendiente",
    ready_for_pickup: "listo para recojo",
    shipped: "enviado",
    delivered: "entregado",
    cancelled: "cancelado",
    returned: "devuelto"
  };

  return labels[normalized] || normalized || "desconocido";
};

module.exports = {
  STATUS_ORDER,
  STATUS_TRANSITIONS,
  getAllowedNextStatuses,
  isValidStatusTransition,
  getStatusLabel,
  normalizeStatus
};
