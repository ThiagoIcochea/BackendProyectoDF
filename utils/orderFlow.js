const DEFAULT_SLA_HOURS = 48;

const toDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const calculateDeliveryDeadline = (createdAt, products = []) => {
  const baseDate = toDate(createdAt) || new Date();
  const maxDays = products.reduce((acc, product) => {
    const days = Number(product?.fechaEntregaPromedio ?? product?.estimatedDays ?? 0);
    return Math.max(acc, Number.isFinite(days) ? days : 0);
  }, 0);

  const deadline = new Date(baseDate);
  deadline.setDate(deadline.getDate() + Math.max(maxDays, 1));
  return deadline;
};

const buildSlaMessage = (deadlineDate) => {
  const deadline = toDate(deadlineDate);
  if (!deadline) return "Consultar con soporte para conocer el tiempo estimado de entrega.";
  return `Tu pedido debería entregarse máximo hasta el ${deadline.toLocaleDateString('es-PE')}.
  Si pasan 48 horas desde esa fecha y el estado sigue pendiente o en tránsito, puedes generar un reclamo por demora.`;
};

const canCreateClaim = ({ category, currentStatus, deadlineDate, existingClaims = [] }, now = new Date()) => {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  const normalizedStatus = String(currentStatus || '').trim().toLowerCase();
  const currentDate = toDate(now) || new Date();
  const deadline = toDate(deadlineDate);

  if (!normalizedCategory) {
    return { allowed: false, reason: 'Selecciona una categoría de reclamo.' };
  }

  const pendingClaim = existingClaims.find((claim) => {
    const sameCategory = String(claim?.category || claim?.categoria || '').trim().toLowerCase() === normalizedCategory;
    const pending = String(claim?.status || claim?.estado || '').trim().toLowerCase() === 'pending';
    return sameCategory && pending;
  });

  if (pendingClaim) {
    return { allowed: false, reason: 'Ya existe un reclamo pendiente de la misma categoría. Espera su resolución.' };
  }

  if (normalizedCategory === 'delay') {
    if (!deadline) {
      return { allowed: false, reason: 'No hay una fecha límite definida para este pedido.' };
    }

    const slaDeadline = new Date(deadline);
    slaDeadline.setHours(slaDeadline.getHours() + DEFAULT_SLA_HOURS);
    if (currentDate < slaDeadline) {
      return { allowed: false, reason: 'El reclamo por demora solo está habilitado 48 horas después de la fecha máxima de entrega.' };
    }

    return { allowed: true, reason: 'Reclamo habilitado.' };
  }

  if (normalizedCategory === 'incomplete' || normalizedCategory === 'damaged') {
    if (!['delivered', 'returned'].includes(normalizedStatus)) {
      return { allowed: false, reason: 'El reclamo por pedido incompleto o producto dañado solo puede generarse después de que el pedido haya sido entregado o devuelto.' };
    }

    return { allowed: true, reason: 'Reclamo habilitado.' };
  }

  if (normalizedCategory === 'cancellation') {
    if (normalizedStatus !== 'cancelled') {
      return { allowed: false, reason: 'El reclamo por cancelación solo puede generarse cuando el pedido ya fue cancelado.' };
    }

    return { allowed: true, reason: 'Reclamo habilitado.' };
  }

  return { allowed: false, reason: 'El reclamo solo puede generarse para pedidos en estados aplicables.' };
};

module.exports = {
  calculateDeliveryDeadline,
  buildSlaMessage,
  canCreateClaim,
  DEFAULT_SLA_HOURS
};
