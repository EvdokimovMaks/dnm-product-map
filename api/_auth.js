const crypto = require("crypto");

const COOKIE_NAME = "dnm_map_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 дней
const SESSION_PAYLOAD = "dnm-product-map-access-v1";

function getPassword() {
  return String(process.env.DNM_ACCESS_PASSWORD || "");
}

function getSecret() {
  // Лучше задать отдельный DNM_AUTH_SECRET.
  // Если его нет, сессия всё равно работает от пароля.
  return String(process.env.DNM_AUTH_SECRET || getPassword());
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function makeSessionToken() {
  const secret = getSecret();
  if (!secret) return "";
  return crypto
    .createHmac("sha256", secret)
    .update(SESSION_PAYLOAD)
    .digest("hex");
}

function parseCookies(req) {
  const raw = String((req && req.headers && req.headers.cookie) || "");
  const out = {};
  raw.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  });
  return out;
}

function isConfigured() {
  return Boolean(getPassword());
}

function isAuthenticated(req) {
  if (!isConfigured()) return false;
  const cookie = parseCookies(req)[COOKIE_NAME];
  const expected = makeSessionToken();
  return Boolean(cookie && expected && safeEqual(cookie, expected));
}

function passwordMatches(candidate) {
  const password = getPassword();
  return Boolean(password && safeEqual(candidate, password));
}

function setSessionCookie(res) {
  const token = makeSessionToken();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
  );
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(body));
}

function requireAuth(req, res) {
  if (!isConfigured()) {
    json(res, 503, {
      error: "Пароль доступа не настроен. Добавьте DNM_ACCESS_PASSWORD в Environment Variables проекта Vercel.",
    });
    return false;
  }

  if (!isAuthenticated(req)) {
    json(res, 401, { error: "Требуется вход" });
    return false;
  }

  return true;
}

module.exports = {
  isConfigured,
  isAuthenticated,
  passwordMatches,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  json,
};
