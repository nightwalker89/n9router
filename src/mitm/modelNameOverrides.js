const fs = require("fs");
const zlib = require("zlib");

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOverrides(overrides) {
  if (!isPlainObject(overrides)) return {};

  return Object.fromEntries(
    Object.entries(overrides)
      .map(([modelId, name]) => [
        typeof modelId === "string" ? modelId.trim() : "",
        typeof name === "string" ? name.trim() : "",
      ])
      .filter(([modelId, name]) => modelId && name)
  );
}

function readMitmModelNameOverrides({ dbFile, tool }) {
  if (!dbFile || !tool || !fs.existsSync(dbFile)) return {};

  try {
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
    return normalizeOverrides(db?.settings?.mitmModelNameOverrides?.[tool]);
  } catch {
    return {};
  }
}

function getHeaderValue(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

function decodeResponseBody(rawBuffer, headers) {
  if (!rawBuffer || rawBuffer.length === 0) return "";

  const encoding = getHeaderValue(headers, "content-encoding").toLowerCase();
  if (encoding.includes("gzip")) return zlib.gunzipSync(rawBuffer).toString("utf-8");
  if (encoding.includes("br")) return zlib.brotliDecompressSync(rawBuffer).toString("utf-8");
  if (encoding.includes("deflate")) return zlib.inflateSync(rawBuffer).toString("utf-8");
  return rawBuffer.toString("utf-8");
}

function isLikelyDisplayNameField(value, modelId) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (value === modelId) return false;
  if (value.includes("/")) return false;
  return true;
}

function applyNameToModelInfo(info, modelId, displayName) {
  if (!isPlainObject(info) || !modelId || !displayName) return false;

  if (info.displayName !== displayName) {
    info.displayName = displayName;
    return true;
  }

  if (!Object.prototype.hasOwnProperty.call(info, "displayName") && isLikelyDisplayNameField(info.name, modelId)) {
    info.name = displayName;
    return true;
  }

  return false;
}

function applyAntigravityModelNameOverrides(data, overrides) {
  const normalized = normalizeOverrides(overrides);
  const changedModelIds = [];

  if (!isPlainObject(data) || !isPlainObject(data.models) && !Array.isArray(data.models)) {
    return { data, changed: false, changedModelIds };
  }

  if (Array.isArray(data.models)) {
    for (const modelInfo of data.models) {
      if (!isPlainObject(modelInfo)) continue;
      const modelId = modelInfo.id || modelInfo.model || modelInfo.name;
      const displayName = typeof modelId === "string" ? normalized[modelId] : null;
      if (displayName && applyNameToModelInfo(modelInfo, modelId, displayName)) {
        changedModelIds.push(modelId);
      }
    }
  } else {
    for (const [modelId, modelInfo] of Object.entries(data.models)) {
      const displayName = normalized[modelId];
      if (displayName && applyNameToModelInfo(modelInfo, modelId, displayName)) {
        changedModelIds.push(modelId);
      }
    }
  }

  return {
    data,
    changed: changedModelIds.length > 0,
    changedModelIds,
  };
}

function buildJsonResponseHeaders(headers) {
  const next = {};

  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key).toLowerCase();
    if (
      normalizedKey === "content-length"
      || normalizedKey === "content-encoding"
      || normalizedKey === "transfer-encoding"
    ) {
      continue;
    }
    next[key] = value;
  }

  next["content-type"] = "application/json; charset=utf-8";
  return next;
}

function rewriteAvailableModelsResponse({ rawBuffer, headers, overrides }) {
  const normalized = normalizeOverrides(overrides);
  if (Object.keys(normalized).length === 0) {
    return { changed: false, reason: "no_overrides", rawBuffer, headers };
  }

  let text;
  let data;

  try {
    text = decodeResponseBody(rawBuffer, headers);
    data = JSON.parse(text);
  } catch (error) {
    return {
      changed: false,
      reason: "parse_failed",
      error,
      rawBuffer,
      headers,
    };
  }

  const result = applyAntigravityModelNameOverrides(data, normalized);
  if (!result.changed) {
    return {
      changed: false,
      reason: "no_matches",
      rawBuffer,
      headers,
    };
  }

  const bodyBuffer = Buffer.from(JSON.stringify(result.data), "utf-8");
  return {
    changed: true,
    bodyBuffer,
    headers: buildJsonResponseHeaders(headers),
    changedModelIds: result.changedModelIds,
  };
}

module.exports = {
  applyAntigravityModelNameOverrides,
  buildJsonResponseHeaders,
  decodeResponseBody,
  normalizeOverrides,
  readMitmModelNameOverrides,
  rewriteAvailableModelsResponse,
};
