const STORE_KEY = "dnm:product-map:v1";
const HISTORY_KEY = "dnm:product-map:history:v1";
const HISTORY_LIMIT = 30;

function getRedisConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.REDIS_REST_TOKEN;

  return { url: url && url.replace(/\/+$/, ""), token };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfig();

  if (!url || !token) {
    const error = new Error("Upstash Redis не подключен к окружению Vercel");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Ошибка Upstash: ${response.status} ${text}`);
    error.statusCode = 502;
    throw error;
  }

  const body = await response.json();
  if (body && body.error) {
    const error = new Error(`Ошибка Upstash: ${body.error}`);
    error.statusCode = 502;
    throw error;
  }

  return body ? body.result : null;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(body));
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function countStats(data) {
  const modules = Array.isArray(data) ? data : [];
  let featureCount = 0;
  let taskCount = 0;

  modules.forEach((module) => {
    const features = Array.isArray(module.features) ? module.features : [];
    featureCount += features.length;
    features.forEach((feature) => {
      taskCount += Array.isArray(feature.tasks) ? feature.tasks.length : 0;
    });
  });

  return {
    moduleCount: modules.length,
    featureCount,
    taskCount,
  };
}

function parseStored(raw) {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return {
        id: "legacy-current",
        data: parsed,
        updatedAt: null,
        action: "save",
        ...countStats(parsed),
      };
    }

    if (parsed && Array.isArray(parsed.data)) {
      return {
        ...parsed,
        ...countStats(parsed.data),
      };
    }
  } catch {}

  return null;
}

function publicMeta(entry) {
  if (!entry) return null;
  return {
    id: entry.id || null,
    updatedAt: entry.updatedAt || null,
    action: entry.action || "save",
    sourceVersionId: entry.sourceVersionId || null,
    moduleCount: entry.moduleCount ?? countStats(entry.data).moduleCount,
    featureCount: entry.featureCount ?? countStats(entry.data).featureCount,
    taskCount: entry.taskCount ?? countStats(entry.data).taskCount,
  };
}

function sameData(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

async function readCurrent() {
  return parseStored(await redisCommand(["GET", STORE_KEY]));
}

async function readHistory() {
  const rawItems = (await redisCommand(["LRANGE", HISTORY_KEY, "0", String(HISTORY_LIMIT - 1)])) || [];
  return rawItems.map(parseStored).filter(Boolean);
}

async function pushHistory(entry) {
  if (!entry || !Array.isArray(entry.data)) return;

  const snapshot = {
    ...entry,
    id: entry.id || makeId(),
    ...countStats(entry.data),
  };

  await redisCommand(["LPUSH", HISTORY_KEY, JSON.stringify(snapshot)]);
  await redisCommand(["LTRIM", HISTORY_KEY, "0", String(HISTORY_LIMIT - 1)]);
}

async function writeCurrent(data, extra = {}) {
  const now = new Date().toISOString();
  const entry = {
    id: makeId(),
    data,
    updatedAt: now,
    action: extra.action || "save",
    sourceVersionId: extra.sourceVersionId || null,
    ...countStats(data),
  };

  await redisCommand(["SET", STORE_KEY, JSON.stringify(entry)]);
  return entry;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      if (req.query && (req.query.history === "1" || req.query.history === "true")) {
        const current = await readCurrent();
        const history = await readHistory();

        return json(res, 200, {
          current: publicMeta(current),
          history: history.map(publicMeta),
        });
      }

      const current = await readCurrent();

      if (!current) {
        return json(res, 200, {
          data: null,
          updatedAt: null,
          versionId: null,
        });
      }

      return json(res, 200, {
        data: current.data,
        updatedAt: current.updatedAt || null,
        versionId: current.id || null,
      });
    }

    if (req.method === "PUT") {
      const data = req.body && req.body.data;

      if (!Array.isArray(data) || !data.length) {
        return json(res, 400, { error: "Некорректный формат данных" });
      }

      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized, "utf8") > 3_500_000) {
        return json(res, 413, { error: "Данные слишком большие для сохранения" });
      }

      const current = await readCurrent();

      if (current && sameData(current.data, data)) {
        return json(res, 200, {
          ok: true,
          unchanged: true,
          updatedAt: current.updatedAt || null,
          versionId: current.id || null,
        });
      }

      if (current) {
        await pushHistory(current);
      }

      const next = await writeCurrent(data, { action: "save" });

      return json(res, 200, {
        ok: true,
        unchanged: false,
        updatedAt: next.updatedAt,
        versionId: next.id,
      });
    }

    if (req.method === "POST") {
      const action = req.body && req.body.action;

      if (action !== "rollback") {
        return json(res, 400, { error: "Неизвестное действие" });
      }

      const versionId = req.body && req.body.versionId;
      if (!versionId) {
        return json(res, 400, { error: "Не указана версия для восстановления" });
      }

      const current = await readCurrent();
      const history = await readHistory();
      const target = history.find((entry) => entry.id === versionId);

      if (!target) {
        return json(res, 404, { error: "Версия не найдена в истории" });
      }

      if (current) {
        await pushHistory(current);
      }

      const restored = await writeCurrent(target.data, {
        action: "rollback",
        sourceVersionId: target.id,
      });

      return json(res, 200, {
        ok: true,
        data: restored.data,
        updatedAt: restored.updatedAt,
        versionId: restored.id,
      });
    }

    res.setHeader("Allow", "GET, PUT, POST");
    return json(res, 405, { error: "Метод не поддерживается" });
  } catch (error) {
    console.error(error);
    return json(res, error.statusCode || 500, {
      error: error.message || "Внутренняя ошибка сервера",
    });
  }
};
