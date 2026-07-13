const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInitialStatusHistory, syncStatusHistory } = require('../utils/deliveryStatusHistory');

test('agrega un nuevo estado al historial y evita duplicados consecutivos', () => {
  const delivery = {
    status: 'pending',
    statusHistory: buildInitialStatusHistory('pending')
  };

  syncStatusHistory(delivery, 'shipped', { note: 'Despachado' });
  assert.equal(delivery.statusHistory.length, 2);
  assert.equal(delivery.statusHistory[1].status, 'shipped');
  assert.equal(delivery.statusHistory[1].note, 'Despachado');

  syncStatusHistory(delivery, 'shipped');
  assert.equal(delivery.statusHistory.length, 2);
});
