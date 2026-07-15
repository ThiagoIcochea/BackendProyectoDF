const jwt = require("jsonwebtoken");
const User = require("../models/User");
const LoginIpBlock = require("../models/LoginIpBlock");
const { normalizeIp } = require("./logger");

const getCookieToken = (cookieHeader = "") => {
  const cookies = String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    if (key === "token" && value) return decodeURIComponent(value);
  }

  return null;
};

const getTokenFromRequest = (req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const queryToken = url.searchParams.get("token");
    if (queryToken) return queryToken;
  } catch (error) {
    // Ignorar errores de parseo de URL.
  }

  const authHeader = req.headers?.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return getCookieToken(req.headers?.cookie || "");
};

const isBlockedIp = async (ip) => {
  if (!ip) return false;
  const entry = await LoginIpBlock.findOne({ ip }).catch(() => null);
  if (!entry?.blockedUntil) return false;
  return new Date(entry.blockedUntil) > new Date();
};

const authenticateWebSocketRequest = async (req) => {
  const ip = normalizeIp(req);
  if (await isBlockedIp(ip)) {
    return { authorized: false, reason: "ip_blocked", ip };
  }

  const token = getTokenFromRequest(req);
  if (!token) {
    return { authorized: false, reason: "missing_token", ip };
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return { authorized: false, reason: "user_not_found", ip };
    }

    if (user.loginBlockedUntil && new Date(user.loginBlockedUntil) > new Date()) {
      return { authorized: false, reason: "account_blocked", ip, user };
    }

    if (user.chatBlockedUntil && new Date(user.chatBlockedUntil) > new Date()) {
      return { authorized: false, reason: "chat_blocked", ip, user };
    }

    return {
      authorized: true,
      ip,
      token,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name || user.email,
        role: user.role,
        profileImg: user.profileImg || ""
      }
    };
  } catch (error) {
    return { authorized: false, reason: "invalid_token", ip };
  }
};

module.exports = {
  authenticateWebSocketRequest,
  getTokenFromRequest
};
