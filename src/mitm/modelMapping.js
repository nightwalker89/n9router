const fs = require("fs");
const http = require("http");

const MITM_ALIAS_RR_STATE_KEY = "mitmAliasRoundRobinState";
const ROUTER_PORT = process.env.PORT || 20128;

const FORCED_PASSTHROUGH_MODELS = {
  antigravity: new Set(["gemini-3.1-flash-lite"]),
};

function readDbSync(dbFile) {
  if (!dbFile || !fs.existsSync(dbFile)) return null;
  return JSON.parse(fs.readFileSync(dbFile, "utf-8"));
}

function shouldPassthroughModel({ tool, model }) {
  if (!tool || !model) return false;
  return FORCED_PASSTHROUGH_MODELS[tool]?.has(model) === true;
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

function findMappedEntry(aliases, model) {
  if (!aliases || !model) return undefined;
  if (aliases[model] !== undefined) {
    return { aliasKey: model, value: aliases[model] };
  }

  const prefixKey = Object.keys(aliases).find((key) => (
    key
    && aliases[key]
    && (model.startsWith(key) || key.startsWith(model))
  ));

  return prefixKey
    ? { aliasKey: prefixKey, value: aliases[prefixKey] }
    : undefined;
}

function getMappedModelSelection({ dbFile, tool, model, limit = 5 }) {
  if (!tool || !model) return null;
  if (shouldPassthroughModel({ tool, model })) return null;

  try {
    const db = readDbSync(dbFile);
    const aliases = db?.mitmAlias?.[tool];
    if (!aliases) return null;

    const match = findMappedEntry(aliases, model);
    const models = normalizeMappedModels(match?.value, limit);
    if (!models) return null;

    return {
      aliasKey: match?.aliasKey || model,
      models,
    };
  } catch {
    return null;
  }
}

function getMappedModels({ dbFile, tool, model, limit = 5 }) {
  return getMappedModelSelection({ dbFile, tool, model, limit })?.models || null;
}

function getMitmAliasStrategy({ dbFile, fallback = "round-robin" }) {
  try {
    const db = readDbSync(dbFile);
    const strategy = db?.settings?.mitmAliasStrategy ?? db?.mitmAliasStrategy;
    return strategy === "fallback" ? "fallback" : fallback;
  } catch {
    return fallback;
  }
}

function getRoundRobinStateValue(db, tool, aliasKey) {
  const state = db?.settings?.[MITM_ALIAS_RR_STATE_KEY];
  if (!state || typeof state !== "object" || Array.isArray(state)) return 0;

  const value = state[`${tool}:${aliasKey}`];
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

// Write RR cursor via app API so SQLite stays the source of truth.
// Fire-and-forget: RR state is best-effort; a missed write just means
// the same model may be tried twice in a row — acceptable.
function setRoundRobinStateValue({ tool, aliasKey, nextIndex }) {
  const update = {
    [`${MITM_ALIAS_RR_STATE_KEY}`]: { [`${tool}:${aliasKey}`]: nextIndex },
  };
  const body = JSON.stringify(update);
  try {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: ROUTER_PORT,
        path: "/api/settings",
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => res.resume() // drain response
    );
    req.on("error", () => {}); // ignore errors silently
    req.write(body);
    req.end();
  } catch {
    // Ignore — RR cursor persistence is best-effort.
  }
}

function orderMappedModels({ dbFile, tool, aliasKey, models, strategy }) {
  const list = Array.isArray(models) ? [...models] : [];
  if (strategy !== "round-robin" || list.length <= 1) return list;

  const db = readDbSync(dbFile);
  const startIndex = getRoundRobinStateValue(db, tool, aliasKey) % list.length;
  const nextIndex = (startIndex + 1) % list.length;
  // Fire-and-forget via API — dbFile ignored (kept in signature for compat)
  setRoundRobinStateValue({ tool, aliasKey, nextIndex });

  return [
    ...list.slice(startIndex),
    ...list.slice(0, startIndex),
  ];
}

async function tryMappedModels({
  dbFile,
  req,
  res,
  bodyBuffer,
  models,
  tool,
  aliasKey,
  strategy,
  handlers,
  interceptOptions,
  log,
  err,
}) {
  const orderedModels = orderMappedModels({
    dbFile,
    tool,
    aliasKey,
    models,
    strategy,
  });

  for (let index = 0; index < orderedModels.length; index += 1) {
    const mappedModel = orderedModels[index];
    const posTag = orderedModels.length > 1 ? ` [${index + 1}/${orderedModels.length}]` : "";
    const strategyTag = strategy === "round-robin" ? "rr" : "fb";
    log(`⚡ [${tool}] mode=${strategyTag}${posTag}: trying ${mappedModel}`);

    if (res.headersSent) {
      log(`⏩ [${tool}] headers already sent, cannot fall back`);
      return true;
    }

    try {
      await handlers[tool].intercept(req, res, bodyBuffer, mappedModel, interceptOptions);
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
  getMappedModelSelection,
  getMappedModels,
  getMitmAliasStrategy,
  normalizeMappedModels,
  orderMappedModels,
  shouldPassthroughModel,
  tryMappedModels,
};
