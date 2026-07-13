const test = require('node:test');
const assert = require('node:assert/strict');

const { getFromAddress } = require('../utils/emailNotifications');

test('getFromAddress falls back to Resend sandbox sender when no explicit sender is configured', () => {
  delete process.env.RESEND_FROM_EMAIL;
  assert.equal(getFromAddress(), 'onboarding@resend.dev');
});
