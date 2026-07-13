const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { PassThrough } = require('stream');

const { issueActionMfa } = require('../utils/twoFactor');

test('issueActionMfa uses the webhook path for non-email methods when the phone exists', async () => {
  const originalGet = https.get;
  const requests = [];

  https.get = (url, callback) => {
    requests.push(url);
    const response = new PassThrough();
    response.statusCode = 200;
    process.nextTick(() => {
      response.emit('data', 'ok');
      response.emit('end');
    });
    callback(response);
    return {
      on: () => ({})
    };
  };

  try {
    const user = {
      email: 'cliente@example.com',
      name: 'Cliente',
      phone: '999999999',
      save: async function () { this.saved = true; return this; }
    };

    const result = await issueActionMfa(user, 'sms', { code: '123456' });

    assert.equal(result.sentBy, 'sms');
    assert.equal(user.twoFactorMethod, 'sms');
    assert.equal(user.twoFactorCode, '123456');
    assert.ok(requests[0].includes('/otp?'));
  } finally {
    https.get = originalGet;
  }
});
