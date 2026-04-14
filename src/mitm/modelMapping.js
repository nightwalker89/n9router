const fs = require("fs");

function readDb(dbFile) {
  if (!dbFile || !fs.existsSync(dbFile)) return null;
  return JSON.parse(fs.readFileSync(dbFile, "utf-8"));
}

function normalizeMappedModels(value, limit = 5) {
  if (Array.isArray(value)) {
    const models = value
      .map((model) => (typeof model === "string" ? model.trim() : ""))
      .filter(Boolean);
    return models.length > 0 ? models.slice(0, limit) : null;
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return null;
}

function findMappedValue(aliases, model) {
  if (!aliases || !model) return undefined;
  if (aliases[model] !== undefined) return aliases[model];

  const prefixKey = Object.keys(aliases).find((key) => (
    key
    && aliases[key]
    && (model.startsWith(key) || key.startsWith(model))
  ));

  return prefixKey ? aliases[prefixKey] : undefined;
}

function getMappedModels({ dbFile, tool, model, limit = 5 }) {
  if (!tool || !model) return null;

  try {
    const db = readDb(dbFile);
    const aliases = db?.mitmAlias?.[tool];
    if (!aliases) return null;
    return normalizeMappedModels(findMappedValue(aliases, model), limit);
  } catch {
    return null;
  }
}

function getMitmAliasStrategy({ dbFile, fallback = "round-robin" }) {
  try {
    const db = readDb(dbFile);
    const strategy = db?.mitmAliasStrategy;
    return strategy === "fallback" ? "fallback" : fallback;
  } catch {
    return fallback;
  }
}

function orderMappedModels(models, strategy) {
  const list = Array.isArray(models) ? [...models] : [];
  if (strategy !== "round-robin" || list.length <= 1) return list;

  const randomStart = Math.floor(Math.random() * list.length);
  return [
    ...list.slice(randomStart),
    ...list.slice(0, randomStart),
  ];
}

async function tryMappedModels({
  req,
  res,
  bodyBuffer,
  models,
  tool,
  strategy,
  handlers,
  passthrough,
  log,
  err,
}) {
  const orderedModels = orderMappedModels(models, strategy);

  for (let index = 0; index < orderedModels.length; index += 1) {
    const mappedModel = orderedModels[index];
    const posTag = orderedModels.length > 1 ? ` [${index + 1}/${orderedModels.length}]` : "";
    log(`⚡ [${tool}]${strategy === "round-robin" ? " rr" : " fb"}${posTag}: trying ${mappedModel}`);

    if (res.headersSent) {
      log(`⏩ [${tool}] headers already sent, cannot fall back`);
      return true;
    }

    try {
      await handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
      log(`✅ [${tool}] routed via ${mappedModel}`);
      return true;
    } catch (error) {
      const hasNext = index < orderedModels.length - 1;
      err(`[${tool}] ${mappedModel} failed: ${error.message}`);
      if (res.headersSent) {
        log(`⏩ [${tool}] headers sent during attempt, cannot fall back`);
        return true;
      }
      if (hasNext) {
        log(`↪️ [${tool}] falling back to next mapped model`);
      }
    }
  }

  return false;
}

module.exports = {
  getMappedModels,
  getMitmAliasStrategy,
  normalizeMappedModels,
  orderMappedModels,
  tryMappedModels,
};
