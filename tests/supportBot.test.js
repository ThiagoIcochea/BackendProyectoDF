const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSupportBotReply, createSupportSession, parseOrderIntent, parseDeliveryPreference, buildKeyValueContext, rankProductMatches, filterProductsForQuery, parseProfileChangeRequest, normalizeMfaMethod } = require('../utils/supportBot');
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

test('buildSupportBotReply answers expensive-product requests directly', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('dime el producto más caro', session);
  assert.match(reply, /caro|costoso|precio/i);
});

test('buildSupportBotReply executes cart requests directly without showing internal routes', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('agrega un producto al carrito', session);
  assert.match(reply, /carrito/i);
  assert.match(reply, /agreg|añad|listo/i);
  assert.doesNotMatch(reply, /ruta interna/i);
  assert.equal(Array.isArray(session.cartItems), true);
  assert.ok(session.cartItems.length >= 1);
});

test('buildKeyValueContext classifies product and cart requests with structured context', () => {
  const context = buildKeyValueContext('quiero agregar un producto al carrito');
  assert.equal(context.intent, 'carrito');
  assert.equal(context.area, 'carrito');
  assert.ok(context.productHint || context.intent === 'carrito');
});

test('rankProductMatches prioritizes exact product names over unrelated products', () => {
  const products = [
    { name: 'Naruto Figure', description: 'Figura de colección' },
    { name: 'Miku Hatsune Figure', description: 'Figura de colección de Vocaloid' }
  ];

  const ranked = rankProductMatches('miku hatsune', products);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].name, 'Miku Hatsune Figure');
  assert.ok(ranked[0].score > 0);
});

test('filterProductsForQuery keeps only discounted items for discount requests', () => {
  const products = [
    { name: 'Figura Naruto', discount: 0.2 },
    { name: 'Figura Miku', discount: 0 },
    { name: 'Figura Goku', discount: 0.15 }
  ];

  const filtered = filterProductsForQuery('productos en descuento', products);
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((product) => Number(product.discount || 0) > 0));
});

test('parseProfileChangeRequest understands natural language for phone and password updates', () => {
  const phoneChange = parseProfileChangeRequest('quiero cambiar mi teléfono por 987654321');
  assert.equal(phoneChange.kind, 'phone');
  assert.equal(phoneChange.newValue, '987654321');

  const numberChange = parseProfileChangeRequest('cámbiame el número a 987654321');
  assert.equal(numberChange.kind, 'phone');
  assert.equal(numberChange.newValue, '987654321');

  const passwordChange = parseProfileChangeRequest('cambia mi contraseña a MiNuevaClave123!');
  assert.equal(passwordChange.kind, 'password');
  assert.equal(passwordChange.newPassword, 'MiNuevaClave123!');
});

test('normalizeMfaMethod accepts common aliases', () => {
  assert.equal(normalizeMfaMethod('correo'), 'email');
  assert.equal(normalizeMfaMethod('whatsapp'), 'whatsapp');
  assert.equal(normalizeMfaMethod('llamada'), 'call');
});
