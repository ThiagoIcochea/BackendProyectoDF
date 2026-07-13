const Log = require("../models/Log");

const normalizeIp = (reqOrIp) => {
  if (!reqOrIp) return "unknown";
  if (typeof reqOrIp === "string") return reqOrIp;
  const forwarded = reqOrIp.headers?.["x-forwarded-for"];
  if (Array.isArray(forwarded)) return forwarded[0];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return reqOrIp.ip || reqOrIp.connection?.remoteAddress || "unknown";
};

const normalizeUserAgent = (reqOrUserAgent) => {
  if (!reqOrUserAgent) return "unknown";
  if (typeof reqOrUserAgent === "string") return reqOrUserAgent;
  return reqOrUserAgent.get?.("user-agent") || reqOrUserAgent.headers?.["user-agent"] || "unknown";
};

const normalizeLogType = (value) => {
  const normalized = String(value || "SISTEMA").trim().toUpperCase();
  return ["TRANSACCION", "ERROR", "SISTEMA", "AUTH", "PEDIDO", "RECLAMO", "CARRITO", "PRODUCTO"].includes(normalized)
    ? normalized
    : "SISTEMA";
};

const recordLog = async ({ req, usuario, descripcion, tipo = "SISTEMA", metodo = "GET", ruta = "/", userAgent, ip }) => {
  try {
    const payload = {
      ip: ip || normalizeIp(req),
      usuario: usuario || req?.user?.email || req?.user?.name || "Anónimo",
      descripcion,
      tipo: normalizeLogType(tipo),
      metodo: metodo || req?.method || "GET",
      ruta: ruta || req?.originalUrl || req?.path || "/",
      userAgent: userAgent || normalizeUserAgent(req)
    };

    await Log.create(payload);
  } catch (error) {
    console.error("No se pudo guardar el log:", error);
  }
};

module.exports = { recordLog, normalizeIp, normalizeUserAgent };
