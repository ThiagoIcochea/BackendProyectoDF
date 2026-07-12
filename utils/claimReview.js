const { getGroqApiKey, callGroq, parseGroqJson } = require('./groqClient');

const fallbackEvaluation = (description, category) => {
  const normalized = String(description || '').trim().toLowerCase();
  const hasConcreteIssue = /(lleg|falt|dañ|dano|roto|tarde|retras|cancel|incomplet|mal estado|malo|incorrect|error|no lleg|no recib|se ve|arrug|faltan|faltó|faltó)/i.test(normalized);
  const hasEnoughContext = normalized.length >= 12;
  const validClaim = Boolean(hasConcreteIssue && hasEnoughContext);
  return {
    validClaim,
    reason: validClaim
      ? 'El reclamo está descrito de forma suficientemente específica.'
      : 'El reclamo no está suficientemente descrito. Explica qué pasó, qué producto o pedido afectó y cómo ocurrió.',
    category,
    confidence: validClaim ? 0.82 : 0.41,
    source: 'fallback'
  };
};

const evaluateClaimDescription = async (description, category) => {
  const normalizedDescription = String(description || '').trim();
  if (!normalizedDescription) {
    return {
      validClaim: false,
      reason: 'Escribe una descripción del reclamo para poder evaluarla.',
      category,
      confidence: 0,
      source: 'fallback'
    };
  }

  try {
    const apiKey = await getGroqApiKey();
    if (!apiKey) {
      return fallbackEvaluation(normalizedDescription, category);
    }

    const raw = await callGroq({
      apiKey,
      system: 'Actúa como un analista de soporte e-commerce. Evalúa si un reclamo describe claramente un problema real y específico del pedido. Responde solo con JSON válido con keys: validClaim (boolean), reason (string), confidence (number), category (string), source (string).',
      user: `Categoría del reclamo: ${category}. Descripción del cliente: ${normalizedDescription}`
    });

    const parsed = parseGroqJson(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        validClaim: Boolean(parsed.validClaim),
        reason: String(parsed.reason || 'No se pudo validar el reclamo.'),
        confidence: Number(parsed.confidence || 0),
        category: String(parsed.category || category),
        source: parsed.source || 'groq'
      };
    }
  } catch (error) {
    console.error('No se pudo evaluar el reclamo con Groq:', error.message);
  }

  return fallbackEvaluation(normalizedDescription, category);
};

module.exports = {
  evaluateClaimDescription,
  fallbackEvaluation
};
