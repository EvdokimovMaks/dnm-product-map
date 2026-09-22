const {
  isConfigured,
  isAuthenticated,
  passwordMatches,
  setSessionCookie,
  clearSessionCookie,
  json,
} = require("./_auth");

module.exports = async function handler(req, res) {
  try {
    if (!isConfigured()) {
      return json(res, 503, {
        error: "Пароль доступа не настроен. Добавьте DNM_ACCESS_PASSWORD в Environment Variables проекта Vercel.",
      });
    }

    if (req.method === "GET") {
      return json(res, 200, {
        authenticated: isAuthenticated(req),
      });
    }

    if (req.method === "POST") {
      const password = req.body && req.body.password;

      if (!passwordMatches(password)) {
        return json(res, 401, {
          authenticated: false,
          error: "Неверный пароль",
        });
      }

      setSessionCookie(res);
      return json(res, 200, {
        authenticated: true,
      });
    }

    if (req.method === "DELETE") {
      clearSessionCookie(res);
      return json(res, 200, {
        authenticated: false,
      });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "Метод не поддерживается" });
  } catch (error) {
    console.error(error);
    return json(res, 500, {
      error: "Внутренняя ошибка сервера",
    });
  }
};
