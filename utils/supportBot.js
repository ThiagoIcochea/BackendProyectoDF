const crypto = require("crypto");
const https = require("https");
const bcrypt = require("bcryptjs");
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
const { issueActionMfa: issueSharedActionMfa, verifyActionMfa: verifySharedActionMfa } = require("./twoFactor");

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
  "Hola, soy NendoBot, tu asesor de atenciÃ³n al cliente de NendoShop. Te puedo ayudar con pedidos, productos, reclamos, devoluciones y cuentas. TambiÃ©n puedo orientarte sobre un producto especÃ­fico o ayudarte a encontrar el mÃ¡s econÃ³mico.";

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
    .replace(/[Ã¡Ã Ã¤Ã¢]/g, "a")
    .replace(/[Ã©Ã¨Ã«Ãª]/g, "e")
    .replace(/[Ã­Ã¬Ã¯Ã®]/g, "i")
    .replace(/[Ã³Ã²Ã¶Ã´]/g, "o")
    .replace(/[ÃºÃ¹Ã¼Ã»]/g, "u");

const applyLeetSubstitutions = (text) =>
  String(text || "").replace(/[01345789!@$]/g, (ch) => LEET_SUBSTITUTIONS[ch] || ch);
const collapseRepeatedChars = (text) => String(text || "").replace(/([a-z0-9Ã±])\1+/g, "$1");
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
    "masacre", "hacerte daÃ±o"
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
    return { allowed: false, block: true, reason: "El mensaje estÃ¡ vacÃ­o." };
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
  pendingClaim: null,
  pendingProfileAction: null,
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
  const normalized = String(text || "").trim();
  const match = normalized.match(/(?:pedido|orden|n(?:Ãº|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento|id)[^a-z0-9]*([a-z0-9]{4,})/i);
  if (match) return match[1];
  const fallback = normalized.match(/\b([a-z0-9]{6,})\b/i);
  return fallback ? fallback[1] : null;
};

const extractProductHint = (text) => {
  const normalized = String(text || "").toLowerCase();
  const patterns = [
    /(?:producto|figura|art(?:Ã­|i)culo|modelo|articulo|artÃ­culo)[^a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9]*([a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9 .,'-]+)/i,
    /(?:quiero|busco|necesito|interesa|recomienda|ver|agrega|aÃ±ade|agregar|aÃ±adir|sumar)[^a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9]*([a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9 .,'-]+)/i,
    /(?:de|la|el|un|una|por|para|con)\s+([a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9 .,'-]{2,})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().replace(/\b(agregar|aÃ±adir|sumar|producto|figura|articulo|artÃ­culo|modelo|el|la|un|una|por|para|con|quiero|busco|necesito|interesa|recomienda|ver|de)\b/gi, "").trim();
      if (value) return value;
    }
  }

  return null;
};

const normalizeMfaMethod = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "email";
  if (["correo", "email", "mail"].includes(raw)) return "email";
  if (["sms", "mensaje", "texto", "smsm", "mensaje de texto"].includes(raw)) return "sms";
  if (["whatsapp", "wa", "wsp", "wasap"].includes(raw)) return "whatsapp";
  if (["llamada", "call", "llamar", "telefono", "telfono", "tel"].includes(raw)) return "call";
  if (["console", "consola"].includes(raw)) return "console";
  return raw;
};

const extractRequestedMfaMethod = (text) => {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return "email";
  const explicitMethod = normalized.match(/\b(correo|email|mail|sms|mensaje|texto|whatsapp|wa|wsp|wasap|llamada|call|llamar|consola|console)\b/i);
  return normalizeMfaMethod(explicitMethod ? explicitMethod[1] : "email");
};

const isClaimIntent = (text) => {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  const lowered = stripAccents(normalized).toLowerCase();
  if (/\b(hola|buenos|buenas|gracias|adios|adiÃ³s|estoy bien|todo bien|como estas|como estÃ¡s)\b/i.test(normalized)) return false;
  const hasClaimKeyword = /\b(reclamo|reclamar|queja|quejas|problema|problemas|incidente|fallo|fallar|fallÃ³|daÃ±ado|daÃ±ada|incompleto|incompleta|retraso|demora|demorado|cancelacion|cancelaciÃ³n|devolucion|devoluciÃ³n|reembolso|refund|error|no lleg[Ã³o]|lleg[Ã³o]|lleg[ao]|entreg[ao]|roto|rota|perdido|perdida)\b/i.test(lowered);
  return hasClaimKeyword || /\b(genera|genera el|crea|crea el|haz|hace)\s+(el\s+)?(reclamo|reclamar)\b/i.test(lowered);
};

const inferClaimCategory = (text) => {
  const normalized = stripAccents(String(text || "").trim()).toLowerCase();
  const priority = [
    /\b(incompleto|incompleta|faltante|falta|faltan|mal|daÃ±ado|daniado|roto|rota|quebrado|quebrada)\b/i,
    /\b(demora|retraso|tarde|atrasado|atrasada)\b/i,
    /\b(devolucion|devoluciÃ³n|devolutiva|reembolso|refund|regreso)\b/i,
    /\b(cancelacion|cancelaciÃ³n|cancelar)\b/i,
    /\b(fallo|fallo|error|problema|incidente)\b/i
  ];

  for (const pattern of priority) {
    if (pattern.test(normalized)) {
      const match = normalized.match(pattern);
      const raw = match?.[0] || "";
      return CLAIM_CATEGORY_ALIASES[raw] || CLAIM_CATEGORY_ALIASES[raw.toLowerCase()] || "delay";
    }
  }

  return "delay";
};
const parseClaimRequest = (text) => {
  const normalized = String(text || "").trim();
  if (!normalized || !isClaimIntent(normalized)) return null;
  const explicitOrderMatch = normalized.match(/\b(?:reclamo|reclamar|queja|problema)\b[^a-z0-9]*(?:a|para|por|del|de|sobre|con)\s+(?:el\s+)?(?:n(?:Ãº|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?\s+)?([a-z0-9]{4,})/i);
  const orderMatch =
    explicitOrderMatch ||
    normalized.match(/(?:pedido|orden|compra|id|n(?:Ãº|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento)[^a-z0-9]*([a-z0-9]{4,})/i) ||
    normalized.match(/\b([a-z0-9]{6,})\b/i);
  const description = normalized
    .replace(/(?:quiero|quieres|necesito|hacer|crear|abrir|generar|registrar|presentar|reclamo|reclamar|queja|problema|pedido|orden|compra|n(?:Ãº|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento|id|por|por favor|porfa|ayuda|con|el|la|un|una|mi|tengo|genera|genera el|crea|crea el|haz|hace|sobre|del|de)\s+/gi, " ")
    .replace(/\b(?:pedido|orden|n(?:Ãº|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento|id)\s+[a-z0-9]{4,}\b/gi, " ")
    .trim();
  return {
    orderNumber: orderMatch?.[1] || null,
    category: inferClaimCategory(normalized),
    description: description || "Reclamo generado por el asistente"
  };
};

const parseCheckoutIntent = (text) => {
  const normalized = String(text || "").trim();
  if (isClaimIntent(normalized)) {
    return null;
  }
  const hasAction = /\b(crear|crea|generar|genera|generame|hacer|haz|armar|confirmar|comprar|ordenar|quiero|necesito)\b/i.test(normalized);
  const hasOrderTerm = /\b(pedido|orden|compra|comprar|comprar algo|pedido nuevo|pedido real|hacer un pedido)\b/i.test(normalized);
  const hasCheckoutCue = /\b(genera|generame|crear|crea|hacer|haz|comprar|ordenar)\b/i.test(normalized);
  if (!hasAction || (!hasOrderTerm && !hasCheckoutCue)) {
    return null;
  }
  const deliveryType = parseDeliveryPreference(normalized);
  const paymentMethod = /paypal|paypay|paypal/i.test(normalized) ? "paypal" : /tarjeta|card|credito|debito|visa|mastercard/i.test(normalized) ? "card" : null;
  return {
    kind: "checkout",
    deliveryType,
    paymentMethod,
    text: normalized
  };
};

const extractProfileImageValue = (text) => {
  const normalized = String(text || "").trim();
  const match = normalized.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].trim() : null;
};

const parseProfileChangeRequest = (text) => {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  const accentless = stripAccents(normalized).toLowerCase();
  const photoMatch = normalized.match(/\b(foto|imagen|avatar|photo|profile)(?:\s+de\s+perfil)?\b/i);
  if (photoMatch) {
    const explicitUrl = extractProfileImageValue(normalized);
    return { kind: "photo", newValue: explicitUrl };
  }

  const phonePatterns = [
    /(?:tel(?:e|Ã©)?fono|telefono|phone|celular|numero|numero|telfono|tel)[^0-9+]*([0-9+\-\s]{4,})/i,
    /(?:cambiar|cambio|actualizar|modificar|editar|poner|cambia|actualiza|modifica|edita|setea|asigna|cambiame|cambie|cambiamelo|cÃ¡mbiame|cÃ¡mbie)(?:\s|[^a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼])*?(?:tel(?:e|Ã©)?fono|telefono|phone|celular|numero|numero|telfono|tel)(?:[^0-9+]*)([0-9+\-\s]{4,})/i,
    /(?:tel(?:e|Ã©)?fono|telefono|phone|celular|numero|numero|telfono|tel)(?:\s|[^a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼])*?(?:a|al|nuevo|nueva|por|:)?(?:\s*)([0-9+\-\s]{4,})/i
  ];

  for (const pattern of phonePatterns) {
    const phoneMatch = normalized.match(pattern) || accentless.match(new RegExp(pattern.source, pattern.flags));
    if (phoneMatch?.[1]) {
      return { kind: "phone", newValue: phoneMatch[1].trim() };
    }
  }

  const passwordMatch = normalized.match(/(?:contrase(?:Ã±|n)a|password)[^\w]*?(?:a|al|nueva|nuevo)?[^\w]*([A-Za-z0-9!@#$%^&*()_+=\-]{4,})/i);
  if (passwordMatch) {
    return { kind: "password", newPassword: passwordMatch[1].trim() };
  }

  return null;
};

const buildKeyValueContext = (text) => {
  const lower = String(text || "").toLowerCase();
  const context = {};
  const productHints = ["producto", "figura", "modelo", "artÃ­culo", "articulo"].filter((hint) => lower.includes(hint));
  const orderHints = ["pedido", "orden", "compra", "envÃ­o", "envio"].filter((hint) => lower.includes(hint));
  const profileHints = ["perfil", "datos", "nombre", "apellido", "direcciÃ³n", "direccion", "ciudad", "telÃ©fono", "telefono"].filter((hint) => lower.includes(hint));
  const cartHints = ["carrito", "cart"].filter((hint) => lower.includes(hint));
  const actionHints = ["agregar", "aÃ±adir", "sumar", "agrega", "aÃ±ade"].filter((hint) => lower.includes(hint));
  if (cartHints.length || (actionHints.length && lower.includes("carrito"))) context.area = "carrito";
  else if (productHints.length) context.area = "productos";
  else if (orderHints.length) context.area = "pedidos";
  else if (profileHints.length) context.area = "perfil";
  context.intent = context.area || "general";
  context.productHint = extractProductHint(text);
  context.orderNumber = extractOrderNumber(text);
  return context;
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
  if (/(env[iÃ­]o|envio|casa|domicilio|shipping|delivery)/i.test(lowered)) return "shipping";
  return null;
};

const extractSurveyRating = (text) => {
  const numMatch = text.match(/\b([1-5])\b/);
  if (numMatch) return Number(numMatch[1]);
  if (/\b(si|sÃ­|excelente|genial|perfecto|bien|ok|okay)\b/i.test(text)) return 5;
  if (/\b(no|mal|p[eÃ©]simo|regular|mejorar)\b/i.test(text)) return 2;
  return null;
};

const explainRolePattern = /\b(quÃ© haces|que haces|por quÃ© haces|por que haces|para quÃ© sirves|cuÃ¡l es tu funciÃ³n|cual es tu funcion|tus funciones|funciones)\b/i;
const offTopicPattern = /\b(politica|polÃ­tica|deporte|futbol|pelÃ­cula|pelicula|serie|noticia|clima|juego|mÃºsica|musica|viaje|cocina|comida|humor|chiste)\b/i;
const scopeIntentPattern = /\b(pedido|orden|envÃ­o|envio|producto|precio|stock|devolucion|devoluciÃ³n|cambio|cuenta|acceso|contraseÃ±a|contrase|credencial|ayuda)\b/i;

const getImmediateSupportReply = ({ text, customerName, intent }) => {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  if (explainRolePattern.test(normalized)) {
    return `Soy NendoBot, tu asesor de atenciÃ³n al cliente de NendoShop. Puedo ayudarte con pedidos, productos, devoluciones y soporte de cuenta. Si tienes una consulta sobre alguno de esos temas, te ayudo enseguida.`;
  }

  if (intent === "devolucion") {
    return /pedido|producto/i.test(normalized)
      ? `Puedo orientarte sobre devoluciones, reclamos y cambios. Si me compartes el nÃºmero de pedido o el producto, te digo quÃ© pasos seguir y si aplica.`
      : `Puedo orientarte sobre devoluciones, reclamos y cambios. Si me dices el pedido o el producto, te ayudo a ver si aplica y quÃ© hacer.`;
  }

  if (intent === "cuenta") {
    return `Puedo ayudarte con acceso a tu cuenta, recuperaciÃ³n de datos o cambios bÃ¡sicos. No pedirÃ© tu contraseÃ±a; si me explicas el problema, te guÃ­o paso a paso.`;
  }

  if (offTopicPattern.test(normalized) || (!scopeIntentPattern.test(normalized) && /\b(quiero|necesito|puedes|ayuda|dime|habl|como)\b/i.test(normalized))) {
    return `Mi funciÃ³n es ayudarte con pedidos, productos, reclamos, devoluciones y cuenta en NendoShop. Si tu consulta es de otro tema, esa no es mi finalidad.`;
  }

  return null;
};

const isCheapestRequest = (text) => /(?:producto|art[iÃ­]culo|figura).{0,20}(m[Ã¡a]s\s+barato|barato|m[Ã¡a]s\s+econ[oÃ³]mico|econ[oÃ³]mico|menor\s+precio|precio\s+menor)/i.test(text) || /(?:m[Ã¡a]s\s+barato|barato|m[Ã¡a]s\s+econ[oÃ³]mico|econ[oÃ³]mico|menor\s+precio|precio\s+menor)/i.test(text);

const isDiscountQuery = (text) => /(?:descuento|descuentos|oferta|ofertas|promocion|promociÃ³n|promo|rebaja|rebajado|en descuento|con descuento|filtra|filtrar|solo|mostrar|muestra|con descuento)/i.test(String(text || ""));

const normalizeSearchTokens = (text) => {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized
    .split(/[\s/,-]+/)
    .filter(Boolean)
    .filter((token) => !["producto", "productos", "figura", "figuras", "modelo", "modelos", "articulo", "artÃ­culo", "descuento", "descuentos", "oferta", "ofertas", "promo", "promocion", "promociÃ³n", "rebaja", "rebajado", "con", "en", "por", "para", "quiero", "necesito", "busco", "muestra", "dime", "ver", "lista", "mejores", "barato", "caro", "de", "del", "la", "el", "un", "una", "filtra", "filtrar", "solo", "mostrar"].includes(token));
};

const rankProductMatches = (hint, products = []) => {
  const normalizedHint = String(hint || "").trim().toLowerCase();
  const tokens = normalizeSearchTokens(normalizedHint);
  if (!tokens.length || !products.length) return [];

  const scoreProduct = (product) => {
    const haystack = [product.name, product.description, product?.specs?.categoria, product?.specs?.marca]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    let score = 0;
    const exactPhrase = normalizedHint.includes("miku") || normalizedHint.includes("hatsune") ? normalizedHint : normalizedHint;

    if (haystack.includes(normalizedHint)) score += 80;
    if (haystack.includes(exactPhrase)) score += 20;
    tokens.forEach((token) => {
      if (haystack.includes(token)) score += 12;
    });
    if (product.name?.toLowerCase().includes(normalizedHint)) score += 25;
    if (product.description?.toLowerCase().includes(normalizedHint)) score += 10;
    if (product?.specs?.categoria?.toLowerCase().includes(normalizedHint)) score += 8;
    return score;
  };

  return products
    .map((product) => ({ product, score: scoreProduct(product) }))
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score > 0)
    .map((item) => ({ ...item.product, score: item.score }));
};

const filterProductsForQuery = (hint, products = []) => {
  const normalizedHint = String(hint || "").trim();
  const wantsDiscounts = isDiscountQuery(normalizedHint);
  const baseProducts = Array.isArray(products) ? products : [];
  const filtered = wantsDiscounts
    ? baseProducts.filter((product) => Number(product.discount || 0) > 0)
    : baseProducts;

  if (!normalizedHint) return filtered.slice(0, 5);
  const searchTokens = normalizeSearchTokens(normalizedHint);
  if (!searchTokens.length) return filtered.slice(0, 5);
  const ranked = rankProductMatches(normalizedHint, filtered);
  return ranked.slice(0, 5);
};

const findProductsByHint = async (hint) => {
  if (!hint) return [];
  const words = normalizeSearchTokens(hint);
  if (!words.length) return [];

  try {
    const products = await Product.find({}).lean();
    return filterProductsForQuery(hint, products);
  } catch (err) {
    return [];
  }
};

const findCheapestProduct = async () => {
  try {
    return await Product.findOne({}).sort({ price: 1, stock: -1 }).lean();
  } catch (err) {
    console.error("No se pudo consultar el producto mÃ¡s barato:", err.message);
    return null;
  }
};

const findMostExpensiveProduct = async () => {
  try {
    return await Product.findOne({}).sort({ price: -1, stock: -1 }).lean();
  } catch (err) {
    console.error("No se pudo consultar el producto mÃ¡s caro:", err.message);
    return null;
  }
};

const findBestDiscountProduct = async () => {
  try {
    const products = await Product.find({}).lean();
    if (!products.length) return null;
    return products
      .filter((product) => Number(product.discount || 0) > 0)
      .sort((a, b) => Number(b.discount || 0) - Number(a.discount || 0) || Number(b.price || 0) - Number(a.price || 0))[0] || null;
  } catch (err) {
    console.error("No se pudo consultar el producto con mayor descuento:", err.message);
    return null;
  }
};

const getDisplayPrice = (product) => {
  const price = Number(product?.price || 0);
  const discount = Number(product?.discount || 0);
  if (discount > 0) {
    const discounted = price * (1 - discount);
    return Number(discounted.toFixed(2));
  }
  return Number(price.toFixed(2));
};

const toProductFact = (product) => ({
  nombre: product.name,
  precio: getDisplayPrice(product),
  precio_original: Number(product.price || 0),
  stock: product.stock || 0,
  descuento: Number(product.discount || 0),
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

  if (selectedMethod === "console") {
    console.log(`[MFA supportBot] CÃ³digo para ${user.email}: ${code}`);
    return { sentBy: "console" };
  }

  if (selectedMethod === "email") {
    if (!resendClient) {
      console.log(`[MFA supportBot] CÃ³digo para ${user.email}: ${code}`);
      return { sentBy: "email", fallback: true };
    }

    const from = (process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev").trim();
    await resendClient.emails.send({
      from,
      to: user.email,
      subject: "CÃ³digo de verificaciÃ³n - Nendoshop",
      text: `Hola ${user.name || user.email}, tu cÃ³digo de verificaciÃ³n es ${code}. Expira en 5 minutos.`,
      html: `<p>Hola ${user.name || user.email},</p><p>Tu cÃ³digo de verificaciÃ³n es:</p><h2>${code}</h2><p>Expira en 5 minutos.</p>`
    });
    return { sentBy: "email" };
  }

  if (!user.phone) {
    console.log(`[MFA supportBot] Sin telÃ©fono para ${selectedMethod}; enviando por correo: ${code}`);
    return { sentBy: "email", fallback: true };
  }

  const macroMethod = selectedMethod === "whatsapp" ? "wtsp" : selectedMethod === "call" ? "call" : selectedMethod === "sms" ? "sms" : "email";
  const nombre = encodeURIComponent(user.name || user.email);
  const numero = encodeURIComponent(String(user.phone));
  const url = `https://trigger.macrodroid.com/543902b9-9627-4797-833f-8ab08ee4a3ec/otp?nombre=${nombre}&numero=${numero}&metodo=${macroMethod}&codigo=${code}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ sentBy: selectedMethod }));
    }).on("error", () => resolve({ sentBy: selectedMethod, error: true }));
  });
};

const issueActionMfa = async (user, method = "email") => {
  const selectedMethod = normalizeMfaMethod(method);
  const result = await issueSharedActionMfa(user, selectedMethod, {
    subject: "CÃ³digo de verificaciÃ³n - Nendoshop",
    title: "VerificaciÃ³n de seguridad",
    description: "Tu cÃ³digo de verificaciÃ³n para el asistente es:"
  });

  if (result?.error) {
    throw new Error(result.message || "No se pudo enviar el cÃ³digo de verificaciÃ³n.");
  }

  return {
    tempToken: result.tempToken,
    code: result.code,
    fallback: result.fallback || false
  };
};

const verifyActionMfa = async (user, tempToken, code) => verifySharedActionMfa(user, tempToken, code);

const handleProfileUpdateRequest = async (text, session) => {
  if (!session?.userId) return null;
  const normalized = String(text || "").trim();
  if (!/(cambiar|actualizar|modificar|editar|poner|cambia|actualiza|modifica|edita|setea|asigna)/i.test(normalized)) {
    return null;
  }

  const user = await User.findById(session.userId).catch(() => null);
  if (!user) {
    const parsedUpdate = parseProfileChangeRequest(normalized);
    if (parsedUpdate?.kind === "photo") {
      session.pendingProfileAction = { type: "photo_change", status: "waiting_for_value" };
      return "Claro, puedo cambiar tu foto de perfil. EnvÃ­ame la URL de la imagen que quieres usar.";
    }
    return null;
  }

  const parsedUpdate = parseProfileChangeRequest(normalized);
  if (session.pendingProfileAction?.type === "photo_change" && session.pendingProfileAction.status === "waiting_for_value") {
    const imageValue = extractProfileImageValue(normalized);
    if (!imageValue) {
      return "EnvÃ­ame la URL de la imagen que quieres usar para tu foto de perfil.";
    }
    user.profileImg = imageValue;
    await user.save();
    session.pendingProfileAction = null;
    return "Listo, actualicÃ© tu foto de perfil con la imagen que compartiste.";
  }

  if (session.pendingMfaAction?.status === "waiting_for_code") {
    const codeMatch = normalized.match(/\b(\d{6})\b/);
    if (!codeMatch) return null;
    const pending = session.pendingMfaAction;
    const user = await User.findById(session.userId).catch(() => null);
    if (!user) return "No puedo validar el cÃ³digo sin tu cuenta.";
    const ok = await verifyActionMfa(user, pending.tempToken, codeMatch[1]);
    if (!ok) return "El cÃ³digo no es vÃ¡lido o ya expirÃ³. Solicita uno nuevo para continuar.";
    if (pending.type === "phone_change") {
      user.phone = pending.newValue;
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, actualicÃ© tu telÃ©fono y quedÃ³ verificado con MFA.";
    }
    if (pending.type === "password_change") {
      const newPassword = pending.newPassword;
      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, cambiÃ© tu contraseÃ±a correctamente y quedÃ³ verificada con MFA.";
    }
    if (pending.type === "cancel_order") {
      const delivery = await Delivery.findById(pending.deliveryId).catch(() => null);
      if (!delivery) return "No encontrÃ© ese pedido para cancelarlo.";
      if (!(["pending", "ready_for_pickup"].includes(delivery.status))) {
        session.pendingMfaAction = null;
        return `El pedido ya no se puede cancelar porque estÃ¡ en estado ${delivery.status}.`;
      }
      delivery.status = "cancelled";
      delivery.cancellationReason = "Cancelado por el asistente con MFA";
      syncStatusHistory(delivery, "cancelled", { note: delivery.cancellationReason });
      await delivery.save();
      await recordLog({ req: { user: { id: session.userId, email: user.email } }, usuario: user.email, descripcion: `Pedido ${delivery._id} cancelado por asistente`, tipo: "PEDIDO", metodo: "BOT", ruta: "/chatbot" });
      session.pendingMfaAction = null;
      return "Listo, cancelÃ© tu pedido y quedÃ³ marcado como cancelado.";
    }
  }

  if (parsedUpdate?.kind === "photo") {
    if (parsedUpdate.newValue) {
      user.profileImg = parsedUpdate.newValue;
      await user.save();
      session.pendingProfileAction = null;
      return "Listo, actualicÃ© tu foto de perfil.";
    }
    session.pendingProfileAction = { type: "photo_change", status: "waiting_for_value" };
    return "Claro, puedo cambiar tu foto de perfil. EnvÃ­ame la URL de la imagen que quieres usar.";
  }

  if (parsedUpdate?.kind === "password") {
    const pending = session.pendingMfaAction || null;
    if (pending?.type === "password_change" && pending.status === "waiting_for_code") {
      const code = normalized.match(/\b(\d{6})\b/);
      if (!code) {
        return "Te enviÃ© un cÃ³digo de verificaciÃ³n. EnvÃ­ame los 6 dÃ­gitos para confirmar el cambio de contraseÃ±a.";
      }
      const ok = await verifyActionMfa(user, pending.tempToken, code[1]);
      if (!ok) {
        return "El cÃ³digo no es vÃ¡lido o ya expirÃ³. Solicita uno nuevo para continuar.";
      }
      const newPassword = pending.newPassword;
      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, cambiÃ© tu contraseÃ±a correctamente y quedÃ³ verificada con MFA.";
    }

    const newPassword = parsedUpdate.newPassword;
    if (!newPassword) {
      return "Puedo ayudarte a cambiar la contraseÃ±a. CompÃ¡rteme la nueva contraseÃ±a y te pedirÃ© la verificaciÃ³n por correo antes de aplicarla.";
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(newPassword)) {
      return "La nueva contraseÃ±a debe tener al menos 8 caracteres, una letra, un nÃºmero y un sÃ­mbolo.";
    }
    const requestedMethod = extractRequestedMfaMethod(normalized);
    const tempToken = await issueActionMfa(user, requestedMethod);
    session.pendingMfaAction = { type: "password_change", status: "waiting_for_code", tempToken, newPassword, method: requestedMethod };
    const methodLabel = requestedMethod === "email" ? "correo" : requestedMethod === "console" ? "consola" : requestedMethod === "call" ? "llamada" : requestedMethod === "whatsapp" ? "WhatsApp" : "SMS";
    return `Te enviÃ© un cÃ³digo de verificaciÃ³n por ${methodLabel}. EnvÃ­ame los 6 dÃ­gitos para confirmar el cambio de contraseÃ±a.`;
  }

  if (/contrase(?:Ã±|n)a|password/i.test(normalized)) {
    return "Puedo ayudarte a cambiar la contraseÃ±a. Solo harÃ© el cambio al confirmar el cÃ³digo MFA que te envÃ­e por correo.";
  }

  if (parsedUpdate?.kind === "phone") {
    const pending = session.pendingMfaAction || null;
    if (pending?.type === "phone_change" && pending.status === "waiting_for_code") {
      const code = normalized.match(/\b(\d{6})\b/);
      if (!code) {
        return "Te enviÃ© un cÃ³digo de verificaciÃ³n. EnvÃ­ame los 6 dÃ­gitos para confirmar el cambio de telÃ©fono.";
      }
      const ok = await verifyActionMfa(user, pending.tempToken, code[1]);
      if (!ok) {
        return "El cÃ³digo no es vÃ¡lido o ya expirÃ³. Solicita uno nuevo para continuar.";
      }
      user.phone = pending.newValue;
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, actualicÃ© tu telÃ©fono y quedÃ³ verificado con MFA.";
    }

    if (!parsedUpdate.newValue) {
      return "Claro, dime el nuevo telÃ©fono para continuar con la actualizaciÃ³n.";
    }

    try {
      const requestedMethod = extractRequestedMfaMethod(normalized);
      const mfaResult = await issueActionMfa(user, requestedMethod);
      session.pendingMfaAction = { type: "phone_change", status: "waiting_for_code", tempToken: mfaResult.tempToken, newValue: parsedUpdate.newValue, method: requestedMethod };
      const fallbackText = mfaResult.fallback ? ` El cÃ³digo para pruebas es ${mfaResult.code}.` : "";
      const methodLabel = requestedMethod === "email" ? "correo" : requestedMethod === "console" ? "consola" : requestedMethod === "call" ? "llamada" : requestedMethod === "whatsapp" ? "WhatsApp" : "SMS";
      return `Te enviÃ© un cÃ³digo de verificaciÃ³n por ${methodLabel}${mfaResult.fallback ? " (se registrÃ³ en consola porque el canal fallÃ³)" : ""}. EnvÃ­ame los 6 dÃ­gitos para confirmar el cambio de telÃ©fono.${fallbackText}`;
    } catch (error) {
      return `No pude enviarte el cÃ³digo en este momento: ${error.message}`;
    }
  }

  if (/(tel(?:e|Ã©)?fono|telefono|phone|celular|numero|telfono|tel)\b/i.test(normalized)) {
    return "Claro, dime el nuevo telÃ©fono para continuar con la actualizaciÃ³n.";
  }

  const fieldMap = [
    { label: "nombre", pattern: /(nombre|name)\b/i, field: "name" },
    { label: "apellido", pattern: /(apellido|lastname|last name)\b/i, field: "lastname" },
    { label: "direcciÃ³n", pattern: /(direcciÃ³n|direccion|address|domicilio)\b/i, field: "address" },
    { label: "ciudad", pattern: /(ciudad|city)\b/i, field: "city" },
    { label: "telÃ©fono", pattern: /(telÃ©fono|telefono|phone|celular)\b/i, field: "phone" }
  ];

  for (const field of fieldMap) {
    const match = normalized.match(new RegExp(`(?:${field.label}|${field.field})[^a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9]*([a-zÃ¡Ã©Ã­Ã³ÃºÃ±Ã¼0-9 .,'/-]+)$`, "i"));
    if (match && match[1]) {
      user[field.field] = match[1].trim();
      await user.save();
      return `Listo, actualicÃ© tu ${field.label}.`;
    }
  }

  return "Puedo actualizar tu perfil. DÃ­me quÃ© dato quieres cambiar y el nuevo valor, por ejemplo: cambia mi direcciÃ³n a Av. Siempre Viva 123.";
};

const handleCheckoutRequest = async (text, session) => {
  if (!session?.userId) return null;
  const normalized = String(text || "").trim();
  const checkoutIntent = parseCheckoutIntent(normalized);
  if (!checkoutIntent) return null;

  const cartItems = Array.isArray(session.cartItems) ? session.cartItems : [];
  if (!cartItems.length) {
    session.pendingMfaAction = null;
    return "Tu carrito estÃ¡ vacÃ­o. Agrega productos primero y luego te ayudo a convertirlos en una orden real.";
  }

  const currentUser = await User.findById(session.userId).catch(() => null);
  if (!currentUser) return "No encuentro tu cuenta para iniciar el pedido.";

  const pending = session.pendingMfaAction || null;
  const shippingFee = 15;
  const baseTotal = cartItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
  const totalWithShipping = baseTotal + shippingFee;
  const requestedDeliveryType = checkoutIntent.deliveryType || parseDeliveryPreference(normalized);
  const requestedMethod = checkoutIntent.paymentMethod || null;

  if (requestedDeliveryType && requestedMethod && !pending) {
    session.pendingMfaAction = {
      type: "checkout",
      status: requestedMethod === "card" && currentUser.paymentmethod ? "waiting_for_confirmation" : "waiting_for_payment_method",
      deliveryType: requestedDeliveryType,
      address: null,
      reference: null,
      agency: null,
      paymentMethod: requestedMethod
    };
  }

  if (pending?.type === "checkout" && pending.status === "waiting_for_delivery_type") {
    const deliveryType = parseDeliveryPreference(normalized);
    if (!deliveryType) {
      return "Perfecto, primero dime si deseas recojo en tienda o envÃ­o a domicilio. Si eliges envÃ­o, te aviso el costo antes de continuar.";
    }

    session.pendingMfaAction = {
      ...pending,
      deliveryType,
      status: deliveryType === "shipping" ? "waiting_for_shipping_data" : "waiting_for_payment_method"
    };

    if (deliveryType === "shipping") {
      return `Elegiste envÃ­o a domicilio. Ese envÃ­o tiene un costo de S/. ${shippingFee.toFixed(2)}. Ahora envÃ­ame la direcciÃ³n, el distrito y una referencia para continuar.`;
    }

    return "Elegiste recojo en tienda. Ahora dime si pagarÃ¡s con tarjeta o con PayPal.";
  }

  if (pending?.type === "checkout" && pending.status === "waiting_for_shipping_data") {
    const addressMatch = normalized.match(/(?:direccion|direcciÃ³n|calle|avenida|av\.?|jr\.?|jiron|jirÃ³n)[^:]*[:\-]?\s*(.+)/i);
    const referenceMatch = normalized.match(/(?:referencia|ref\.?)[^:]*[:\-]?\s*(.+)/i);
    const address = addressMatch?.[1]?.trim() || pending.address || null;
    const reference = referenceMatch?.[1]?.trim() || pending.reference || null;

    if (!address) {
      session.pendingMfaAction = { ...pending, deliveryType: "shipping", status: "waiting_for_shipping_data" };
      return `AÃºn me falta la direcciÃ³n de entrega. EnvÃ­amela junto con el distrito, por favor. El envÃ­o cuesta S/. ${shippingFee.toFixed(2)}.`;
    }

    session.pendingMfaAction = {
      ...pending,
      deliveryType: "shipping",
      address,
      reference,
      status: "waiting_for_payment_method"
    };
    return "Gracias. Ahora dime si pagarÃ¡s con tarjeta o con PayPal.";
  }

  if ((pending?.type === "checkout" && pending.status === "waiting_for_payment_method") || (requestedDeliveryType && requestedMethod && !pending)) {
    const method = requestedMethod || (/paypal|paypay|paypal/i.test(normalized) ? "paypal" : /tarjeta|card|credito|debito|visa|mastercard/i.test(normalized) ? "card" : null);
    if (!method) return "Dime si pagarÃ¡s con PayPal o con tarjeta.";

    const checkoutState = pending?.type === "checkout" ? pending : session.pendingMfaAction || {
      type: "checkout",
      deliveryType: requestedDeliveryType || "shipping",
      address: null,
      reference: null,
      agency: null
    };
    session.pendingMfaAction = { ...checkoutState, paymentMethod: method, status: "waiting_for_confirmation" };

    if (method === "paypal") {
      setSessionMeta(session, {
        type: "navigate",
        path: "/pagos",
        paymentMethod: "paypal",
        deliveryType: session.pendingMfaAction.deliveryType || requestedDeliveryType || "shipping"
      });
      return "Perfecto, te llevo al pago seguro de PayPal para terminar la compra. Cuando finalices, la orden quedarÃ¡ completada automÃ¡ticamente.";
    }

    if (currentUser.paymentmethod?.numerotarjeta) {
      const masked = String(currentUser.paymentmethod.numerotarjeta).replace(/\d(?=\d{4})/g, "â€¢");
      setSessionMeta(session, {
        type: "navigate",
        path: "/pagos",
        paymentMethod: "card",
        deliveryType: session.pendingMfaAction.deliveryType || requestedDeliveryType || "shipping"
      });
      return `Tengo una tarjeta guardada que termina en ${masked.slice(-4)}. Te llevo al pago seguro para continuar con esa misma tarjeta.`;
    }

    setSessionMeta(session, {
      type: "navigate",
      path: "/pagos",
      paymentMethod: "card",
      deliveryType: session.pendingMfaAction.deliveryType || requestedDeliveryType || "shipping"
    });
    return "Perfecto, te llevo al pago seguro para que completes la tarjeta con los datos necesarios.";
  }

  if (/^(si|sÃ­|si gracias|ok|okay|listo|confirmo|acepto)$/i.test(normalized)) {
    if (pending?.type === "checkout" && pending.status === "waiting_for_confirmation") {
      const paymentPayload = {
        cliente: currentUser.name || currentUser.email,
        documento: `BOT-${Date.now().toString().slice(-6)}`,
        productos: cartItems.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
        total: pending.deliveryType === "shipping" ? totalWithShipping : baseTotal,
        deliveryType: pending.deliveryType || "shipping",
        metodo_envio: pending.deliveryType === "shipping" ? "delivery" : "recojo",
        direccion_entrega: pending.deliveryType === "shipping" ? pending.address || currentUser.address || "Pendiente" : "Recojo en tienda",
        referencia: pending.deliveryType === "shipping" ? pending.reference || "Pendiente" : undefined,
        envio: pending.deliveryType === "shipping" ? shippingFee : 0,
        estado: "Pagado"
      };

      if (currentUser.paymentmethod) {
        paymentPayload.saveCard = true;
        paymentPayload.paymentmethod = {
          nombretarjeta: currentUser.paymentmethod.nombretarjeta || "",
          numerotarjeta: currentUser.paymentmethod.numerotarjeta || "",
          cvv: currentUser.paymentmethod.cvv || "",
          tipo: currentUser.paymentmethod.tipo || "visa"
        };
      }

      const payment = await Payment.create(paymentPayload);
      await Delivery.create({
        paymentId: payment._id,
        user: session.userId,
        deliveryType: pending.deliveryType || "shipping",
        status: "pending",
        statusHistory: [{ status: "pending", timestamp: new Date(), note: "Pedido creado por asistente" }],
        destinationAddress: pending.deliveryType === "shipping" ? pending.address || currentUser.address || "Pendiente" : undefined,
        reference: pending.deliveryType === "shipping" ? pending.reference || "Pendiente" : undefined,
        agency: pending.deliveryType === "shipping" ? "Pendiente de registro" : undefined
      });
      session.pendingMfaAction = null;
      session.cartItems = [];
      return `Listo, generÃ© tu pedido real. El nÃºmero de pedido es ${payment.documento}.`;
    }
  }

  const deliveryType = requestedDeliveryType || pending?.deliveryType || null;
  if (!deliveryType) {
    session.pendingMfaAction = { type: "checkout", status: "waiting_for_delivery_type", deliveryType: null, address: null, reference: null, agency: null };
    return "Perfecto, voy a preparar tu pedido. Primero dime si deseas recojo en tienda o envÃ­o a domicilio.";
  }

  session.pendingMfaAction = {
    type: "checkout",
    status: deliveryType === "shipping" ? "waiting_for_shipping_data" : "waiting_for_payment_method",
    deliveryType,
    address: null,
    reference: null,
    agency: null
  };

  if (deliveryType === "shipping") {
    return `Perfecto, voy a preparar tu pedido con envÃ­o a domicilio. Ese envÃ­o tiene un costo de S/. ${shippingFee.toFixed(2)}. EnvÃ­ame la direcciÃ³n, el distrito y una referencia para continuar.`;
  }

  return "Perfecto, voy a preparar tu pedido con recojo en tienda. Ahora dime si pagarÃ¡s con tarjeta o con PayPal.";

  if (/^(si|sÃ­|si gracias|ok|okay|listo|confirmo|acepto)$/i.test(normalized)) {
    if (session.pendingMfaAction?.type === "checkout" && session.pendingMfaAction.status === "waiting_for_confirmation") {
      const user = await User.findById(session.userId).catch(() => null);
      if (!user) return "No encuentro tu cuenta para iniciar el pedido.";
      const paymentPayload = {
        cliente: user.name || user.email,
        documento: `BOT-${Date.now().toString().slice(-6)}`,
        productos: session.cartItems || [],
        total: (session.cartItems || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0),
        deliveryType: session.pendingMfaAction.deliveryType,
        direccion_entrega: session.pendingMfaAction.deliveryType === "shipping" ? session.pendingMfaAction.address || "Pendiente" : undefined,
        referencia: session.pendingMfaAction.deliveryType === "shipping" ? session.pendingMfaAction.reference || "Pendiente" : undefined,
        metodo_envio: session.pendingMfaAction.deliveryType === "shipping" ? "delivery" : "recojo",
        estado: "Pagado"
      };
      const payment = await Payment.create(paymentPayload);
      await Delivery.create({
        paymentId: payment._id,
        user: session.userId,
        deliveryType: session.pendingMfaAction.deliveryType,
        status: "pending",
        statusHistory: [{ status: "pending", timestamp: new Date(), note: "Pedido creado por asistente" }],
        destinationAddress: session.pendingMfaAction.deliveryType === "shipping" ? session.pendingMfaAction.address || "Pendiente" : undefined,
        reference: session.pendingMfaAction.deliveryType === "shipping" ? session.pendingMfaAction.reference || "Pendiente" : undefined,
        agency: session.pendingMfaAction.deliveryType === "shipping" ? session.pendingMfaAction.agency || "Pendiente" : undefined
      });
      session.pendingMfaAction = null;
      session.cartItems = [];
      return `Listo, generÃ© el pedido real para ti. El nÃºmero de pedido es ${payment.documento}.`;
    }
  }

  const user = await User.findById(session.userId).catch(() => null);
  if (!user) return "No encuentro tu cuenta para iniciar el pedido.";

  const legacyPending = session.pendingMfaAction || null;
  if (pending?.type === "checkout" && pending.status === "waiting_for_payment_method") {
    const method = /paypal|paypay|paypal/i.test(normalized) ? "paypal" : /tarjeta|card|credito|debito|visa|mastercard/i.test(normalized) ? "card" : null;
    if (!method) return "Dime si pagarÃ¡s con PayPal o con tarjeta.";
    session.pendingMfaAction = { ...pending, paymentMethod: method, status: "waiting_for_confirmation" };
    return method === "paypal" ? "Perfecto, prepararÃ© el pedido con PayPal. Si quieres, te puedo ayudar a completar la orden con los datos necesarios y te indico el siguiente paso." : "Perfecto, prepararÃ© el pedido con tarjeta. Si tienes una tarjeta guardada, la usarÃ©; si no, te pedirÃ© los datos.";
  }

  if (pending?.type === "checkout" && pending.status === "waiting_for_confirmation") {
    const confirmed = /si|sÃ­|confirmo|acepto|ok|listo|crear|generar|hacer/i.test(normalized);
    if (!confirmed) return "Confirma si deseas generar el pedido ahora.";
    const paymentPayload = {
      cliente: user.name || user.email,
      documento: `BOT-${Date.now().toString().slice(-6)}`,
      productos: session.cartItems || [],
      total: (session.cartItems || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0),
      deliveryType: pending.deliveryType,
      direccion_entrega: pending.deliveryType === "shipping" ? pending.address || "Pendiente" : undefined,
      referencia: pending.deliveryType === "shipping" ? pending.reference || "Pendiente" : undefined,
      metodo_envio: pending.deliveryType === "shipping" ? "delivery" : "recojo",
      estado: "Pagado"
    };
    const payment = await Payment.create(paymentPayload);
    await Delivery.create({
      paymentId: payment._id,
      user: session.userId,
      deliveryType: pending.deliveryType,
      status: "pending",
      statusHistory: [{ status: "pending", timestamp: new Date(), note: "Pedido creado por asistente" }],
      destinationAddress: pending.deliveryType === "shipping" ? pending.address || "Pendiente" : undefined,
      reference: pending.deliveryType === "shipping" ? pending.reference || "Pendiente" : undefined,
      agency: pending.deliveryType === "shipping" ? pending.agency || "Pendiente" : undefined
    });
    session.pendingMfaAction = null;
    session.cartItems = [];
    return `Listo, generÃ© el pedido con ${pending.deliveryType === "shipping" ? "envÃ­o a domicilio" : "recojo en tienda"}. El nÃºmero de pedido es ${payment.documento}.`;
  }
};
const handleClaimRequest = async (text, session) => {
  if (!session?.userId) return null;
  const normalized = String(text || "").trim();
  const parsed = parseClaimRequest(normalized);

  const pendingClaim = session.pendingClaim || null;
  if (pendingClaim?.step === "waiting_for_order" || pendingClaim?.step === "waiting_for_details") {
    const orderNumber = extractOrderNumber(normalized) || pendingClaim.orderNumber || null;
    if (!orderNumber) {
      if (!isClaimIntent(normalized) && !/\b(pedido|orden|compra|id|n(?:Ãº|u)mero|numero|seguimiento)\b/i.test(normalized)) {
        session.pendingClaim = null;
        return null;
      }
      return "Aún necesito el número de pedido para registrar el reclamo.";
    }

    const delivery = await findUserDeliveryById(session.userId, orderNumber);
    if (!delivery) {
      session.pendingClaim = { step: "waiting_for_order", orderNumber };
      return `No encontré un pedido con el número ${orderNumber}. Envíame el número exacto y lo reviso de nuevo.`;
    }

    const category = CLAIM_CATEGORY_ALIASES[inferClaimCategory(normalized)] || inferClaimCategory(normalized);
    const description = parsed?.description || normalized;
    const existingClaims = await Claim.find({ delivery: delivery._id, status: "pending" }).lean().catch(() => []);
    const decision = canCreateClaim({
      category,
      currentStatus: delivery.status,
      deadlineDate: delivery.estimatedDate || delivery.paymentId?.fecha,
      existingClaims
    }, new Date());
    if (!decision.allowed) return decision.reason;

    const review = await evaluateClaimDescription(description, category);
    if (!review.validClaim) {
      session.pendingClaim = { step: "waiting_for_details", orderNumber };
      return `${review.reason} Envíame una descripción más clara del problema del pedido ${orderNumber}.`;
    }

    await Claim.create({
      delivery: delivery._id,
      payment: delivery.paymentId?._id,
      user: session.userId,
      category,
      description,
      resolution: "pending",
      status: "pending"
    });
    session.pendingClaim = null;
    setSessionMeta(session, { type: "navigate", path: "/pedidos", focus: "claims", deliveryId: String(delivery._id) });
    return `Listo, registré tu reclamo para el pedido ${String(delivery._id).slice(-6).toUpperCase()}. Quedó pendiente de revisión.`;
  }

  if (!parsed) {
    if (isClaimIntent(normalized)) {
      const explicitOrderNumber = normalized.match(/\b(?:reclamo|reclamar|queja|problema)\b[^a-z0-9]*(?:a|para|por|del|de|sobre|con)\s+(?:el\s+)?(?:n(?:Ãº|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?\s+)?([a-z0-9]{4,})/i)?.[1];
      const orderNumber = explicitOrderNumber || extractOrderNumber(normalized) || pendingClaim?.orderNumber || null;
      if (orderNumber) {
        session.pendingClaim = { orderNumber, step: "waiting_for_details" };
        return `Perfecto, tengo el pedido ${orderNumber}. Ahora envíame una descripción breve del problema para registrar el reclamo.`;
      }
      session.pendingClaim = { orderNumber: null, step: "waiting_for_order" };
      return "Claro. Dime el número de pedido para registrar el reclamo.";
    }
    return null;
  }

  const user = await User.findById(session.userId).catch(() => null);
  if (!user) {
    if (/(reclamo|reclamar)/i.test(normalized)) {
      session.pendingClaim = { orderNumber: null, step: "waiting_for_order" };
      return "Claro. Dime el número de pedido para registrar el reclamo.";
    }
    return "No encuentro tu cuenta para generar un reclamo.";
  }

  const delivery = parsed.orderNumber ? await findUserDeliveryById(session.userId, parsed.orderNumber) : null;
  if (!delivery) {
    session.pendingClaim = { orderNumber: parsed.orderNumber, step: "waiting_for_order" };
    return `No encontré un pedido con el número ${parsed.orderNumber}. Si me compartes el número exacto o el código de pedido, te ayudo mejor.`;
  }

  const category = parsed.category;
  const description = parsed.description || "Reclamo generado por el asistente para revision del pedido.";
  const existingClaims = await Claim.find({ delivery: delivery._id, status: "pending" }).lean().catch(() => []);
  const decision = canCreateClaim({
    category,
    currentStatus: delivery.status,
    deadlineDate: delivery.estimatedDate || delivery.paymentId?.fecha,
    existingClaims
  }, new Date());
  if (!decision.allowed) return decision.reason;

  session.pendingClaim = null;
  await Claim.create({
    delivery: delivery._id,
    payment: delivery.paymentId?._id,
    user: session.userId,
    category,
    description,
    resolution: "pending",
    status: "pending"
  });
  setSessionMeta(session, { type: "navigate", path: "/pedidos", focus: "claims", deliveryId: String(delivery._id) });
  return `Listo, registré un reclamo para el pedido ${String(delivery._id).slice(-6).toUpperCase()} con categoría ${category}. Quedó pendiente de revisión.`;
};
const handleCancelOrderRequest = async (text, session) => {
  if (!session?.userId) return null;
  const normalized = String(text || "").trim();
  if (!/(cancelar|anular|cancelacion|cancelaciÃ³n).*(pedido|orden|compra)/i.test(normalized) && !/(pedido|orden|compra).*(cancelar|anular)/i.test(normalized)) {
    return null;
  }

  const user = await User.findById(session.userId).catch(() => null);
  if (!user) return "No encuentro tu cuenta para cancelar el pedido.";

  const existingPending = session.pendingMfaAction;
  if (existingPending?.type === "cancel_order" && existingPending.status === "waiting_for_method") {
    const explicitMethod = normalized.match(/\b(correo|email|sms|mensaje|whatsapp|wa|wsp|llamada|call|consola|console)\b/i);
    const method = normalizeMfaMethod(explicitMethod ? explicitMethod[1] : normalized);
    if (!["email", "console", "sms", "call", "whatsapp"].includes(method)) {
      return "Para confirmar la cancelaciÃ³n necesito el mÃ©todo de verificaciÃ³n: correo, SMS, llamada, WhatsApp o consola.";
    }
    const mfaResult = await issueActionMfa(user, method);
    session.pendingMfaAction = { type: "cancel_order", status: "waiting_for_code", deliveryId: existingPending.deliveryId, tempToken: mfaResult.tempToken, method };
    const fallbackText = mfaResult.fallback ? ` El cÃ³digo para pruebas es ${mfaResult.code}.` : "";
    return `Te enviÃ© el cÃ³digo por ${method === "email" ? "correo" : method === "console" ? "consola" : method === "call" ? "llamada" : method === "whatsapp" ? "WhatsApp" : "SMS"}.${fallbackText} EnvÃ­ame el cÃ³digo de 6 dÃ­gitos para confirmar.`;
  }

  if (existingPending?.type === "cancel_order" && existingPending.status === "waiting_for_code") {
    const code = normalized.match(/\b(\d{6})\b/);
    if (!code) {
      return "EnvÃ­ame el cÃ³digo de 6 dÃ­gitos que te enviÃ© para confirmar la cancelaciÃ³n.";
    }

    const ok = await verifyActionMfa(user, existingPending.tempToken, code[1]);
    if (!ok) {
      return "El cÃ³digo no es vÃ¡lido o ya expirÃ³. Solicita uno nuevo para continuar.";
    }

    const delivery = await Delivery.findById(existingPending.deliveryId).catch(() => null);
    if (!delivery) return "No encontrÃ© ese pedido para cancelarlo.";
    if (!(["pending", "ready_for_pickup"].includes(delivery.status))) {
      session.pendingMfaAction = null;
      return `El pedido ya no se puede cancelar porque estÃ¡ en estado ${delivery.status}.`;
    }

    delivery.status = "cancelled";
    delivery.cancellationReason = "Cancelado por el asistente con MFA";
    syncStatusHistory(delivery, "cancelled", { note: delivery.cancellationReason });
    await delivery.save();
    await recordLog({ req: { user: { id: session.userId, email: user.email } }, usuario: user.email, descripcion: `Pedido ${delivery._id} cancelado por asistente`, tipo: "PEDIDO", metodo: "BOT", ruta: "/chatbot" });
    session.pendingMfaAction = null;
    return `Listo, cancelÃ© tu pedido y quedÃ³ marcado como cancelado.`;
  }

  const delivery = await Delivery.findOne({ user: session.userId, status: { $in: ["pending", "ready_for_pickup"] } }).sort({ createdAt: -1 }).catch(() => null);
  if (!delivery) return "No encuentro un pedido activo que pueda cancelar en este momento.";

  session.pendingMfaAction = { type: "cancel_order", status: "waiting_for_method", deliveryId: delivery._id };
  return "Para confirmar la cancelaciÃ³n necesito verificar tu identidad. Dime cÃ³mo prefieres recibir el cÃ³digo: correo, SMS, llamada, WhatsApp o consola.";
};

const CLAIM_CATEGORY_ALIASES = {
  "demora": "delay",
  "delay": "delay",
  "incompleto": "incomplete",
  "incomplete": "incomplete",
  "danado": "damaged",
  "daÃ±ado": "damaged",
  "damaged": "damaged",
  "devolucion": "return",
  "devoluciÃ³n": "return",
  "return": "return",
  "cancelacion": "cancellation",
  "cancelaciÃ³n": "cancellation",
  "cancellation": "cancellation"
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
  return deliveries.find((delivery) => {
    const needle = id.toLowerCase();
    const deliverySuffix = String(delivery._id).slice(-6).toLowerCase();
    const paymentDocument = String(delivery.paymentId?.documento || "").toLowerCase();
    return deliverySuffix === needle || paymentDocument === needle || paymentDocument.endsWith(needle);
  }) || null;
};

const findDeliveriesByProductHint = async (userId, hint) => {
  if (!userId || !hint) return [];
  const searchTokens = normalizeSearchTokens(String(hint || ""));
  if (!searchTokens.length) return [];

  try {
    const deliveries = await Delivery.find({ user: userId }).populate("paymentId").sort({ createdAt: -1 }).lean();
    return deliveries.filter((delivery) => {
      const products = Array.isArray(delivery.paymentId?.productos) ? delivery.paymentId.productos : [];
      return products.some((product) => {
        const haystack = stripAccents(String(product?.name || "").toLowerCase());
        return searchTokens.some((token) => haystack.includes(token));
      });
    });
  } catch (err) {
    return [];
  }
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

  if (/(producto|figura|art[iÃ­]culo|articulo).{0,20}(m[Ã¡a]s\s+caro|m[Ã¡a]s\s+costoso|mayor\s+precio|precio\s+mayor)/i.test(normalized) || /(?:m[Ã¡a]s\s+caro|m[Ã¡a]s\s+costoso|mayor\s+precio|precio\s+mayor)/i.test(normalized)) {
    const expensiveProduct = await findMostExpensiveProduct();
    if (!expensiveProduct) return "No tengo productos registrados en este momento para comparar precios.";
    return `El producto mÃ¡s caro que tengo registrado es "${expensiveProduct.name}" con precio S/. ${expensiveProduct.price}. Puedes revisarlo aquÃ­: ${buildProductLink(expensiveProduct._id)}`;
  }

  if (/(producto|figura|art[iÃ­]culo|articulo).{0,20}(m[Ã¡a]s\s+descuento|mayor\s+descuento|mejor\s+oferta|oferta\s+mejor|descuento\s+m[Ã¡a]s\s+alto)/i.test(normalized) || /(?:m[Ã¡a]s\s+descuento|mayor\s+descuento|mejor\s+oferta|oferta\s+mejor|descuento\s+m[Ã¡a]s\s+alto)/i.test(normalized)) {
    const discountedProduct = await findBestDiscountProduct();
    if (!discountedProduct) return "No tengo productos con descuento disponible en este momento.";
    const price = Number(discountedProduct.price || 0);
    const discount = Number(discountedProduct.discount || 0);
    const finalPrice = (price * (1 - discount)).toFixed(2);
    return `El producto con mayor descuento que tengo es "${discountedProduct.name}" con ${Math.round(discount * 100)}% de descuento, precio final S/. ${finalPrice}. Puedes revisarlo aquÃ­: ${buildProductLink(discountedProduct._id)}`;
  }

  if (/(agregar|aÃ±adir|sumar).*(carrito|cart)/i.test(normalized) || /(carrito|cart)/i.test(normalized)) {
    const hint = extractProductHint(normalized);
    const product = await addProductToCartSession(session, hint);

    if (product) {
      return `Listo, aÃ±adÃ­ "${product.name}" a tu carrito para que lo sigas revisando.`;
    }

    return "Puedo ayudarte con el carrito, pero por ahora no encuentro un producto disponible para agregar.";
  }

  return null;
};
const handleAutomationCommand = async (text, session) => {
  const userId = session?.userId;
  const normalized = String(text || "").trim();
  const shouldHandle = /^\/|^(ver|consultar|crear|generar|cancelar|cambiar|actualizar|modificar|editar|agregar|aÃ±adir|busca|muestra|dime|revisa|ayuda|quiero|necesito|puedes)/i.test(normalized) || /(mis pedidos|mis ordenes|mis compras|pedido|orden|producto|productos|perfil|direcciÃ³n|direccion|telÃ©fono|telefono|ciudad|carrito|cart|cancelar|cambiar|actualizar|modificar|editar)/i.test(normalized);

  if (!shouldHandle) return null;
  if (parseCheckoutIntent(normalized) || isClaimIntent(normalized)) return null;

  if (!userId) {
    return "Para ejecutar acciones necesito que escribas desde tu cuenta iniciada. Puedo orientarte, pero no modificar ni consultar pedidos sin identificarte.";
  }

  if (/^\/?(mis[-\s]?pedidos|ordenes|Ã³rdenes|mis pedidos|mis ordenes|mis compras)$/i.test(normalized) || /(mis pedidos|mis ordenes|mis compras)/i.test(normalized)) {
    const deliveries = await Delivery.find({ user: userId }).populate("paymentId").sort({ createdAt: -1 }).limit(5).lean().catch(() => []);
    if (!deliveries.length) return "No encuentro pedidos asociados a tu cuenta. Si acabas de pagar, espera unos segundos y vuelve a consultar.";
    return deliveries.map(buildOrderSummary).join("\n");
  }

  if (/(productos|catalogo|catÃ¡logo|stock|inventario|figuras)/i.test(normalized)) {
    const products = await Product.find().limit(10).lean().catch(() => []);
    if (!products.length) return "No encuentro productos disponibles en este momento.";
    return products.map((product) => {
      const price = Number(product.price || 0);
      const discount = Number(product.discount || 0);
      if (discount > 0) {
        const discountedPrice = (price * (1 - discount)).toFixed(2);
        return `${product.name} - precio final S/. ${discountedPrice} (precio original S/. ${price.toFixed(2)} | descuento ${Math.round(discount * 100)}%) - stock ${product.stock || 0}`;
      }
      return `${product.name} - S/. ${price.toFixed(2)} - stock ${product.stock || 0}`;
    }).join("\n");
  }

  if (/(perfil|mis datos|datos|nombre|apellido|direcciÃ³n|direccion|ciudad|telÃ©fono|telefono)/i.test(normalized) && !/(cambiar|actualizar|modificar|editar|poner|cambia|actualiza|modifica|edita|setea|asigna)/i.test(normalized)) {
    const user = await User.findById(userId).select("-password").lean().catch(() => null);
    if (!user) return "No puedo ver tu perfil sin que estÃ©s autenticado.";
    const details = [
      `Nombre: ${user.name || "sin registrar"}`,
      `Apellido: ${user.lastname || "sin registrar"}`,
      `Email: ${user.email || "sin registrar"}`,
      `DirecciÃ³n: ${user.address || "sin registrar"}`,
      `Ciudad: ${user.city || "sin registrar"}`,
      `TelÃ©fono: ${user.phone || "sin registrar"}`
    ];
    return `Estos son tus datos actuales:\n${details.join("\n")}`;
  }

  const orderMatch = normalized.match(/(?:pedido|orden|detalle|estado)\s+#?([a-f0-9]{24}|[a-z0-9]{6})/i);
  if (orderMatch && /ver|consultar|detalle|estado|pedido|orden/i.test(normalized)) {
    const delivery = await findUserDeliveryById(userId, orderMatch[1]);
    return delivery ? buildOrderSummary(delivery) : "No encontrÃ© ese pedido en tu cuenta. Revisa el ID corto o completo y lo intento de nuevo.";
  }

  const claimMatch = normalized.match(/(?:reclamo|reclamar)\s+#?([a-f0-9]{24}|[a-z0-9]{6})\s+([a-zÃ¡Ã©Ã­Ã³ÃºÃ±]+)\s+(.+)/i);
  if (claimMatch) {
    const delivery = await findUserDeliveryById(userId, claimMatch[1]);
    if (!delivery) return "No encontrÃ© ese pedido en tu cuenta. No crearÃ© reclamos sobre pedidos que no te pertenecen.";
    const category = CLAIM_CATEGORY_ALIASES[String(claimMatch[2]).toLowerCase()] || "";
    if (!category) return "La categorÃ­a no coincide. Usa demora, incompleto, daÃ±ado, devoluciÃ³n o cancelaciÃ³n.";
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
    return "Listo, registrÃ© tu reclamo y quedÃ³ pendiente de revisiÃ³n por administraciÃ³n. Puedes seguir el avance desde Mis Pedidos.";
  }

  const actionReply = await resolveActionRequest(normalized, session);
  if (actionReply) return actionReply;

  const context = buildKeyValueContext(normalized);
  const productHint = extractProductHint(normalized);
  if ((/pedido|orden/i.test(normalized)) && (/producto|articulo|artÃ­culo|figura/i.test(normalized) || productHint)) {
    const matchingDeliveries = await findDeliveriesByProductHint(userId, productHint || normalized);
    if (matchingDeliveries.length) {
      return matchingDeliveries.map(buildOrderSummary).join("\n");
    }
    return "No encontrÃ© pedidos relacionados con ese producto en tu cuenta.";
  }

  if (productHint && /pedido|orden/i.test(normalized)) {
    const matchingDeliveries = await findDeliveriesByProductHint(userId, productHint);
    if (matchingDeliveries.length) {
      return matchingDeliveries.map(buildOrderSummary).join("\n");
    }
    return `No encontrÃ© pedidos relacionados con "${productHint}" en tu cuenta.`;
  }

  if (context.intent === "productos" || context.intent === "carrito") {
    const products = await findProductsByHint(context.productHint || normalized);
    if (products.length) {
      const productNames = products.map((product) => {
        const price = Number(product.price || 0);
        const discount = Number(product.discount || 0);
        if (discount > 0) {
          const discountedPrice = (price * (1 - discount)).toFixed(2);
          return `${product.name} | precio final S/. ${discountedPrice} | precio original S/. ${price.toFixed(2)} | descuento ${Math.round(discount * 100)}% | stock ${product.stock || 0}`;
        }
        return `${product.name} | precio S/. ${price.toFixed(2)} | stock ${product.stock || 0}`;
      }).join("\n");
      return `Tengo estos productos que coinciden con tu consulta:\n${productNames}`;
    }
  }

  if (context.intent === "pedidos") {
    if (productHint) {
      const matchingDeliveries = await findDeliveriesByProductHint(userId, productHint);
      if (matchingDeliveries.length) {
        return matchingDeliveries.map(buildOrderSummary).join("\n");
      }
      return `No encontrÃ© pedidos relacionados con "${productHint}" en tu cuenta.`;
    }
    const deliveries = await Delivery.find({ user: userId }).populate("paymentId").sort({ createdAt: -1 }).lean().catch(() => []);
    if (deliveries.length) {
      return deliveries.map(buildOrderSummary).join("\n");
    }
  }

  if (context.intent === "perfil") {
    const user = await User.findById(userId).select("-password").lean().catch(() => null);
    if (user) {
      return `Datos actuales:\nNombre: ${user.name || "sin registrar"}\nApellido: ${user.lastname || "sin registrar"}\nDirecciÃ³n: ${user.address || "sin registrar"}\nCiudad: ${user.city || "sin registrar"}\nTelÃ©fono: ${user.phone || "sin registrar"}`;
    }
  }

  if (/contrase|password/i.test(normalized)) {
    return "Puedo guiarte con el cambio de contraseÃ±a, pero no te pedirÃ© tu contraseÃ±a actual por chat. Ve a Perfil > Seguridad, solicita el cambio y cuando el sistema pida MFA ingresa el cÃ³digo recibido en tu correo.";
  }

  if (/crear\s+pedido|comprar|ordenar/i.test(normalized)) {
    const cartItems = Array.isArray(session?.cartItems) ? session.cartItems : [];
    if (!cartItems.length) return "Tu carrito estÃ¡ vacÃ­o. Agrega productos primero y te ayudo a convertirlos en un pedido real.";

    const user = await User.findById(userId).catch(() => null);
    if (!user) return "No encuentro tu cuenta para crear el pedido.";

    const total = cartItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
    const payment = await Payment.create({
      cliente: user.name || user.email,
      documento: `BOT-${Date.now().toString().slice(-6)}`,
      productos: cartItems.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
      total,
      deliveryType: "shipping",
      metodo_envio: "delivery",
      estado: "Pagado"
    });

    const delivery = await Delivery.create({
      paymentId: payment._id,
      user: userId,
      deliveryType: "shipping",
      status: "pending",
      statusHistory: [{ status: "pending", timestamp: new Date(), note: "Pedido creado por asistente" }],
      destinationAddress: user.address || "Sin direcciÃ³n",
      reference: "Creado por asistente",
      agency: "Asistente"
    });

    session.cartItems = [];
    return `Listo, creÃ© un pedido real para ti con ${cartItems.length} producto(s). El nÃºmero de pedido es ${payment.documento} y ya quedÃ³ registrado con estado ${delivery.status}.`;
  }

  return null;
};

const CLASSIFICATION_PROMPT = (text) => `Eres un clasificador para el chatbot de atenciÃ³n al cliente de NendoShop (tienda de figuras Nendoroid). Analiza el mensaje del cliente y responde ÃšNICAMENTE con un JSON vÃ¡lido, sin texto adicional, con esta forma exacta:

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

Reglas de moderaciÃ³n:
- Si el mensaje contiene insultos, amenazas, acoso, lenguaje sexual explÃ­cito o contenido violento: allowed=false, block=true, category="inapropiado".
- En cualquier otro caso: allowed=true, block=false, category="apropiado".
- Para moderar debes tener en cuenta sinonimos  y las palabras sexuales como los oparatos reproductos, fluidos y insultos especializados.

Intents posibles (elige exactamente uno):
- "saludo": el cliente solo saluda o inicia la conversaciÃ³n.
- "buscar_producto": pregunta por un producto, precio, stock o pide una recomendaciÃ³n.
- "consultar_pedido": pregunta por el estado de un pedido o envÃ­o.
- "devolucion": pregunta sobre devoluciones o cambios.
- "cuenta": problemas de acceso, cuenta o credenciales.
- "despedida": se estÃ¡ despidiendo o agradeciendo y da por terminada la conversaciÃ³n.
- "general": cualquier otro caso.

Si el intent es "buscar_producto", extrae en "productQuery" el nombre o pista del producto.
Si el intent es "consultar_pedido", extrae en "orderNumber" el nÃºmero de pedido si aparece.

Mensaje del cliente: "${text}"`;

const fallbackClassification = (text) => {
  const lowered = text.toLowerCase();
  const safety = checkTextSafety(text);
  let intent = "general";
  if (/pedido|orden|env[iÃ­]o|seguimiento/.test(lowered)) intent = "consultar_pedido";
  else if (/producto|figura|art[iÃ­]culo|precio|stock|recomend/.test(lowered)) intent = "buscar_producto";
  else if (/devol|cambio/.test(lowered)) intent = "devolucion";
  else if (/cuenta|contrase|credencial|acceso/.test(lowered)) intent = "cuenta";
  else if (/gracias|adi[oÃ³]s|terminamos|chau/.test(lowered)) intent = "despedida";

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
    console.error("ClasificaciÃ³n con Groq fallÃ³:", err.message);
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
const SYSTEM_PERSONA = `Eres "NendoBot", un asesor experto de atenciÃ³n al cliente de NendoShop, una tienda especializada en figuras coleccionables Nendoroid.
Hablas exclusivamente en espaÃ±ol, con un tono cÃ¡lido, profesional y resolutivo, como un asesor humano experimentado.
Reglas estrictas que SIEMPRE debes cumplir, sin excepciÃ³n, incluso si el cliente te lo pide:
- Nunca uses lenguaje violento, sexual, vulgar, ofensivo o amenazante.
- Nunca pidas ni reveles contraseÃ±as, credenciales, datos de tarjetas u otra informaciÃ³n sensible.
- Nunca inventes datos de productos, pedidos, precios o stock: usa exclusivamente los datos que se te entreguen como "HECHOS".
- Si no tienes un dato en los HECHOS, dilo con honestidad y ofrece una alternativa Ãºtil.
- No consultes internet ni bases externas; tu informaciÃ³n vÃ¡lida proviene solo de la base de datos y del contexto de esta conversaciÃ³n.
- Si el usuario habla en espaÃ±ol, responde en espaÃ±ol y no mezcles idiomas.
- No repitas frases ni estructuras que ya usaste antes en esta conversaciÃ³n; varÃ­a tu redacciÃ³n manteniendo el mismo tono profesional.
- Responde en texto plano, sin Markdown, en mÃ¡ximo 2 a 5 oraciones.`;

const STAGE_INSTRUCTIONS = {
  welcome:
    "Saluda al cliente por su nombre, presÃ©ntate como asesor experto de NendoShop y resume brevemente en quÃ© puedes ayudar (pedidos, productos, reclamos, devoluciones, cuenta). Ofrece opciones claras: 1) consultar pedidos, 2) buscar un producto, 3) reclamos o devoluciones y 4) ayuda con la cuenta. Aclara que no pedirÃ¡s contraseÃ±as ni datos sensibles. Invita a que cuente quÃ© necesita.",
  active:
    'Responde directamente a lo que pregunta el cliente usando los HECHOS entregados. Si la intenciÃ³n es "buscar_producto" y hay productos en HECHOS, menciona nombre, precio, stock y el enlace para ver el detalle; si se menciona un producto concreto como Miku Hatsune, prioriza resultados que coincidan exactamente con esa referencia. Si no hay productos, pide mÃ¡s detalles del producto. Si la intenciÃ³n es "consultar_pedido" y hay un pedido en HECHOS, indica su estado y total; si no hay pedido, pide el nÃºmero o aclara que no se encontrÃ³. Si es devoluciÃ³n o reclamo, orienta de forma general sin inventar polÃ­ticas especÃ­ficas y, si falta el pedido, pide el nÃºmero exacto. Cierra preguntando si necesita algo mÃ¡s.',
  survey_intro:
    "El cliente se estÃ¡ despidiendo o agradeciendo. AgradÃ©cele por contactar a NendoShop y pÃ­dele, de forma breve y amable, que califique la atenciÃ³n del 1 (muy mala) al 5 (excelente).",
  closing:
    "El cliente respondiÃ³ a la encuesta de satisfacciÃ³n. AgradÃ©cele sinceramente por su respuesta (sin inventar nada que no te dieron) y cierra la conversaciÃ³n de forma cordial, indicando que puede volver a escribir cuando lo necesite."
};

const buildCompositionInput = ({ customerName, intent, stage, session, facts }) => {
  const recent = (session.history || [])
    .slice(-6)
    .map((h) => `${h.role === "user" ? "Cliente" : "NendoBot"}: ${h.text}`)
    .join("\n");

  const stageInstruction = STAGE_INSTRUCTIONS[stage] || STAGE_INSTRUCTIONS.active;

  return `${SYSTEM_PERSONA}

Nombre del cliente: ${customerName}
IntenciÃ³n detectada: ${intent}
InstrucciÃ³n de la etapa actual: ${stageInstruction}

HECHOS (usa solo estos datos, no agregues otros):
${facts ? JSON.stringify(facts) : "No hay datos adicionales para esta respuesta."}

ConversaciÃ³n reciente (para que no repitas frases):
${recent || "(sin historial previo)"}

Escribe ahora el siguiente mensaje de NendoBot dirigido al cliente.`;
};

const fallbackTemplate = ({ customerName, stage, facts }) => {
  if (stage === "welcome") {
    return `Hola ${customerName}, soy NendoBot, asesor de NendoShop. Puedo ayudarte con pedidos, productos, reclamos, devoluciones y cuenta. No pedirÃ© contraseÃ±as ni datos sensibles. Si lo prefieres, puedes decirme 1) pedidos, 2) productos, 3) reclamos o devoluciones, o 4) tu cuenta.`;
  }
  if (facts?.tipo === "producto") {
    const [p] = facts.productos || [];
    if (p) {
      const commentsText = p.comentarios?.length ? ` Comentarios recientes: ${p.comentarios.join("; ")}` : "";
      const intro = facts.cheapest ? `El producto mÃ¡s econÃ³mico que tengo registrado es "${p.nombre}".` : `EncontrÃ© "${p.nombre}".`;
      return `${intro} Tiene un precio de S/. ${p.precio} y ${p.stock} unidades disponibles. Puedes ver el detalle aquÃ­: ${p.enlace}${commentsText}`;
    }
    return `En este momento no tengo un producto que coincida con esa bÃºsqueda en la base de datos. Si me das el nombre o la categorÃ­a, te ayudo mejor. TambiÃ©n puedo revisar el mÃ¡s econÃ³mico si lo prefieres.`;
  }
  if (facts?.tipo === "pedido") {
    if (facts.pedido) {
      return `Tu pedido ${facts.pedido.numeroPedido} estÃ¡ ${facts.pedido.estado}. Total: S/. ${facts.pedido.total}.`;
    }
    return `No encontrÃ© ese nÃºmero de pedido, ${customerName}. Â¿Puedes confirmarlo?`;
  }
  if (stage === "survey_intro") {
    return `Gracias por contactarnos, ${customerName}. Antes de decir adiÃ³s, Â¿podrÃ­as calificar nuestra atenciÃ³n del 1 al 5 para ayudarnos a mejorar?`;
  }
  if (stage === "closing") {
    return `Gracias por tu respuesta, ${customerName}. Cerramos esta conversaciÃ³n con satisfacciÃ³n; escrÃ­benos cuando lo necesites.`;
  }
  return `Gracias por tu mensaje, ${customerName}. Â¿PodrÃ­as darme mÃ¡s detalles para ayudarte mejor?`;
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
    console.error("ComposiciÃ³n de respuesta fallÃ³:", err.message);
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
        pista: "mÃ¡s barato",
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
    const lastUserText = session.history?.slice(-1)[0]?.text;
    const lastBotReply = session.history?.slice(-1)[0]?.text;
    const isRepetitive = lastUserText === text && lastBotReply === profileReply;
    const finalReply = isRepetitive
      ? `${profileReply} Si quieres, puedo ayudarte con algo mÃ¡s concreto como pedidos, productos o devoluciones.`
      : profileReply;
    pushHistory(session, "user", text);
    pushHistory(session, "bot", finalReply);
    return finalReply;
  }

  const context = buildKeyValueContext(text);
  if (context.intent !== "general") {
    const contextualReply = await handleAutomationCommand(text, session);
    if (contextualReply) {
      pushHistory(session, "user", text);
      pushHistory(session, "bot", contextualReply);
      return contextualReply;
    }
  }

  const checkoutReply = await handleCheckoutRequest(text, session);
  if (checkoutReply) {
    pushHistory(session, "user", text);
    pushHistory(session, "bot", checkoutReply);
    return checkoutReply;
  }

  const claimReply = await handleClaimRequest(text, session);
  if (claimReply) {
    pushHistory(session, "user", text);
    pushHistory(session, "bot", claimReply);
    return claimReply;
  }

  const cancelReply = await handleCancelOrderRequest(text, session);
  if (cancelReply) {
    const lastUserText = session.history?.slice(-1)[0]?.text;
    const lastBotReply = session.history?.slice(-1)[0]?.text;
    const isRepetitive = lastUserText === text && lastBotReply === cancelReply;
    const finalReply = isRepetitive
      ? `${cancelReply} Si prefieres, tambiÃ©n puedo consultar tu pedido o ayudarte a encontrar un producto.`
      : cancelReply;
    pushHistory(session, "user", text);
    pushHistory(session, "bot", finalReply);
    return finalReply;
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
  if (reply && /miku|hatsune/i.test(text) && !/miku|hatsune/i.test(reply)) {
    const exactHint = String(text || "").trim();
    return `He encontrado coincidencias relevantes para â€œ${exactHint}â€. Si quieres, puedo ayudarte a listar solo los productos que coinciden con esa referencia y te digo precio y stock.`;
  }
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
  buildKeyValueContext,
  checkTextSafety,
  normalizeCustomerName,
  extractOrderNumber,
  extractProductHint,
  findProductsByHint,
  filterProductsForQuery,
  parseOrderIntent,
  parseDeliveryPreference,
  moderateCommunityMessage,
  analyzeMessageWithGroq,
  rankProductMatches,
  parseProfileChangeRequest,
  parseClaimRequest,
  parseCheckoutIntent,
  normalizeMfaMethod,
  extractRequestedMfaMethod
};
