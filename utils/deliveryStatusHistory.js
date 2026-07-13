const buildInitialStatusHistory = (initialStatus) => {
  const createdAt = new Date().toISOString();
  return [
    {
      status: initialStatus,
      timestamp: createdAt,
      note: 'Pedido registrado'
    }
  ];
};

const syncStatusHistory = (delivery, nextStatus, metadata = {}) => {
  if (!delivery) return delivery;
  const history = Array.isArray(delivery.statusHistory) && delivery.statusHistory.length
    ? delivery.statusHistory.slice()
    : buildInitialStatusHistory(delivery.status || 'pending');

  const lastEntry = history[history.length - 1];
  const isDuplicate = lastEntry?.status === nextStatus;
  if (!isDuplicate) {
    history.push({
      status: nextStatus,
      timestamp: metadata.timestamp || new Date().toISOString(),
      note: metadata.note || 'Actualización de estado'
    });
  }

  delivery.statusHistory = history;
  return delivery;
};

module.exports = {
  buildInitialStatusHistory,
  syncStatusHistory
};
