const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./paths");

const DB_FILE = path.join(DATA_DIR, "db.json");
const LOG_FILENAME = "mitm-debug.jsonl";
const MITM_ANTIGRAVITY_LOG_DIR = path.join(DATA_DIR, "mitm", "logs", "antigravity");

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readSettings() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return db?.settings || null;
  } catch {
    return null;
  }
}

function isAntigravityDebugLoggingEnabled() {
  return readSettings()?.mitmAntigravityDebugLogsEnabled === true;
}

function getAntigravityDebugLogDir(date = new Date()) {
  const day = new Date(date).toISOString().slice(0, 10);
  return path.join(MITM_ANTIGRAVITY_LOG_DIR, day);
}

function getAntigravityDebugLogFilePath(date = new Date()) {
  return path.join(getAntigravityDebugLogDir(date), LOG_FILENAME);
}

function ensureLogDir(date = new Date()) {
  const dir = getAntigravityDebugLogDir(date);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function maskToken(token) {
  if (!token || typeof token !== "string") return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function normalizeHeaders(headers) {
  if (!headers) return {};

  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Object.entries(headers);

  return entries.reduce((acc, [rawKey, rawValue]) => {
    const key = String(rawKey).toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue ?? "");

    if (key === "authorization") {
      acc[key] = (() => {
        const bearer = extractBearerToken(value);
        return bearer ? `Bearer ${maskToken(bearer)}` : "[masked]";
      })();
      return acc;
    }

    if (key === "cookie" || key === "set-cookie") {
      acc[key] = "[masked]";
      return acc;
    }

    acc[key] = value;
    return acc;
  }, {});
}

function decodeBodyBuffer(bodyBuffer) {
  if (!bodyBuffer || bodyBuffer.length === 0) {
    return { rawText: "", parsed: null };
  }

  const rawText = bodyBuffer.toString("utf-8");
  return {
    rawText,
    parsed: safeJsonParse(rawText),
  };
}

function decodeResponseBuffer(rawBuffer, contentEncoding) {
  if (!rawBuffer || rawBuffer.length === 0) return "";

  try {
    const encoding = String(contentEncoding || "").toLowerCase();
    if (encoding.includes("gzip")) return zlib.gunzipSync(rawBuffer).toString("utf-8");
    if (encoding.includes("br")) return zlib.brotliDecompressSync(rawBuffer).toString("utf-8");
    if (encoding.includes("deflate")) return zlib.inflateSync(rawBuffer).toString("utf-8");
    return rawBuffer.toString("utf-8");
  } catch {
    return rawBuffer.toString("utf-8");
  }
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || null,
  };
}

function buildConnectionDetails(connection) {
  if (!connection || typeof connection !== "object") return {};
  return {
    connectionId: connection.id || null,
    accountEmail: connection.email || null,
    accountName: connection.name || null,
  };
}

function writeLogRecord(record, now = new Date()) {
  ensureLogDir(now);
  fs.appendFileSync(
    getAntigravityDebugLogFilePath(now),
    `${JSON.stringify({ timestamp: now.toISOString(), ...record })}\n`,
    "utf-8",
  );
}

function findConnectionByAccessToken(provider, accessToken) {
  if (!provider || !accessToken) return null;

  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const connections = Array.isArray(db?.providerConnections) ? db.providerConnections : [];
    return connections.find((connection) => (
      connection?.provider === provider
      && connection?.accessToken
      && connection.accessToken === accessToken
    )) || null;
  } catch {
    return null;
  }
}

function createAntigravityDebugContext({ req, bodyBuffer, model, connection }) {
  if (!isAntigravityDebugLoggingEnabled()) return null;

  const requestId = `agmitm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const requestBody = decodeBodyBuffer(bodyBuffer);
  const incomingToken = extractBearerToken(req?.headers?.authorization);
  const matchedConnection = connection || findConnectionByAccessToken("antigravity", incomingToken);

  return {
    enabled: true,
    requestId,
    model: model || null,
    requestBody,
    incomingTokenMasked: maskToken(incomingToken),
    matchedConnection,

    log(event, data = {}) {
      try {
        writeLogRecord({
          requestId,
          model: model || null,
          event,
          ...data,
        });
      } catch {
        // Logging failures must never break MITM traffic.
      }
    },

    logRequest(extra = {}) {
      this.log("request.received", {
        method: req?.method || "GET",
        host: req?.headers?.host || null,
        url: req?.url || null,
        incomingTokenMasked: this.incomingTokenMasked,
        requestHeaders: normalizeHeaders(req?.headers),
        requestBody: requestBody.parsed || requestBody.rawText || null,
        requestBodyRaw: requestBody.rawText || null,
        ...buildConnectionDetails(matchedConnection),
        ...extra,
      });
    },

    logResponse({ event = "response.completed", statusCode, headers, bodyBuffer: rawBody, streamed = false, note = null, extra = {} }) {
      const responseText = decodeResponseBuffer(rawBody, headers?.["content-encoding"] || headers?.get?.("content-encoding"));
      this.log(event, {
        statusCode: statusCode || null,
        streamed,
        note,
        responseHeaders: normalizeHeaders(headers),
        responseBody: safeJsonParse(responseText) || responseText || null,
        responseBodyRaw: responseText || null,
        ...extra,
      });
    },

    logError(event, error, extra = {}) {
      this.log(event, {
        error: serializeError(error),
        ...extra,
      });
    },
  };
}

module.exports = {
  createAntigravityDebugContext,
  extractBearerToken,
  findConnectionByAccessToken,
  getAntigravityDebugLogDir,
  getAntigravityDebugLogFilePath,
  isAntigravityDebugLoggingEnabled,
  maskToken,
  normalizeHeaders,
};
