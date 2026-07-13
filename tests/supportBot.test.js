const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSupportBotReply, createSupportSession, parseOrderIntent, parseDeliveryPreference } = require('../utils/supportBot');
const { checkTextSafety } = require('../utils/wsBroadcast');

test('buildSupportBotReply returns a greeting with options', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('hola', session);
  assert.match(reply, /NendoBot/i);
  assert.match(reply, /1\)/);
  assert.match(reply, /2\)/);
});

test('buildSupportBotReply can guide a purchase issue flow', async () => {
  const session = createSupportSession();
  await buildSupportBotReply('hola', session);
  const reply = await buildSupportBotReply('1', session);
  assert.match(reply, /pedido/i);
  assert.match(reply, /número de pedido/i);
});

test('checkTextSafety blocks violent or sexual content locally', async () => {
  const result = await checkTextSafety('Quiero hacer algo sexual muy explícito');
  assert.equal(result.allowed, false);
  assert.equal(result.block, true);
});

test('buildSupportBotReply personalizes the welcome response with the customer name', async () => {
  const session = createSupportSession('Ana');
  const reply = await buildSupportBotReply('hola', session);
  assert.match(reply, /Ana/i);
  assert.match(reply, /pedidos/i);
  assert.match(reply, /productos/i);
  assert.match(reply, /No pedir/i);
});

test('checkTextSafety blocks obfuscated profanity variants', async () => {
  const result = await checkTextSafety('p u t a');
  assert.equal(result.allowed, false);
  assert.equal(result.block, true);
});

test('buildSupportBotReply can end the conversation gracefully', async () => {
  const session = createSupportSession();
  await buildSupportBotReply('hola', session);
  const reply = await buildSupportBotReply('gracias, ya terminamos', session);
  assert.match(reply, /gracias/i);
  assert.match(reply, /adiós/i);
});

test('buildSupportBotReply asks for a satisfaction survey before closing', async () => {
  const session = createSupportSession();
  await buildSupportBotReply('hola', session);
  await buildSupportBotReply('gracias, ya terminamos', session);
  const closingReply = await buildSupportBotReply('sí, todo bien', session);
  assert.match(closingReply, /satisfacción/i);
  assert.match(closingReply, /gracias/i);
});

test('buildSupportBotReply explains its role when asked', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('¿por qué haces esto?', session);
  assert.match(reply, /NendoBot/i);
  assert.match(reply, /pedidos/i);
});

test('parseOrderIntent detects purchase requests and product names', () => {
  const result = parseOrderIntent('Quiero comprar una figura de Naruto');
  assert.equal(result.isPurchase, true);
  assert.match(result.productName, /naruto/i);
});

test('parseDeliveryPreference recognises pickup and shipping requests', () => {
  assert.equal(parseDeliveryPreference('quiero recojo en tienda'), 'pickup');
  assert.equal(parseDeliveryPreference('envío a casa'), 'shipping');
});

test('buildSupportBotReply clarifies scope for unrelated questions', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('¿qué pasa con el clima hoy?', session);
  assert.match(reply, /mi función/i);
  assert.match(reply, /no es mi finalidad/i);
});
