/**
 * Token Swap Pool — reads providerConnections from db.json,
 * provides round-robin rotation with cooldown management.
 *
 * Runs in MITM server process (CJS, separate from Next.js).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { DATA_DIR } = require("./paths");
const { log } = require("./logger");

const DB_FILE = path.join(DATA_DIR, "db.json");
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry
const ROUTER_PORT = process.env.PORT || 20128;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// ── In-memory state ──────────────────────────────────────────
const cooldownMap = {};        // { [connectionId]: expiresTimestamp }
const modelCooldownMap = {};   // { [connectionId]: { [model]: expiresTimestamp } }
const rrState = {};            // { [provider]: roundRobinIndex }

// ── Cooldown management ──────────────────────────────────────

function setCooldown(connId, durationMs) {
  const ms = durationMs || DEFAULT_COOLDOWN_MS;
  cooldownMap[connId] = Date.now() + ms;
  log(`⏸ [token-pool] cooldown: ${connId.slice(0, 8)}… for ${Math.ceil(ms / 60000)}m`);
}

function isInCooldown(connId) {
  if (!cooldownMap[connId]) return false;
  if (Date.now() > cooldownMap[connId]) {
    delete cooldownMap[connId];
    return false;
  }
  return true;
}

// ── Per-model cooldown management ────────────────────────────
// Tracks which account+model combinations are quota-exhausted.
// Used by "sticky" strategy: whole account stays available for other models.

function setModelCooldown(connId, model, durationMs) {
  const ms = durationMs || DEFAULT_COOLDOWN_MS;
  const key = model || "__unknown__";
  if (!modelCooldownMap[connId]) modelCooldownMap[connId] = {};
  modelCooldownMap[connId][key] = Date.now() + ms;
  log(`⏸ [token-pool] model-cooldown: ${connId.slice(0, 8)}… model="${key}" for ${Math.ceil(ms / 60000)}m`);
}

function isModelExhausted(connId, model) {
  const key = model || "__unknown__";
  const map = modelCooldownMap[connId];
  if (!map) return false;
  const expiry = map[key];
  if (!expiry) return false;
  if (Date.now() > expiry) {
    delete map[key];
    return false;
  }
  return true;
}

// ── Strategy reader ───────────────────────────────────────────

function getTokenSwapStrategy() {
  try {
    if (!fs.existsSync(DB_FILE)) return "round-robin";
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return db.settings?.tokenSwapStrategy || "round-robin";
  } catch { return "round-robin"; }
}

// ── Quota cooldown parser ────────────────────────────────────
// Antigravity error format: "Your quota will reset after 2h7m23s"
function parseQuotaCooldown(errorBody) {
  try {
    const json = JSON.parse(errorBody);
    const msg = json?.error?.message || json?.message || "";
    const match = msg.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return null;
    let ms = 0;
    if (match[1]) ms += parseInt(match[1]) * 3600000;
    if (match[2]) ms += parseInt(match[2]) * 60000;
    if (match[3]) ms += parseInt(match[3]) * 1000;
    return ms > 0 ? ms : null;
  } catch { return null; }
}

// ── Read connections from db.json (sync) ─────────────────────

function getActiveConnections(provider) {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const connections = db.providerConnections || [];
    const now = Date.now();

    return connections
      .filter(c =>
        c.provider === provider &&
        c.isActive !== false &&
        c.accessToken &&
        !isInCooldown(c.id) &&
        // Skip expired tokens that have no refresh token
        !(c.expiresAt && new Date(c.expiresAt).getTime() < now && !c.refreshToken)
      )
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  } catch { return []; }
}

function getConnectionById(connId) {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const connections = db.providerConnections || [];
    return connections.find(c => c.id === connId) || null;
  } catch {
    return null;
  }
}

function maskEmail(email) {
  if (!email || typeof email !== "string") return email;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (local.length === 1) return `${local[0]}**@${domain}`;
  if (local.length === 2) return `${local[0]}**${local[1]}@${domain}`;

  return `${local[0]}**${local[local.length - 1]}@${domain}`;
}

function isAccountEmailMaskEnabled() {
  try {
    if (!fs.existsSync(DB_FILE)) return false;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return !!db.settings?.tokenSwapMaskEmails;
  } catch {
    return false;
  }
}

function getConnectionLabel(connection) {
  if (!connection) return "";

  const shouldMask = isAccountEmailMaskEnabled();
  const email = shouldMask ? maskEmail(connection.email) : connection.email;

  if (connection.name && email) return `${connection.name} <${email}>`;
  if (email) return email;
  return connection.name || connection.id.slice(0, 8);
}

function isTokenSwapEnabled(provider) {
  try {
    if (!fs.existsSync(DB_FILE)) return false;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    // Explicit toggle — must be enabled in settings
    if (!db.settings?.tokenSwapEnabled) {
      return false;
    }
    const active = getActiveConnections(provider);
    if (active.length === 0) {
      log(`⚙️ [token-pool] swap enabled in settings but no active ${provider} connections`);
      return false;
    }
    return true;
  } catch { return false; }
}

function getNextConnection(provider) {
  const connections = getActiveConnections(provider);
  if (connections.length === 0) return null;
  if (connections.length === 1) {
    log(`🎯 [token-pool] selected: "${getConnectionLabel(connections[0])}" (only account)`);
    return connections[0];
  }
  const idx = (rrState[provider] || 0) % connections.length;
  rrState[provider] = idx + 1;
  const selected = connections[idx];
  log(`🎯 [token-pool] round-robin[${idx}/${connections.length}]: "${getConnectionLabel(selected)}"`);
  return selected;
}

function getAllActiveConnections(provider, model) {
  const connections = getActiveConnections(provider);
  if (connections.length <= 1) return connections;

  const strategy = getTokenSwapStrategy();

  if (strategy === "sticky") {
    // Sticky strategy: filter out accounts exhausted for this specific model,
    // then sort most-recently-used first so the same account sticks across requests.
    const available = model
      ? connections.filter(c => !isModelExhausted(c.id, model))
      : connections;

    // If all accounts exhausted for this model, fall back to full list
    const pool = available.length > 0 ? available : connections;

    // Most-recently-used first (sticky within session)
    return [...pool].sort((a, b) => {
      if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
      if (!a.lastUsedAt) return 1;
      if (!b.lastUsedAt) return -1;
      return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
    });
  }

  // Round-robin strategy: sticky round-robin matching the main routing engine
  // (src/sse/services/auth.js). Least-recently-used account starts each request.
  const stickyLimit = getStickyLimit(provider);

  const byRecency = [...connections].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return 1;
    if (!b.lastUsedAt) return -1;
    return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
  });
  const current = byRecency[0];
  const currentCount = current?.consecutiveUseCount || 0;

  if (current?.lastUsedAt && currentCount < stickyLimit) {
    // Keep current account first, rest sorted oldest-first for fallback
    const rest = connections.filter(c => c.id !== current.id).sort((a, b) => {
      if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
      if (!a.lastUsedAt) return -1;
      if (!b.lastUsedAt) return 1;
      return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
    });
    return [current, ...rest];
  }

  // Rotate: least-recently-used first
  return [...connections].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return -1;
    if (!b.lastUsedAt) return 1;
    return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
  });
}

function getStickyLimit(provider) {
  try {
    if (!fs.existsSync(DB_FILE)) return 3;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const settings = db.settings || {};
    const providerOverride = (settings.providerStrategies || {})[provider] || {};
    return providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;
  } catch { return 3; }
}

// ── Mark account as used (update lastUsedAt + consecutiveUseCount in db.json) ──
// This drives the sticky round-robin: after stickyLimit consecutive uses,
// getAllActiveConnections will rotate to the next least-recently-used account.

function markAccountUsed(connId) {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const connections = db.providerConnections || [];
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;

    const now = new Date().toISOString();
    const wasAlreadyCurrent = conn.lastUsedAt &&
      (Date.now() - new Date(conn.lastUsedAt).getTime()) < 60000;

    conn.lastUsedAt = now;
    conn.consecutiveUseCount = wasAlreadyCurrent
      ? (conn.consecutiveUseCount || 0) + 1
      : 1;

    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    log(`⚠️ [token-pool] markAccountUsed error: ${e.message}`);
  }
}

// ── Token refresh trigger (refresh + reload persisted token) ─
// Calls 9Router's existing POST /api/providers/:id/test which
// checks expiry, refreshes token automatically, then returns the
// latest persisted connection snapshot for the current request.

async function triggerRefreshIfNeeded(connection) {
  if (!connection?.expiresAt || !connection?.refreshToken) return connection;
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (Date.now() + TOKEN_EXPIRY_BUFFER_MS < expiresAt) return connection;

  log(`🔄 [token-pool] near-expiry refresh → ${getConnectionLabel(connection).slice(0, 20)}`);
  return await new Promise((resolve) => {
    try {
      const req = http.request(
        { hostname: "127.0.0.1", port: ROUTER_PORT, path: `/api/providers/${connection.id}/test`, method: "POST" },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => {
            const refreshed = getConnectionById(connection.id);
            if (refreshed?.accessToken && refreshed.accessToken !== connection.accessToken) {
              log(`♻️ [token-pool] refreshed token applied → ${getConnectionLabel(connection).slice(0, 20)}`);
            }
            resolve(refreshed || connection);
          });
        }
      );
      req.on("error", () => resolve(connection));
      req.end();
    } catch {
      resolve(connection);
    }
  });
}

module.exports = {
  isTokenSwapEnabled,
  getNextConnection,
  getAllActiveConnections,
  triggerRefreshIfNeeded,
  setCooldown,
  setModelCooldown,
  isModelExhausted,
  getTokenSwapStrategy,
  parseQuotaCooldown,
  markAccountUsed,
  getConnectionLabel,
  maskEmail,
};
