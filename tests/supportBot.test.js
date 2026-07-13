const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSupportBotReply, createSupportSession, parseOrderIntent, parseDeliveryPreference, buildKeyValueContext, rankProductMatches, filterProductsForQuery, parseProfileChangeRequest, normalizeMfaMethod, extractRequestedMfaMethod, parseClaimRequest, parseCheckoutIntent, extractProductHint } = require('../utils/supportBot');
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

test('buildSupportBotReply answers highest-discount product requests directly', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('dime el producto con mayor descuento', session);
  assert.match(reply, /descuento|oferta|precio/i);
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

  const filteredByInstruction = filterProductsForQuery('filtra productos con descuento', products);
  assert.equal(filteredByInstruction.length, 2);
  assert.ok(filteredByInstruction.every((product) => Number(product.discount || 0) > 0));
});

test('parseProfileChangeRequest understands natural language for phone, password, and photo updates', () => {
  const phoneChange = parseProfileChangeRequest('quiero cambiar mi teléfono por 987654321');
  assert.equal(phoneChange.kind, 'phone');
  assert.equal(phoneChange.newValue, '987654321');

  const numberChange = parseProfileChangeRequest('cámbiame el número a 987654321');
  assert.equal(numberChange.kind, 'phone');
  assert.equal(numberChange.newValue, '987654321');

  const altPhoneChange = parseProfileChangeRequest('cambia mi telfono por 912345678');
  assert.equal(altPhoneChange.kind, 'phone');
  assert.equal(altPhoneChange.newValue, '912345678');

  const passwordChange = parseProfileChangeRequest('cambia mi contraseña a MiNuevaClave123!');
  assert.equal(passwordChange.kind, 'password');
  assert.equal(passwordChange.newPassword, 'MiNuevaClave123!');

  const photoChange = parseProfileChangeRequest('cambia mi foto de perfil por https://cdn.example.com/avatar.png');
  assert.equal(photoChange.kind, 'photo');
  assert.equal(photoChange.newValue, 'https://cdn.example.com/avatar.png');
});

test('buildSupportBotReply asks for the missing image URL when the user requests a profile photo change', async () => {
  const session = createSupportSession();
  session.userId = 'user-123';
  const reply = await buildSupportBotReply('cambia mi foto de perfil', session);
  assert.match(reply, /foto|imagen|url/i);
});

test('normalizeMfaMethod accepts common aliases', () => {
  assert.equal(normalizeMfaMethod('correo'), 'email');
  assert.equal(normalizeMfaMethod('whatsapp'), 'whatsapp');
  assert.equal(normalizeMfaMethod('llamada'), 'call');
});

test('extractRequestedMfaMethod ignores casing and picks the requested channel', () => {
  assert.equal(extractRequestedMfaMethod('hola cambia mi celular a 968085026 por SMS'), 'sms');
  assert.equal(extractRequestedMfaMethod('cambia mi contraseña por WhatsApp'), 'whatsapp');
  assert.equal(extractRequestedMfaMethod('envíame el código por LlAmAdA'), 'call');
});

test('buildSupportBotReply does not misclassify a greeting as a claim request', async () => {
  const session = createSupportSession();
  const reply = await buildSupportBotReply('hola', session);
  assert.doesNotMatch(reply, /No encontré un pedido asociado/i);
  assert.match(reply, /NendoBot|pedidos|productos/i);
});

test('parseClaimRequest extracts the order and issue category from a claim request', () => {
  const parsed = parseClaimRequest('quiero hacer un reclamo por mi pedido 123456 por demora');
  assert.equal(parsed.orderNumber, '123456');
  assert.equal(parsed.category, 'delay');
  assert.match(parsed.description, /demora/i);
});

test('parseClaimRequest handles synonyms and natural wording', () => {
  const parsed = parseClaimRequest('tengo un problema con mi compra y llegó incompleto');
  assert.equal(parsed.category, 'incomplete');
  assert.match(parsed.description, /problema|incompleto/i);
});

test('parseClaimRequest handles short claim creation requests', () => {
  const parsed = parseClaimRequest('genera el reclamo');
  assert.ok(parsed);
  assert.equal(parsed.category, 'delay');
});

test('parseCheckoutIntent recognizes natural checkout requests', () => {
  const parsed = parseCheckoutIntent('genera el pedido');
  assert.ok(parsed);
  assert.equal(parsed.kind, 'checkout');
  assert.equal(parsed.deliveryType, null);

  const parsedNatural = parseCheckoutIntent('generame mi pedido');
  assert.ok(parsedNatural);
  assert.equal(parsedNatural.kind, 'checkout');
});

test('extractProductHint keeps product references inside pedido queries', () => {
  const hint = extractProductHint('buscame un pedido con miku');
  assert.match(hint, /miku/i);
});

test('buildSupportBotReply continues a pending claim instead of greeting', async () => {
  const session = createSupportSession();
  session.userId = 'user-123';
  session.pendingClaim = { step: 'waiting_for_order' };
  const reply = await buildSupportBotReply('123456', session);
  assert.match(reply, /pedido|reclamo|encontr/i);
  assert.doesNotMatch(reply, /NendoBot/i);
});

test('buildSupportBotReply asks for delivery type before checkout', async () => {
  const session = createSupportSession();
  session.userId = 'user-123';
  session.cartItems = [{ name: 'Figura Miku', quantity: 1, price: 100 }];

  const User = require('../models/User');
  const originalFindById = User.findById;
  User.findById = () => Promise.resolve({ name: 'Ana', email: 'ana@test.com', address: 'Av. Lima 123' });

  try {
    const reply = await buildSupportBotReply('genera el pedido', session);
    assert.match(reply, /recojo|env[ií]o/i);
    assert.equal(session.pendingMfaAction?.status, 'waiting_for_delivery_type');
  } finally {
    User.findById = originalFindById;
  }
});

test('buildSupportBotReply asks for the order number when the user requests a claim', async () => {
  const session = createSupportSession();
  session.userId = 'user-123';
  const reply = await buildSupportBotReply('generame el reclamo', session);
  assert.match(reply, /número de pedido|pedido/i);
});

test('parseCheckoutIntent detects a checkout request and delivery preference', () => {
  const parsed = parseCheckoutIntent('crea un pedido con envío a casa');
  assert.equal(parsed.kind, 'checkout');
  assert.equal(parsed.deliveryType, 'shipping');
});
