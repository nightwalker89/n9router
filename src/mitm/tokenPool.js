/**
 * Token Swap Pool — reads providerConnections from db.json,
 * provides token rotation with cooldown management.
 *
 * Runs in MITM server process (CJS, separate from Next.js).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { DATA_DIR } = require("./paths");
const { log } = require("./logger");
const { updateJsonFileSync } = require("../lib/dbFileSafety.js");

const DB_FILE = path.join(DATA_DIR, "db.json");
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry
const ROUTER_PORT = process.env.PORT || 20128;
const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_AUTH_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_STRIKE_THRESHOLD = 3; // consecutive 429s before hard cooldown
const CAPACITY_EXHAUSTED_COOLDOWN_MS = 60 * 1000;
const SONNET_46_MODEL_KEY = "claude-sonnet-4-6";
// Must match DEFAULT_AG_503_RETRY_COUNT in open-sse/config/runtimeConfig.js
const DEFAULT_503_RETRY_COUNT = 3;  // default 503 retries per account before switching

// ── In-memory state ──────────────────────────────────────────
const cooldownMap = {};        // { [connectionId]: expiresTimestamp } quota/general cooldown
const authCooldownMap = {};    // { [connectionId]: expiresTimestamp } invalid_token/auth cooldown
const modelCooldownMap = {};   // { [connectionId]: { [model]: expiresTimestamp } }
const strikeMap = {};          // { [connectionId]: consecutiveHitCount }
const modelStrikeMap = {};     // { [connectionId]: { [model]: consecutiveHitCount } }
// ── Strike + cooldown management ─────────────────────────────
// Upstream often returns false-positive 429s. Instead of locking
// an account on the first hit, we count consecutive strikes.
// Hard cooldown only triggers after STRIKE_THRESHOLD consecutive 429s.

function getStrikeThreshold() {
  try {
    if (!fs.existsSync(DB_FILE)) return DEFAULT_STRIKE_THRESHOLD;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return db.settings?.cooldownStrikeThreshold || DEFAULT_STRIKE_THRESHOLD;
  } catch { return DEFAULT_STRIKE_THRESHOLD; }
}

/**
 * Record a 429 strike for an account. Returns true if the account
 * just entered hard cooldown (threshold reached), false if it's
 * still within tolerance.
 */
function recordStrike(connId, durationMs) {
  const count = (strikeMap[connId] || 0) + 1;
  strikeMap[connId] = count;
  const threshold = getStrikeThreshold();

  if (count >= threshold) {
    const ms = durationMs || DEFAULT_COOLDOWN_MS;
    cooldownMap[connId] = Date.now() + ms;
    delete strikeMap[connId];
    log(`⏸ [token-pool] cooldown: ${connId.slice(0, 8)}… for ${Math.ceil(ms / 60000)}m (after ${count} strikes)`);
    return true;
  }

  log(`⚡ [token-pool] strike ${count}/${threshold}: ${connId.slice(0, 8)}… (not locked yet)`);
  return false;
}

function clearStrikes(connId) {
  delete strikeMap[connId];
}

function setCooldown(connId, durationMs) {
  const ms = durationMs || DEFAULT_COOLDOWN_MS;
  cooldownMap[connId] = Date.now() + ms;
  delete strikeMap[connId];
  log(`⏸ [token-pool] cooldown: ${connId.slice(0, 8)}… for ${Math.ceil(ms / 60000)}m`);
}

function setAuthCooldown(connId, durationMs) {
  const ms = durationMs || DEFAULT_AUTH_COOLDOWN_MS;
  authCooldownMap[connId] = Date.now() + ms;
  log(`🔒 [token-pool] auth-cooldown: ${connId.slice(0, 8)}… for ${Math.ceil(ms / 60000)}m`);
}

function getMapExpiry(map, connId) {
  if (!map[connId]) return 0;
  if (Date.now() > map[connId]) {
    delete map[connId];
    return 0;
  }
  return map[connId];
}

function getCooldownState(connId) {
  const authExpiry = getMapExpiry(authCooldownMap, connId);
  if (authExpiry) return { type: "auth", expiresAt: authExpiry };

  const quotaExpiry = getMapExpiry(cooldownMap, connId);
  if (quotaExpiry) return { type: "quota", expiresAt: quotaExpiry };

  return null;
}

function isInCooldown(connId) {
  return !!getCooldownState(connId);
}

// ── Per-model strike + cooldown management ───────────────────
// Tracks which account+model combinations are quota-exhausted.
// Same strike-before-cooldown logic as account-level.

/**
 * Record a 429 strike for a specific account+model. Returns true
 * if the model just entered hard cooldown.
 */
function recordModelStrike(connId, model, durationMs) {
  const key = model || "__unknown__";
  if (!modelStrikeMap[connId]) modelStrikeMap[connId] = {};
  const count = (modelStrikeMap[connId][key] || 0) + 1;
  modelStrikeMap[connId][key] = count;
  const threshold = getStrikeThreshold();

  if (count >= threshold) {
    const ms = durationMs || DEFAULT_COOLDOWN_MS;
    if (!modelCooldownMap[connId]) modelCooldownMap[connId] = {};
    modelCooldownMap[connId][key] = Date.now() + ms;
    delete modelStrikeMap[connId][key];
    log(`⏸ [token-pool] model-cooldown: ${connId.slice(0, 8)}… model="${key}" for ${Math.ceil(ms / 60000)}m (after ${count} strikes)`);
    return true;
  }

  log(`⚡ [token-pool] model-strike ${count}/${threshold}: ${connId.slice(0, 8)}… model="${key}" (not locked yet)`);
  return false;
}

function clearModelStrikes(connId, model) {
  const key = model || "__unknown__";
  if (modelStrikeMap[connId]?.[key]) delete modelStrikeMap[connId][key];
}

function setModelCooldown(connId, model, durationMs) {
  const ms = durationMs || DEFAULT_COOLDOWN_MS;
  const key = model || "__unknown__";
  if (!modelCooldownMap[connId]) modelCooldownMap[connId] = {};
  modelCooldownMap[connId][key] = Date.now() + ms;
  if (modelStrikeMap[connId]?.[key]) delete modelStrikeMap[connId][key];
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

function isStoredModelQuotaExhausted(connection, model) {
  if (!connection || !model) return false;
  const status = connection.modelQuotaStatus;
  if (!status || typeof status !== "object") return false;

  const modelStatus = status[model];
  if (!modelStatus || typeof modelStatus !== "object") return false;

  return modelStatus.exhausted === true || modelStatus.remainingPercentage === 0;
}

function isAntigravitySonnetZeroAutoDisableEnabled(db) {
  return db?.settings?.mitmAntigravityAutoDisableOnSonnetZero !== false;
}

function autoDisableAccountIfSonnetQuotaZero(connection, failure = {}) {
  if (!connection?.id || connection.provider !== "antigravity") return false;

  try {
    const now = new Date().toISOString();
    const statusLabel = failure.statusCode ? `status ${failure.statusCode}` : "request failure";
    const disabled = updateConnectionInDb(connection.id, (conn, db) => {
      if (!isAntigravitySonnetZeroAutoDisableEnabled(db)) return false;
      if (conn.isActive === false) return false;
      if (!isStoredModelQuotaExhausted(conn, SONNET_46_MODEL_KEY)) return false;
      Object.assign(conn, {
        isActive: false,
        autoDisabledAt: now,
        autoDisabledReason: "sonnet_4_6_quota_zero",
        lastError: `Auto-disabled after ${statusLabel}: Claude Sonnet 4.6 quota is 0%`,
        lastErrorAt: now,
        updatedAt: now,
      });
    });

    if (disabled) log(`⏸ [token-pool] auto-disabled: ${connection.id.slice(0, 8)}… Claude Sonnet 4.6 quota is 0%`);
    return disabled;
  } catch (e) {
    log(`⚠️ [token-pool] auto-disable check failed: ${e.message}`);
    return false;
  }
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
  const raw = String(errorBody || "");

  try {
    const json = JSON.parse(raw);
    const msg = json?.error?.message || json?.message || "";
    const reason = String(
      json?.error?.details?.[0]?.reason ||
      json?.error?.reason ||
      json?.reason ||
      ""
    ).toUpperCase();
    const match = msg.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (match) {
      let ms = 0;
      if (match[1]) ms += parseInt(match[1]) * 3600000;
      if (match[2]) ms += parseInt(match[2]) * 60000;
      if (match[3]) ms += parseInt(match[3]) * 1000;
      return ms > 0 ? ms : null;
    }

    if (
      reason === "MODEL_CAPACITY_EXHAUSTED" ||
      /no capacity available for model|model capacity exhausted|capacity exhausted/i.test(msg)
    ) {
      return CAPACITY_EXHAUSTED_COOLDOWN_MS;
    }
  } catch {
    if (/no capacity available for model|model capacity exhausted|capacity exhausted/i.test(raw)) {
      return CAPACITY_EXHAUSTED_COOLDOWN_MS;
    }
  }

  return null;
}

function shouldImmediateQuotaCooldown(statusCode, errorBody) {
  if (statusCode !== 503) return false;
  return parseQuotaCooldown(errorBody) != null;
}

/**
 * Get effective 503 retry count for a connection.
 * Priority: per-account override → global setting → DEFAULT_503_RETRY_COUNT
 * @param {number|null|undefined} connectionOverride - Per-account antigravity503RetryCount
 * @returns {number}
 */
function getAntigravity503RetryCount(connectionOverride) {
  // Per-account override takes priority — even 0 (no retries) is a valid override
  if (connectionOverride != null) {
    return connectionOverride;
  }
  // Global setting from db.json — 0 is valid ("switch immediately, no retry")
  try {
    if (!fs.existsSync(DB_FILE)) return DEFAULT_503_RETRY_COUNT;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return db.settings?.antigravity503RetryCount ?? DEFAULT_503_RETRY_COUNT;
  } catch { return DEFAULT_503_RETRY_COUNT; }
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

function getTokenSwapAvailabilitySummary(provider, model) {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return {
        total: 0,
        eligible: 0,
        skipped: 0,
        reasons: {},
        summaryText: "0/0 account(s) eligible"
      };
    }

    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const connections = (db.providerConnections || []).filter(c => c.provider === provider);
    const now = Date.now();
    const strategy = getTokenSwapStrategy();
    const reasons = {
      inactive: 0,
      noToken: 0,
      expiredNoRefresh: 0,
      quotaCooldown: 0,
      authCooldown: 0,
      modelCooldown: 0,
    };

    let eligible = 0;

    for (const connection of connections) {
      if (connection.isActive === false) {
        reasons.inactive += 1;
        continue;
      }
      if (!connection.accessToken) {
        reasons.noToken += 1;
        continue;
      }
      if (connection.expiresAt && new Date(connection.expiresAt).getTime() < now && !connection.refreshToken) {
        reasons.expiredNoRefresh += 1;
        continue;
      }

      const cooldownState = getCooldownState(connection.id);
      if (cooldownState?.type === "auth") {
        reasons.authCooldown += 1;
        continue;
      }
      if (cooldownState?.type === "quota") {
        reasons.quotaCooldown += 1;
        continue;
      }

      if (model && isStoredModelQuotaExhausted(connection, model)) {
        reasons.modelCooldown += 1;
        continue;
      }

      if (strategy === "sticky" && model && isModelExhausted(connection.id, model)) {
        reasons.modelCooldown += 1;
        continue;
      }

      eligible += 1;
    }

    const skipped = connections.length - eligible;
    const reasonParts = [];
    if (reasons.quotaCooldown) reasonParts.push(`${reasons.quotaCooldown} quota cooldown`);
    if (reasons.authCooldown) reasonParts.push(`${reasons.authCooldown} auth cooldown`);
    if (reasons.modelCooldown) reasonParts.push(`${reasons.modelCooldown} model cooldown`);
    if (reasons.inactive) reasonParts.push(`${reasons.inactive} inactive`);
    if (reasons.noToken) reasonParts.push(`${reasons.noToken} missing token`);
    if (reasons.expiredNoRefresh) reasonParts.push(`${reasons.expiredNoRefresh} expired-no-refresh`);

    const summaryText = skipped > 0
      ? `${eligible}/${connections.length} account(s) eligible, skipped ${skipped} (${reasonParts.join(", ")})`
      : `${eligible}/${connections.length} account(s) eligible`;

    return { total: connections.length, eligible, skipped, reasons, summaryText };
  } catch {
    return {
      total: 0,
      eligible: 0,
      skipped: 0,
      reasons: {},
      summaryText: "0/0 account(s) eligible"
    };
  }
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
  const connections = getAllActiveConnections(provider);
  if (connections.length === 0) return null;

  const selected = connections[0];
  const strategy = getTokenSwapStrategy();
  if (connections.length === 1) {
    log(`🎯 [token-pool] selected: "${getConnectionLabel(selected)}" (only account)`);
    return selected;
  }

  const lastUsedTag = selected.lastUsedAt ? ` lastUsed=${selected.lastUsedAt}` : " lastUsed=never";
  log(`🎯 [token-pool] ${strategy}[next/${connections.length}]: "${getConnectionLabel(selected)}"${lastUsedTag}`);
  return selected;
}

function getAllActiveConnections(provider, model) {
  const connections = getActiveConnections(provider);
  if (connections.length <= 1) return connections;

  const strategy = getTokenSwapStrategy();
  const hardAvailable = model
    ? connections.filter(c => !isStoredModelQuotaExhausted(c, model))
    : connections;

  if (model && hardAvailable.length === 0) {
    return [];
  }

  if (strategy === "sticky") {
    // Sticky strategy: filter out accounts exhausted for this specific model,
    // then sort most-recently-used first so the same account sticks across requests.
    const available = model
      ? hardAvailable.filter(c => !isModelExhausted(c.id, model))
      : hardAvailable;

    // Runtime model cooldowns are temporary and may be false positives,
    // so sticky mode can still fall back to hard-eligible accounts.
    const pool = available.length > 0 ? available : hardAvailable;

    // Most-recently-used first (sticky within session)
    return [...pool].sort((a, b) => {
      if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
      if (!a.lastUsedAt) return 1;
      if (!b.lastUsedAt) return -1;
      return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
    });
  }

  // Round-robin strategy: least-recently-used first. Successful requests
  // update lastUsedAt, so the next selection naturally advances without
  // extra streak state or in-memory round-robin indexes.
  return [...hardAvailable].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return -1;
    if (!b.lastUsedAt) return 1;
    return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
  });
}

// ── Shared DB helper ─────────────────────────────────────────
// Read db.json, find a connection by id, apply patchFn, write back.
// patchFn receives the mutable connection object; returning false aborts.

function updateConnectionInDb(connId, patchFn) {
  const result = updateJsonFileSync(DB_FILE, (db) => {
    const connections = db.providerConnections || [];
    const index = connections.findIndex(c => c.id === connId);
    if (index === -1) return false;
    return patchFn(connections[index], db);
  });
  return result.updated;
}

// ── Mark account as used (update lastUsedAt in db.json) ──
// Round-robin selection is based on least-recently-used ordering.

function markAccountUsed(connId) {
  try {
    updateConnectionInDb(connId, (conn) => {
      conn.lastUsedAt = new Date().toISOString();
      if ("consecutiveUseCount" in conn) delete conn.consecutiveUseCount;
    });
  } catch (e) {
    log(`⚠️ [token-pool] markAccountUsed error: ${e.message}`);
  }
}

// ── Token refresh trigger (refresh + reload persisted token) ─
// Calls 9Router's existing POST /api/providers/:id/test which
// checks expiry, refreshes token automatically, then returns the
// latest persisted connection snapshot for the current request.

async function runConnectionTest(connection) {
  return await new Promise((resolve) => {
    if (!connection?.id) {
      resolve({ connection, refreshed: false, valid: false });
      return;
    }

    let responseBody = "";

    try {
      const req = http.request(
        { hostname: "127.0.0.1", port: ROUTER_PORT, path: `/api/providers/${connection.id}/test`, method: "POST" },
        (res) => {
          res.on("data", (chunk) => {
            responseBody += chunk.toString();
          });
          res.on("end", () => {
            let payload = {};
            try {
              payload = JSON.parse(responseBody || "{}");
            } catch {
              payload = {};
            }

            const refreshedConnection = getConnectionById(connection.id);
            const tokenChanged = !!(refreshedConnection?.accessToken && refreshedConnection.accessToken !== connection.accessToken);
            resolve({
              connection: refreshedConnection || connection,
              refreshed: !!payload.refreshed || tokenChanged,
              valid: !!payload.valid,
            });
          });
        }
      );
      req.on("error", () => resolve({ connection, refreshed: false, valid: false }));
      req.end();
    } catch {
      resolve({ connection, refreshed: false, valid: false });
    }
  });
}

async function triggerRefreshIfNeeded(connection) {
  if (!connection?.expiresAt || !connection?.refreshToken) return connection;
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (Date.now() + TOKEN_EXPIRY_BUFFER_MS < expiresAt) return connection;

  log(`🔄 [token-pool] near-expiry refresh → ${getConnectionLabel(connection).slice(0, 20)}`);
  const result = await runConnectionTest(connection);
  if (result.refreshed) {
    log(`♻️ [token-pool] refreshed token applied → ${getConnectionLabel(connection).slice(0, 20)}`);
  }
  return result.connection || connection;
}

async function forceRefreshConnection(connection) {
  if (!connection?.refreshToken) {
    return { connection, refreshed: false, valid: false };
  }

  log(`🔄 [token-pool] auth refresh → ${getConnectionLabel(connection).slice(0, 20)}`);
  const result = await runConnectionTest(connection);
  if (result.refreshed) {
    log(`♻️ [token-pool] refreshed token applied → ${getConnectionLabel(connection).slice(0, 20)}`);
  }
  return result;
}

module.exports = {
  isTokenSwapEnabled,
  getNextConnection,
  getAllActiveConnections,
  triggerRefreshIfNeeded,
  forceRefreshConnection,
  setCooldown,
  setAuthCooldown,
  setModelCooldown,
  recordStrike,
  recordModelStrike,
  clearStrikes,
  clearModelStrikes,
  isModelExhausted,
  getTokenSwapStrategy,
  parseQuotaCooldown,
  shouldImmediateQuotaCooldown,
  autoDisableAccountIfSonnetQuotaZero,
  markAccountUsed,
  getConnectionLabel,
  maskEmail,
  getTokenSwapAvailabilitySummary,
  getAntigravity503RetryCount,
};
