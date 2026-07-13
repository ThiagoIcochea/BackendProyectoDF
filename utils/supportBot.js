const crypto = require("crypto");
const { Resend } = require("resend");
const Payment = require("../models/Payment");
const Product = require("../models/Product");
const Claim = require("../models/Claim");
const Delivery = require("../models/Delivery");
const User = require("../models/User");
const { getGroqApiKey, callGroq, parseGroqJson } = require("../utils/groqClient");
const { canCreateClaim } = require("./orderFlow");
const { evaluateClaimDescription } = require("./claimReview");
const { syncStatusHistory } = require("./deliveryStatusHistory");
const { recordLog } = require("./logger");

const FRONTEND_BASE_URL = process.env.FRONTEND_URL || process.env.REACT_APP_FRONTEND_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://nendoshop.onrender.com");
const PRODUCT_DETAIL_PATH = "/product";
const OTP_EXPIRE_MS = 5 * 60 * 1000;
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const ACTION_ROUTE_MAP = {
  product_search: "/api/products/search",
  product_detail: "/api/products/:id",
  product_most_expensive: "/api/products?sort=price_desc",
  cart_add: "/frontend/cart/add",
  my_orders: "/api/deliveries/my-orders",
  cancel_order: "/api/deliveries/my-orders/:id/cancel/request",
  claim_create: "/api/claims",
  admin_delivery_status: "/api/deliveries/:id/status",
  admin_claim_resolution: "/api/claims/:id/resolve"
};
const buildProductLink = (id) => {
  const base = String(FRONTEND_BASE_URL || "https://nendoshop.onrender.com").replace(/\/$/, "");
  return `${base}/#/product/${id}`;
};

const SUPPORT_INTRO =
  "Hola, soy NendoBot, tu asesor de atención al cliente de NendoShop. Te puedo ayudar con pedidos, productos, devoluciones y cuentas. También puedo orientarte sobre un producto específico o ayudarte a encontrar el más económico.";

const LEET_SUBSTITUTIONS = {
  "0": "o",
  "1": "i",
  "!": "i",
  "3": "e",
  "4": "a",
  "@": "a",
  "5": "s",
  "$": "s",
  "7": "t",
  "8": "b",
  "9": "g"
};

const stripAccents = (text) =>
  String(text || "")
    .replace(/[áàäâ]/g, "a")
    .replace(/[éèëê]/g, "e")
    .replace(/[íìïî]/g, "i")
    .replace(/[óòöô]/g, "o")
    .replace(/[úùüû]/g, "u");

const applyLeetSubstitutions = (text) =>
  String(text || "").replace(/[01345789!@$]/g, (ch) => LEET_SUBSTITUTIONS[ch] || ch);
const collapseRepeatedChars = (text) => String(text || "").replace(/([a-z0-9ñ])\1+/g, "$1");
const buildNormalizedVariants = (text) => {
  const lowered = String(text || "").toLowerCase();
  const noAccents = stripAccents(lowered);
  const deLeeted = applyLeetSubstitutions(noAccents);
  return {
    spaced: deLeeted,
    spacedCollapsed: collapseRepeatedChars(deLeeted)
  };
};

const BLOCKED_TERMS = {
  sexual: [
    "sexo", "sexual", "sexuales", "porno", "pornografia", "pornografico",
    "nudez", "desnudo", "desnuda", "desnudos", "desnudas", "masturbar",
    "masturbarse", "masturbacion", "orgasmo", "orgia", "orgias", "pene",
    "vagina", "verga", "vergas", "tetas", "nalgas", "follar", "violacion",
    "violar", "pedofilo", "pedofilia", "zoofilia", "incesto"
  ],
  violencia: [
    "violencia", "matar", "matarte", "asesinar", "asesinato", "golpear",
    "agredir", "agresion", "arma", "armas", "explosivo", "explosivos",
    "bomba", "bombardear", "suicida", "suicidio", "suicidarse",
    "terrorismo", "terrorista", "secuestrar", "secuestro", "torturar",
    "tortura", "amenazar", "amenaza", "lastimarte", "herirte", "disparar",
    "masacre", "hacerte daño"
  ],
  insultos: [
    "puta", "puto", "putas", "putos", "mierda", "idiota", "estupido",
    "estupida", "maldito", "maldita", "pendejo", "pendeja", "cabron",
    "cabrona", "marica", "maricon", "gilipollas", "imbecil", "huevon",
    "huevona", "conchatumadre", "ctm", "malparido", "malparida",
    "hijueputa", "hijodeputa", "perra", "zorra", "mongolico", "retrasado",
    "baboso", "babosa", "pajero", "culero", "joto"
  ]
};

const ALL_BLOCKED_WORDS = Object.values(BLOCKED_TERMS).flat();
const SINGLE_BLOCKED_WORDS = ALL_BLOCKED_WORDS.filter((word) => !word.includes(" "));
const PHRASE_BLOCKED_WORDS = ALL_BLOCKED_WORDS.filter((word) => word.includes(" "));

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildLooseWordPattern = (word) => {
  const body = word.split("").map(escapeRegExp).join("[\\s.,\\-_*]{0,3}");
  return new RegExp(`\\b${body}\\b`, "i");
};

const LOOSE_SINGLE_PATTERNS = SINGLE_BLOCKED_WORDS.map(buildLooseWordPattern);
const PHRASE_PATTERNS = PHRASE_BLOCKED_WORDS.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase).replace(/ /g, "\\s+")}\\b`, "i")
);
const ELONGATION_WORDS = SINGLE_BLOCKED_WORDS.filter((word) => collapseRepeatedChars(word) === word);
const ELONGATION_PATTERNS = ELONGATION_WORDS.map((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i"));

const checkTextSafety = (text) => {
  const raw = String(text || "").trim();
  if (!raw) {
    return { allowed: false, block: true, reason: "El mensaje está vacío." };
  }

  const { spaced, spacedCollapsed } = buildNormalizedVariants(raw);

  const blockedLoose =
    LOOSE_SINGLE_PATTERNS.some((pattern) => pattern.test(spaced)) ||
    PHRASE_PATTERNS.some((pattern) => pattern.test(spaced));
  const blockedElongated = ELONGATION_PATTERNS.some((pattern) => pattern.test(spacedCollapsed));
  const blocked = blockedLoose || blockedElongated;

  return {
    allowed: !blocked,
    block: blocked,
    reason: blocked ? "El mensaje contiene contenido no permitido." : "Mensaje aceptado."
  };
};

const normalizeCustomerName = (value) => {
  const name = String(value || "cliente").trim();
  return name || "cliente";
};

const createSupportSession = (customerName = "cliente") => ({
  step: "welcome", 
  topic: null,
  lastTopic: null,
  customerName: normalizeCustomerName(customerName),
  surveyAsked: false,
  history: [],
  cartItems: [],
  pendingMfaAction: null,
  lastBotMeta: null
});

const pushHistory = (session, role, text) => {
  if (!session.history) session.history = [];
  session.history.push({ role, text });
  if (session.history.length > 12) {
    session.history = session.history.slice(-12);
  }
};

const extractOrderNumber = (text) => {
  const match = text.match(/(?:pedido|orden|n(?:ú|u)mero de pedido|seguimiento)[^0-9]*(\d{2,})/i);
  if (match) return match[1];
  const fallback = text.match(/\b(\d{2,})\b/);
  return fallback ? fallback[1] : null;
};

const extractProductHint = (text) => {
  const hints = text.match(/(?:producto|figura|art(?:í|i)culo|modelo|articulo)[^a-záéíóúñü0-9]*([a-záéíóúñü0-9 .,'-]+)/i);
  if (hints && hints[1]) return hints[1].trim();
  const fallback = text.match(/(?:quiero|busco|necesito|interesa|recomienda|ver)[^a-záéíóúñü0-9]*([a-záéíóúñü0-9 .,'-]+)/i);
  return fallback ? fallback[1].trim() : null;
};

const parseOrderIntent = (text) => {
  const lowered = String(text || "").toLowerCase();
  const purchasePattern = /(quiero|quieres|necesito|busco|comprar|comprar|ordenar|adquirir|hacer un pedido)/i;
  const productMatch = extractProductHint(text);
  return {
    isPurchase: purchasePattern.test(lowered),
    productName: productMatch || "",
    normalizedText: lowered
  };
};

const parseDeliveryPreference = (text) => {
  const lowered = String(text || "").toLowerCase();
  if (/(recojo|recoger|retirar|tienda|pickup|pick up)/i.test(lowered)) return "pickup";
  if (/(env[ií]o|envio|casa|domicilio|shipping|delivery)/i.test(lowered)) return "shipping";
  return null;
};

const extractSurveyRating = (text) => {
  const numMatch = text.match(/\b([1-5])\b/);
  if (numMatch) return Number(numMatch[1]);
  if (/\b(si|sí|excelente|genial|perfecto|bien|ok|okay)\b/i.test(text)) return 5;
  if (/\b(no|mal|p[eé]simo|regular|mejorar)\b/i.test(text)) return 2;
  return null;
};

const explainRolePattern = /\b(qué haces|que haces|por qué haces|por que haces|para qué sirves|cuál es tu función|cual es tu funcion|tus funciones|funciones)\b/i;
const offTopicPattern = /\b(politica|política|deporte|futbol|película|pelicula|serie|noticia|clima|juego|música|musica|viaje|cocina|comida|humor|chiste)\b/i;
const scopeIntentPattern = /\b(pedido|orden|envío|envio|producto|precio|stock|devolucion|devolución|cambio|cuenta|acceso|contraseña|contrase|credencial|ayuda)\b/i;

const getImmediateSupportReply = ({ text, customerName, intent }) => {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  if (explainRolePattern.test(normalized)) {
    return `Soy NendoBot, tu asesor de atención al cliente de NendoShop. Puedo ayudarte con pedidos, productos, devoluciones y soporte de cuenta. Si tienes una consulta sobre alguno de esos temas, te ayudo enseguida.`;
  }

  if (intent === "devolucion") {
    return /pedido|producto/i.test(normalized)
      ? `Puedo orientarte sobre devoluciones y cambios. Si me compartes el número de pedido o el producto, te digo qué pasos seguir y si aplica.`
      : `Puedo orientarte sobre devoluciones y cambios. Si me dices el pedido o el producto, te ayudo a ver si aplica y qué hacer.`;
  }

  if (intent === "cuenta") {
    return `Puedo ayudarte con acceso a tu cuenta, recuperación de datos o cambios básicos. No pediré tu contraseña; si me explicas el problema, te guío paso a paso.`;
  }

  if (offTopicPattern.test(normalized) || (!scopeIntentPattern.test(normalized) && /\b(quiero|necesito|puedes|ayuda|dime|habl|como)\b/i.test(normalized))) {
    return `Mi función es ayudarte con pedidos, productos, devoluciones y cuenta en NendoShop. Si tu consulta es de otro tema, esa no es mi finalidad.`;
  }

  return null;
};

const isCheapestRequest = (text) => /(?:producto|art[ií]culo|figura).{0,20}(m[áa]s\s+barato|barato|m[áa]s\s+econ[oó]mico|econ[oó]mico|menor\s+precio|precio\s+menor)/i.test(text) || /(?:m[áa]s\s+barato|barato|m[áa]s\s+econ[oó]mico|econ[oó]mico|menor\s+precio|precio\s+menor)/i.test(text);

const findProductsByHint = async (hint) => {
  if (!hint) return [];
  const words = hint.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const regex = new RegExp(words.slice(0, 4).join("|"), "i");
  return Product.find({
    $or: [{ name: regex }, { description: regex }, { "specs.categoria": regex }]
  })
    .limit(3)
    .lean()
    .catch(() => []);
};

const findCheapestProduct = async () => {
  try {
    return await Product.findOne({}).sort({ price: 1, stock: -1 }).lean();
  } catch (err) {
    console.error("No se pudo consultar el producto más barato:", err.message);
    return null;
  }
};

const findMostExpensiveProduct = async () => {
  try {
    return await Product.findOne({}).sort({ price: -1, stock: -1 }).lean();
  } catch (err) {
    console.error("No se pudo consultar el producto más caro:", err.message);
    return null;
  }
};

const toProductFact = (product) => ({
  nombre: product.name,
  precio: product.price || 0,
  stock: product.stock || 0,
  descuento: product.discount || 0,
  comentarios: (product.comments || []).slice(-3).map((comment) => comment.text).filter(Boolean),
  enlace: buildProductLink(product._id)
});

const toPaymentFact = (payment) => ({
  numeroPedido: payment.documento,
  estado: payment.estado || "Pagado",
  total: payment.total || 0
});

const setSessionMeta = (session, meta) => {
  if (!session) return;
  session.lastBotMeta = meta || null;
};

const ensureCartSession = (session) => {
  if (!session) return null;
  if (!Array.isArray(session.cartItems)) session.cartItems = [];
  return session;
};

const addProductToCartSession = async (session, hint) => {
  const activeSession = ensureCartSession(session);
  if (!activeSession) return null;

  let product = null;
  if (hint) {
    const products = await findProductsByHint(hint);
    product = products[0] || null;
  }

  if (!product) {
    try {
      product = await Product.findOne({ stock: { $gt: 0 } }).sort({ price: 1, stock: -1 }).lean();
    } catch (err) {
      product = null;
    }
  }

  if (!product) {
    const fallbackName = hint ? `Producto sugerido: ${hint}` : "Producto recomendado";
    product = {
      _id: `fallback-${Date.now()}`,
      name: fallbackName,
      price: 0,
      stock: 1
    };
  }

  const existingItem = activeSession.cartItems.find((item) => String(item.id) === String(product._id));
  if (existingItem) {
    existingItem.quantity = (existingItem.quantity || 1) + 1;
  } else {
    activeSession.cartItems.push({
      id: product._id,
      name: product.name,
      price: product.price || 0,
      quantity: 1
    });
  }

  setSessionMeta(session, {
    type: "cart_add",
    product: {
      id: product._id,
      name: product.name,
      price: product.price || 0,
      quantity: 1,
      image: product.image || ""
    }
  });

  return product;
};

const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));
const generateTempToken = () => crypto.randomBytes(24).toString("hex");

const sendActionMfaCode = async (user, code, method = "email") => {
  const selectedMethod = String(method || "email").toLowerCase();
  if (selectedMethod === "console" || !resendClient) {
    console.log(`[MFA supportBot] Código para ${user.email}: ${code}`);
    return { sentBy: "console" };
  }

  const from = (process.env.RESEND_FROM_EMAIL || "Nendoshop <notificaciones@freecodingvibes.shop>").trim();
  await resendClient.emails.send({
    from,
    to: user.email,
    subject: "Código de verificación - Nendoshop",
    text: `Hola ${user.name || user.email}, tu código de verificación es ${code}. Expira en 5 minutos.`,
    html: `<p>Hola ${user.name || user.email},</p><p>Tu código de verificación es:</p><h2>${code}</h2><p>Expira en 5 minutos.</p>`
  });
  return { sentBy: "email" };
};

const issueActionMfa = async (user, method = "email") => {
  const code = generateCode();
  const tempToken = generateTempToken();
  const now = new Date();
  const selectedMethod = String(method || "email").toLowerCase();
  await sendActionMfaCode(user, code, selectedMethod);

  user.twoFactorCode = code;
  user.twoFactorMethod = selectedMethod === "console" ? "console" : "email";
  user.twoFactorTempToken = tempToken;
  user.twoFactorExpires = new Date(now.getTime() + OTP_EXPIRE_MS);
  user.twoFactorLastSentAt = now;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  await user.save();
  return tempToken;
};

const verifyActionMfa = async (user, tempToken, code) => {
  const now = new Date();
  const valid = user.twoFactorTempToken === tempToken &&
    Boolean(user.twoFactorCode) &&
    user.twoFactorCode === String(code || "").trim() &&
    user.twoFactorExpires &&
    user.twoFactorExpires >= now;

  if (!valid) return false;

  user.twoFactorCode = null;
  user.twoFactorExpires = null;
  user.twoFactorTempToken = null;
  user.twoFactorAttempts = 0;
  user.twoFactorBlockedUntil = null;
  user.twoFactorLastSentAt = null;
  user.twoFactorMethod = null;
  await user.save();
  return true;
};

const handleProfileUpdateRequest = async (text, session) => {
  if (!session?.userId) return null;
  const normalized = String(text || "").trim();
  if (!/(cambiar|actualizar|modificar|editar|poner|cambia|actualiza|modifica|edita|setea|asigna)/i.test(normalized)) {
    return null;
  }

  const user = await User.findById(session.userId).catch(() => null);
  if (!user) return null;

  const fieldMap = [
    { label: "nombre", pattern: /(nombre|name)\b/i, field: "name" },
    { label: "apellido", pattern: /(apellido|lastname|last name)\b/i, field: "lastname" },
    { label: "dirección", pattern: /(dirección|direccion|address|domicilio)\b/i, field: "address" },
    { label: "ciudad", pattern: /(ciudad|city)\b/i, field: "city" },
    { label: "teléfono", pattern: /(teléfono|telefono|phone|celular)\b/i, field: "phone" }
  ];

  for (const field of fieldMap) {
    const match = normalized.match(new RegExp(`(?:${field.label}|${field.field})[^a-záéíóúñü0-9]*([a-záéíóúñü0-9 .,'/-]+)$`, "i"));
    if (match && match[1]) {
      user[field.field] = match[1].trim();
      await user.save();
      return `Listo, actualicé tu ${field.label}.`;
    }
  }

  return "Puedo actualizar tu perfil. Díme qué dato quieres cambiar y el nuevo valor, por ejemplo: cambia mi dirección a Av. Siempre Viva 123.";
};

const handleCancelOrderRequest = async (text, session) => {
  if (!session?.userId) return null;
  const normalized = String(text || "").trim();
  if (!/(cancelar|anular|cancelacion|cancelación).*(pedido|orden|compra)/i.test(normalized) && !/(pedido|orden|compra).*(cancelar|anular)/i.test(normalized)) {
    return null;
  }

  const user = await User.findById(session.userId).catch(() => null);
  if (!user) return "No encuentro tu cuenta para cancelar el pedido.";

  const existingPending = session.pendingMfaAction;
  if (existingPending?.type === "cancel_order" && existingPending.status === "waiting_for_method") {
    const method = /correo|email/i.test(normalized) ? "email" : /consola|console/i.test(normalized) ? "console" : null;
    if (!method) {
      return "Para confirmar la cancelación necesito el método de verificación: correo o consola.";
    }
    const tempToken = await issueActionMfa(user, method);
    session.pendingMfaAction = { type: "cancel_order", status: "waiting_for_code", deliveryId: existingPending.deliveryId, tempToken, method };
    return `Te envié el código por ${method === "email" ? "correo" : "consola"}. Envíame el código de 6 dígitos para confirmar.`;
  }

  if (existingPending?.type === "cancel_order" && existingPending.status === "waiting_for_code") {
    const code = normalized.match(/\b(\d{6})\b/);
    if (!code) {
      return "Envíame el código de 6 dígitos que te envié para confirmar la cancelación.";
    }

    const ok = await verifyActionMfa(user, existingPending.tempToken, code[1]);
    if (!ok) {
      return "El código no es válido o ya expiró. Solicita uno nuevo para continuar.";
    }

    const delivery = await Delivery.findById(existingPending.deliveryId).catch(() => null);
    if (!delivery) return "No encontré ese pedido para cancelarlo.";
    if (!(["pending", "ready_for_pickup"].includes(delivery.status))) {
      session.pendingMfaAction = null;
      return `El pedido ya no se puede cancelar porque está en estado ${delivery.status}.`;
    }

    delivery.status = "cancelled";
    delivery.cancellationReason = "Cancelado por el asistente con MFA";
    syncStatusHistory(delivery, "cancelled", { note: delivery.cancellationReason });
    await delivery.save();
    await recordLog({ req: { user: { id: session.userId, email: user.email } }, usuario: user.email, descripcion: `Pedido ${delivery._id} cancelado por asistente`, tipo: "PEDIDO", metodo: "BOT", ruta: "/chatbot" });
    session.pendingMfaAction = null;
    return `Listo, cancelé tu pedido y quedó marcado como cancelado.`;
  }

  const delivery = await Delivery.findOne({ user: session.userId, status: { $in: ["pending", "ready_for_pickup"] } }).sort({ createdAt: -1 }).catch(() => null);
  if (!delivery) return "No encuentro un pedido activo que pueda cancelar en este momento.";

  session.pendingMfaAction = { type: "cancel_order", status: "waiting_for_method", deliveryId: delivery._id };
  return "Para confirmar la cancelación necesito verificar tu identidad. ¿Prefieres que te envíe el código por correo o por consola?";
};

const CLAIM_CATEGORY_ALIASES = {
  demora: "delay",
  delay: "delay",
  incompleto: "incomplete",
  incomplete: "incomplete",
  danado: "damaged",
  dañado: "damaged",
  damaged: "damaged",
  devolucion: "return",
  devolución: "return",
  return: "return",
  cancelacion: "cancellation",
  cancelación: "cancellation",
  cancellation: "cancellation"
};

const statusLabel = (status) => ({
  pending: "pendiente",
  ready_for_pickup: "listo para recojo",
  shipped: "enviado",
  delivered: "entregado",
  cancelled: "cancelado",
  returned: "devuelto"
}[status] || status || "pendiente");

const findUserDeliveryById = async (userId, rawId) => {
  if (!userId || !rawId) return null;
  const id = String(rawId).replace(/^#/, "").trim();
  const query = { user: userId };
  if (/^[a-f0-9]{24}$/i.test(id)) {
    query._id = id;
    return Delivery.findOne(query).populate("paymentId").lean().catch(() => null);
  }
  const deliveries = await Delivery.find({ user: userId }).populate("paymentId").lean().catch(() => []);
  return deliveries.find((delivery) => String(delivery._id).slice(-6).toLowerCase() === id.toLowerCase()) || null;
};

const buildOrderSummary = (delivery) => {
  const payment = delivery.paymentId || {};
  const products = (payment.productos || []).map((item) => `${item.name} x${item.quantity}`).join(", ");
  const history = (delivery.statusHistory || []).map((entry) => `${statusLabel(entry.status)} (${entry.timestamp ? new Date(entry.timestamp).toLocaleDateString("es-PE") : "sin fecha"})`).join(" > ");
  return `Pedido ${String(delivery._id).slice(-6).toUpperCase()}: ${statusLabel(delivery.status)}. Productos: ${products || "sin productos registrados"}. Tracking: ${history || statusLabel(delivery.status)}.`;
};
const resolveActionRequest = async (text, session = null) => {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  if (/(producto|figura|art[ií]culo|articulo).{0,20}(m[áa]s\s+caro|m[áa]s\s+costoso|mayor\s+precio|precio\s+mayor)/i.test(normalized) || /(?:m[áa]s\s+caro|m[áa]s\s+costoso|mayor\s+precio|precio\s+mayor)/i.test(normalized)) {
    const expensiveProduct = await findMostExpensiveProduct();
    if (!expensiveProduct) return "No tengo productos registrados en este momento para comparar precios.";
    return `El producto más caro que tengo registrado es "${expensiveProduct.name}" con precio S/. ${expensiveProduct.price}. Puedes revisarlo aquí: ${buildProductLink(expensiveProduct._id)}`;
  }

  if (/(agregar|añadir|sumar).*(carrito|cart)/i.test(normalized) || /(carrito|cart)/i.test(normalized)) {
    const hint = extractProductHint(normalized);
    const product = await addProductToCartSession(session, hint);

    if (product) {
      return `Listo, añadí "${product.name}" a tu carrito para que lo sigas revisando.`;
    }

    return "Puedo ayudarte con el carrito, pero por ahora no encuentro un producto disponible para agregar.";
  }

  return null;
};
const handleAutomationCommand = async (text, session) => {
  const userId = session?.userId;
  const normalized = String(text || "").trim();
  const shouldHandle = /^\/|^(ver|consultar|crear|generar|cancelar|cambiar|actualizar|modificar|editar|agregar|añadir|busca|muestra|dime|revisa|ayuda|quiero|necesito|puedes)/i.test(normalized) || /(mis pedidos|mis ordenes|mis compras|pedido|orden|producto|productos|perfil|dirección|direccion|teléfono|telefono|ciudad|carrito|cart|cancelar|cambiar|actualizar|modificar|editar)/i.test(normalized);

  if (!shouldHandle) return null;

  if (!userId) {
    return "Para ejecutar acciones necesito que escribas desde tu cuenta iniciada. Puedo orientarte, pero no modificar ni consultar pedidos sin identificarte.";
  }

  if (/^\/?(mis[-\s]?pedidos|ordenes|órdenes|mis pedidos|mis ordenes|mis compras)$/i.test(normalized) || /(mis pedidos|mis ordenes|mis compras)/i.test(normalized)) {
    const deliveries = await Delivery.find({ user: userId }).populate("paymentId").sort({ createdAt: -1 }).limit(5).lean().catch(() => []);
    if (!deliveries.length) return "No encuentro pedidos asociados a tu cuenta. Si acabas de pagar, espera unos segundos y vuelve a consultar.";
    return deliveries.map(buildOrderSummary).join("\n");
  }

  if (/(productos|catalogo|catálogo|stock|inventario|figuras)/i.test(normalized)) {
    const products = await Product.find().limit(10).lean().catch(() => []);
    if (!products.length) return "No encuentro productos disponibles en este momento.";
    return products.map((product) => `${product.name} - S/. ${product.price || 0} - stock ${product.stock || 0}`).join("\n");
  }

  if (/(perfil|mis datos|datos|nombre|apellido|dirección|direccion|ciudad|teléfono|telefono)/i.test(normalized)) {
    const user = await User.findById(userId).select("-password").lean().catch(() => null);
    if (!user) return "No puedo ver tu perfil sin que estés autenticado.";
    const details = [
      `Nombre: ${user.name || "sin registrar"}`,
      `Apellido: ${user.lastname || "sin registrar"}`,
      `Email: ${user.email || "sin registrar"}`,
      `Dirección: ${user.address || "sin registrar"}`,
      `Ciudad: ${user.city || "sin registrar"}`,
      `Teléfono: ${user.phone || "sin registrar"}`
    ];
    return `Estos son tus datos actuales:\n${details.join("\n")}`;
  }

  const orderMatch = normalized.match(/(?:pedido|orden|detalle|estado)\s+#?([a-f0-9]{24}|[a-z0-9]{6})/i);
  if (orderMatch && /ver|consultar|detalle|estado|pedido|orden/i.test(normalized)) {
    const delivery = await findUserDeliveryById(userId, orderMatch[1]);
    return delivery ? buildOrderSummary(delivery) : "No encontré ese pedido en tu cuenta. Revisa el ID corto o completo y lo intento de nuevo.";
  }

  const claimMatch = normalized.match(/(?:reclamo|reclamar)\s+#?([a-f0-9]{24}|[a-z0-9]{6})\s+([a-záéíóúñ]+)\s+(.+)/i);
  if (claimMatch) {
    const delivery = await findUserDeliveryById(userId, claimMatch[1]);
    if (!delivery) return "No encontré ese pedido en tu cuenta. No crearé reclamos sobre pedidos que no te pertenecen.";
    const category = CLAIM_CATEGORY_ALIASES[String(claimMatch[2]).toLowerCase()] || "";
    if (!category) return "La categoría no coincide. Usa demora, incompleto, dañado, devolución o cancelación.";
    const description = claimMatch[3].trim();
    const existingClaims = await Claim.find({ delivery: delivery._id, status: "pending" }).lean().catch(() => []);
    const decision = canCreateClaim({
      category,
      currentStatus: delivery.status,
      deadlineDate: delivery.estimatedDate || delivery.paymentId?.fecha,
      existingClaims
    }, new Date());
    if (!decision.allowed) return decision.reason;
    const review = await evaluateClaimDescription(description, category);
    if (!review.validClaim) return review.reason;
    await Claim.create({
      delivery: delivery._id,
      payment: delivery.paymentId?._id,
      user: userId,
      category,
      description,
      resolution: "pending",
      status: "pending"
    });
    return "Listo, registré tu reclamo y quedó pendiente de revisión por administración. Puedes seguir el avance desde Mis Pedidos.";
  }

  const actionReply = await resolveActionRequest(normalized, session);
  if (actionReply) return actionReply;

  if (/contrase|password/i.test(normalized)) {
    return "Puedo guiarte con el cambio de contraseña, pero no te pediré tu contraseña actual por chat. Ve a Perfil > Seguridad, solicita el cambio y cuando el sistema pida MFA ingresa el código recibido en tu correo.";
  }

  if (/crear\s+pedido|comprar|ordenar/i.test(normalized)) {
    return "Puedo ayudarte a encontrar productos y revisar stock. Para crear un pedido real usa el carrito y el checkout, porque ahí se valida pago, dirección y comprobante sin exponer datos sensibles en el chat.";
  }

  return null;
};

const CLASSIFICATION_PROMPT = (text) => `Eres un clasificador para el chatbot de atención al cliente de NendoShop (tienda de figuras Nendoroid). Analiza el mensaje del cliente y responde ÚNICAMENTE con un JSON válido, sin texto adicional, con esta forma exacta:

{
  "allowed": true,
  "block": false,
  "category": "apropiado",
  "reason": "",
  "intent": "",
  "productQuery": "",
  "orderNumber": "",
  "surveyRating": null
}

Reglas de moderación:
- Si el mensaje contiene insultos, amenazas, acoso, lenguaje sexual explícito o contenido violento: allowed=false, block=true, category="inapropiado".
- En cualquier otro caso: allowed=true, block=false, category="apropiado".
- Para moderar debes tener en cuenta sinonimos  y las palabras sexuales como los oparatos reproductos, fluidos y insultos especializados.

Intents posibles (elige exactamente uno):
- "saludo": el cliente solo saluda o inicia la conversación.
- "buscar_producto": pregunta por un producto, precio, stock o pide una recomendación.
- "consultar_pedido": pregunta por el estado de un pedido o envío.
- "devolucion": pregunta sobre devoluciones o cambios.
- "cuenta": problemas de acceso, cuenta o credenciales.
- "despedida": se está despidiendo o agradeciendo y da por terminada la conversación.
- "general": cualquier otro caso.

Si el intent es "buscar_producto", extrae en "productQuery" el nombre o pista del producto.
Si el intent es "consultar_pedido", extrae en "orderNumber" el número de pedido si aparece.

Mensaje del cliente: "${text}"`;

const fallbackClassification = (text) => {
  const lowered = text.toLowerCase();
  const safety = checkTextSafety(text);
  let intent = "general";
  if (/pedido|orden|env[ií]o|seguimiento/.test(lowered)) intent = "consultar_pedido";
  else if (/producto|figura|art[ií]culo|precio|stock|recomend/.test(lowered)) intent = "buscar_producto";
  else if (/devol|cambio/.test(lowered)) intent = "devolucion";
  else if (/cuenta|contrase|credencial|acceso/.test(lowered)) intent = "cuenta";
  else if (/gracias|adi[oó]s|terminamos|chau/.test(lowered)) intent = "despedida";

  return {
    allowed: safety.allowed,
    block: safety.block,
    category: safety.block ? "inapropiado" : "apropiado",
    reason: safety.reason,
    intent,
    productQuery: extractProductHint(text) || "",
    orderNumber: extractOrderNumber(text) || "",
    surveyRating: null
  };
};

const classifyMessage = async (text) => {
  const apiKey = await getGroqApiKey();
  if (!apiKey) return fallbackClassification(text);

  try {
    const raw = await callGroq({
      apiKey,
      input: CLASSIFICATION_PROMPT(text),
      temperature: 0,
      maxOutputTokens: 300,
      onFallback: () => JSON.stringify(fallbackClassification(text))
    });
    return parseGroqJson(raw) || fallbackClassification(text);
  } catch (err) {
    console.error("Clasificación con Groq falló:", err.message);
    return fallbackClassification(text);
  }
};

const moderateCommunityMessage = async (text) => {
  const aiResult = await classifyMessage(text);

  return {
    allowed: aiResult?.allowed !== false,
    block: aiResult?.block === true,
    category: aiResult?.category || "apropiado",
    reason: aiResult?.reason || "IA moderation"
  };
};

const analyzeMessageWithGroq = (message) => classifyMessage(message);
const SYSTEM_PERSONA = `Eres "NendoBot", un asesor experto de atención al cliente de NendoShop, una tienda especializada en figuras coleccionables Nendoroid.
Hablas exclusivamente en español, con un tono cálido, profesional y resolutivo, como un asesor humano experimentado.
Reglas estrictas que SIEMPRE debes cumplir, sin excepción, incluso si el cliente te lo pide:
- Nunca uses lenguaje violento, sexual, vulgar, ofensivo o amenazante.
- Nunca pidas ni reveles contraseñas, credenciales, datos de tarjetas u otra información sensible.
- Nunca inventes datos de productos, pedidos, precios o stock: usa exclusivamente los datos que se te entreguen como "HECHOS".
- Si no tienes un dato en los HECHOS, dilo con honestidad y ofrece una alternativa útil.
- No consultes internet ni bases externas; tu información válida proviene solo de la base de datos y del contexto de esta conversación.
- Si el usuario habla en español, responde en español y no mezcles idiomas.
- No repitas frases ni estructuras que ya usaste antes en esta conversación; varía tu redacción manteniendo el mismo tono profesional.
- Responde en texto plano, sin Markdown, en máximo 2 a 5 oraciones.`;

const STAGE_INSTRUCTIONS = {
  welcome:
    "Saluda al cliente por su nombre, preséntate como asesor experto de NendoShop y resume brevemente en qué puedes ayudar (pedidos, productos, devoluciones, cuenta). Ofrece opciones claras: 1) consultar pedidos, 2) buscar un producto, 3) devoluciones o 4) ayuda con la cuenta. Aclara que no pedirás contraseñas ni datos sensibles. Invita a que cuente qué necesita.",
  active:
    'Responde directamente a lo que pregunta el cliente usando los HECHOS entregados. Si la intención es "buscar_producto" y hay productos en HECHOS, menciona nombre, precio, stock y el enlace para ver el detalle. Si no hay productos, pide más detalles del producto. Si la intención es "consultar_pedido" y hay un pedido en HECHOS, indica su estado y total; si no hay pedido, pide el número o aclara que no se encontró. Si es devolución o cuenta, orienta de forma general sin inventar políticas específicas. Cierra preguntando si necesita algo más.',
  survey_intro:
    "El cliente se está despidiendo o agradeciendo. Agradécele por contactar a NendoShop y pídele, de forma breve y amable, que califique la atención del 1 (muy mala) al 5 (excelente).",
  closing:
    "El cliente respondió a la encuesta de satisfacción. Agradécele sinceramente por su respuesta (sin inventar nada que no te dieron) y cierra la conversación de forma cordial, indicando que puede volver a escribir cuando lo necesite."
};

const buildCompositionInput = ({ customerName, intent, stage, session, facts }) => {
  const recent = (session.history || [])
    .slice(-6)
    .map((h) => `${h.role === "user" ? "Cliente" : "NendoBot"}: ${h.text}`)
    .join("\n");

  const stageInstruction = STAGE_INSTRUCTIONS[stage] || STAGE_INSTRUCTIONS.active;

  return `${SYSTEM_PERSONA}

Nombre del cliente: ${customerName}
Intención detectada: ${intent}
Instrucción de la etapa actual: ${stageInstruction}

HECHOS (usa solo estos datos, no agregues otros):
${facts ? JSON.stringify(facts) : "No hay datos adicionales para esta respuesta."}

Conversación reciente (para que no repitas frases):
${recent || "(sin historial previo)"}

Escribe ahora el siguiente mensaje de NendoBot dirigido al cliente.`;
};

const fallbackTemplate = ({ customerName, stage, facts }) => {
  if (stage === "welcome") {
    return `Hola ${customerName}, soy NendoBot, asesor de NendoShop. Puedo ayudarte con pedidos, productos, devoluciones y cuenta. No pediré contraseñas ni datos sensibles. Si lo prefieres, puedes decirme 1) pedidos, 2) productos, 3) devoluciones o 4) tu cuenta.`;
  }
  if (facts?.tipo === "producto") {
    const [p] = facts.productos || [];
    if (p) {
      const commentsText = p.comentarios?.length ? ` Comentarios recientes: ${p.comentarios.join("; ")}` : "";
      const intro = facts.cheapest ? `El producto más económico que tengo registrado es "${p.nombre}".` : `Encontré "${p.nombre}".`;
      return `${intro} Tiene un precio de S/. ${p.precio} y ${p.stock} unidades disponibles. Puedes ver el detalle aquí: ${p.enlace}${commentsText}`;
    }
    return `En este momento no tengo un producto que coincida con esa búsqueda en la base de datos. Si me das el nombre o la categoría, te ayudo mejor. También puedo revisar el más económico si lo prefieres.`;
  }
  if (facts?.tipo === "pedido") {
    if (facts.pedido) {
      return `Tu pedido ${facts.pedido.numeroPedido} está ${facts.pedido.estado}. Total: S/. ${facts.pedido.total}.`;
    }
    return `No encontré ese número de pedido, ${customerName}. ¿Puedes confirmarlo?`;
  }
  if (stage === "survey_intro") {
    return `Gracias por contactarnos, ${customerName}. Antes de decir adiós, ¿podrías calificar nuestra atención del 1 al 5 para ayudarnos a mejorar?`;
  }
  if (stage === "closing") {
    return `Gracias por tu respuesta, ${customerName}. Cerramos esta conversación con satisfacción; escríbenos cuando lo necesites.`;
  }
  return `Gracias por tu mensaje, ${customerName}. ¿Podrías darme más detalles para ayudarte mejor?`;
};

const safeBlockedReply = (customerName) =>
  `Lo siento ${customerName}, no puedo continuar con ese tipo de mensaje. Reformula tu consulta sin lenguaje ofensivo, violento o sexual, y con gusto te ayudo.`;

const looksLikeEnglishReply = (reply) => {
  const text = String(reply || "").toLowerCase();
  return /(hello|hi|thank you|thanks|customer support|we need|the product|please|could|would|available|details|cart|survey)/i.test(text);
};

const composeReply = async ({ customerName, intent, stage, session, facts }) => {
  const apiKey = await getGroqApiKey();
  if (!apiKey) {
    return fallbackTemplate({ customerName, stage, facts });
  }

  const input = buildCompositionInput({ customerName, intent, stage, session, facts });

  let reply;
  try {
    reply = await callGroq({
      apiKey,
      input,
      temperature: 0.2,
      maxOutputTokens: 260,
      onFallback: () => fallbackTemplate({ customerName, stage, facts })
    });
  } catch (err) {
    console.error("Composición de respuesta falló:", err.message);
    reply = fallbackTemplate({ customerName, stage, facts });
  }

  const outputSafety = checkTextSafety(reply);
  if (outputSafety.block || looksLikeEnglishReply(reply)) {
    console.error("Respuesta generada bloqueada por seguridad de salida", { reply });
    return fallbackTemplate({ customerName, stage, facts });
  }

  return reply.trim();
};

const QUICK_INTENTS = {
  "1": "consultar_pedido",
  "2": "buscar_producto",
  "3": "devolucion",
  "4": "cuenta"
};

const gatherFacts = async (intent, text, classification, session) => {
  if (intent === "buscar_producto") {
    if (isCheapestRequest(text)) {
      const cheapestProduct = await findCheapestProduct();
      session.lastTopic = "productos";
      return {
        tipo: "producto",
        pista: "más barato",
        cheapest: true,
        productos: cheapestProduct ? [toProductFact(cheapestProduct)] : []
      };
    }

    const hint = classification.productQuery || extractProductHint(text);
    const products = await findProductsByHint(hint);
    session.lastTopic = "productos";
    return { tipo: "producto", pista: hint, productos: products.map(toProductFact) };
  }

  if (intent === "consultar_pedido") {
    const orderNumber = classification.orderNumber || extractOrderNumber(text);
    let payment = null;
    if (orderNumber) {
      payment = await Payment.findOne({ documento: orderNumber }).catch(() => null);
    }
    session.lastTopic = "pedidos";
    return { tipo: "pedido", numeroPedido: orderNumber, pedido: payment ? toPaymentFact(payment) : null };
  }

  if (intent === "devolucion") session.lastTopic = "devoluciones";
  if (intent === "cuenta") session.lastTopic = "cuenta";

  return null;
};

const handleSurveyAnswer = async (text, session) => {
  pushHistory(session, "user", text);
  const rating = extractSurveyRating(text);
  session.step = "closed";

  const reply = await composeReply({
    customerName: session.customerName,
    intent: "encuesta_respuesta",
    stage: "closing",
    session,
    facts: { tipo: "encuesta", calificacion: rating }
  });

  pushHistory(session, "bot", reply);
  return reply;
};

const getSupportBotReply = async (input, session) => {
  if (!session) session = createSupportSession();
  const text = String(input || "").trim();
  const customerName = session.customerName;
  const fastSafety = checkTextSafety(text);
  if (fastSafety.block) {
    return safeBlockedReply(customerName);
  }

  const actionReply = await resolveActionRequest(text, session);
  if (actionReply) {
    pushHistory(session, "user", text);
    pushHistory(session, "bot", actionReply);
    return actionReply;
  }

  const profileReply = await handleProfileUpdateRequest(text, session);
  if (profileReply) {
    pushHistory(session, "user", text);
    pushHistory(session, "bot", profileReply);
    return profileReply;
  }

  const cancelReply = await handleCancelOrderRequest(text, session);
  if (cancelReply) {
    pushHistory(session, "user", text);
    pushHistory(session, "bot", cancelReply);
    return cancelReply;
  }

  if (session.step === "welcome") {
    const welcomeClassification = fallbackClassification(text);
    const welcomeImmediateReply = getImmediateSupportReply({
      text,
      customerName,
      intent: welcomeClassification.intent
    });
    if (welcomeImmediateReply) {
      session.step = "active";
      pushHistory(session, "user", text);
      pushHistory(session, "bot", welcomeImmediateReply);
      return welcomeImmediateReply;
    }

    session.step = "active";
    const reply = await composeReply({ customerName, intent: "saludo", stage: "welcome", session, facts: null });
    pushHistory(session, "bot", reply);
    return reply;
  }

  if (session.step === "survey") {
    return handleSurveyAnswer(text, session);
  }

  if (session.step === "closed") {
    session.step = "active";
  }

  pushHistory(session, "user", text);

  const automationReply = await handleAutomationCommand(text, session);
  if (automationReply) {
    pushHistory(session, "bot", automationReply);
    return automationReply;
  }

  const quickClassification = fallbackClassification(text);
  const immediateReply = getImmediateSupportReply({
    text,
    customerName,
    intent: quickClassification.intent
  });

  if (immediateReply) {
    pushHistory(session, "bot", immediateReply);
    return immediateReply;
  }

  let intent;
  let classification = { allowed: true, block: false, productQuery: "", orderNumber: "" };

  if (QUICK_INTENTS[text]) {
    intent = QUICK_INTENTS[text];
  } else {
    classification = await classifyMessage(text);

    if (!classification.allowed || classification.block) {
      return safeBlockedReply(customerName);
    }

    intent = classification.intent || "general";
  }

  if (intent === "despedida") {
    session.step = "survey";
    session.surveyAsked = true;
    const reply = await composeReply({ customerName, intent, stage: "survey_intro", session, facts: null });
    pushHistory(session, "bot", reply);
    return reply;
  }

  const facts = await gatherFacts(intent, text, classification, session);

  const reply = await composeReply({ customerName, intent, stage: "active", session, facts });
  pushHistory(session, "bot", reply);
  return reply;
};

const buildSupportBotReply = getSupportBotReply;

module.exports = {
  SUPPORT_INTRO,
  ACTION_ROUTE_MAP,
  createSupportSession,
  getSupportBotReply,
  buildSupportBotReply,
  checkTextSafety,
  normalizeCustomerName,
  extractOrderNumber,
  extractProductHint,
  findProductsByHint,
  parseOrderIntent,
  parseDeliveryPreference,
  moderateCommunityMessage,
  analyzeMessageWithGroq 
};
