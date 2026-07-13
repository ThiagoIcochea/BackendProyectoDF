const STATUS_ORDER = ["pending", "ready_for_pickup", "shipped", "delivered", "cancelled", "returned"];

const STATUS_TRANSITIONS = {
  pending: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: ["returned"],
  cancelled: [],
  returned: []
};

const normalizeStatus = (status) => String(status || "").trim().toLowerCase();

const getAllowedNextStatuses = (currentStatus) => {
  const normalized = normalizeStatus(currentStatus);
  return STATUS_TRANSITIONS[normalized] || [];
};

const isValidStatusTransition = (currentStatus, nextStatus) => {
  if (!currentStatus || !nextStatus) return false;

  const normalizedCurrent = normalizeStatus(currentStatus);
  const normalizedNext = normalizeStatus(nextStatus);

  if (!STATUS_ORDER.includes(normalizedCurrent) || !STATUS_ORDER.includes(normalizedNext)) {
    return false;
  }

  if (normalizedCurrent === normalizedNext) {
    return true;
  }

  return getAllowedNextStatuses(normalizedCurrent).includes(normalizedNext);
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
