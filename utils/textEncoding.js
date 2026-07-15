const MOJIBAKE_REPLACEMENTS = [
  [/Ã¡/g, "á"],
  [/Ã©/g, "é"],
  [/Ã­/g, "í"],
  [/Ã³/g, "ó"],
  [/Ãº/g, "ú"],
  [/Ã/g, "Á"],
  [/Ã‰/g, "É"],
  [/Ã/g, "Í"],
  [/Ã“/g, "Ó"],
  [/Ãš/g, "Ú"],
  [/Ã±/g, "ñ"],
  [/Ã‘/g, "Ñ"],
  [/Ã¼/g, "ü"],
  [/Â¿/g, "¿"],
  [/Â¡/g, "¡"],
  [/Â·/g, "·"],
  [/Â/g, ""],
  [/â€œ/g, '"'],
  [/â€/g, '"'],
  [/â€™/g, "'"],
  [/â€˜/g, "'"],
  [/â€“/g, "-"],
  [/â€”/g, "-"],
  [/â€¦/g, "..."],
  [/Cï¿½digo/g, "Código"],
  [/cï¿½digo/g, "código"],
  [/verificaciï¿½n/g, "verificación"],
  [/contraseï¿½a/g, "contraseña"],
  [/Contraseï¿½a/g, "Contraseña"],
  [/telï¿½fono/g, "teléfono"],
  [/Telï¿½fono/g, "Teléfono"],
  [/dï¿½a/g, "día"],
  [/lï¿½mite/g, "límite"],
  [/aquï¿½/g, "aquí"],
  [/mï¿½s/g, "más"],
  [/atenciï¿½n/g, "atención"],
  [/informaciï¿½n/g, "información"],
  [/funciï¿½n/g, "función"],
  [/nï¿½mero/g, "número"],
  [/envï¿½o/g, "envío"],
  [/anï¿½lisis/g, "análisis"],
  [/categorï¿½a/g, "categoría"],
  [/sï¿½mbolo/g, "símbolo"],
  [/vï¿½lido/g, "válido"],
  [/invï¿½lido/g, "inválido"],
  [/estï¿½/g, "está"],
  [/estï¿½n/g, "están"],
  [/serï¿½/g, "será"],
  [/enviï¿½/g, "envió"],
  [/fallï¿½/g, "falló"],
  [/ï¿½/g, "ó"]
];

const QUESTION_MARK_REPLACEMENTS = [
  [/\bc\?digo\b/g, "código"],
  [/\bC\?digo\b/g, "Código"],
  [/\bverificaci\?n\b/g, "verificación"],
  [/\bcontrase\?a\b/g, "contraseña"],
  [/\bContrase\?a\b/g, "Contraseña"],
  [/\bn\?mero\b/g, "número"],
  [/\btel\?fono\b/g, "teléfono"],
  [/\bd\?a\b/g, "día"],
  [/\bl\?mite\b/g, "límite"],
  [/\baqu\?\b/g, "aquí"],
  [/\bm\?s\b/g, "más"],
  [/\ba\?adir\b/g, "añadir"],
  [/\benv\?o\b/g, "envío"],
  [/\bfunci\?n\b/g, "función"],
  [/\batenci\?n\b/g, "atención"],
  [/\binformaci\?n\b/g, "información"],
  [/\bintenci\?n\b/g, "intención"],
  [/\binstrucci\?n\b/g, "instrucción"],
  [/\bconversaci\?n\b/g, "conversación"],
  [/\ban\?lisis\b/g, "análisis"],
  [/\bcategor\?a\b/g, "categoría"],
  [/\best\?\b/g, "está"],
  [/\best\?n\b/g, "están"],
  [/\bser\?\b/g, "será"],
  [/\benvi\?\b/g, "envió"],
  [/\bfall\?\b/g, "falló"],
  [/\bS\? riguroso/g, "Sé riguroso"]
];

const normalizeSpanishText = (value) => {
  if (typeof value !== "string") return value;

  let output = value.normalize("NFC");
  for (const [pattern, replacement] of MOJIBAKE_REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of QUESTION_MARK_REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  return output.normalize("NFC");
};

const normalizeJsonPayload = (payload, seen = new WeakSet()) => {
  if (typeof payload === "string") return normalizeSpanishText(payload);
  if (!payload || typeof payload !== "object") return payload;
  if (payload instanceof Date) return payload;
  if (
    typeof payload.toJSON === "function" &&
    payload.constructor &&
    payload.constructor.name !== "Object" &&
    !Array.isArray(payload)
  ) {
    return normalizeJsonPayload(payload.toJSON(), seen);
  }
  if (seen.has(payload)) return payload;
  seen.add(payload);

  if (Array.isArray(payload)) {
    return payload.map((item) => normalizeJsonPayload(item, seen));
  }

  const normalized = {};
  for (const [key, value] of Object.entries(payload)) {
    normalized[key] = normalizeJsonPayload(value, seen);
  }
  return normalized;
};

module.exports = {
  normalizeSpanishText,
  normalizeJsonPayload
};
