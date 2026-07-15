const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateDeliveryDeadline, addBusinessHours, canCreateClaim } = require('../utils/orderFlow');
const { isValidStatusTransition } = require('../utils/deliveryStatusFlow');

test('calculateDeliveryDeadline uses the highest delivery window among products', () => {
  const createdAt = new Date('2026-07-01T00:00:00.000Z');
  const deadline = calculateDeliveryDeadline(createdAt, [
    { fechaEntregaPromedio: 3 },
    { fechaEntregaPromedio: 5 },
    { fechaEntregaPromedio: 1 }
  ]);

  assert.equal(deadline.toISOString(), '2026-07-06T00:00:00.000Z');
});

test('canCreateClaim blocks a duplicate claim for the same category while pending', () => {
  const result = canCreateClaim({
    category: 'delay',
    currentStatus: 'shipped',
    deadlineDate: new Date('2026-07-06T00:00:00.000Z'),
    existingClaims: [{ category: 'delay', status: 'pending' }]
  }, new Date('2026-07-08T00:00:00.000Z'));

  assert.equal(result.allowed, false);
  assert.match(result.reason, /ya existe/i);
});

test('canCreateClaim allows a delay claim after the SLA window', () => {
  const result = canCreateClaim({
    category: 'delay',
    currentStatus: 'shipped',
    deadlineDate: new Date('2026-07-06T00:00:00.000Z'),
    existingClaims: []
  }, new Date('2026-07-09T00:00:00.000Z'));

  assert.equal(result.allowed, true);
});

test('canCreateClaim counts delay SLA as 48 business hours', () => {
  const deadline = new Date('2026-07-10T00:00:00.000Z');

  assert.equal(addBusinessHours(deadline, 48).toISOString(), '2026-07-14T00:00:00.000Z');

  const beforeBusinessSla = canCreateClaim({
    category: 'delay',
    currentStatus: 'shipped',
    deadlineDate: deadline,
    existingClaims: []
  }, new Date('2026-07-13T23:59:59.000Z'));

  const afterBusinessSla = canCreateClaim({
    category: 'delay',
    currentStatus: 'shipped',
    deadlineDate: deadline,
    existingClaims: []
  }, new Date('2026-07-14T00:00:00.000Z'));

  assert.equal(beforeBusinessSla.allowed, false);
  assert.equal(afterBusinessSla.allowed, true);
});

test('canCreateClaim blocks an incomplete claim before delivery', () => {
  const result = canCreateClaim({
    category: 'incomplete',
    currentStatus: 'shipped',
    deadlineDate: new Date('2026-07-06T00:00:00.000Z'),
    existingClaims: []
  }, new Date('2026-07-07T00:00:00.000Z'));

  assert.equal(result.allowed, false);
  assert.match(result.reason, /entregado/i);
});

test('canCreateClaim allows an incomplete claim only after delivery', () => {
  const result = canCreateClaim({
    category: 'incomplete',
    currentStatus: 'delivered',
    deadlineDate: new Date('2026-07-06T00:00:00.000Z'),
    existingClaims: []
  }, new Date('2026-07-07T00:00:00.000Z'));

  assert.equal(result.allowed, true);
});

test('canCreateClaim allows a cancellation claim when the order has been cancelled', () => {
  const result = canCreateClaim({
    category: 'cancellation',
    currentStatus: 'cancelled',
    deadlineDate: new Date('2026-07-06T00:00:00.000Z'),
    existingClaims: []
  }, new Date('2026-07-07T00:00:00.000Z'));

  assert.equal(result.allowed, true);
});

test('delivery status flow allows pending -> shipped -> delivered for shipping and pending -> ready_for_pickup -> delivered for pickup', () => {
  assert.equal(isValidStatusTransition('pending', 'shipped', 'shipping'), true);
  assert.equal(isValidStatusTransition('shipped', 'delivered', 'shipping'), true);
  assert.equal(isValidStatusTransition('pending', 'ready_for_pickup', 'pickup'), true);
  assert.equal(isValidStatusTransition('ready_for_pickup', 'delivered', 'pickup'), true);
  assert.equal(isValidStatusTransition('ready_for_pickup', 'shipped', 'pickup'), false);
});
