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

// Support bot intro kept in plain UTF-8 Spanish text to avoid mojibake artifacts.
const SUPPORT_INTRO =
  "Hola, soy NendoBot, tu asesor de atención al cliente de NendoShop. Te puedo ayudar con pedidos, productos, reclamos, devoluciones y cuentas. También puedo orientarte sobre un producto específico o ayudarte a encontrar el más económico.";

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
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

const applyLeetSubstitutions = (text) =>
  String(text || "").replace(/[01345789!@$]/g, (ch) => LEET_SUBSTITUTIONS[ch] || ch);
// Collapse repeated characters without introducing mojibake artifacts.
const collapseRepeatedChars = (text) => String(text || "").replace(/([a-z0-9])\1+/g, "$1");
const buildNormalizedVariants = (text) => {
  const lowered = String(text || "").toLowerCase();
  const noAccents = stripAccents(lowered);
  const deLeeted = applyLeetSubstitutions(noAccents);
  return {
    spaced: deLeeted,
    spacedCollapsed: collapseRepeatedChars(deLeeted)
  };
};

const CLAIM_CATEGORY_ALIASES = {
  demora: "delay",
  retraso: "delay",
  tarde: "delay",
  atrasado: "delay",
  atrasada: "delay",
  devolucion: "return",
  devolución: "return",
  reembolso: "return",
  refund: "return",
  regreso: "return",
  cancelacion: "cancel",
  cancelación: "cancel",
  cancelar: "cancel",
  incompleto: "incomplete",
  incompleta: "incomplete",
  faltante: "incomplete",
  falta: "incomplete",
  faltan: "incomplete",
  dañado: "damaged",
  daniado: "damaged",
  dañada: "damaged",
  daniada: "damaged",
  roto: "damaged",
  rota: "damaged",
  quebrado: "damaged",
  quebrada: "damaged",
  mal: "damaged",
  fallo: "delay",
  error: "delay",
  problema: "delay",
  incidente: "delay"
};

const normalizeBotText = (text) => String(text || "")
  .replace(/Ã¡/g, "á")
  .replace(/Ã©/g, "é")
  .replace(/Ã­/g, "í")
  .replace(/Ã³/g, "ó")
  .replace(/Ãº/g, "ú")
  .replace(/Ã±/g, "ñ")
  .replace(/Ã¼/g, "ü")
  .replace(/Â/g, "")
  .replace(/â€™/g, "'")
  .replace(/â€œ/g, '"')
  .replace(/â€/g, '"')
  .replace(/â€/g, '"')
  .replace(/â€‹/g, "")
  .replace(/â€“/g, "-")
  .replace(/ï¿½/g, "ó");

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
  const match = normalized.match(/(?:pedido|orden|n(?:ú|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento|id)[^a-z0-9]*([a-z0-9]{4,})/i);
  if (match) return match[1];
  const fallback = normalized.match(/\b([a-z0-9]{6,})\b/i);
  return fallback ? fallback[1] : null;
};

const extractProductHint = (text) => {
  const normalized = String(text || "").toLowerCase();
  const patterns = [
    /(?:producto|figura|art(?:í|i)culo|modelo|articulo|artículo)[^a-záéíóúñü0-9]*([a-záéíóúñü0-9 .,'\-]+)/i,
    /(?:quiero|busco|necesito|interesa|recomienda|ver|agrega|añade|agregar|añadir|sumar)[^a-záéíóúñü0-9]*([a-záéíóúñü0-9 .,'\-]+)/i,
    /(?:de|la|el|un|una|por|para|con)\s+([a-záéíóúñü0-9 .,'\-]{2,})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().replace(/\b(agregar|añadir|sumar|producto|figura|articulo|artículo|modelo|el|la|un|una|por|para|con|quiero|busco|necesito|interesa|recomienda|ver|de)\b/gi, "").trim();
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
  if (/\b(hola|buenos|buenas|gracias|adios|adiós|estoy bien|todo bien|como estas|como estás)\b/i.test(normalized)) return false;
  const hasClaimKeyword = /\b(reclamo|reclamar|queja|quejas|problema|problemas|incidente|fallo|fallar|falla|falla|dañado|daniado|dañada|daniada|incompleto|incompleta|retraso|demora|demorado|cancelacion|cancelación|devolucion|devolución|reembolso|refund|error|no lleg[oó]|llego|llegó|entrego|entregó|roto|rota|perdido|perdida)\b/i.test(lowered);
  return hasClaimKeyword || /\b(genera|genera el|crea|crea el|haz|hace)\s+(el\s+)?(reclamo|reclamar)\b/i.test(lowered);
};

const inferClaimCategory = (text) => {
  const normalized = stripAccents(String(text || "").trim()).toLowerCase();
  const patterns = [
    { pattern: /\b(incompleto|incompleta|faltante|falta|faltan|mal|dañado|daniado|roto|rota|quebrado|quebrada)\b/i, category: "incomplete" },
    { pattern: /\b(demora|retraso|tarde|atrasado|atrasada)\b/i, category: "delay" },
    { pattern: /\b(devolucion|devolución|devolutiva|reembolso|refund|regreso)\b/i, category: "return" },
    { pattern: /\b(cancelacion|cancelación|cancelar)\b/i, category: "cancel" },
    { pattern: /\b(fallo|error|problema|incidente)\b/i, category: "delay" }
  ];

  for (const { pattern, category } of patterns) {
    if (pattern.test(normalized)) {
      return category;
    }
  }

  return "delay";
};
const parseClaimRequest = (text) => {
  const normalized = String(text || "").trim();
  if (!normalized || !isClaimIntent(normalized)) return null;
  const explicitOrderMatch = normalized.match(/\b(?:reclamo|reclamar|queja|problema)\b[^a-z0-9]*(?:a|para|por|del|de|sobre|con)\s+(?:el\s+)?(?:n(?:ú|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?\s+)?([a-z0-9]{4,})/i);
  const orderMatch =
    explicitOrderMatch ||
    normalized.match(/(?:pedido|orden|compra|id|n(?:ú|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento)[^a-z0-9]*([a-z0-9]{4,})/i) ||
    normalized.match(/\b([a-z0-9]{4,})\b/i);
  const description = normalized
    .replace(/(?:quiero|quieres|necesito|hacer|crear|abrir|generar|registrar|presentar|reclamo|reclamar|queja|problema|pedido|orden|compra|n(?:ú|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento|id|por|por favor|porfa|ayuda|con|el|la|un|una|mi|tengo|genera|genera el|crea|crea el|haz|hace|sobre|del|de)\s+/gi, " ")
    .replace(/\b(?:pedido|orden|n(?:ú|u)mero(?:\s+de)?(?:\s+pedido|\s+orden)?|seguimiento|id)\s+[a-z0-9]{4,}\b/gi, " ")
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
    return { kind: "photo", newValue: explicitUrl || null };
  }

  const phonePatterns = [
    /\b(?:tel(?:e|é)?fono|telefono|phone|celular|numero|n(?:ú|u)mero|telfono|tel)\b[^0-9+]*([0-9+\-\s]{4,})/i,
    /\b(?:cambiar|cambio|actualizar|modificar|editar|poner|cambia|actualiza|modifica|edita|setea|asigna|cambiame|cámbiame|cambie|cambie|cambiamelo)\b(?:\s|[^a-záéíóúñü0-9])*?(?:tel(?:e|é)?fono|telefono|phone|celular|numero|n(?:ú|u)mero|telfono|tel)(?:[^0-9+]*)([0-9+\-\s]{4,})/i,
    /\b(?:tel(?:e|é)?fono|telefono|phone|celular|numero|n(?:ú|u)mero|telfono|tel)(?:\s|[^a-záéíóúñü0-9])*?(?:a|al|nuevo|nueva|por|:)?(?:\s*)([0-9+\-\s]{4,})/i
  ];

  for (const pattern of phonePatterns) {
    const phoneMatch = normalized.match(pattern) || accentless.match(new RegExp(pattern.source, pattern.flags));
    if (phoneMatch?.[1]) {
      return { kind: "phone", newValue: phoneMatch[1].trim() };
    }
  }

  const passwordMatch = normalized.match(/(?:contrase(?:ñ|n)a|password)[^\w]*?(?:a|al|nueva|nuevo)?[^\w]*([A-Za-z0-9!@#$%^&*()_+=\-]{4,})/i);
  if (passwordMatch) {
    return { kind: "password", newPassword: passwordMatch[1].trim() };
  }

  return null;
};

const buildKeyValueContext = (text) => {
  const lower = String(text || "").toLowerCase();
  const context = {};
  const productHints = ["producto", "figura", "modelo", "art?culo", "articulo"].filter((hint) => lower.includes(hint));
  const orderHints = ["pedido", "orden", "compra", "env?o", "envio"].filter((hint) => lower.includes(hint));
  const profileHints = ["perfil", "datos", "nombre", "apellido", "direcci?n", "direccion", "ciudad", "tel?fono", "telefono"].filter((hint) => lower.includes(hint));
  const cartHints = ["carrito", "cart"].filter((hint) => lower.includes(hint));
  const actionHints = ["agregar", "a?adir", "sumar", "agrega", "a?ade"].filter((hint) => lower.includes(hint));
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
  if (/(env[iï¿½]o|envio|casa|domicilio|shipping|delivery)/i.test(lowered)) return "shipping";
  return null;
};

const extractSurveyRating = (text) => {
  const numMatch = text.match(/\b([1-5])\b/);
  if (numMatch) return Number(numMatch[1]);
  if (/\b(si|sï¿½|excelente|genial|perfecto|bien|ok|okay)\b/i.test(text)) return 5;
  if (/\b(no|mal|p[eï¿½]simo|regular|mejorar)\b/i.test(text)) return 2;
  return null;
};

const explainRolePattern = /\b(qu? haces|que haces|por qu? haces|por que haces|para qu? sirves|cu?l es tu funci?n|cual es tu funcion|tus funciones|funciones)\b/i;
const offTopicPattern = /\b(politica|pol?tica|deporte|futbol|pel?cula|pelicula|serie|noticia|clima|juego|m?sica|musica|viaje|cocina|comida|humor|chiste)\b/i;
const scopeIntentPattern = /\b(pedido|orden|env?o|envio|producto|precio|stock|devolucion|devoluci?n|cambio|cuenta|acceso|contrase?a|contrase|credencial|ayuda)\b/i;

const getImmediateSupportReply = ({ text, customerName, intent }) => {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  if (explainRolePattern.test(normalized)) {
    return `Soy NendoBot, tu asesor de atenci?n al cliente de NendoShop. Puedo ayudarte con pedidos, productos, devoluciones y soporte de cuenta. Si tienes una consulta sobre alguno de esos temas, te ayudo enseguida.`;
  }

  if (intent === "devolucion") {
    return /pedido|producto/i.test(normalized)
      ? `Puedo orientarte sobre devoluciones, reclamos y cambios. Si me compartes el n?mero de pedido o el producto, te digo qu? pasos seguir y si aplica.`
      : `Puedo orientarte sobre devoluciones, reclamos y cambios. Si me dices el pedido o el producto, te ayudo a ver si aplica y qu? hacer.`;
  }

  if (intent === "cuenta") {
    return `Puedo ayudarte con acceso a tu cuenta, recuperaciÃ³n de datos o cambios bÃ¡sicos. No pedirÃ© tu contraseÃ±a; si me explicas el problema, te guÃ­o paso a paso.`;
  }

  if (offTopicPattern.test(normalized) || (!scopeIntentPattern.test(normalized) && /\b(quiero|necesito|puedes|ayuda|dime|habl|como)\b/i.test(normalized))) {
    return `Mi funciÃ³n es ayudarte con pedidos, productos, reclamos, devoluciones y cuenta en NendoShop. Si tu consulta es de otro tema, esa no es mi finalidad.`;
  }

  return null;
};

const isCheapestRequest = (text) => /(?:producto|art[iï¿½]culo|figura).{0,20}(m[ï¿½a]s\s+barato|barato|m[ï¿½a]s\s+econ[oï¿½]mico|econ[oï¿½]mico|menor\s+precio|precio\s+menor)/i.test(text) || /(?:m[ï¿½a]s\s+barato|barato|m[ï¿½a]s\s+econ[oï¿½]mico|econ[oï¿½]mico|menor\s+precio|precio\s+menor)/i.test(text);

const isDiscountQuery = (text) => /(?:descuento|descuentos|oferta|ofertas|promocion|promociï¿½n|promo|rebaja|rebajado|en descuento|con descuento|filtra|filtrar|solo|mostrar|muestra|con descuento)/i.test(String(text || ""));

const normalizeSearchTokens = (text) => {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized
    .split(/[\s/,-]+/)
    .filter(Boolean)
    .filter((token) => !["producto", "productos", "figura", "figuras", "modelo", "modelos", "articulo", "artï¿½culo", "descuento", "descuentos", "oferta", "ofertas", "promo", "promocion", "promociï¿½n", "rebaja", "rebajado", "con", "en", "por", "para", "quiero", "necesito", "busco", "muestra", "dime", "ver", "lista", "mejores", "barato", "caro", "de", "del", "la", "el", "un", "una", "filtra", "filtrar", "solo", "mostrar"].includes(token));
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
    console.error("No se pudo consultar el producto mï¿½s barato:", err.message);
    return null;
  }
};

const findMostExpensiveProduct = async () => {
  try {
    return await Product.findOne({}).sort({ price: -1, stock: -1 }).lean();
  } catch (err) {
    console.error("No se pudo consultar el producto mï¿½s caro:", err.message);
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
    console.log(`[MFA supportBot] Cï¿½digo para ${user.email}: ${code}`);
    return { sentBy: "console" };
  }

  if (selectedMethod === "email") {
    if (!resendClient) {
      console.log(`[MFA supportBot] Cï¿½digo para ${user.email}: ${code}`);
      return { sentBy: "email", fallback: true };
    }

    const from = (process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev").trim();
    await resendClient.emails.send({
      from,
      to: user.email,
      subject: "Cï¿½digo de verificaciï¿½n - Nendoshop",
      text: `Hola ${user.name || user.email}, tu cï¿½digo de verificaciï¿½n es ${code}. Expira en 5 minutos.`,
      html: `<p>Hola ${user.name || user.email},</p><p>Tu cï¿½digo de verificaciï¿½n es:</p><h2>${code}</h2><p>Expira en 5 minutos.</p>`
    });
    return { sentBy: "email" };
  }

  if (!user.phone) {
    console.log(`[MFA supportBot] Sin telï¿½fono para ${selectedMethod}; enviando por correo: ${code}`);
    return { sentBy: "email", fallback: true };
  }

  const macroMethod = selectedMethod === "whatsapp" ? "wtsp" : selectedMethod === "call" ? "call" : selectedMethod === "sms" ? "sms" : "email";
  const nombre = encodeURIComponent(user.name || user.email);
  const numero = encodeURIComponent(String(user.phone));
  const url = `https://trigger.macrodroid.com/543902b9-9627-4797-833f-8ab08ee4a3ec/otp?nombre=${nombre}&numero=${numero}&metodo=${macroMethod}&codigo=${code}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      res.on("data", () => { });
      res.on("end", () => resolve({ sentBy: selectedMethod }));
    }).on("error", () => resolve({ sentBy: selectedMethod, error: true }));
  });
};

const issueActionMfa = async (user, method = "email") => {
  const selectedMethod = normalizeMfaMethod(method);
  const result = await issueSharedActionMfa(user, selectedMethod, {
    subject: "Cï¿½digo de verificaciï¿½n - Nendoshop",
    title: "Verificaciï¿½n de seguridad",
    description: "Tu cï¿½digo de verificaciï¿½n para el asistente es:"
  });

  if (result?.error) {
    throw new Error(result.message || "No se pudo enviar el cï¿½digo de verificaciï¿½n.");
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
      return "Claro, puedo cambiar tu foto de perfil. Envï¿½ame la URL de la imagen que quieres usar.";
    }
    return null;
  }

  const parsedUpdate = parseProfileChangeRequest(normalized);
  if (session.pendingProfileAction?.type === "photo_change" && session.pendingProfileAction.status === "waiting_for_value") {
    const imageValue = extractProfileImageValue(normalized);
    if (!imageValue) {
      return "Envï¿½ame la URL de la imagen que quieres usar para tu foto de perfil.";
    }
    user.profileImg = imageValue;
    await user.save();
    session.pendingProfileAction = null;
    return "Listo, actualicï¿½ tu foto de perfil con la imagen que compartiste.";
  }

  if (session.pendingMfaAction?.status === "waiting_for_code") {
    const codeMatch = normalized.match(/\b(\d{6})\b/);
    if (!codeMatch) return null;
    const pending = session.pendingMfaAction;
    const user = await User.findById(session.userId).catch(() => null);
    if (!user) return "No puedo validar el cï¿½digo sin tu cuenta.";
    const ok = await verifyActionMfa(user, pending.tempToken, codeMatch[1]);
    if (!ok) return "El cï¿½digo no es vï¿½lido o ya expirï¿½. Solicita uno nuevo para continuar.";
    if (pending.type === "phone_change") {
      user.phone = pending.newValue;
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, actualicï¿½ tu telï¿½fono y quedï¿½ verificado con MFA.";
    }
    if (pending.type === "password_change") {
      const newPassword = pending.newPassword;
      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, cambiï¿½ tu contraseï¿½a correctamente y quedï¿½ verificada con MFA.";
    }
    if (pending.type === "cancel_order") {
      const delivery = await Delivery.findById(pending.deliveryId).catch(() => null);
      if (!delivery) return "No encontrÃ© ese pedido para cancelarlo.";
      if (!(["pending", "ready_for_pickup"].includes(delivery.status))) {
        session.pendingMfaAction = null;
        return `El pedido ya no se puede cancelar porque estï¿½ en estado ${delivery.status}.`;
      }
      delivery.status = "cancelled";
      delivery.cancellationReason = "Cancelado por el asistente con MFA";
      syncStatusHistory(delivery, "cancelled", { note: delivery.cancellationReason });
      await delivery.save();
      await recordLog({ req: { user: { id: session.userId, email: user.email } }, usuario: user.email, descripcion: `Pedido ${delivery._id} cancelado por asistente`, tipo: "PEDIDO", metodo: "BOT", ruta: "/chatbot" });
      session.pendingMfaAction = null;
      return "Listo, cancelï¿½ tu pedido y quedï¿½ marcado como cancelado.";
    }
  }

  if (parsedUpdate?.kind === "photo") {
    if (parsedUpdate.newValue) {
      user.profileImg = parsedUpdate.newValue;
      await user.save();
      session.pendingProfileAction = null;
      return "Listo, actualicï¿½ tu foto de perfil.";
    }
    session.pendingProfileAction = { type: "photo_change", status: "waiting_for_value" };
    return "Claro, puedo cambiar tu foto de perfil. Envï¿½ame la URL de la imagen que quieres usar.";
  }

  if (parsedUpdate?.kind === "password") {
    const pending = session.pendingMfaAction || null;
    if (pending?.type === "password_change" && pending.status === "waiting_for_code") {
      const code = normalized.match(/\b(\d{6})\b/);
      if (!code) {
        return "Te enviï¿½ un cï¿½digo de verificaciï¿½n. Envï¿½ame los 6 dï¿½gitos para confirmar el cambio de contraseï¿½a.";
      }
      const ok = await verifyActionMfa(user, pending.tempToken, code[1]);
      if (!ok) {
        return "El cï¿½digo no es vï¿½lido o ya expirï¿½. Solicita uno nuevo para continuar.";
      }
      const newPassword = pending.newPassword;
      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, cambiï¿½ tu contraseï¿½a correctamente y quedï¿½ verificada con MFA.";
    }

    const newPassword = parsedUpdate.newPassword;
    if (!newPassword) {
      return "Puedo ayudarte a cambiar la contraseï¿½a. Compï¿½rteme la nueva contraseï¿½a y te pedirï¿½ la verificaciï¿½n por correo antes de aplicarla.";
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(newPassword)) {
      return "La nueva contraseï¿½a debe tener al menos 8 caracteres, una letra, un nï¿½mero y un sï¿½mbolo.";
    }
    const requestedMethod = extractRequestedMfaMethod(normalized);
    const tempToken = await issueActionMfa(user, requestedMethod);
    session.pendingMfaAction = { type: "password_change", status: "waiting_for_code", tempToken, newPassword, method: requestedMethod };
    const methodLabel = requestedMethod === "email" ? "correo" : requestedMethod === "console" ? "consola" : requestedMethod === "call" ? "llamada" : requestedMethod === "whatsapp" ? "WhatsApp" : "SMS";
    return `Te enviï¿½ un cï¿½digo de verificaciï¿½n por ${methodLabel}. Envï¿½ame los 6 dï¿½gitos para confirmar el cambio de contraseï¿½a.`;
  }

  if (/contrase(?:ï¿½|n)a|password/i.test(normalized)) {
    return "Puedo ayudarte a cambiar la contraseï¿½a. Solo harï¿½ el cambio al confirmar el cï¿½digo MFA que te envï¿½e por correo.";
  }

  if (parsedUpdate?.kind === "phone") {
    const pending = session.pendingMfaAction || null;
    if (pending?.type === "phone_change" && pending.status === "waiting_for_code") {
      const code = normalized.match(/\b(\d{6})\b/);
      if (!code) {
        return "Te enviï¿½ un cï¿½digo de verificaciï¿½n. Envï¿½ame los 6 dï¿½gitos para confirmar el cambio de telï¿½fono.";
      }
      const ok = await verifyActionMfa(user, pending.tempToken, code[1]);
      if (!ok) {
        return "El cï¿½digo no es vï¿½lido o ya expirï¿½. Solicita uno nuevo para continuar.";
      }
      user.phone = pending.newValue;
      await user.save();
      session.pendingMfaAction = null;
      return "Listo, actualicï¿½ tu telï¿½fono y quedï¿½ verificado con MFA.";
    }

    if (!parsedUpdate.newValue) {
      return "Claro, dime el nuevo telï¿½fono para continuar con la actualizaciï¿½n.";
    }

    try {
      const requestedMethod = extractRequestedMfaMethod(normalized);
      const mfaResult = await issueActionMfa(user, requestedMethod);
      session.pendingMfaAction = { type: "phone_change", status: "waiting_for_code", tempToken: mfaResult.tempToken, newValue: parsedUpdate.newValue, method: requestedMethod };
      const fallbackText = mfaResult.fallback ? ` El cï¿½digo para pruebas es ${mfaResult.code}.` : "";
      const methodLabel = requestedMethod === "email" ? "correo" : requestedMethod === "console" ? "consola" : requestedMethod === "call" ? "llamada" : requestedMethod === "whatsapp" ? "WhatsApp" : "SMS";
      return `Te enviï¿½ un cï¿½digo de verificaciï¿½n por ${methodLabel}${mfaResult.fallback ? " (se registrï¿½ en consola porque el canal fallï¿½)" : ""}. Envï¿½ame los 6 dï¿½gitos para confirmar el cambio de telï¿½fono.${fallbackText}`;
    } catch (error) {
      return `No pude enviarte el cï¿½digo en este momento: ${error.message}`;
    }
  }

  if (/(tel(?:e|ï¿½)?fono|telefono|phone|celular|numero|telfono|tel)\b/i.test(normalized)) {
    return "Claro, dime el nuevo telï¿½fono para continuar con la actualizaciï¿½n.";
  }

  const fieldMap = [
    { label: "nombre", pattern: /(nombre|name)\b/i, field: "name" },
    { label: "apellido", pattern: /(apellido|lastname|last name)\b/i, field: "lastname" },
    { label: "direcciï¿½n", pattern: /(direcciï¿½n|direccion|address|domicilio)\b/i, field: "address" },
    { label: "ciudad", pattern: /(ciudad|city)\b/i, field: "city" },
    { label: "telï¿½fono", pattern: /(telï¿½fono|telefono|phone|celular)\b/i, field: "phone" }
  ];

  for (const field of fieldMap) {
    const match = normalized.match(new RegExp(`(?:${field.label}|${field.field})[^a-zï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½0-9]*([a-zï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½0-9 .,'/-]+)$`, "i"));
    if (match && match[1]) {
      user[field.field] = match[1].trim();
      await user.save();
      return `Listo, actualicï¿½ tu ${field.label}.`;
    }
  }

  return "Puedo actualizar tu perfil. Dï¿½me quï¿½ dato quieres cambiar y el nuevo valor, por ejemplo: cambia mi direcciï¿½n a Av. Siempre Viva 123.";
};

const handleClaimRequest = async (text, session) => {
  if (!session) return null;
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  if (session.pendingClaim?.step === "waiting_for_order") {
    const orderNumber = extractOrderNumber(normalized);
    if (orderNumber) {
      session.pendingClaim = { step: "waiting_for_description", orderNumber, category: "delay" };
      return `Perfecto, voy a revisar el pedido ${orderNumber}. Describe brevemente lo que pasó para registrar el reclamo.`;
    }
    return "Claro, necesito el número de pedido para registrar tu reclamo. Compárteme el número o el ID del pedido.";
  }

  if (isClaimIntent(normalized) || /reclamo|reclamar|queja/i.test(normalized)) {
    const parsedClaim = parseClaimRequest(normalized);
    if (parsedClaim?.orderNumber) {
      session.pendingClaim = { step: "waiting_for_description", orderNumber: parsedClaim.orderNumber, category: parsedClaim.category };
      return `Perfecto, voy a revisar el pedido ${parsedClaim.orderNumber}. Describe brevemente lo que pasó para registrar el reclamo.`;
    }
    session.pendingClaim = { step: "waiting_for_order", orderNumber: null, category: null };
    return "Claro, necesito el número de pedido para registrar tu reclamo. Compárteme el número o el ID del pedido.";
  }

  return null;
};

const handleCheckoutRequest = async (text, session) => {
  if (!session?.userId) return null;

  const normalized = String(text || "").trim();
  const checkoutIntent = parseCheckoutIntent(normalized);
  if (!checkoutIntent) return null;

  const cartItems = Array.isArray(session.cartItems) ? session.cartItems : [];
  if (!cartItems.length) {
    session.pendingMfaAction = null;
    return "Tu carrito está vacío. Agrega productos primero y luego te ayudo a convertirlos en una orden real.";
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
      return "Perfecto, primero dime si deseas recojo en tienda o envío a domicilio. Si eliges envío, te aviso el costo antes de continuar.";
    }

    session.pendingMfaAction = {
      ...pending,
      deliveryType,
      status: deliveryType === "shipping" ? "waiting_for_shipping_data" : "waiting_for_payment_method"
    };

    if (deliveryType === "shipping") {
      return `Elegiste envío a domicilio. Ese envío tiene un costo de S/. ${shippingFee.toFixed(2)}. Ahora envíame la dirección, el distrito y una referencia para continuar.`;
    }

    return "Elegiste recojo en tienda. Ahora dime si pagarás con tarjeta o con PayPal.";
  }

  if (pending?.type === "checkout" && pending.status === "waiting_for_shipping_data") {
    const addressMatch = normalized.match(/(?:direccion|dirección|calle|avenida|av\.?|jr\.?|jiron|jirón)[^:]*[:\-]?\s*(.+)/i);
    const referenceMatch = normalized.match(/(?:referencia|ref\.?)[^:]*[:\-]?\s*(.+)/i);
    const address = addressMatch?.[1]?.trim() || pending.address || null;
    const reference = referenceMatch?.[1]?.trim() || pending.reference || null;

    if (!address) {
      session.pendingMfaAction = { ...pending, deliveryType: "shipping", status: "waiting_for_shipping_data" };
      return `Aún me falta la dirección de entrega. Envíamela junto con el distrito, por favor. El envío cuesta S/. ${shippingFee.toFixed(2)}.`;
    }

    session.pendingMfaAction = {
      ...pending,
      deliveryType: "shipping",
      address,
      reference,
      status: "waiting_for_payment_method"
    };
    return "Gracias. Ahora dime si pagarás con tarjeta o con PayPal.";
  }

  if ((pending?.type === "checkout" && pending.status === "waiting_for_payment_method") || (requestedDeliveryType && requestedMethod && !pending)) {
    const method = requestedMethod || (/paypal/i.test(normalized) ? "paypal" : /tarjeta|card|credito|debito|visa|mastercard/i.test(normalized) ? "card" : null);
    if (!method) return "Dime si pagarás con PayPal o con tarjeta.";

    const checkoutState = pending?.type === "checkout"
      ? pending
      : session.pendingMfaAction || {
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
      return "Perfecto, te llevo al pago seguro de PayPal para terminar la compra. Cuando finalices, la orden quedará completada automáticamente.";
    }

    if (currentUser.paymentmethod?.numerotarjeta) {
      const masked = String(currentUser.paymentmethod.numerotarjeta).replace(/\d(?=\d{4})/g, "*");
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

  if (/^(si|sí|si gracias|ok|okay|listo|confirmo|acepto)$/i.test(normalized)) {
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
      return `Listo, generé tu pedido real. El número de pedido es ${payment.documento}.`;
    }
  }

  const deliveryType = requestedDeliveryType || pending?.deliveryType || null;
  if (!deliveryType) {
    session.pendingMfaAction = {
      type: "checkout",
      status: "waiting_for_delivery_type",
      deliveryType: null,
      address: null,
      reference: null,
      agency: null
    };
    return "Perfecto, voy a preparar tu pedido. Primero dime si deseas recojo en tienda o envío a domicilio.";
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
    return `Perfecto, voy a preparar tu pedido con envío a domicilio. Ese envío tiene un costo de S/. ${shippingFee.toFixed(2)}. Envíame la dirección, el distrito y una referencia para continuar.`;
  }

  return "Perfecto, voy a preparar tu pedido con recojo en tienda. Ahora dime si pagarás con tarjeta o con PayPal.";
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
  const shouldHandle = /^\/|^(ver|consultar|crear|generar|cancelar|cambiar|actualizar|modificar|editar|agregar|aï¿½adir|busca|muestra|dime|revisa|ayuda|quiero|necesito|puedes)/i.test(normalized) || /(mis pedidos|mis ordenes|mis compras|pedido|orden|producto|productos|perfil|direcciï¿½n|direccion|telï¿½fono|telefono|ciudad|carrito|cart|cancelar|cambiar|actualizar|modificar|editar)/i.test(normalized);

  if (!shouldHandle) return null;
  if (parseCheckoutIntent(normalized) || isClaimIntent(normalized)) return null;

  if (!userId) {
    return "Para ejecutar acciones necesito que escribas desde tu cuenta iniciada. Puedo orientarte, pero no modificar ni consultar pedidos sin identificarte.";
  }

  if (/^\/?(mis[-\s]?pedidos|ordenes|ï¿½rdenes|mis pedidos|mis ordenes|mis compras)$/i.test(normalized) || /(mis pedidos|mis ordenes|mis compras)/i.test(normalized)) {
    const deliveries = await Delivery.find({ user: userId }).populate("paymentId").sort({ createdAt: -1 }).limit(5).lean().catch(() => []);
    if (!deliveries.length) return "No encuentro pedidos asociados a tu cuenta. Si acabas de pagar, espera unos segundos y vuelve a consultar.";
    return deliveries.map(buildOrderSummary).join("\n");
  }

  if (/(productos|catalogo|catï¿½logo|stock|inventario|figuras)/i.test(normalized)) {
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

  if (/(perfil|mis datos|datos|nombre|apellido|direcciï¿½n|direccion|ciudad|telï¿½fono|telefono)/i.test(normalized) && !/(cambiar|actualizar|modificar|editar|poner|cambia|actualiza|modifica|edita|setea|asigna)/i.test(normalized)) {
    const user = await User.findById(userId).select("-password").lean().catch(() => null);
    if (!user) return "No puedo ver tu perfil sin que estï¿½s autenticado.";
    const details = [
      `Nombre: ${user.name || "sin registrar"}`,
      `Apellido: ${user.lastname || "sin registrar"}`,
      `Email: ${user.email || "sin registrar"}`,
      `Direcciï¿½n: ${user.address || "sin registrar"}`,
      `Ciudad: ${user.city || "sin registrar"}`,
      `Telï¿½fono: ${user.phone || "sin registrar"}`
    ];
    return `Estos son tus datos actuales:\n${details.join("\n")}`;
  }

  const orderMatch = normalized.match(/(?:pedido|orden|detalle|estado)\s+#?([a-f0-9]{24}|[a-z0-9]{6})/i);
  if (orderMatch && /ver|consultar|detalle|estado|pedido|orden/i.test(normalized)) {
    const delivery = await findUserDeliveryById(userId, orderMatch[1]);
    return delivery ? buildOrderSummary(delivery) : "No encontrÃ© ese pedido en tu cuenta. Revisa el ID corto o completo y lo intento de nuevo.";
  }

  const claimMatch = normalized.match(/(?:reclamo|reclamar)\s+#?([a-f0-9]{24}|[a-z0-9]{6})\s+([a-zï¿½ï¿½ï¿½ï¿½ï¿½ï¿½]+)\s+(.+)/i);
  if (claimMatch) {
    const delivery = await findUserDeliveryById(userId, claimMatch[1]);
    if (!delivery) return "No encontrÃ© ese pedido en tu cuenta. No crearÃ© reclamos sobre pedidos que no te pertenecen.";
    const category = CLAIM_CATEGORY_ALIASES[String(claimMatch[2]).toLowerCase()] || "";
    if (!category) return "La categorï¿½a no coincide. Usa demora, incompleto, daï¿½ado, devoluciï¿½n o cancelaciï¿½n.";
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
    return "Listo, registrï¿½ tu reclamo y quedï¿½ pendiente de revisiï¿½n por administraciï¿½n. Puedes seguir el avance desde Mis Pedidos.";
  }

  const actionReply = await resolveActionRequest(normalized, session);
  if (actionReply) return actionReply;

  const context = buildKeyValueContext(normalized);
  const productHint = extractProductHint(normalized);
  if ((/pedido|orden/i.test(normalized)) && (/producto|articulo|artï¿½culo|figura/i.test(normalized) || productHint)) {
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
      return `Datos actuales:\nNombre: ${user.name || "sin registrar"}\nApellido: ${user.lastname || "sin registrar"}\nDirecciï¿½n: ${user.address || "sin registrar"}\nCiudad: ${user.city || "sin registrar"}\nTelï¿½fono: ${user.phone || "sin registrar"}`;
    }
  }

  if (/contrase|password/i.test(normalized)) {
    return "Puedo guiarte con el cambio de contraseï¿½a, pero no te pedirï¿½ tu contraseï¿½a actual por chat. Ve a Perfil > Seguridad, solicita el cambio y cuando el sistema pida MFA ingresa el cï¿½digo recibido en tu correo.";
  }

  if (/crear\s+pedido|comprar|ordenar/i.test(normalized)) {
    const cartItems = Array.isArray(session?.cartItems) ? session.cartItems : [];
    if (!cartItems.length) return "Tu carrito estï¿½ vacï¿½o. Agrega productos primero y te ayudo a convertirlos en un pedido real.";

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
      destinationAddress: user.address || "Sin direcciï¿½n",
      reference: "Creado por asistente",
      agency: "Asistente"
    });

    session.cartItems = [];
    return `Listo, creï¿½ un pedido real para ti con ${cartItems.length} producto(s). El nï¿½mero de pedido es ${payment.documento} y ya quedï¿½ registrado con estado ${delivery.status}.`;
  }

  return null;
};

const CLASSIFICATION_PROMPT = (text) => `Eres un clasificador para el chatbot de atenciï¿½n al cliente de NendoShop (tienda de figuras Nendoroid). Analiza el mensaje del cliente y responde ï¿½NICAMENTE con un JSON vï¿½lido, sin texto adicional, con esta forma exacta:

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

Reglas de moderaciï¿½n:
- Si el mensaje contiene insultos, amenazas, acoso, lenguaje sexual explï¿½cito o contenido violento: allowed=false, block=true, category="inapropiado".
- En cualquier otro caso: allowed=true, block=false, category="apropiado".
- Para moderar debes tener en cuenta sinonimos  y las palabras sexuales como los oparatos reproductos, fluidos y insultos especializados.

Intents posibles (elige exactamente uno):
- "saludo": el cliente solo saluda o inicia la conversaciï¿½n.
- "buscar_producto": pregunta por un producto, precio, stock o pide una recomendaciï¿½n.
- "consultar_pedido": pregunta por el estado de un pedido o envï¿½o.
- "devolucion": pregunta sobre devoluciones o cambios.
- "cuenta": problemas de acceso, cuenta o credenciales.
- "despedida": se estï¿½ despidiendo o agradeciendo y da por terminada la conversaciï¿½n.
- "general": cualquier otro caso.

Si el intent es "buscar_producto", extrae en "productQuery" el nombre o pista del producto.
Si el intent es "consultar_pedido", extrae en "orderNumber" el nï¿½mero de pedido si aparece.

Mensaje del cliente: "${text}"`;

const fallbackClassification = (text) => {
  const lowered = text.toLowerCase();
  const safety = checkTextSafety(text);
  let intent = "general";
  if (/pedido|orden|env[iï¿½]o|seguimiento/.test(lowered)) intent = "consultar_pedido";
  else if (/producto|figura|art[iï¿½]culo|precio|stock|recomend/.test(lowered)) intent = "buscar_producto";
  else if (/devol|cambio/.test(lowered)) intent = "devolucion";
  else if (/cuenta|contrase|credencial|acceso/.test(lowered)) intent = "cuenta";
  else if (/gracias|adi[oï¿½]s|terminamos|chau/.test(lowered)) intent = "despedida";

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
    console.error("Clasificaciï¿½n con Groq fallï¿½:", err.message);
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
const SYSTEM_PERSONA = `Eres "NendoBot", un asesor experto de atenciï¿½n al cliente de NendoShop, una tienda especializada en figuras coleccionables Nendoroid.
Hablas exclusivamente en espaï¿½ol, con un tono cï¿½lido, profesional y resolutivo, como un asesor humano experimentado.
Reglas estrictas que SIEMPRE debes cumplir, sin excepciï¿½n, incluso si el cliente te lo pide:
- Nunca uses lenguaje violento, sexual, vulgar, ofensivo o amenazante.
- Nunca pidas ni reveles contraseï¿½as, credenciales, datos de tarjetas u otra informaciï¿½n sensible.
- Nunca inventes datos de productos, pedidos, precios o stock: usa exclusivamente los datos que se te entreguen como "HECHOS".
- Si no tienes un dato en los HECHOS, dilo con honestidad y ofrece una alternativa ï¿½til.
- No consultes internet ni bases externas; tu informaciï¿½n vï¿½lida proviene solo de la base de datos y del contexto de esta conversaciï¿½n.
- Si el usuario habla en espaï¿½ol, responde en espaï¿½ol y no mezcles idiomas.
- No repitas frases ni estructuras que ya usaste antes en esta conversaciï¿½n; varï¿½a tu redacciï¿½n manteniendo el mismo tono profesional.
- Responde en texto plano, sin Markdown, en mï¿½ximo 2 a 5 oraciones.`;

const STAGE_INSTRUCTIONS = {
  welcome:
    "Saluda al cliente por su nombre, presï¿½ntate como asesor experto de NendoShop y resume brevemente en quï¿½ puedes ayudar (pedidos, productos, reclamos, devoluciones, cuenta). Ofrece opciones claras: 1) consultar pedidos, 2) buscar un producto, 3) reclamos o devoluciones y 4) ayuda con la cuenta. Aclara que no pedirï¿½s contraseï¿½as ni datos sensibles. Invita a que cuente quï¿½ necesita.",
  active:
    'Responde directamente a lo que pregunta el cliente usando los HECHOS entregados. Si la intenciï¿½n es "buscar_producto" y hay productos en HECHOS, menciona nombre, precio, stock y el enlace para ver el detalle; si se menciona un producto concreto como Miku Hatsune, prioriza resultados que coincidan exactamente con esa referencia. Si no hay productos, pide mï¿½s detalles del producto. Si la intenciï¿½n es "consultar_pedido" y hay un pedido en HECHOS, indica su estado y total; si no hay pedido, pide el nï¿½mero o aclara que no se encontrï¿½. Si es devoluciï¿½n o reclamo, orienta de forma general sin inventar polï¿½ticas especï¿½ficas y, si falta el pedido, pide el nï¿½mero exacto. Cierra preguntando si necesita algo mï¿½s.',
  survey_intro:
    "El cliente se estï¿½ despidiendo o agradeciendo. Agradï¿½cele por contactar a NendoShop y pï¿½dele, de forma breve y amable, que califique la atenciï¿½n del 1 (muy mala) al 5 (excelente).",
  closing:
    "El cliente respondiï¿½ a la encuesta de satisfacciï¿½n. Agradï¿½cele sinceramente por su respuesta (sin inventar nada que no te dieron) y cierra la conversaciï¿½n de forma cordial, indicando que puede volver a escribir cuando lo necesite."
};

const buildCompositionInput = ({ customerName, intent, stage, session, facts }) => {
  const recent = (session.history || [])
    .slice(-6)
    .map((h) => `${h.role === "user" ? "Cliente" : "NendoBot"}: ${h.text}`)
    .join("\n");

  const stageInstruction = STAGE_INSTRUCTIONS[stage] || STAGE_INSTRUCTIONS.active;

  return `${SYSTEM_PERSONA}

Nombre del cliente: ${customerName}
Intenciï¿½n detectada: ${intent}
Instrucciï¿½n de la etapa actual: ${stageInstruction}

HECHOS (usa solo estos datos, no agregues otros):
${facts ? JSON.stringify(facts) : "No hay datos adicionales para esta respuesta."}

Conversaciï¿½n reciente (para que no repitas frases):
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
        pista: "mï¿½s barato",
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
      ? `${profileReply} Si quieres, puedo ayudarte con algo mï¿½s concreto como pedidos, productos o devoluciones.`
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
      ? `${cancelReply} Si prefieres, tambiï¿½n puedo consultar tu pedido o ayudarte a encontrar un producto.`
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
    return `He encontrado coincidencias relevantes para ï¿½${exactHint}ï¿½. Si quieres, puedo ayudarte a listar solo los productos que coinciden con esa referencia y te digo precio y stock.`;
  }
  pushHistory(session, "bot", reply);
  return reply;
};

const buildSupportBotReply = getSupportBotReply;

const REPORT_CLASSIFICATION_PROMPT = (reason, historyText) => `Eres un moderador de chat avanzado para NendoShop.
Tu tarea es analizar el historial de mensajes de un usuario reportado durante el d?a de hoy y el motivo del reporte proporcionado por el denunciante.

Motivo del reporte: "${reason}"

Historial de mensajes del usuario reportado hoy:
${historyText}

Analiza si el usuario reportado ha infringido las normas del chat (insultos, spam, acoso, lenguaje sexual expl?cito, estafas, amenazas o comportamiento violento).
Responde ?NICAMENTE con un JSON v?lido en espa?ol, sin texto adicional, con esta forma exacta:

{
  "allowed": true,
  "block": false,
  "category": "apropiado",
  "reason": "Explicaci?n breve del an?lisis de la conversaci?n"
}

Reglas:
- Si consideras que el historial de mensajes del usuario contiene infracciones graves (insultos, acoso, amenazas, lenguaje sexual, etc.): "allowed": false, "block": true, "category": "inapropiado".
- Si el comportamiento es apropiado y no hay infracciones graves: "allowed": true, "block": false, "category": "apropiado".
- S? riguroso y objetivo en tu evaluaci?n.`;

const fallbackReportClassification = (reason, hasMessages) => {
  return {
    allowed: true,
    block: false,
    category: "apropiado",
    reason: hasMessages
      ? "Moderaci?n de reporte fall? (fallback seguro)"
      : "El usuario no enviÃ³ mensajes hoy para ser evaluados."
  };
};

const analyzeReportWithGroq = async (reason, userMessages) => {
  const hasMessages = Array.isArray(userMessages) && userMessages.length > 0;
  if (!hasMessages) {
    return fallbackReportClassification(reason, false);
  }

  const apiKey = await getGroqApiKey();
  if (!apiKey) {
    console.warn("Groq API Key no configurada para moderaciÃ³n de reportes");
    return fallbackReportClassification(reason, true);
  }

  // Formatear mensajes: "[HH:MM:SS] username: texto"
  const historyText = userMessages
    .map((m) => {
      const timeStr = m.createdAt
        ? new Date(m.createdAt).toISOString().slice(11, 19)
        : "00:00:00";
      return `[${timeStr}] ${m.username || "Usuario"}: ${m.text}`;
    })
    .join("\n");

  try {
    const prompt = REPORT_CLASSIFICATION_PROMPT(reason, historyText);
    const raw = await callGroq({
      apiKey,
      input: prompt,
      temperature: 0,
      maxOutputTokens: 300,
      onFallback: () => JSON.stringify(fallbackReportClassification(reason, true))
    });

    const parsed = parseGroqJson(raw);
    if (parsed) {
      return {
        allowed: parsed.allowed !== false,
        block: parsed.block === true,
        category: parsed.category || "apropiado",
        reason: parsed.reason || "Moderado exitosamente"
      };
    }
    return fallbackReportClassification(reason, true);
  } catch (err) {
    console.error("Error al analizar reporte con Groq:", err.message);
    return fallbackReportClassification(reason, true);
  }
};

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
  extractRequestedMfaMethod,
  analyzeReportWithGroq
};
