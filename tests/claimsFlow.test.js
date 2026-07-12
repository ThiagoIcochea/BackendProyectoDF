const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateClaimDescription } = require('../utils/claimReview');

test('evaluateClaimDescription rejects vague descriptions', async () => {
  const result = await evaluateClaimDescription('Hola, necesito ayuda', 'delay');
  assert.equal(result.validClaim, false);
  assert.match(result.reason, /descrito/i);
});

test('evaluateClaimDescription accepts specific claim descriptions', async () => {
  const result = await evaluateClaimDescription('El pedido llegó con 2 piezas menos y el producto está dañado', 'incomplete');
  assert.equal(result.validClaim, true);
});
